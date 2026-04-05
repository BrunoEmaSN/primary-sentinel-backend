// src/application/use-cases/ProcessWebhookEvent.ts
// Main orchestrator: receives raw event → validates → heals if needed → loads

import { RawEvent } from "../../domain/events/entities/RawEvent.js";
import type { IEventRepository } from "../../domain/events/repositories/IEventRepository.js";
import type { IEndpointRepository } from "../../domain/events/repositories/IEndpointRepository.js";
import type { ITransformationRuleRepository, IRuleCache } from "../../domain/healing/repositories/ITransformationRuleRepository.js";
import type {
  ILLMService,
  IStorageService,
  INotificationService,
  ISandboxService,
} from "../ports/index.js";
import { TransformationRule } from "../../domain/healing/entities/TransformationRule.js";
import { generateId, hashFingerprint } from "../../infrastructure/utils/crypto.js";
import { createLogger } from "../../infrastructure/utils/logger.js";

const logger = createLogger("ProcessWebhookEvent");

export type ProcessWebhookEventCommand = {
  eventId: string;
  tenantId: string;
  endpointSlug: string;
  rawPayload: unknown;
  metadata: {
    contentType: string;
    headers: Record<string, string>;
    ipAddress?: string;
    userAgent?: string;
  };
  origin: string;
};

export type ProcessWebhookEventResult = {
  eventId: string;
  status: "loaded" | "healed" | "queued_for_healing" | "dead";
  message: string;
};

export class ProcessWebhookEvent {
  constructor(
    private readonly eventRepo: IEventRepository,
    private readonly endpointRepo: IEndpointRepository,
    private readonly ruleRepo: ITransformationRuleRepository,
    private readonly ruleCache: IRuleCache,
    private readonly llmService: ILLMService,
    private readonly storageService: IStorageService,
    private readonly notificationService: INotificationService,
    private readonly sandboxService: ISandboxService
  ) {}

  async execute(
    command: ProcessWebhookEventCommand
  ): Promise<ProcessWebhookEventResult> {
    logger.info("Processing webhook event", {
      eventId: command.eventId,
      tenantId: command.tenantId,
      endpointSlug: command.endpointSlug,
    });

    // ── Step 0: Idempotency Guard ──────────────────────────────────────────
    const alreadyProcessed = await this.eventRepo.existsById(command.eventId);
    if (alreadyProcessed) {
      logger.info("Duplicate event detected, skipping", { eventId: command.eventId });
      return { eventId: command.eventId, status: "loaded", message: "Duplicate event — already processed" };
    }

    // ── Step 1: Load Endpoint Configuration ────────────────────────────────
    const endpoint = await this.endpointRepo.findBySlug({
      tenantId: command.tenantId,
      slug: command.endpointSlug,
    });

    if (!endpoint) {
      throw new EndpointNotFoundError(command.endpointSlug, command.tenantId);
    }

    if (!endpoint.isActive()) {
      throw new EndpointInactiveError(endpoint.id);
    }

    // ── Step 2: Persist Raw Event ──────────────────────────────────────────
    const event = RawEvent.create({
      id: command.eventId,
      tenantId: command.tenantId,
      endpointId: endpoint.id,
      rawPayload: command.rawPayload,
      source: {
        tenantId: command.tenantId,
        endpointId: endpoint.id,
        origin: command.origin,
        receivedAt: new Date(),
      },
      metadata: command.metadata,
    });

    await this.eventRepo.save(event);
    endpoint.incrementReceived();
    await this.endpointRepo.update(endpoint);

    // ── Step 3: DataValidator — Validate Against Schema ────────────────────
    const zodSchema = endpoint.buildZodSchema();
    const validationResult = zodSchema.safeParse(command.rawPayload);

    if (validationResult.success) {
      // ✅ FAST PATH: Valid data — load directly
      logger.info("Validation passed, loading event", { eventId: event.id });
      event.markAsValidated(validationResult.data);
      await this.eventRepo.updateStatus(event);

      await this.loadEvent(event, endpoint);
      return { eventId: event.id, status: "loaded", message: "Event validated and loaded successfully" };
    }

    // ── Step 4: HealingAgent — Try to fix broken data ──────────────────────
    const validationErrors = validationResult.error.errors.map(
      (e) => `${e.path.join(".")}: ${e.message}`
    );

    logger.warn("Validation failed, attempting healing", {
      eventId: event.id,
      errors: validationErrors,
    });

    if (!endpoint.healingConfig.enabled) {
      return await this.sendToDLQ(event, endpoint, "Healing disabled for this endpoint");
    }

    if (!event.canAttemptHealing(endpoint.healingConfig.maxAttempts)) {
      return await this.sendToDLQ(event, endpoint, "Max healing attempts exceeded");
    }

    event.markAsHealing();
    await this.eventRepo.updateStatus(event);

    // Step 4A: Check cache for existing transformation rule
    const errorFingerprint = hashFingerprint(
      endpoint.id,
      JSON.stringify(endpoint.schema),
      validationErrors.join("|")
    );

    const cachedRuleId = await this.ruleCache.get(errorFingerprint);

    if (cachedRuleId) {
      logger.info("Found cached transformation rule", { ruleId: cachedRuleId });
      const rule = await this.ruleRepo.findById(cachedRuleId);

      if (rule && rule.isUsable()) {
        const healed = await this.applyRule(rule, event);
        if (healed) {
          event.markAsHealed(healed, rule.id);
          await this.eventRepo.updateStatus(event);
          rule.recordSuccess();
          await this.ruleRepo.update(rule);
          await this.loadEvent(event, endpoint);

          if (endpoint.healingConfig.notifyOnHealing) {
            await this.notifyHealing(event, endpoint, rule, "cache_hit");
          }

          return { eventId: event.id, status: "healed", message: "Event healed using cached rule" };
        }
        rule.recordFailure();
        await this.ruleRepo.update(rule);
      }
    }

    // Step 4B: Generate new transformation rule via LLM
    logger.info("Generating new transformation rule via LLM", { eventId: event.id });

    let healingResult;
    try {
      healingResult = await this.llmService.generateTransformationScript({
        expectedSchema: endpoint.schema,
        receivedPayload: command.rawPayload,
        validationErrors,
        endpointContext: `Endpoint: ${endpoint.name}`,
      });
    } catch (llmError) {
      logger.error("LLM failed to generate transformation", { error: llmError, eventId: event.id });
      return await this.sendToDLQ(event, endpoint, `LLM generation failed: ${String(llmError)}`);
    }

    // Step 4C: Execute in sandbox
    const sandboxResult = await this.sandboxService.execute(
      healingResult.script,
      command.rawPayload
    );

    if (!sandboxResult.success) {
      logger.error("Sandbox execution failed", { error: sandboxResult.error, eventId: event.id });
      event.addError(`Sandbox failed: ${sandboxResult.error}`);
      return await this.sendToDLQ(event, endpoint, `Sandbox execution failed: ${sandboxResult.error}`);
    }

    // Validate the sandbox output against the schema
    const healedValidation = zodSchema.safeParse(sandboxResult.output);
    if (!healedValidation.success) {
      logger.error("Healed data still invalid after transformation", { eventId: event.id });
      return await this.sendToDLQ(event, endpoint, "Transformed data still fails schema validation");
    }

    // ✅ Healing successful — persist rule
    const newRule = TransformationRule.create({
      id: generateId(),
      tenantId: command.tenantId,
      endpointId: endpoint.id,
      schemaVersion: "1",
      errorFingerprint,
      language: healingResult.language,
      script: healingResult.script,
      description: healingResult.description,
      generatedBy: healingResult.modelUsed,
    });

    newRule.recordSuccess();
    await this.ruleRepo.save(newRule);
    await this.ruleCache.set(errorFingerprint, newRule.id, 86400); // 24h TTL

    event.markAsHealed(healedValidation.data, newRule.id);
    await this.eventRepo.updateStatus(event);
    endpoint.incrementHealed();
    await this.endpointRepo.update(endpoint);

    await this.loadEvent(event, endpoint);

    if (endpoint.healingConfig.notifyOnHealing) {
      await this.notifyHealing(event, endpoint, newRule, "llm_generated");
    }

    logger.info("Event healed and loaded successfully", { eventId: event.id, ruleId: newRule.id });
    return { eventId: event.id, status: "healed", message: "Event healed via AI-generated rule" };
  }

  private async loadEvent(
    event: RawEvent,
    endpoint: import("../../domain/events/entities/Endpoint.js").Endpoint
  ): Promise<void> {
    // DataLoader: insert into destination DWH
    // In production this would call the specific destination adapter
    // For now, we mark as loaded and update stats
    event.markAsLoaded();
    await this.eventRepo.updateStatus(event);
    endpoint.incrementLoaded();
    await this.endpointRepo.update(endpoint);
    logger.info("Event loaded to destination", { eventId: event.id, destination: endpoint.destination.type });
  }

  private async applyRule(
    rule: TransformationRule,
    event: RawEvent
  ): Promise<unknown | null> {
    const result = await this.sandboxService.execute(rule.script, event.rawPayload);
    return result.success ? result.output : null;
  }

  private async sendToDLQ(
    event: RawEvent,
    endpoint: import("../../domain/events/entities/Endpoint.js").Endpoint,
    reason: string
  ): Promise<ProcessWebhookEventResult> {
    event.markAsDead(reason);
    await this.eventRepo.updateStatus(event);
    endpoint.incrementDead();
    await this.endpointRepo.update(endpoint);

    // Store raw payload in R2
    const dlqKey = `dlq/${event.tenantId}/${event.id}.json`;
    await this.storageService.store(dlqKey, event.toSnapshot());

    if (endpoint.healingConfig.notifyOnDead) {
      await this.notificationService.send({
        type: "dead_letter",
        tenantId: event.tenantId,
        endpointId: endpoint.id,
        tenantEmail: "", // fetched from tenant record in production
        endpointName: endpoint.name,
        eventId: event.id,
        details: { reason, errorLog: event.errorLog },
      }).catch((e) => logger.error("Failed to send DLQ notification", { error: e }));
    }

    logger.error("Event sent to DLQ", { eventId: event.id, reason });
    return { eventId: event.id, status: "dead", message: reason };
  }

  private async notifyHealing(
    event: RawEvent,
    endpoint: import("../../domain/events/entities/Endpoint.js").Endpoint,
    rule: TransformationRule,
    method: string
  ): Promise<void> {
    await this.notificationService.send({
      tenantId: event.tenantId,
      endpointId: endpoint.id,
      type: "healing_success",
      tenantEmail: "",
      endpointName: endpoint.name,
      eventId: event.id,
      details: { ruleId: rule.id, method, description: rule.description },
    }).catch((e) => logger.error("Failed to send healing notification", { error: e }));
  }
}

// ── Domain Errors ───────────────────────────────────────────────────────────

export class EndpointNotFoundError extends Error {
  constructor(slug: string, tenantId: string) {
    super(`Endpoint '${slug}' not found for tenant '${tenantId}'`);
    this.name = "EndpointNotFoundError";
  }
}

export class EndpointInactiveError extends Error {
  constructor(endpointId: string) {
    super(`Endpoint '${endpointId}' is not active`);
    this.name = "EndpointInactiveError";
  }
}

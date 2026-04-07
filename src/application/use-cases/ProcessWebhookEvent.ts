// src/application/use-cases/ProcessWebhookEvent.ts
// Main orchestrator: receive → validate → heal → dispatch to ALL destinations

import { RawEvent } from "../../domain/events/entities/RawEvent.js";
import type { IEventRepository } from "../../domain/events/repositories/IEventRepository.js";
import type { IEndpointRepository } from "../../domain/events/repositories/IEndpointRepository.js";
import type {
  ITransformationRuleRepository,
  IRuleCache,
} from "../../domain/healing/repositories/ITransformationRuleRepository.js";
import type {
  ILLMService,
  IStorageService,
  INotificationService,
  ISandboxService,
} from "../ports/index.js";
import { TransformationRule } from "../../domain/healing/entities/TransformationRule.js";
import { OutputDispatcher } from "./OutputDispatcher.js";
import {
  generateId,
  hashFingerprint,
} from "../../infrastructure/utils/crypto.js";
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
  status: "loaded" | "healed" | "dead";
  message: string;
  // NEW: per-destination dispatch summary
  dispatchResults?: Array<{
    destinationType: string;
    destinationIndex: number;
    success: boolean;
    durationMs: number;
    error?: string;
  }>;
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
    private readonly sandboxService: ISandboxService,
    private readonly outputDispatcher: OutputDispatcher
  ) {}

  async execute(
    command: ProcessWebhookEventCommand
  ): Promise<ProcessWebhookEventResult> {
    logger.info("Processing webhook event", {
      eventId: command.eventId,
      tenantId: command.tenantId,
      endpointSlug: command.endpointSlug,
    });

    // ── Step 0: Idempotency guard ───────────────────────────────────────────
    if (await this.eventRepo.existsById(command.eventId)) {
      logger.info("Duplicate event, skipping", { eventId: command.eventId });
      return {
        eventId: command.eventId,
        status: "loaded",
        message: "Duplicate event — already processed",
      };
    }

    // ── Step 1: Load endpoint ───────────────────────────────────────────────
    const endpoint = await this.endpointRepo.findBySlug({
      tenantId: command.tenantId,
      slug: command.endpointSlug,
    });

    if (!endpoint) throw new EndpointNotFoundError(command.endpointSlug, command.tenantId);
    if (!endpoint.isActive()) throw new EndpointInactiveError(endpoint.id);

    // ── Step 2: Persist raw event ───────────────────────────────────────────
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

    // ── Step 3: Validate against schema ────────────────────────────────────
    const zodSchema = endpoint.buildZodSchema();
    const validationResult = zodSchema.safeParse(command.rawPayload);

    if (validationResult.success) {
      // ✅ Fast path — valid payload
      event.markAsValidated(validationResult.data);
      await this.eventRepo.updateStatus(event);
      return await this.dispatchAndFinalize(event, endpoint, validationResult.data, "loaded");
    }

    // ── Step 4: HealingAgent ────────────────────────────────────────────────
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

    // Step 4A: Cache lookup
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
        if (healed !== null) {
          const healedValidation = zodSchema.safeParse(healed);
          if (healedValidation.success) {
            event.markAsHealed(healedValidation.data, rule.id);
            await this.eventRepo.updateStatus(event);
            rule.recordSuccess();
            await this.ruleRepo.update(rule);

            if (endpoint.healingConfig.notifyOnHealing) {
              await this.notifyHealing(event, endpoint, rule, "cache_hit");
            }

            endpoint.incrementHealed();
            await this.endpointRepo.update(endpoint);
            return await this.dispatchAndFinalize(event, endpoint, healedValidation.data, "healed");
          }
        }
        rule.recordFailure();
        await this.ruleRepo.update(rule);
      }
    }

    // Step 4B: Generate via LLM
    logger.info("Calling LLM for new transformation rule", { eventId: event.id });

    let healingResult;
    try {
      healingResult = await this.llmService.generateTransformationScript({
        expectedSchema: endpoint.schema,
        receivedPayload: command.rawPayload,
        validationErrors,
        endpointContext: `Endpoint: ${endpoint.name}`,
      });
    } catch (llmErr) {
      logger.error("LLM failed", { error: llmErr, eventId: event.id });
      return await this.sendToDLQ(
        event,
        endpoint,
        `LLM generation failed: ${String(llmErr)}`
      );
    }

    // Step 4C: Sandbox execution
    const sandboxResult = await this.sandboxService.execute(
      healingResult.script,
      command.rawPayload
    );

    if (!sandboxResult.success) {
      event.addError(`Sandbox failed: ${sandboxResult.error}`);
      return await this.sendToDLQ(
        event,
        endpoint,
        `Sandbox execution failed: ${sandboxResult.error}`
      );
    }

    // Step 4D: Re-validate healed output
    const healedValidation = zodSchema.safeParse(sandboxResult.output);
    if (!healedValidation.success) {
      return await this.sendToDLQ(
        event,
        endpoint,
        "Transformed data still fails schema validation"
      );
    }

    // ✅ Healing successful — persist new rule
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
    await this.ruleCache.set(errorFingerprint, newRule.id, 86400);

    event.markAsHealed(healedValidation.data, newRule.id);
    await this.eventRepo.updateStatus(event);
    endpoint.incrementHealed();
    await this.endpointRepo.update(endpoint);

    if (endpoint.healingConfig.notifyOnHealing) {
      await this.notifyHealing(event, endpoint, newRule, "llm_generated");
    }

    logger.info("Event healed via LLM", { eventId: event.id, ruleId: newRule.id });
    return await this.dispatchAndFinalize(event, endpoint, healedValidation.data, "healed");
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  /**
   * Dispatches validated payload to ALL destinations (fanout),
   * marks event as loaded, updates stats, returns result.
   */
  private async dispatchAndFinalize(
    event: RawEvent,
    endpoint: import("../../domain/events/entities/Endpoint.js").Endpoint,
    payload: unknown,
    finalStatus: "loaded" | "healed"
  ): Promise<ProcessWebhookEventResult> {
    logger.info("Dispatching to destinations", {
      eventId: event.id,
      destinationCount: endpoint.destinations.length,
    });

    const dispatchResults = await this.outputDispatcher.dispatch(
      endpoint.destinations,
      payload
    );

    const allFailed = dispatchResults.length > 0 && dispatchResults.every((r) => !r.success);

    if (allFailed) {
      // All destinations failed — send to DLQ
      const errors = dispatchResults.map((r) => r.error ?? "unknown").join("; ");
      return await this.sendToDLQ(event, endpoint, `All destinations failed: ${errors}`);
    }

    // At least one destination succeeded — mark as loaded
    event.markAsLoaded(dispatchResults);
    await this.eventRepo.updateStatus(event);
    endpoint.incrementLoaded();
    await this.endpointRepo.update(endpoint);

    const failedCount = dispatchResults.filter((r) => !r.success).length;
    const message =
      failedCount > 0
        ? `Event ${finalStatus} — ${dispatchResults.length - failedCount}/${dispatchResults.length} destinations succeeded`
        : `Event ${finalStatus} and dispatched to all ${dispatchResults.length} destination(s)`;

    logger.info(message, { eventId: event.id });

    return {
      eventId: event.id,
      status: finalStatus === "healed" ? "healed" : "loaded",
      message,
      dispatchResults,
    };
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

    await this.storageService
      .store(`dlq/${event.tenantId}/${event.id}.json`, event.toSnapshot())
      .catch((e) => logger.error("Failed to store DLQ payload", { error: e }));

    if (endpoint.healingConfig.notifyOnDead) {
      await this.notificationService
        .send({
          type: "dead_letter",
          tenantId: event.tenantId,
          endpointId: endpoint.id,
          tenantEmail: "",
          endpointName: endpoint.name,
          eventId: event.id,
          details: { reason, errorLog: event.errorLog },
        })
        .catch((e) => logger.error("Failed to send DLQ notification", { error: e }));
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
    await this.notificationService
      .send({
        tenantId: event.tenantId,
        endpointId: endpoint.id,
        type: "healing_success",
        tenantEmail: "",
        endpointName: endpoint.name,
        eventId: event.id,
        details: { ruleId: rule.id, method, description: rule.description },
      })
      .catch((e) => logger.error("Failed to send healing notification", { error: e }));
  }
}

// ── Domain errors ─────────────────────────────────────────────────────────────

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

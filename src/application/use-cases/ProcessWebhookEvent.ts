// src/application/use-cases/ProcessWebhookEvent.ts
// Main orchestrator: receive → validate → heal → dispatch to ALL destinations

import { RawEvent } from "../../domain/events/entities/RawEvent.js";
import type { IEventRepository } from "../../domain/events/repositories/IEventRepository.js";
import type { IEndpointRepository } from "../../domain/events/repositories/IEndpointRepository.js";
import type {
  ITransformationRuleRepository,
  IRuleCache,
} from "../../domain/healing/repositories/ITransformationRuleRepository.js";
import type { ILLMService, IStorageService, ISandboxService } from "../ports/index.js";
import type { TenantInfraAdapter } from "../../infrastructure/adapters/database/TenantInfraAdapter.js";
import type { IncidentAlertOrchestrator } from "../../infrastructure/notifications/IncidentAlertOrchestrator.js";
import { TransformationRule } from "../../domain/healing/entities/TransformationRule.js";
import { OutputDispatcher } from "./OutputDispatcher.js";
import {
  generateId,
  hashFingerprint,
} from "../../infrastructure/utils/crypto.js";
import { createLogger } from "../../infrastructure/utils/logger.js";
import {
  encryptTenantPayload,
  TENANT_CRYPTO_INFO_DLQ_R2,
} from "../../infrastructure/utils/tenantIngestionCrypto.js";

const logger = createLogger("ProcessWebhookEvent");

/**
 * Default wall-clock cap for one webhook run. Must exceed Gemini 429 backoff (~45s+) plus
 * model inference, sandbox, and destination dispatch. Override with `WEBHOOK_PROCESSING_TIMEOUT_MS`.
 */
export const DEFAULT_GLOBAL_PROCESSING_TIMEOUT_MS = 180_000;

export type ProcessWebhookEventCommand = {
  eventId: string;
  tenantId: string;
  /** Ingesta HTTP pública (`POST /webhook/...`): usar slug. */
  endpointSlug?: string;
  /** Reinyección DLQ: preferir id para cargar el mismo endpoint aunque cambie el slug. */
  endpointId?: string;
  rawPayload: unknown;
  metadata: {
    contentType: string;
    headers: Record<string, string>;
    ipAddress?: string;
    userAgent?: string;
  };
  /** Origen del request HTTP o URN interno (reinyección DLQ); no se usa como URL de red. */
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
  private readonly processingTimeoutMs: number;

  constructor(
    private readonly eventRepo: IEventRepository,
    private readonly endpointRepo: IEndpointRepository,
    private readonly ruleRepo: ITransformationRuleRepository,
    private readonly ruleCache: IRuleCache,
    private readonly llmService: ILLMService,
    private readonly storageService: IStorageService,
    private readonly sandboxService: ISandboxService,
    private readonly outputDispatcher: OutputDispatcher,
    private readonly incidentAlerts: IncidentAlertOrchestrator,
    private readonly tenantInfra?: TenantInfraAdapter,
    private readonly ingestionSecretKey?: string,
    processingTimeoutMs?: number
  ) {
    this.processingTimeoutMs =
      processingTimeoutMs !== undefined
        ? Math.min(Math.max(processingTimeoutMs, 15_000), 300_000)
        : DEFAULT_GLOBAL_PROCESSING_TIMEOUT_MS;
  }

  async execute(
    command: ProcessWebhookEventCommand
  ): Promise<ProcessWebhookEventResult> {
    const capture: {
      event?: RawEvent;
      endpoint?: import("../../domain/events/entities/Endpoint.js").Endpoint;
    } = {};

    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(
        () => reject(new ProcessingTimeoutError()),
        this.processingTimeoutMs
      );
    });

    try {
      return await Promise.race([
        this.runProcessing(command, capture).finally(() => {
          if (timeoutId !== undefined) clearTimeout(timeoutId);
        }),
        timeoutPromise,
      ]);
    } catch (err) {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      if (err instanceof ProcessingTimeoutError) {
        if (capture.event && capture.endpoint) {
          logger.error("Global processing timeout, sending to DLQ", {
            eventId: capture.event.id,
            endpointId: capture.endpoint.id,
          });
          return await this.sendToDLQ(
            capture.event,
            capture.endpoint,
            "Global processing timeout exceeded"
          );
        }
        throw err;
      }
      throw err;
    }
  }

  /**
   * Core pipeline (validate → heal → dispatch). Used under a global timeout in {@link execute}.
   * After the raw event is persisted, {@link capture} is filled so a timeout can still DLQ.
   */
  private async runProcessing(
    command: ProcessWebhookEventCommand,
    capture: {
      event?: RawEvent;
      endpoint?: import("../../domain/events/entities/Endpoint.js").Endpoint;
    }
  ): Promise<ProcessWebhookEventResult> {
    logger.info("Processing webhook event", {
      eventId: command.eventId,
      tenantId: command.tenantId,
      endpointSlug: command.endpointSlug,
      endpointId: command.endpointId,
    });

    const processingStarted = Date.now();

    if (!command.endpointSlug && !command.endpointId) {
      throw new Error("ProcessWebhookEvent: endpointSlug or endpointId is required");
    }

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
    const endpoint = command.endpointId
      ? await this.endpointRepo.findById(command.endpointId)
      : await this.endpointRepo.findBySlug({
          tenantId: command.tenantId,
          slug: command.endpointSlug!,
        });

    if (!endpoint) {
      if (command.endpointId) {
        throw new Error(`Endpoint not found: ${command.endpointId}`);
      }
      throw new EndpointNotFoundError(command.endpointSlug!, command.tenantId);
    }
    if (endpoint.tenantId !== command.tenantId) {
      throw new Error("Endpoint tenant mismatch");
    }
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
    capture.event = event;
    capture.endpoint = endpoint;
    endpoint.incrementReceived();
    await this.endpointRepo.update(endpoint);

    // ── Step 3: Validate against schema ────────────────────────────────────
    const zodSchema = endpoint.buildZodSchema();
    const validationResult = zodSchema.safeParse(command.rawPayload);

    if (validationResult.success) {
      // ✅ Fast path — valid payload
      event.markAsValidated(validationResult.data);
      await this.eventRepo.updateStatus(event);
      return await this.dispatchAndFinalize(
        event,
        endpoint,
        validationResult.data,
        "loaded",
        processingStarted
      );
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
            await this.logAiDecision({
              tenantId: command.tenantId,
              endpoint,
              event,
              ruleId: rule.id,
              action: "rule_applied_cache",
              detail: { method: "cache_hit" },
            });

            endpoint.incrementHealed();
            await this.endpointRepo.update(endpoint);
            return await this.dispatchAndFinalize(
              event,
              endpoint,
              healedValidation.data,
              "healed",
              processingStarted
            );
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

    await this.logAiDecision({
      tenantId: command.tenantId,
      endpoint,
      event,
      ruleId: newRule.id,
      action: "rule_generated_llm",
      detail: { model: healingResult.modelUsed },
    });

    logger.info("Event healed via LLM", { eventId: event.id, ruleId: newRule.id });
    return await this.dispatchAndFinalize(
      event,
      endpoint,
      healedValidation.data,
      "healed",
      processingStarted
    );
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
    finalStatus: "loaded" | "healed",
    processingStarted: number
  ): Promise<ProcessWebhookEventResult> {
    logger.info("Dispatching to destinations", {
      eventId: event.id,
      destinationCount: endpoint.destinations.length,
    });

    if (endpoint.destinations.length === 0) {
      return await this.sendToDLQ(
        event,
        endpoint,
        "No destinations configured — add at least one outbound destination (e.g. webhook URL) for this endpoint"
      );
    }

    const d0 = Date.now();
    const dispatchResults = await this.outputDispatcher.dispatch(
      endpoint.destinations,
      payload
    );
    const dispatchMs = Date.now() - d0;

    await this.tenantInfra?.insertStageMetric({
      tenantId: event.tenantId,
      endpointId: endpoint.id,
      stage: "dispatch",
      latencyMs: dispatchMs,
    });
    await this.tenantInfra?.insertStageMetric({
      tenantId: event.tenantId,
      endpointId: endpoint.id,
      stage: "processing_total",
      latencyMs: Date.now() - processingStarted,
    });

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

    const snapshot = event.toSnapshot();
    const dlqBody =
      this.ingestionSecretKey != null && this.ingestionSecretKey !== ""
        ? {
            __sentinel_dlq_v1: await encryptTenantPayload(
              JSON.stringify(snapshot),
              this.ingestionSecretKey,
              event.tenantId,
              TENANT_CRYPTO_INFO_DLQ_R2
            ),
          }
        : snapshot;

    await this.storageService
      .store(`dlq/${event.tenantId}/${event.id}.json`, dlqBody)
      .catch((e) => logger.error("Failed to store DLQ payload", { error: e }));

    const rl = reason.toLowerCase();
    if (rl.includes("schema") || rl.includes("validation")) {
      await this.tenantInfra
        ?.upsertEventTag({
          tenantId: event.tenantId,
          eventId: event.id,
          tag: "esquema",
          source: "auto",
        })
        .catch(() => undefined);
    }
    if (rl.includes("destination") || rl.includes("webhook")) {
      await this.tenantInfra
        ?.upsertEventTag({
          tenantId: event.tenantId,
          eventId: event.id,
          tag: "destino",
          source: "auto",
        })
        .catch(() => undefined);
    }

    if (endpoint.healingConfig.notifyOnDead) {
      await this.incidentAlerts
        .dispatch({
          type: "dead_letter",
          kind: "dead_letter",
          tenantId: event.tenantId,
          endpointId: endpoint.id,
          endpointName: endpoint.name,
          eventId: event.id,
          environment: endpoint.environment,
          reason,
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
    await this.incidentAlerts
      .dispatch({
        tenantId: event.tenantId,
        endpointId: endpoint.id,
        type: "healing_success",
        kind: "healing_success",
        endpointName: endpoint.name,
        eventId: event.id,
        environment: endpoint.environment,
        details: { ruleId: rule.id, method, description: rule.description },
      })
      .catch((e) => logger.error("Failed to send healing notification", { error: e }));
  }

  private async logAiDecision(params: {
    tenantId: string;
    endpoint: import("../../domain/events/entities/Endpoint.js").Endpoint;
    event: RawEvent;
    ruleId: string;
    action: string;
    detail: Record<string, unknown>;
  }): Promise<void> {
    await this.tenantInfra?.insertAiDecisionLog({
      tenantId: params.tenantId,
      endpointId: params.endpoint.id,
      eventId: params.event.id,
      ruleId: params.ruleId,
      action: params.action,
      detail: params.detail,
      actor: "system",
    });
  }
}

// ── Domain errors ─────────────────────────────────────────────────────────────

/** Thrown when the webhook processing wall-clock budget elapses (see {@link ProcessWebhookEvent.execute}). */
export class ProcessingTimeoutError extends Error {
  constructor() {
    super("Processing timeout");
    this.name = "ProcessingTimeoutError";
  }
}

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

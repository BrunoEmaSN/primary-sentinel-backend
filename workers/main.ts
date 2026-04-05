// workers/main.ts
// Cloudflare Workers entry point — handles all HTTP requests and queue messages

import { handleRequest } from "../src/infrastructure/http/routes/index.js";
import type { WorkerEnv } from "../src/infrastructure/http/middleware/auth.js";
import { resetDependencies } from "../src/infrastructure/container.js";
import { createLogger } from "../src/infrastructure/utils/logger.js";

const logger = createLogger("Worker");

// ── HTTP Handler ─────────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
    // Reset DI container per request (Workers can reuse isolates)
    resetDependencies();

    const start = Date.now();
    const url = new URL(request.url);

    logger.info("Incoming request", {
      method: request.method,
      path: url.pathname,
      cf_ray: request.headers.get("CF-Ray") ?? undefined,
      ip: request.headers.get("CF-Connecting-IP") ?? undefined,
    });

    try {
      const response = await handleRequest(request, env);

      logger.info("Request completed", {
        method: request.method,
        path: url.pathname,
        status: response.status,
        durationMs: Date.now() - start,
      });

      // Add CORS headers to all responses
      const headers = new Headers(response.headers);
      headers.set("Access-Control-Allow-Origin", "*");
      headers.set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
      headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Sentinel-Signature, X-Event-ID");
      headers.set("X-Response-Time", `${Date.now() - start}ms`);

      return new Response(response.body, {
        status: response.status,
        headers,
      });
    } catch (error) {
      logger.error("Unhandled worker error", {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        path: url.pathname,
        durationMs: Date.now() - start,
      });

      return new Response(
        JSON.stringify({ error: "Internal server error", requestId: request.headers.get("CF-Ray") }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }
  },

  // ── Queue Consumer ──────────────────────────────────────────────────────────
  // Handles async event processing from Cloudflare Queues

  async queue(batch: MessageBatch<QueueBody>, env: WorkerEnv): Promise<void> {
    logger.info("Processing queue batch", { size: batch.messages.length });
    resetDependencies();

    for (const message of batch.messages) {
      try {
        const body = message.body;
        logger.info("Processing queue message", { action: body.action, eventId: body.eventId });

        // Re-process events that were queued for async handling
        // This is used for heavy LLM operations that exceed synchronous limits
        switch (body.action) {
          case "heal": {
            // Fetch the raw event and re-run healing pipeline
            // deps would be built here and ProcessWebhookEvent re-invoked
            logger.info("Async healing triggered", { eventId: body.eventId });
            break;
          }
          case "dlq": {
            logger.warn("DLQ item received via queue", { eventId: body.eventId });
            break;
          }
          default:
            logger.warn("Unknown queue action", { action: body.action });
        }

        message.ack();
      } catch (error) {
        logger.error("Queue message processing failed", {
          error: error instanceof Error ? error.message : String(error),
          messageId: message.id,
        });
        message.retry();
      }
    }
  },

  // ── Cron Triggers ──────────────────────────────────────────────────────────
  // Scheduled tasks: cleanup, rule evaluation, health reports

  async scheduled(event: ScheduledEvent, env: WorkerEnv, ctx: ExecutionContext): Promise<void> {
    logger.info("Cron triggered", { cron: event.cron });
    resetDependencies();

    ctx.waitUntil(
      (async () => {
        switch (event.cron) {
          // Daily: quarantine underperforming rules & send health digest
          case "0 9 * * *":
            logger.info("Running daily maintenance tasks");
            // quarantineUnderperformingRules(deps);
            // sendDailyDigest(deps);
            break;

          // Every 6 hours: cleanup stale "healing" events stuck > 1 hour
          case "0 */6 * * *":
            logger.info("Running cleanup tasks");
            break;

          default:
            logger.warn("Unknown cron schedule", { cron: event.cron });
        }
      })()
    );
  },
};

// ── Type definitions ──────────────────────────────────────────────────────────

type QueueBody = {
  eventId: string;
  tenantId: string;
  endpointId: string;
  action: "validate" | "heal" | "load" | "dlq";
};

interface MessageBatch<T> {
  readonly messages: Message<T>[];
  ackAll(): void;
  retryAll(): void;
}

interface Message<T> {
  readonly id: string;
  readonly body: T;
  ack(): void;
  retry(): void;
}

interface ScheduledEvent {
  readonly cron: string;
  readonly scheduledTime: number;
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

// workers/main.ts

import { handleRequest } from "../src/infrastructure/http/routes/index.js";
import type { WorkerEnv } from "../src/infrastructure/http/middleware/auth.js";
import { resetDependencies } from "../src/infrastructure/container.js";
import { createLogger } from "../src/infrastructure/utils/logger.js";

const logger = createLogger("Worker");

export default {
  async fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
    resetDependencies();

    const start = Date.now();
    const url = new URL(request.url);

    logger.info("Incoming request", {
      method: request.method,
      path: url.pathname,
      cf_ray: request.headers.get("CF-Ray") ?? undefined,
    });

    try {
      const response = await handleRequest(request, env);

      const headers = new Headers(response.headers);
      headers.set("Access-Control-Allow-Origin", "*");
      headers.set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
      headers.set("Access-Control-Allow-Headers",
        "Authorization, Content-Type, X-Sentinel-Signature, X-Event-ID");
      headers.set("X-Response-Time", `${Date.now() - start}ms`);

      logger.info("Request completed", {
        status: response.status,
        durationMs: Date.now() - start,
      });

      return new Response(response.body, { status: response.status, headers });
    } catch (error) {
      logger.error("Unhandled worker error", {
        error: error instanceof Error ? error.message : String(error),
        path: url.pathname,
      });
      return new Response(
        JSON.stringify({ error: "Internal server error" }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }
  },

  async scheduled(event: ScheduledEvent, env: WorkerEnv, ctx: ExecutionContext): Promise<void> {
    logger.info("Cron triggered", { cron: event.cron });
    resetDependencies();

    ctx.waitUntil(
      (async () => {
        switch (event.cron) {
          case "0 9 * * *":
            logger.info("Running daily maintenance tasks");
            break;
          case "0 */6 * * *":
            logger.info("Running cleanup tasks");
            break;
          default:
            logger.warn("Unknown cron", { cron: event.cron });
        }
      })()
    );
  },
};

interface ScheduledEvent {
  readonly cron: string;
  readonly scheduledTime: number;
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

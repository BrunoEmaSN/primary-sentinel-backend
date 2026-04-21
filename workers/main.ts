// workers/main.ts

import { handleRequest } from "../src/infrastructure/http/routes/index.js";
import type { WorkerEnv } from "../src/infrastructure/http/middleware/auth.js";
import { resetDependencies } from "../src/infrastructure/container.js";
import { createLogger } from "../src/infrastructure/utils/logger.js";
import {
  preflightResponse,
  withCors,
  jsonErrorWithCors,
} from "../src/infrastructure/http/cors.js";
import { resolveApiLocale } from "../src/infrastructure/http/i18n/apiLocale.js";
import { apiT } from "../src/infrastructure/http/i18n/apiMessages.js";

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
      if (request.method === "OPTIONS") {
        return preflightResponse(request, env);
      }

      const response = await handleRequest(request, env);
      const withCorsHeaders = withCors(response, request, env);
      const headers = new Headers(withCorsHeaders.headers);
      headers.set("X-Response-Time", `${Date.now() - start}ms`);

      logger.info("Request completed", {
        status: response.status,
        durationMs: Date.now() - start,
      });

      return new Response(withCorsHeaders.body, {
        status: withCorsHeaders.status,
        statusText: withCorsHeaders.statusText,
        headers,
      });
    } catch (error) {
      logger.error("Unhandled worker error", {
        error: error instanceof Error ? error.message : String(error),
        path: url.pathname,
      });
      return jsonErrorWithCors(
        request,
        { error: apiT(resolveApiLocale(request), "internalServerError") },
        500,
        env
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

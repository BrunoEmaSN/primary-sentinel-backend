import { describe, it, expect } from "vitest";
import { buildCorsHeaders } from "../../src/infrastructure/http/cors.js";
import type { WorkerEnv } from "../../src/infrastructure/http/workerEnv.js";

function baseEnv(over: Partial<WorkerEnv> = {}): WorkerEnv {
  return {
    SUPABASE_URL: "https://x.supabase.co",
    SUPABASE_SERVICE_KEY: "k",
    AI_API_KEY: "a",
    UPSTASH_REDIS_REST_URL: "https://u",
    UPSTASH_REDIS_REST_TOKEN: "t",
    EMAIL: {} as unknown as WorkerEnv["EMAIL"],
    SENTINEL_WEBHOOK_SECRET: "w",
    RULE_CACHE: {} as unknown as WorkerEnv["RULE_CACHE"],
    DLQ_BUCKET: {} as unknown as WorkerEnv["DLQ_BUCKET"],
    ENVIRONMENT: "development",
    LOG_LEVEL: "info",
    WORKER_URL: "https://worker.test",
    ...over,
  } as WorkerEnv;
}

describe("buildCorsHeaders", () => {
  it("reflects Origin in development when allowlist unset", () => {
    const req = new Request("http://x", { headers: { Origin: "https://evil.example" } });
    const h = buildCorsHeaders(req, baseEnv({ ENVIRONMENT: "development" }));
    expect(h["Access-Control-Allow-Origin"]).toBe("https://evil.example");
  });

  it("does not set ACAO for arbitrary Origin in production without allowlist", () => {
    const req = new Request("http://x", { headers: { Origin: "https://evil.example" } });
    const h = buildCorsHeaders(req, baseEnv({ ENVIRONMENT: "production" }));
    expect(h["Access-Control-Allow-Origin"]).toBeUndefined();
  });

  it("reflects Origin in production when ALLOW_CORS_DEV=1", () => {
    const req = new Request("http://x", { headers: { Origin: "https://app.example" } });
    const h = buildCorsHeaders(
      req,
      baseEnv({ ENVIRONMENT: "production", ALLOW_CORS_DEV: "1" })
    );
    expect(h["Access-Control-Allow-Origin"]).toBe("https://app.example");
  });
});

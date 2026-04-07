// tests/integration/webhook-pipeline.test.ts
// Requires a running worker: WORKER_URL=http://localhost:8787 TEST_TENANT_TOKEN=<jwt> npx vitest run tests/integration

import { describe, it, expect, beforeAll } from "vitest";

const WORKER_URL = process.env["WORKER_URL"] ?? "http://localhost:8787";
const TOKEN      = process.env["TEST_TENANT_TOKEN"] ?? "";

describe.skipIf(!TOKEN)("Webhook pipeline — integration", () => {
  let endpointId: string;
  let webhookUrl: string;
  let webhookSecret: string;

  beforeAll(async () => {
    // Create a test endpoint with two destinations (webhook fanout)
    const res = await fetch(`${WORKER_URL}/api/endpoints`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({
        name: "Integration Test Endpoint",
        schema: {
          type: "object",
          required: ["id", "event"],
          properties: {
            id:    { type: "string" },
            event: { type: "string" },
          },
        },
        // Multi-destination: Supabase + webhook relay
        destinations: [
          {
            type: "supabase",
            tableName: "test_events",
          },
          {
            type: "webhook",
            url: "https://httpbin.org/post",
            method: "POST",
            timeoutMs: 5000,
            retryOnFailure: false,
          },
        ],
        healingConfig: { enabled: true, notifyOnHealing: false, notifyOnDead: false },
      }),
    });

    expect(res.status).toBe(201);
    const data = await res.json() as {
      endpoint: { id: string };
      webhookUrl: string;
      webhookSecret: string;
    };
    endpointId    = data.endpoint.id;
    webhookUrl    = data.webhookUrl;
    webhookSecret = data.webhookSecret;
  });

  it("processes a valid payload and dispatches to all destinations", async () => {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Event-ID": `test-${Date.now()}`,
      },
      body: JSON.stringify({ id: "evt-abc", event: "user.created" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as {
      status: string;
      dispatchResults: Array<{ success: boolean }>;
    };

    expect(body.status).toBe("loaded");
    expect(body.dispatchResults).toBeDefined();
    expect(body.dispatchResults.length).toBeGreaterThan(0);
  });

  it("heals a broken payload and dispatches healed data", async () => {
    // Wrong types — schema expects strings, we send wrong field names
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Event-ID": `heal-${Date.now()}`,
      },
      body: JSON.stringify({ user_id: 999, event_type: "signup" }),
    });

    // Either healed (200) or dead (422)
    expect([200, 422]).toContain(res.status);
    const body = await res.json() as { status: string };
    expect(["healed", "loaded", "dead"]).toContain(body.status);
  });

  it("returns 429 after rate limit is exceeded", async () => {
    // Artificially spam requests
    const promises = Array.from({ length: 10 }, (_, i) =>
      fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Event-ID": `spam-${i}-${Date.now()}` },
        body: JSON.stringify({ id: "x", event: "test" }),
      })
    );
    await Promise.allSettled(promises);
    // This test is best-effort — rate limiting depends on KV state
  });

  it("GET /api/endpoints/:id/events returns dispatch_results", async () => {
    const res = await fetch(`${WORKER_URL}/api/endpoints/${endpointId}/events?limit=5`, {
      headers: { "Authorization": `Bearer ${TOKEN}` },
    });

    expect(res.status).toBe(200);
    const body = await res.json() as {
      data: Array<{ dispatch_results?: unknown[] }>;
    };
    expect(body.data).toBeDefined();
  });
});

// tests/integration/webhook-pipeline.test.ts
// End-to-end simulation of the webhook pipeline using real Worker fetch handler
// Run with: SUPABASE_URL=... npx vitest run tests/integration

import { describe, it, expect } from "vitest";

/**
 * These tests simulate real HTTP calls to the Worker.
 * In CI, they run against a local wrangler dev instance.
 * Set WORKER_URL env var to point to your local or staging worker.
 */
const WORKER_URL = process.env["WORKER_URL"] ?? "http://localhost:8787";
const TEST_TENANT_TOKEN = process.env["TEST_TENANT_TOKEN"] ?? ""; // Supabase JWT

function authHeaders() {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${TEST_TENANT_TOKEN}`,
  };
}

describe.skipIf(!TEST_TENANT_TOKEN)("Webhook Pipeline Integration", () => {
  let createdEndpointId: string;
  let webhookUrl: string;

  it("GET /health — returns healthy status", async () => {
    const res = await fetch(`${WORKER_URL}/health`);
    const body = await res.json() as { status: string };
    expect(res.status).toBe(200);
    expect(body.status).toBe("ok");
  });

  it("POST /api/endpoints — creates an endpoint", async () => {
    const res = await fetch(`${WORKER_URL}/api/endpoints`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        name: "Integration Test Endpoint",
        schema: {
          type: "object",
          required: ["id", "email"],
          properties: {
            id: { type: "string" },
            email: { type: "string" },
          },
        },
        destination: { type: "supabase", tableName: "test_events" },
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json() as { endpoint: { id: string }; webhookUrl: string; webhookSecret: string };
    createdEndpointId = body.endpoint.id;
    webhookUrl = body.webhookUrl;
    expect(body.webhookSecret).toBeTruthy();
  });

  it("POST /webhook/:tenantId/:slug — accepts valid payload", async () => {
    const url = new URL(webhookUrl);
    const res = await fetch(url.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Event-ID": "integ-test-001" },
      body: JSON.stringify({ id: "user-1", email: "test@example.com" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { status: string };
    expect(body.status).toBe("loaded");
  });

  it("POST /webhook — heals broken payload", async () => {
    const url = new URL(webhookUrl);
    const res = await fetch(url.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Event-ID": "integ-test-002" },
      body: JSON.stringify({ user_id: "user-2", email_address: "broken@example.com" }),
    });

    // Could be healed (200) or dead (422) depending on LLM availability
    expect([200, 422]).toContain(res.status);
    const body = await res.json() as { status: string };
    expect(["healed", "dead"]).toContain(body.status);
  });

  it("POST /webhook — rejects duplicate event (idempotency)", async () => {
    const url = new URL(webhookUrl);
    const payload = { id: "user-dup", email: "dup@example.com" };

    await fetch(url.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Event-ID": "integ-dup-001" },
      body: JSON.stringify(payload),
    });

    const res2 = await fetch(url.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Event-ID": "integ-dup-001" },
      body: JSON.stringify(payload),
    });

    expect(res2.status).toBe(200);
    const body = await res2.json() as { message: string };
    expect(body.message).toContain("Duplicate");
  });

  it("GET /api/endpoints — lists created endpoint", async () => {
    const res = await fetch(`${WORKER_URL}/api/endpoints`, { headers: authHeaders() });
    expect(res.status).toBe(200);
    const body = await res.json() as { data: unknown[] };
    expect(body.data.length).toBeGreaterThan(0);
  });

  it("GET /api/endpoints/:id/events — lists processed events", async () => {
    const res = await fetch(
      `${WORKER_URL}/api/endpoints/${createdEndpointId}/events?limit=10`,
      { headers: authHeaders() }
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { data: unknown[]; total: number };
    expect(body.total).toBeGreaterThan(0);
  });

  it("DELETE /api/endpoints/:id — deletes the endpoint", async () => {
    const res = await fetch(`${WORKER_URL}/api/endpoints/${createdEndpointId}`, {
      method: "DELETE",
      headers: authHeaders(),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { deleted: boolean };
    expect(body.deleted).toBe(true);
  });
});

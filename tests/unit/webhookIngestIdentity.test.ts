import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveIngestEventId } from "../../src/infrastructure/http/webhookIngestIdentity.js";

function headersFrom(init: Record<string, string>): Headers {
  const h = new Headers();
  for (const [k, v] of Object.entries(init)) h.set(k, v);
  return h;
}

describe("resolveIngestEventId", () => {
  const gen = vi.fn(() => "generated-uuid");

  beforeEach(() => {
    gen.mockClear();
  });

  it("usa X-Request-ID cuando no hay X-Event-ID ni X-Idempotency-Key", () => {
    const id = resolveIngestEventId({
      tenantId: "t1",
      endpointSlug: "pay",
      headers: headersFrom({ "X-Request-ID": "req-abc-7" }),
      rawPayload: { id: "body-should-not-win" },
      generateId: gen,
    });
    expect(id).toBe("req-abc-7");
    expect(gen).not.toHaveBeenCalled();
  });

  it("prioridad: X-Event-ID > X-Idempotency-Key > X-Request-ID", () => {
    const h = headersFrom({
      "X-Event-ID": "evt-first",
      "X-Idempotency-Key": "idem-second",
      "X-Request-ID": "req-third",
    });
    expect(
      resolveIngestEventId({
        tenantId: "t",
        endpointSlug: "s",
        headers: h,
        rawPayload: {},
        generateId: gen,
      })
    ).toBe("evt-first");
  });

  it("sin headers, usa id del JSON con prefijo tenant:slug", () => {
    const id = resolveIngestEventId({
      tenantId: "tenant-uuid",
      endpointSlug: "stripe",
      headers: new Headers(),
      rawPayload: { id: "evt_123", type: "x" },
      generateId: gen,
    });
    expect(id).toBe("tenant-uuid:stripe:evt_123");
    expect(gen).not.toHaveBeenCalled();
  });

  it("sin headers ni id en cuerpo, genera UUID", () => {
    const id = resolveIngestEventId({
      tenantId: "t",
      endpointSlug: "s",
      headers: new Headers(),
      rawPayload: { foo: 1 },
      generateId: gen,
    });
    expect(id).toBe("generated-uuid");
    expect(gen).toHaveBeenCalledOnce();
  });
});

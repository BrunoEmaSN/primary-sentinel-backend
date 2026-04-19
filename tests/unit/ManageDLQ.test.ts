// tests/unit/ManageDLQ.test.ts

import { describe, it, expect, vi, beforeEach } from "vitest";
import { ReinjectDlqEvent } from "../../src/application/use-cases/ManageDLQ.js";
import { RawEvent } from "../../src/domain/events/entities/RawEvent.js";
import { Endpoint } from "../../src/domain/events/entities/Endpoint.js";
import { EVENT_ORIGIN_REINJECT_DLQ } from "../../src/domain/events/internalOrigins.js";

describe("ReinjectDlqEvent", () => {
  const endpoint = Endpoint.create({
    id: "ep-1",
    tenantId: "t1",
    name: "E",
    slug: "e",
    schema: {
      type: "object",
      required: ["id"],
      properties: { id: { type: "string" } },
    },
    destinations: [
      {
        type: "webhook",
        url: "https://example.com/h",
        method: "POST" as const,
        retryOnFailure: false,
        timeoutMs: 5000,
      },
    ],
    webhookSecret: "s",
  });

  let processExecute: ReturnType<typeof vi.fn>;
  let eventRepo: { findById: ReturnType<typeof vi.fn>; deleteById: ReturnType<typeof vi.fn> };
  let endpointRepo: { findById: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    processExecute = vi.fn().mockResolvedValue({
      eventId: "new-ev",
      status: "loaded",
      message: "ok",
    });
    eventRepo = {
      findById: vi.fn(),
      deleteById: vi.fn().mockResolvedValue(undefined),
    };
    endpointRepo = {
      findById: vi.fn().mockResolvedValue(endpoint),
    };
  });

  function deadEvent(overrides: {
    rawPayload: unknown;
    validatedPayload: unknown | null;
  }) {
    return RawEvent.reconstitute({
      id: "dlq-1",
      tenantId: "t1",
      endpointId: "ep-1",
      rawPayload: overrides.rawPayload,
      source: {
        tenantId: "t1",
        endpointId: "ep-1",
        origin: "test",
        receivedAt: new Date(),
      },
      metadata: { contentType: "application/json", headers: {} },
      status: "dead",
      validatedPayload: overrides.validatedPayload,
      healingAttempts: 0,
      errorLog: ["[test] FATAL: All destinations failed"],
      transformationRuleId: null,
      dispatchResults: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }

  it("reinject uses validatedPayload when present so dispatch path receives schema-valid data", async () => {
    const rawBroken = { junk: true };
    const validated = { id: "ok" };
    eventRepo.findById.mockResolvedValue(
      deadEvent({ rawPayload: rawBroken, validatedPayload: validated })
    );

    const uc = new ReinjectDlqEvent(
      eventRepo as never,
      endpointRepo as never,
      { execute: processExecute } as never,
      undefined
    );

    await uc.execute({
      tenantId: "t1",
      eventId: "dlq-1",
      actorEmail: "a@b.co",
    });

    expect(processExecute).toHaveBeenCalledTimes(1);
    const cmd = processExecute.mock.calls[0]![0] as {
      rawPayload: unknown;
      origin: string;
    };
    expect(cmd.rawPayload).toEqual(validated);
    expect(cmd.rawPayload).not.toEqual(rawBroken);
    expect(cmd.origin).toBe(EVENT_ORIGIN_REINJECT_DLQ);
  });

  it("reinject falls back to rawPayload when validatedPayload is null", async () => {
    const raw = { id: "only-raw" };
    eventRepo.findById.mockResolvedValue(
      deadEvent({ rawPayload: raw, validatedPayload: null })
    );

    const uc = new ReinjectDlqEvent(
      eventRepo as never,
      endpointRepo as never,
      { execute: processExecute } as never,
      undefined
    );

    await uc.execute({ tenantId: "t1", eventId: "dlq-1", actorEmail: "a@b.co" });

    expect(processExecute.mock.calls[0]![0].rawPayload).toEqual(raw);
  });

  it("correctedPayload overrides validated and raw", async () => {
    eventRepo.findById.mockResolvedValue(
      deadEvent({
        rawPayload: { id: "a" },
        validatedPayload: { id: "b" },
      })
    );

    const uc = new ReinjectDlqEvent(
      eventRepo as never,
      endpointRepo as never,
      { execute: processExecute } as never,
      undefined
    );

    const corrected = { id: "c" };
    await uc.execute({
      tenantId: "t1",
      eventId: "dlq-1",
      correctedPayload: corrected,
      actorEmail: "a@b.co",
    });

    expect(processExecute.mock.calls[0]![0].rawPayload).toEqual(corrected);
  });
});

// tests/unit/ProcessWebhookEvent.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ProcessWebhookEvent } from "../../src/application/use-cases/ProcessWebhookEvent.js";
import { RawEvent } from "../../src/domain/events/entities/RawEvent.js";
import { Endpoint } from "../../src/domain/events/entities/Endpoint.js";
import { TransformationRule } from "../../src/domain/healing/entities/TransformationRule.js";

// ── Mock factories ────────────────────────────────────────────────────────────

function makeEndpoint(overrides = {}) {
  return Endpoint.create({
    id: "ep-001",
    tenantId: "tenant-001",
    name: "Test Endpoint",
    slug: "test-endpoint",
    schema: {
      type: "object",
      required: ["id", "name", "email"],
      properties: {
        id: { type: "string" },
        name: { type: "string" },
        email: { type: "string" },
      },
    },
    destination: { type: "supabase", tableName: "test_events" },
    webhookSecret: "secret-abc",
    ...overrides,
  });
}

function makeCommand(payload: unknown = { id: "1", name: "Alice", email: "a@b.com" }) {
  return {
    eventId: "evt-001",
    tenantId: "tenant-001",
    endpointSlug: "test-endpoint",
    rawPayload: payload,
    metadata: {
      contentType: "application/json",
      headers: {},
    },
    origin: "https://example.com",
  };
}

function makeMocks() {
  return {
    eventRepo: {
      save: vi.fn().mockResolvedValue(undefined),
      findById: vi.fn().mockResolvedValue(null),
      findByTenantAndEndpoint: vi.fn().mockResolvedValue({ events: [], total: 0 }),
      updateStatus: vi.fn().mockResolvedValue(undefined),
      existsById: vi.fn().mockResolvedValue(false),
    },
    endpointRepo: {
      save: vi.fn().mockResolvedValue(undefined),
      findById: vi.fn().mockResolvedValue(null),
      findBySlug: vi.fn().mockResolvedValue(makeEndpoint()),
      findByTenantId: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
    },
    ruleRepo: {
      save: vi.fn().mockResolvedValue(undefined),
      findByFingerprint: vi.fn().mockResolvedValue(null),
      findById: vi.fn().mockResolvedValue(null),
      findByEndpoint: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockResolvedValue(undefined),
    },
    ruleCache: {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue(undefined),
      invalidate: vi.fn().mockResolvedValue(undefined),
    },
    llmService: {
      generateTransformationScript: vi.fn().mockResolvedValue({
        success: true,
        script: "return { id: input.user_id, name: input.full_name, email: input.email_address };",
        description: "Maps legacy fields to standard schema",
        language: "javascript",
        confidence: 0.95,
        modelUsed: "claude-sonnet-4-20250514",
      }),
    },
    queueService: {
      enqueue: vi.fn().mockResolvedValue(undefined),
      enqueueBatch: vi.fn().mockResolvedValue(undefined),
    },
    storageService: {
      store: vi.fn().mockResolvedValue("dlq/tenant-001/evt-001.json"),
      retrieve: vi.fn().mockResolvedValue(null),
      delete: vi.fn().mockResolvedValue(undefined),
    },
    notificationService: {
      send: vi.fn().mockResolvedValue(undefined),
    },
    sandboxService: {
      execute: vi.fn().mockResolvedValue({
        success: true,
        output: { id: "1", name: "Alice", email: "alice@example.com" },
        executionTimeMs: 12,
      }),
    },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("ProcessWebhookEvent", () => {
  let mocks: ReturnType<typeof makeMocks>;

  beforeEach(() => {
    mocks = makeMocks();
  });

  function buildUseCase() {
    return new ProcessWebhookEvent(
      mocks.eventRepo as never,
      mocks.endpointRepo as never,
      mocks.ruleRepo as never,
      mocks.ruleCache as never,
      mocks.llmService as never,
      mocks.queueService as never,
      mocks.storageService as never,
      mocks.notificationService as never,
      mocks.sandboxService as never
    );
  }

  describe("Happy path — valid payload", () => {
    it("should save, validate, and load a valid event", async () => {
      const useCase = buildUseCase();
      const result = await useCase.execute(makeCommand());

      expect(result.status).toBe("loaded");
      expect(mocks.eventRepo.save).toHaveBeenCalledOnce();
      expect(mocks.eventRepo.updateStatus).toHaveBeenCalled();
      expect(mocks.llmService.generateTransformationScript).not.toHaveBeenCalled();
    });
  });

  describe("Idempotency", () => {
    it("should skip duplicate events", async () => {
      mocks.eventRepo.existsById.mockResolvedValue(true);
      const useCase = buildUseCase();
      const result = await useCase.execute(makeCommand());

      expect(result.status).toBe("loaded");
      expect(mocks.eventRepo.save).not.toHaveBeenCalled();
    });
  });

  describe("HealingAgent — LLM path", () => {
    it("should call LLM and heal a broken payload", async () => {
      const brokenPayload = { user_id: "1", full_name: "Alice", email_address: "alice@example.com" };
      const useCase = buildUseCase();
      const result = await useCase.execute(makeCommand(brokenPayload));

      expect(result.status).toBe("healed");
      expect(mocks.llmService.generateTransformationScript).toHaveBeenCalledOnce();
      expect(mocks.sandboxService.execute).toHaveBeenCalled();
      expect(mocks.ruleRepo.save).toHaveBeenCalledOnce();
      expect(mocks.ruleCache.set).toHaveBeenCalledOnce();
    });

    it("should use cached rule if available", async () => {
      mocks.ruleCache.get.mockResolvedValue("rule-cached-id");
      const cachedRule = TransformationRule.create({
        id: "rule-cached-id",
        tenantId: "tenant-001",
        endpointId: "ep-001",
        schemaVersion: "1",
        errorFingerprint: "abc123",
        language: "javascript",
        script: "return { id: input.user_id, name: input.full_name, email: input.email_address };",
        description: "Cached rule",
        generatedBy: "claude-sonnet-4-20250514",
      });
      mocks.ruleRepo.findById.mockResolvedValue(cachedRule);

      const brokenPayload = { user_id: "1", full_name: "Alice", email_address: "alice@example.com" };
      const useCase = buildUseCase();
      const result = await useCase.execute(makeCommand(brokenPayload));

      expect(result.status).toBe("healed");
      expect(mocks.llmService.generateTransformationScript).not.toHaveBeenCalled();
      expect(result.message).toContain("cached");
    });

    it("should send to DLQ if LLM throws", async () => {
      mocks.llmService.generateTransformationScript.mockRejectedValue(
        new Error("Anthropic API rate limited")
      );

      const brokenPayload = { wrong_field: "data" };
      const useCase = buildUseCase();
      const result = await useCase.execute(makeCommand(brokenPayload));

      expect(result.status).toBe("dead");
      expect(mocks.storageService.store).toHaveBeenCalledOnce();
    });

    it("should send to DLQ if sandbox output is still invalid", async () => {
      mocks.sandboxService.execute.mockResolvedValue({
        success: true,
        output: { wrong: "output" }, // still invalid after transformation
        executionTimeMs: 5,
      });

      const brokenPayload = { wrong_field: "data" };
      const useCase = buildUseCase();
      const result = await useCase.execute(makeCommand(brokenPayload));

      expect(result.status).toBe("dead");
    });

    it("should send to DLQ if healing is disabled", async () => {
      mocks.endpointRepo.findBySlug.mockResolvedValue(
        makeEndpoint({ healingConfig: { enabled: false } })
      );

      const brokenPayload = { wrong_field: "data" };
      const useCase = buildUseCase();
      const result = await useCase.execute(makeCommand(brokenPayload));

      expect(result.status).toBe("dead");
      expect(mocks.llmService.generateTransformationScript).not.toHaveBeenCalled();
    });
  });

  describe("Error cases", () => {
    it("should throw if endpoint not found", async () => {
      mocks.endpointRepo.findBySlug.mockResolvedValue(null);
      const useCase = buildUseCase();
      await expect(useCase.execute(makeCommand())).rejects.toThrow("EndpointNotFoundError");
    });
  });
});

// ── Domain entity tests ───────────────────────────────────────────────────────

describe("RawEvent", () => {
  it("should transition through lifecycle correctly", () => {
    const event = RawEvent.create({
      id: "evt-1",
      tenantId: "t1",
      endpointId: "ep-1",
      rawPayload: { foo: "bar" },
      source: { tenantId: "t1", endpointId: "ep-1", origin: "test", receivedAt: new Date() },
      metadata: { contentType: "application/json", headers: {} },
    });

    expect(event.status).toBe("received");

    event.markAsValidated({ foo: "bar" });
    expect(event.status).toBe("validated");

    event.markAsLoaded();
    expect(event.status).toBe("loaded");
  });

  it("should track healing attempts", () => {
    const event = RawEvent.create({
      id: "evt-2",
      tenantId: "t1",
      endpointId: "ep-1",
      rawPayload: {},
      source: { tenantId: "t1", endpointId: "ep-1", origin: "test", receivedAt: new Date() },
      metadata: { contentType: "application/json", headers: {} },
    });

    expect(event.canAttemptHealing(3)).toBe(true);
    event.markAsHealing();
    event.markAsHealing();
    event.markAsHealing();
    expect(event.canAttemptHealing(3)).toBe(false);
  });
});

describe("TransformationRule", () => {
  it("should auto-quarantine on low success rate", () => {
    const rule = TransformationRule.create({
      id: "r1",
      tenantId: "t1",
      endpointId: "ep-1",
      schemaVersion: "1",
      errorFingerprint: "abc",
      language: "javascript",
      script: "return input;",
      description: "test",
      generatedBy: "claude",
    });

    // Simulate 10 failures, 2 successes (< 30% success rate)
    for (let i = 0; i < 8; i++) rule.recordFailure();
    for (let i = 0; i < 2; i++) rule.recordSuccess();

    expect(rule.status).toBe("quarantined");
  });
});

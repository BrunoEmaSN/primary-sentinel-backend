// tests/unit/ProcessWebhookEvent.test.ts

import { describe, it, expect, vi, beforeEach } from "vitest";
import { ProcessWebhookEvent } from "../../src/application/use-cases/ProcessWebhookEvent.js";
import { Endpoint } from "../../src/domain/events/entities/Endpoint.js";
import type { Destination } from "../../src/domain/events/entities/Endpoint.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeEndpoint(destinations: Destination[]): Endpoint {
  return Endpoint.create({
    id: "ep-001",
    tenantId: "tenant-001",
    name: "Test Endpoint",
    slug: "test-endpoint",
    schema: {
      type: "object",
      required: ["id", "name"],
      properties: {
        id:   { type: "string" },
        name: { type: "string" },
      },
    },
    destinations,
    webhookSecret: "secret",
  });
}

function makeDeps() {
  const endpoint = makeEndpoint([
    {
      type: "webhook",
      url: "https://example.com/hook",
      method: "POST" as const,
      retryOnFailure: false,
      timeoutMs: 5000,
    },
  ]);

  const eventRepo = {
    save: vi.fn().mockResolvedValue(undefined),
    findById: vi.fn().mockResolvedValue(null),
    findByTenantAndEndpoint: vi.fn().mockResolvedValue({ events: [], total: 0 }),
    updateStatus: vi.fn().mockResolvedValue(undefined),
    existsById: vi.fn().mockResolvedValue(false),
    deleteById: vi.fn().mockResolvedValue(undefined),
  };

  const endpointRepo = {
    save: vi.fn().mockResolvedValue(undefined),
    findById: vi.fn().mockResolvedValue(endpoint),
    findBySlug: vi.fn().mockResolvedValue(endpoint),
    findByTenantId: vi.fn().mockResolvedValue([endpoint]),
    update: vi.fn().mockResolvedValue(undefined),
    updateFull: vi.fn().mockResolvedValue(undefined),
    countActiveByTenant: vi.fn().mockResolvedValue(0),
    delete: vi.fn().mockResolvedValue(undefined),
  };

  const ruleRepo = {
    save: vi.fn().mockResolvedValue(undefined),
    findByFingerprint: vi.fn().mockResolvedValue(null),
    findById: vi.fn().mockResolvedValue(null),
    findByEndpoint: vi.fn().mockResolvedValue([]),
    update: vi.fn().mockResolvedValue(undefined),
  };

  const ruleCache = {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
    invalidate: vi.fn().mockResolvedValue(undefined),
  };

  const llmService = {
    generateTransformationScript: vi.fn().mockResolvedValue({
      success: true,
      script: "return { id: String(input.user_id), name: input.full_name };",
      description: "Maps user_id → id and full_name → name",
      language: "javascript",
      confidence: 0.95,
      modelUsed: "claude-sonnet-4-20250514",
    }),
  };

  const storageService = {
    store: vi.fn().mockResolvedValue("key"),
    retrieve: vi.fn().mockResolvedValue(null),
    delete: vi.fn().mockResolvedValue(undefined),
  };

  const incidentAlerts = {
    dispatch: vi.fn().mockResolvedValue(undefined),
  };

  const sandboxService = {
    execute: vi.fn().mockResolvedValue({
      success: true,
      output: { id: "123", name: "Alice" },
      executionTimeMs: 10,
    }),
  };

  const outputDispatcher = {
    dispatch: vi.fn().mockResolvedValue([
      {
        destinationType: "webhook",
        destinationIndex: 0,
        success: true,
        durationMs: 42,
      },
    ]),
  };

  return {
    eventRepo, endpointRepo, ruleRepo, ruleCache,
    llmService, storageService, incidentAlerts,
    sandboxService, outputDispatcher, endpoint,
  };
}

function createProcessWebhook(deps: ReturnType<typeof makeDeps>) {
  return new ProcessWebhookEvent(
    deps.eventRepo,
    deps.endpointRepo,
    deps.ruleRepo,
    deps.ruleCache,
    deps.llmService,
    deps.storageService,
    deps.sandboxService,
    deps.outputDispatcher as never,
    deps.incidentAlerts as never,
    undefined
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("ProcessWebhookEvent", () => {
  describe("valid payload — fast path", () => {
    it("validates, dispatches, returns loaded status", async () => {
      const deps = makeDeps();
      const useCase = createProcessWebhook(deps);

      const result = await useCase.execute({
        eventId: "evt-001",
        tenantId: "tenant-001",
        endpointSlug: "test-endpoint",
        rawPayload: { id: "123", name: "Alice" },
        metadata: { contentType: "application/json", headers: {} },
        origin: "https://example.com",
      });

      expect(result.status).toBe("loaded");
      expect(result.eventId).toBe("evt-001");
      expect(deps.outputDispatcher.dispatch).toHaveBeenCalledOnce();
      expect(deps.outputDispatcher.dispatch).toHaveBeenCalledWith(
        deps.endpoint.destinations,
        expect.objectContaining({ id: "123", name: "Alice" })
      );
      expect(result.dispatchResults).toHaveLength(1);
      expect(result.dispatchResults![0]!.success).toBe(true);
    });

    it("sends to DLQ when global processing timeout is exceeded", async () => {
      vi.useFakeTimers();
      const deps = makeDeps();
      let finishDispatch: () => void = () => {};
      deps.outputDispatcher.dispatch = vi.fn(
        () =>
          new Promise((resolve) => {
            finishDispatch = () =>
              resolve([
                {
                  destinationType: "webhook",
                  destinationIndex: 0,
                  success: true,
                  durationMs: 1,
                },
              ]);
          })
      );

      const useCase = createProcessWebhook(deps);
      const execPromise = useCase.execute({
        eventId: "evt-global-timeout",
        tenantId: "tenant-001",
        endpointSlug: "test-endpoint",
        rawPayload: { id: "123", name: "Alice" },
        metadata: { contentType: "application/json", headers: {} },
        origin: "https://example.com",
      });

      await vi.advanceTimersByTimeAsync(28_000);
      const result = await execPromise;

      expect(result.status).toBe("dead");
      expect(result.message).toContain("Global processing timeout exceeded");
      expect(deps.storageService.store).toHaveBeenCalled();

      finishDispatch();
      vi.useRealTimers();
    });

    it("skips duplicate events (idempotency)", async () => {
      const deps = makeDeps();
      deps.eventRepo.existsById = vi.fn().mockResolvedValue(true);

      const useCase = createProcessWebhook(deps);

      const result = await useCase.execute({
        eventId: "evt-dup",
        tenantId: "tenant-001",
        endpointSlug: "test-endpoint",
        rawPayload: {},
        metadata: { contentType: "application/json", headers: {} },
        origin: "https://example.com",
      });

      expect(result.status).toBe("loaded");
      expect(result.message).toContain("Duplicate");
      expect(deps.outputDispatcher.dispatch).not.toHaveBeenCalled();
    });
  });

  describe("invalid payload — healing path", () => {
    it("calls LLM, runs sandbox, dispatches healed payload", async () => {
      const deps = makeDeps();
      const useCase = createProcessWebhook(deps);

      const result = await useCase.execute({
        eventId: "evt-heal",
        tenantId: "tenant-001",
        endpointSlug: "test-endpoint",
        rawPayload: { user_id: 123, full_name: "Alice" }, // wrong types
        metadata: { contentType: "application/json", headers: {} },
        origin: "https://example.com",
      });

      expect(result.status).toBe("healed");
      expect(deps.llmService.generateTransformationScript).toHaveBeenCalledOnce();
      expect(deps.sandboxService.execute).toHaveBeenCalledOnce();
      expect(deps.outputDispatcher.dispatch).toHaveBeenCalledOnce();
    });

    it("sends to DLQ when all destinations fail", async () => {
      const deps = makeDeps();
      deps.outputDispatcher.dispatch = vi.fn().mockResolvedValue([
        {
          destinationType: "webhook",
          destinationIndex: 0,
          success: false,
          error: "Connection refused",
          durationMs: 10,
        },
      ]);

      const useCase = createProcessWebhook(deps);

      const result = await useCase.execute({
        eventId: "evt-fail",
        tenantId: "tenant-001",
        endpointSlug: "test-endpoint",
        rawPayload: { id: "valid", name: "Alice" },
        metadata: { contentType: "application/json", headers: {} },
        origin: "https://example.com",
      });

      expect(result.status).toBe("dead");
      expect(deps.storageService.store).toHaveBeenCalledOnce();
    });

    it("sends to DLQ when healing is disabled", async () => {
      const endpointNoHealing = Endpoint.create({
        id: "ep-002",
        tenantId: "tenant-001",
        name: "No Healing",
        slug: "no-healing",
        schema: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
        destinations: [{ type: "webhook", url: "https://example.com", method: "POST", retryOnFailure: false, timeoutMs: 5000 }],
        healingConfig: { enabled: false, maxAttempts: 3, autoApplyRules: false, notifyOnHealing: false, notifyOnDead: false },
        webhookSecret: "sec",
      });

      const deps = makeDeps();
      deps.endpointRepo.findBySlug = vi.fn().mockResolvedValue(endpointNoHealing);

      const useCase = createProcessWebhook(deps);

      const result = await useCase.execute({
        eventId: "evt-nodlq",
        tenantId: "tenant-001",
        endpointSlug: "no-healing",
        rawPayload: { wrong_field: "oops" },
        metadata: { contentType: "application/json", headers: {} },
        origin: "https://example.com",
      });

      expect(result.status).toBe("dead");
      expect(result.message).toContain("Healing disabled");
      expect(deps.llmService.generateTransformationScript).not.toHaveBeenCalled();
    });
  });

  describe("fanout — partial success", () => {
    it("marks event as loaded even if one of multiple destinations fails", async () => {
      const endpointMulti = Endpoint.create({
        id: "ep-multi",
        tenantId: "tenant-001",
        name: "Multi Dest",
        slug: "multi-dest",
        schema: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
        destinations: [
          { type: "webhook", url: "https://good.example.com", method: "POST", retryOnFailure: false, timeoutMs: 5000 },
          { type: "webhook", url: "https://bad.example.com",  method: "POST", retryOnFailure: false, timeoutMs: 5000 },
        ],
        webhookSecret: "sec",
      });

      const deps = makeDeps();
      deps.endpointRepo.findBySlug = vi.fn().mockResolvedValue(endpointMulti);
      deps.outputDispatcher.dispatch = vi.fn().mockResolvedValue([
        { destinationType: "webhook", destinationIndex: 0, success: true,  durationMs: 20 },
        { destinationType: "webhook", destinationIndex: 1, success: false, error: "timeout", durationMs: 5000 },
      ]);

      const useCase = createProcessWebhook(deps);

      const result = await useCase.execute({
        eventId: "evt-partial",
        tenantId: "tenant-001",
        endpointSlug: "multi-dest",
        rawPayload: { id: "valid" },
        metadata: { contentType: "application/json", headers: {} },
        origin: "https://example.com",
      });

      expect(result.status).toBe("loaded");
      expect(result.message).toContain("1/2");
      expect(result.dispatchResults).toHaveLength(2);
    });
  });
});

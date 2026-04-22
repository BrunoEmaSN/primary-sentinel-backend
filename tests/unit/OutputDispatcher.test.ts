// tests/unit/OutputDispatcher.test.ts

import { describe, it, expect, vi, beforeEach } from "vitest";
import { OutputDispatcher } from "../../src/application/use-cases/OutputDispatcher.js";
import type { Destination } from "../../src/domain/events/entities/Endpoint.js";

// Mock fetch globally
const fetchMock = vi.fn();
(globalThis as unknown as { fetch: typeof fetch }).fetch = fetchMock;

// Mock Supabase
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: () => ({
      insert: vi.fn().mockResolvedValue({ error: null }),
    }),
  }),
}));

describe("OutputDispatcher", () => {
  let dispatcher: OutputDispatcher;

  beforeEach(() => {
    dispatcher = new OutputDispatcher("https://test.supabase.co", "test-service-key", undefined, false);
    fetchMock.mockReset();
  });

  describe("dispatch — single webhook destination", () => {
    it("calls fetch when URL is root-only (no preemptive error)", async () => {
      fetchMock.mockResolvedValue({ ok: false, status: 404, text: async () => "nope" });
      const dest: Destination = {
        type: "webhook",
        url: "https://example.com",
        method: "POST",
        retryOnFailure: false,
        timeoutMs: 5000,
      };

      const results = await dispatcher.dispatch([dest], { id: "x" });

      expect(fetchMock).toHaveBeenCalled();
      expect(results[0]!.success).toBe(false);
      expect(results[0]!.error).toMatch(/Webhook 404/i);
    });

    it("expands root Worker URL to test sink when WORKER_URL matches", async () => {
      fetchMock.mockResolvedValue({ ok: true, status: 200 });
      const local = new OutputDispatcher(
        "https://test.supabase.co",
        "test-service-key",
        "https://w.workers.dev",
        false
      );
      const dest: Destination = {
        type: "webhook",
        url: "https://w.workers.dev",
        method: "POST",
        retryOnFailure: false,
        timeoutMs: 5000,
      };

      const results = await local.dispatch([dest], { id: "x" });

      expect(results[0]!.success).toBe(true);
      expect(fetchMock).toHaveBeenCalledWith(
        "https://w.workers.dev/api/public/webhook-test-sink",
        expect.anything()
      );
    });

    it("expands root URL to sink under WORKER_URL path prefix (e.g. /gateway)", async () => {
      fetchMock.mockResolvedValue({ ok: true, status: 200 });
      const local = new OutputDispatcher(
        "https://test.supabase.co",
        "test-service-key",
        "https://api.example.com/gateway",
        false
      );
      const dest: Destination = {
        type: "webhook",
        url: "https://api.example.com",
        method: "POST",
        retryOnFailure: false,
        timeoutMs: 5000,
      };

      const results = await local.dispatch([dest], { id: "x" });

      expect(results[0]!.success).toBe(true);
      expect(fetchMock).toHaveBeenCalledWith(
        "https://api.example.com/gateway/api/public/webhook-test-sink",
        expect.anything()
      );
    });

    it("does not fetch blocked SSRF URLs (link-local IP)", async () => {
      const dest: Destination = {
        type: "webhook",
        url: "https://169.254.169.254/latest/meta-data",
        method: "POST",
        retryOnFailure: false,
        timeoutMs: 5000,
      };
      const results = await dispatcher.dispatch([dest], { x: 1 });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(results[0]!.success).toBe(false);
      expect(String(results[0]!.error)).toMatch(/not allowed|Non-public/i);
    });

    it("returns success result when webhook responds 200", async () => {
      fetchMock.mockResolvedValue({ ok: true, status: 200 });

      const dest: Destination = {
        type: "webhook",
        url: "https://example.com/hook",
        method: "POST",
        retryOnFailure: true,
        timeoutMs: 5000,
      };

      const results = await dispatcher.dispatch([dest], { id: "123", event: "test" });

      expect(results).toHaveLength(1);
      expect(results[0]!.success).toBe(true);
      expect(results[0]!.destinationType).toBe("webhook");
      expect(results[0]!.destinationIndex).toBe(0);
      expect(results[0]!.durationMs).toBeGreaterThanOrEqual(0);
    });

    it("returns failure result when webhook responds 500", async () => {
      fetchMock.mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => "Internal Server Error",
      });

      const dest: Destination = {
        type: "webhook",
        url: "https://example.com/hook",
        method: "POST",
        retryOnFailure: false,
        timeoutMs: 5000,
      };

      const results = await dispatcher.dispatch([dest], { id: "123" });

      expect(results[0]!.success).toBe(false);
      expect(results[0]!.error).toContain("500");
    });

    it("retries webhook with backoff when retryOnFailure and succeeds on second attempt", async () => {
      vi.useFakeTimers();
      try {
        fetchMock
          .mockResolvedValueOnce({
            ok: false,
            status: 503,
            text: async () => "unavailable",
          })
          .mockResolvedValueOnce({ ok: true, status: 200 });

        const dest: Destination = {
          type: "webhook",
          url: "https://example.com/hook",
          method: "POST",
          retryOnFailure: true,
          timeoutMs: 5000,
        };

        const promise = dispatcher.dispatch([dest], { id: "123" });

        await vi.advanceTimersByTimeAsync(500);

        const results = await promise;

        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(results[0]!.success).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it("gives up after 3 attempts when retryOnFailure and all fail", async () => {
      vi.useFakeTimers();
      try {
        fetchMock.mockResolvedValue({
          ok: false,
          status: 503,
          text: async () => "unavailable",
        });

        const dest: Destination = {
          type: "webhook",
          url: "https://example.com/hook",
          method: "POST",
          retryOnFailure: true,
          timeoutMs: 5000,
        };

        const promise = dispatcher.dispatch([dest], { id: "123" });

        await vi.advanceTimersByTimeAsync(500);
        await vi.advanceTimersByTimeAsync(1000);

        const results = await promise;

        expect(fetchMock).toHaveBeenCalledTimes(3);
        expect(results[0]!.success).toBe(false);
        expect(results[0]!.error).toContain("503");
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("dispatch — http_api with bearer auth", () => {
    it("sends Authorization: Bearer header", async () => {
      fetchMock.mockResolvedValue({ ok: true, status: 201 });

      const dest: Destination = {
        type: "http_api",
        url: "https://api.example.com/events",
        method: "POST",
        authType: "bearer",
        authValue: "my-secret-token",
        timeoutMs: 5000,
      };

      await dispatcher.dispatch([dest], { data: "payload" });

      expect(fetchMock).toHaveBeenCalledOnce();
      const callArgs = fetchMock.mock.calls[0]!;
      const options = callArgs[1] as RequestInit;
      const headers = options.headers as Record<string, string>;
      expect(headers["Authorization"]).toBe("Bearer my-secret-token");
    });

    it("sends X-Api-Key header for api_key auth", async () => {
      fetchMock.mockResolvedValue({ ok: true, status: 200 });

      const dest: Destination = {
        type: "http_api",
        url: "https://api.example.com/ingest",
        method: "POST",
        authType: "api_key",
        authValue: "my-api-key",
        authHeader: "X-Custom-Key",
        timeoutMs: 5000,
      };

      await dispatcher.dispatch([dest], {});

      const headers = (fetchMock.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
      expect(headers["X-Custom-Key"]).toBe("my-api-key");
    });
  });

  describe("dispatch — fanout to multiple destinations", () => {
    it("dispatches to all destinations concurrently and returns all results", async () => {
      fetchMock
        .mockResolvedValueOnce({ ok: true, status: 200 })
        .mockResolvedValueOnce({ ok: false, status: 503, text: async () => "Service Unavailable" });

      const destinations: Destination[] = [
        {
          type: "webhook",
          url: "https://dest1.example.com/hook",
          method: "POST",
          retryOnFailure: false,
          timeoutMs: 5000,
        },
        {
          type: "webhook",
          url: "https://dest2.example.com/hook",
          method: "POST",
          retryOnFailure: false,
          timeoutMs: 5000,
        },
      ];

      const results = await dispatcher.dispatch(destinations, { event: "test" });

      expect(results).toHaveLength(2);
      expect(results[0]!.success).toBe(true);
      expect(results[0]!.destinationIndex).toBe(0);
      expect(results[1]!.success).toBe(false);
      expect(results[1]!.destinationIndex).toBe(1);
    });

    it("a single destination failure never throws — other results still returned", async () => {
      fetchMock.mockRejectedValueOnce(new Error("Network error"));
      fetchMock.mockResolvedValueOnce({ ok: true, status: 200 });

      const destinations: Destination[] = [
        { type: "webhook", url: "https://bad.example.com/hook", method: "POST", retryOnFailure: false, timeoutMs: 5000 },
        { type: "webhook", url: "https://good.example.com/hook", method: "POST", retryOnFailure: false, timeoutMs: 5000 },
      ];

      const results = await dispatcher.dispatch(destinations, {});

      expect(results).toHaveLength(2);
      expect(results[0]!.success).toBe(false);
      expect(results[1]!.success).toBe(true);
    });

    it("wraps payload in wrapKey when specified", async () => {
      fetchMock.mockResolvedValue({ ok: true, status: 200 });

      const dest: Destination = {
        type: "webhook",
        url: "https://example.com/hook",
        method: "POST",
        wrapKey: "data",
        retryOnFailure: false,
        timeoutMs: 5000,
      };

      await dispatcher.dispatch([dest], { id: "abc" });

      const body = JSON.parse(
        (fetchMock.mock.calls[0]![1] as RequestInit).body as string
      );
      expect(body).toEqual({ data: { id: "abc" } });
    });
  });

  describe("dispatch — supabase destination", () => {
    it("calls supabase insert and returns success", async () => {
      const dest: Destination = {
        type: "supabase",
        tableName: "my_events",
      };

      const results = await dispatcher.dispatch([dest], { id: "123", name: "test" });

      expect(results[0]!.success).toBe(true);
      expect(results[0]!.destinationType).toBe("supabase");
    });
  });
});

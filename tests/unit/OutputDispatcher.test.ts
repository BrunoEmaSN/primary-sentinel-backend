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
    dispatcher = new OutputDispatcher(
      "https://test.supabase.co",
      "test-service-key"
    );
    fetchMock.mockReset();
  });

  describe("dispatch — single webhook destination", () => {
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
        { type: "webhook", url: "https://bad.example.com", method: "POST", retryOnFailure: false, timeoutMs: 5000 },
        { type: "webhook", url: "https://good.example.com", method: "POST", retryOnFailure: false, timeoutMs: 5000 },
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

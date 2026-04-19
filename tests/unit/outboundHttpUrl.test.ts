import { describe, it, expect } from "vitest";
import {
  expandRootUrlToWorkerTestSink,
  isHttpUrlRootPathOnly,
  WEBHOOK_TEST_SINK_PATH,
} from "../../src/domain/events/outboundHttpUrl.js";

describe("isHttpUrlRootPathOnly", () => {
  it("is true for https host with path / only", () => {
    expect(isHttpUrlRootPathOnly("https://localhost:3000")).toBe(true);
    expect(isHttpUrlRootPathOnly("https://localhost:3000/")).toBe(true);
    expect(isHttpUrlRootPathOnly("https://example.com")).toBe(true);
  });

  it("is false when there is a path segment", () => {
    expect(isHttpUrlRootPathOnly("https://httpbin.org/post")).toBe(false);
    expect(isHttpUrlRootPathOnly("https://x.workers.dev/api/public/webhook-test-sink")).toBe(false);
  });
});

describe("expandRootUrlToWorkerTestSink", () => {
  it("rewrites root URL to sink when origin matches WORKER_URL", () => {
    const out = expandRootUrlToWorkerTestSink("https://my-worker.workers.dev/", "https://my-worker.workers.dev");
    expect(out).toBe(`https://my-worker.workers.dev${WEBHOOK_TEST_SINK_PATH}`);
  });

  it("does not rewrite when origins differ (non-loopback or different port without dev flag)", () => {
    expect(expandRootUrlToWorkerTestSink("https://localhost:3000", "http://127.0.0.1:8787")).toBe(
      "https://localhost:3000"
    );
  });

  it("treats localhost and 127.0.0.1 as same service when protocol and port match", () => {
    const out = expandRootUrlToWorkerTestSink("http://localhost:8787/", "http://127.0.0.1:8787");
    expect(out).toBe(`http://127.0.0.1:8787${WEBHOOK_TEST_SINK_PATH}`);
  });

  it("with loopbackRootUsesWorkerSink, maps loopback root to WORKER_URL sink (e.g. :3000 → Worker)", () => {
    const out = expandRootUrlToWorkerTestSink("http://localhost:3000", "http://localhost:8787", {
      loopbackRootUsesWorkerSink: true,
    });
    expect(out).toBe(`http://localhost:8787${WEBHOOK_TEST_SINK_PATH}`);
  });

  it("does not rewrite when path is not root-only", () => {
    expect(
      expandRootUrlToWorkerTestSink("https://my-worker.workers.dev/foo", "https://my-worker.workers.dev")
    ).toBe("https://my-worker.workers.dev/foo");
  });
});

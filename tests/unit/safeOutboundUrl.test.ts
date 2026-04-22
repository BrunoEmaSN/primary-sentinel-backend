import { describe, it, expect } from "vitest";
import {
  assertSafeOutboundHttpUrl,
  isNonPublicIpv4,
  UnsafeOutboundUrlError,
} from "../../src/domain/events/safeOutboundUrl.js";

describe("assertSafeOutboundHttpUrl", () => {
  it("allows public https", () => {
    expect(() =>
      assertSafeOutboundHttpUrl("https://example.com/path", { allowHttpOnLoopback: false })
    ).not.toThrow();
  });

  it("blocks metadata host", () => {
    expect(() =>
      assertSafeOutboundHttpUrl("https://metadata.google.internal/computeMetadata/v1", {
        allowHttpOnLoopback: true,
      })
    ).toThrow(UnsafeOutboundUrlError);
  });

  it("blocks link-local IPv4", () => {
    expect(() =>
      assertSafeOutboundHttpUrl("https://169.254.169.254/latest/meta-data", {
        allowHttpOnLoopback: true,
      })
    ).toThrow(UnsafeOutboundUrlError);
  });

  it("blocks http unless loopback when allowHttpOnLoopback", () => {
    expect(() =>
      assertSafeOutboundHttpUrl("http://example.com/", { allowHttpOnLoopback: true })
    ).toThrow(UnsafeOutboundUrlError);
  });

  it("allows http on 127.0.0.1 when allowHttpOnLoopback", () => {
    expect(() =>
      assertSafeOutboundHttpUrl("http://127.0.0.1:8080/hook", { allowHttpOnLoopback: true })
    ).not.toThrow();
  });

  it("rejects http on 127.0.0.1 when not allowHttpOnLoopback", () => {
    expect(() =>
      assertSafeOutboundHttpUrl("http://127.0.0.1:8080/hook", { allowHttpOnLoopback: false })
    ).toThrow(UnsafeOutboundUrlError);
  });
});

describe("isNonPublicIpv4", () => {
  it("detects RFC1918 and metadata", () => {
    expect(isNonPublicIpv4([10, 0, 0, 1])).toBe(true);
    expect(isNonPublicIpv4([192, 168, 1, 1])).toBe(true);
    expect(isNonPublicIpv4([172, 16, 0, 1])).toBe(true);
    expect(isNonPublicIpv4([169, 254, 169, 254])).toBe(true);
    expect(isNonPublicIpv4([8, 8, 8, 8])).toBe(false);
  });
});

import { describe, it, expect } from "vitest";
import { validateWebhookSignature } from "../../src/infrastructure/http/middleware/auth.js";

async function expectedHeader(secret: string, body: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(body));
  const hex = Array.from(new Uint8Array(mac))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `sha256=${hex}`;
}

describe("validateWebhookSignature", () => {
  it("accepts a valid sha256= hex signature", async () => {
    const body = '{"a":1}';
    const secret = "mysecret";
    const sig = await expectedHeader(secret, body);
    await expect(validateWebhookSignature(new Request("http://x"), body, secret, sig)).resolves.toBe(
      true
    );
  });

  it("rejects wrong secret", async () => {
    const body = "{}";
    const sig = await expectedHeader("right", body);
    await expect(validateWebhookSignature(new Request("http://x"), body, "wrong", sig)).resolves.toBe(
      false
    );
  });

  it("rejects tampered body", async () => {
    const sig = await expectedHeader("s", '{"ok":true}');
    await expect(validateWebhookSignature(new Request("http://x"), '{"ok":false}', "s", sig)).resolves.toBe(
      false
    );
  });

  it("rejects malformed hex", async () => {
    await expect(
      validateWebhookSignature(new Request("http://x"), "{}", "s", "sha256=gg")
    ).resolves.toBe(false);
  });
});

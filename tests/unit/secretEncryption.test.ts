import { describe, it, expect } from "vitest";
import { encryptSecret, decryptSecret, isEncryptedSecret } from "../../src/infrastructure/utils/secretEncryption.js";

/** 32 raw bytes as standard base64 */
const TEST_KEY = Buffer.from("0123456789abcdef0123456789abcdef").toString("base64");

describe("secretEncryption", () => {
  it("roundtrips plaintext", async () => {
    const plain = "postgresql://user:pass@host:5432/db";
    const enc = await encryptSecret(plain, TEST_KEY);
    expect(isEncryptedSecret(enc)).toBe(true);
    const dec = await decryptSecret(enc, TEST_KEY);
    expect(dec).toBe(plain);
  });

  it("decryptSecret leaves non-encrypted strings unchanged", async () => {
    expect(await decryptSecret("plain", TEST_KEY)).toBe("plain");
  });
});

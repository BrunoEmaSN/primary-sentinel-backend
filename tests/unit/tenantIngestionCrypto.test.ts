import { describe, it, expect } from "vitest";
import {
  encryptTenantPayload,
  decryptTenantPayload,
  isTenantIngestionCiphertext,
  TENANT_CRYPTO_INFO_EVENTS,
  TENANT_CRYPTO_INFO_DLQ_R2,
} from "../../src/infrastructure/utils/tenantIngestionCrypto.js";

/** 32 raw bytes as standard base64 */
const MASTER = Buffer.from("fedcba9876543210fedcba9876543210").toString("base64");

describe("tenantIngestionCrypto", () => {
  it("roundtrips JSON plaintext per tenant", async () => {
    const plain = JSON.stringify({ a: 1, nested: { b: "x" } });
    const enc = await encryptTenantPayload(plain, MASTER, "tenant-a", TENANT_CRYPTO_INFO_EVENTS);
    expect(isTenantIngestionCiphertext(enc)).toBe(true);
    const dec = await decryptTenantPayload(enc, MASTER, "tenant-a", TENANT_CRYPTO_INFO_EVENTS);
    expect(JSON.parse(dec)).toEqual({ a: 1, nested: { b: "x" } });
  });

  it("produces different ciphertext for different tenants (same plaintext)", async () => {
    const plain = '{"x":1}';
    const encA = await encryptTenantPayload(plain, MASTER, "tenant-a", TENANT_CRYPTO_INFO_EVENTS);
    const encB = await encryptTenantPayload(plain, MASTER, "tenant-b", TENANT_CRYPTO_INFO_EVENTS);
    expect(encA).not.toBe(encB);
  });

  it("fails decrypt with wrong tenant", async () => {
    const enc = await encryptTenantPayload("secret", MASTER, "tenant-a", TENANT_CRYPTO_INFO_EVENTS);
    await expect(
      decryptTenantPayload(enc, MASTER, "tenant-b", TENANT_CRYPTO_INFO_EVENTS)
    ).rejects.toThrow();
  });

  it("uses distinct keys per HKDF info label", async () => {
    const plain = "same";
    const encEvents = await encryptTenantPayload(plain, MASTER, "t1", TENANT_CRYPTO_INFO_EVENTS);
    const encDlq = await encryptTenantPayload(plain, MASTER, "t1", TENANT_CRYPTO_INFO_DLQ_R2);
    await expect(
      decryptTenantPayload(encEvents, MASTER, "t1", TENANT_CRYPTO_INFO_DLQ_R2)
    ).rejects.toThrow();
    expect(await decryptTenantPayload(encDlq, MASTER, "t1", TENANT_CRYPTO_INFO_DLQ_R2)).toBe(plain);
  });

  it("decryptTenantPayload leaves non-encrypted strings unchanged", async () => {
    expect(await decryptTenantPayload("plain-json", MASTER, "t", TENANT_CRYPTO_INFO_EVENTS)).toBe(
      "plain-json"
    );
  });
});

// AES-GCM over HKDF-derived per-tenant keys (ingestion artifacts at rest).

export const TENANT_INGESTION_PREFIX = "enc:ti1:";

/** HKDF info for `events.raw_payload` / `validated_payload`. */
export const TENANT_CRYPTO_INFO_EVENTS = "sentinel:events:v1";
/** HKDF info for R2 DLQ object envelope. */
export const TENANT_CRYPTO_INFO_DLQ_R2 = "sentinel:dlq-r2:v1";
/** HKDF info for `event_snapshots.payload`. */
export const TENANT_CRYPTO_INFO_EVENT_SNAPSHOT = "sentinel:event-snapshot:v1";

function bytesToB64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function b64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

async function importHkdfKey(masterRaw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", masterRaw, "HKDF", false, ["deriveBits"]);
}

async function deriveAes256Key(
  masterB64: string,
  tenantId: string,
  info: string
): Promise<CryptoKey> {
  const master = b64ToBytes(masterB64.replace(/\s/g, ""));
  if (master.length !== 32) {
    throw new Error("SENTINEL_INGESTION_SECRET_KEY must be 32 bytes (base64)");
  }
  const ikm = await importHkdfKey(master);
  const salt = new TextEncoder().encode(tenantId);
  const infoBytes = new TextEncoder().encode(info);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt, info: infoBytes },
    ikm,
    256
  );
  return crypto.subtle.importKey("raw", bits, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export function isTenantIngestionCiphertext(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(TENANT_INGESTION_PREFIX);
}

export async function encryptTenantPayload(
  plaintext: string,
  masterB64: string,
  tenantId: string,
  info: string
): Promise<string> {
  const key = await deriveAes256Key(masterB64, tenantId, info);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const enc = new TextEncoder().encode(plaintext);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc);
  const combined = new Uint8Array(iv.length + ct.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ct), iv.length);
  return TENANT_INGESTION_PREFIX + bytesToB64(combined);
}

export async function decryptTenantPayload(
  ciphertext: string,
  masterB64: string,
  tenantId: string,
  info: string
): Promise<string> {
  if (!isTenantIngestionCiphertext(ciphertext)) return ciphertext;

  const key = await deriveAes256Key(masterB64, tenantId, info);
  const combined = b64ToBytes(ciphertext.slice(TENANT_INGESTION_PREFIX.length));
  const iv = combined.slice(0, 12);
  const data = combined.slice(12);
  const dec = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, data);
  return new TextDecoder().decode(dec);
}

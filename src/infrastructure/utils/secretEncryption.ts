// AES-GCM encryption for destination secrets at rest (tenant JSONB).

const PREFIX = "enc:v1:";

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

async function importAesKey(keyB64: string): Promise<CryptoKey | null> {
  try {
    const raw = b64ToBytes(keyB64.replace(/\s/g, ""));
    if (raw.length !== 32) return null;
    return await crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  } catch {
    return null;
  }
}

export function isEncryptedSecret(value: string): boolean {
  return typeof value === "string" && value.startsWith(PREFIX);
}

export async function encryptSecret(plaintext: string, keyB64: string): Promise<string> {
  const key = await importAesKey(keyB64);
  if (!key) throw new Error("SENTINEL_DESTINATION_SECRET_KEY must be 32 bytes (base64)");

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const enc = new TextEncoder().encode(plaintext);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc);
  const combined = new Uint8Array(iv.length + ct.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ct), iv.length);
  return PREFIX + bytesToB64(combined);
}

export async function decryptSecret(ciphertext: string, keyB64: string): Promise<string> {
  if (!isEncryptedSecret(ciphertext)) return ciphertext;

  const key = await importAesKey(keyB64);
  if (!key) throw new Error("Invalid SENTINEL_DESTINATION_SECRET_KEY");

  const combined = b64ToBytes(ciphertext.slice(PREFIX.length));
  const iv = combined.slice(0, 12);
  const data = combined.slice(12);
  const dec = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, data);
  return new TextDecoder().decode(dec);
}

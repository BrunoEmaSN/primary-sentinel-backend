// src/infrastructure/utils/crypto.ts
// Cloudflare Workers–compatible crypto utilities (Web Crypto API)

/**
 * Generates a URL-safe UUID v4 without hyphens
 */
export function generateId(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

/**
 * Generates a secure webhook secret (hex string)
 */
export function generateWebhookSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Creates a deterministic fingerprint for error patterns
 * Used as cache key for transformation rules
 */
export function hashFingerprint(...parts: string[]): string {
  // In Workers, crypto.subtle.digest is async but we need sync here.
  // We use a fast non-crypto hash (djb2) for fingerprinting.
  const input = parts.join("|");
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) + hash) ^ input.charCodeAt(i);
    hash = hash >>> 0; // convert to unsigned 32-bit
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * Async SHA-256 hash (for signatures)
 */
export async function sha256(data: string): Promise<string> {
  const encoder = new TextEncoder();
  const buffer = await crypto.subtle.digest("SHA-256", encoder.encode(data));
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Timing-safe string comparison (prevents timing attacks on secrets)
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

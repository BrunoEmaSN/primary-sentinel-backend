// Encrypt / decrypt / redact sensitive fields inside Destination payloads.

import type { Destination } from "../../domain/events/entities/Endpoint.js";
import { encryptSecret, decryptSecret, isEncryptedSecret } from "./secretEncryption.js";

const REDACTED = "[REDACTED]";

type EncryptFn = (s: string) => Promise<string>;
type DecryptFn = (s: string) => Promise<string>;

async function mapStringFields(
  dest: Destination,
  fields: string[],
  fn: (v: string) => Promise<string>
): Promise<Destination> {
  const o = { ...(dest as Record<string, unknown>) };
  for (const f of fields) {
    const v = o[f];
    if (typeof v === "string" && v.length > 0) {
      o[f] = await fn(v);
    }
  }
  return o as Destination;
}

export async function encryptDestinationSecrets(dest: Destination, encrypt: EncryptFn): Promise<Destination> {
  switch (dest.type) {
    case "supabase":
      return mapStringFields(dest, ["serviceKey", "apiKey"], async (v) =>
        isEncryptedSecret(v) ? v : encrypt(v)
      );
    case "postgres":
    case "mysql":
      return mapStringFields(dest, ["connectionString"], async (v) =>
        isEncryptedSecret(v) ? v : encrypt(v)
      );
    case "bigquery":
      return mapStringFields(dest, ["serviceAccountKey"], async (v) =>
        isEncryptedSecret(v) ? v : encrypt(v)
      );
    case "http_api":
      return mapStringFields(dest, ["authValue"], async (v) =>
        isEncryptedSecret(v) ? v : encrypt(v)
      );
    case "webhook":
      return dest;
    default:
      return dest;
  }
}

export async function decryptDestinationSecrets(dest: Destination, decrypt: DecryptFn): Promise<Destination> {
  switch (dest.type) {
    case "supabase":
      return mapStringFields(dest, ["serviceKey", "apiKey"], decrypt);
    case "postgres":
    case "mysql":
      return mapStringFields(dest, ["connectionString"], decrypt);
    case "bigquery":
      return mapStringFields(dest, ["serviceAccountKey"], decrypt);
    case "http_api":
      return mapStringFields(dest, ["authValue"], decrypt);
    case "webhook":
      return dest;
    default:
      return dest;
  }
}

export function redactDestinationForPublic(dest: Destination): Destination {
  const o = { ...(dest as Record<string, unknown>) };
  switch (dest.type) {
    case "supabase":
      if (typeof o.serviceKey === "string") o.serviceKey = REDACTED;
      if (typeof o.apiKey === "string") o.apiKey = REDACTED;
      break;
    case "postgres":
    case "mysql":
      if (typeof o.connectionString === "string") o.connectionString = REDACTED;
      break;
    case "bigquery":
      if (typeof o.serviceAccountKey === "string") o.serviceAccountKey = REDACTED;
      break;
    case "http_api":
      if (typeof o.authValue === "string") o.authValue = REDACTED;
      break;
    default:
      break;
  }
  return o as Destination;
}

export async function encryptDestinationsWithKey(
  destinations: Destination[],
  keyB64: string
): Promise<Destination[]> {
  const enc = (s: string) => encryptSecret(s, keyB64);
  return Promise.all(destinations.map((d) => encryptDestinationSecrets(d, enc)));
}

export async function decryptDestinationsWithKey(
  destinations: Destination[],
  keyB64: string
): Promise<Destination[]> {
  const dec = (s: string) => decryptSecret(s, keyB64);
  return Promise.all(destinations.map((d) => decryptDestinationSecrets(d, dec)));
}

export function redactDestinationsForPublic(destinations: Destination[]): Destination[] {
  return destinations.map(redactDestinationForPublic);
}

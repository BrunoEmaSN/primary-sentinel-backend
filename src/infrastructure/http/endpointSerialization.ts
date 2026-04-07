import type { Destination } from "../../domain/events/entities/Endpoint.js";
import { redactDestinationsForPublic } from "../utils/destinationSecretsCodec.js";

/** API-safe endpoint snapshot (no plaintext or ciphertext secrets). */
export function toPublicEndpointSnapshot(snapshot: Record<string, unknown>): Record<string, unknown> {
  const dests = snapshot["destinations"];
  const redacted = Array.isArray(dests)
    ? redactDestinationsForPublic(dests as Destination[])
    : [];
  return {
    ...snapshot,
    destinations: redacted,
    destination: redacted.length === 1 ? redacted[0] : redacted,
  };
}

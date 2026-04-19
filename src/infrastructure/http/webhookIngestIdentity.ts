/**
 * Deterministic event id for webhook ingestion (idempotencia).
 * Headers explícitos tienen prioridad; el `id` del JSON se usa solo si no hay header,
 * con prefijo tenant+slug para no colisionar entre endpoints.
 */

const MAX_CLIENT_KEY_LEN = 240;

function trimHeader(v: string | null): string | null {
  const t = v?.trim();
  if (!t || t.length === 0) return null;
  return t.length > MAX_CLIENT_KEY_LEN ? t.slice(0, MAX_CLIENT_KEY_LEN) : t;
}

function extractPayloadId(raw: unknown): string | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const id = (raw as Record<string, unknown>)["id"];
  if (typeof id === "string") {
    const t = id.trim();
    if (!t) return null;
    return t.length > MAX_CLIENT_KEY_LEN ? t.slice(0, MAX_CLIENT_KEY_LEN) : t;
  }
  if (typeof id === "number" && Number.isFinite(id)) {
    const s = String(id);
    return s.length > MAX_CLIENT_KEY_LEN ? s.slice(0, MAX_CLIENT_KEY_LEN) : s;
  }
  return null;
}

export type ResolveIngestEventIdParams = {
  tenantId: string;
  endpointSlug: string;
  headers: Headers;
  rawPayload: unknown;
  generateId: () => string;
};

/**
 * Orden: `X-Event-ID` → `X-Idempotency-Key` → `X-Request-ID` → `id` en el cuerpo
 * (con ámbito `tenantId:endpointSlug:`) → UUID nuevo.
 */
export function resolveIngestEventId(params: ResolveIngestEventIdParams): string {
  const { tenantId, endpointSlug, headers, rawPayload, generateId } = params;

  const fromHeader =
    trimHeader(headers.get("X-Event-ID")) ??
    trimHeader(headers.get("X-Idempotency-Key")) ??
    trimHeader(headers.get("X-Request-ID"));

  if (fromHeader) return fromHeader;

  const payloadId = extractPayloadId(rawPayload);
  if (payloadId) {
    return `${tenantId}:${endpointSlug}:${payloadId}`;
  }

  return generateId();
}

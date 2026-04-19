/**
 * Orígenes sintéticos para `EventSource.origin` cuando el evento no viene de un POST HTTP
 * al webhook. Usar URN (RFC 8141) evita que parezcan hosts HTTPS reales en local, dev o prod.
 */
export const EVENT_ORIGIN_REINJECT_DLQ = "urn:sentinel:source:reinject" as const;

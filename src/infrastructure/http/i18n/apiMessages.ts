import type { ApiLocale } from "./apiLocale.js";

const ES = {
  notFound: "No encontrado",
  internalServerError: "Error interno del servidor",
  rateLimitExceeded: "Límite de solicitudes excedido",
  invalidWebhookUrl: "URL de webhook no válida",
  invalidWebhookSignature: "Firma de webhook no válida",
  invalidJsonPayload: "Cuerpo JSON no válido",
  missingNameSchema: "Faltan campos obligatorios: name, schema",
  missingDestination: "Falta el campo obligatorio: destination o destinations",
  freePlanEndpointLimit:
    "Solo puedes tener 1 endpoint de prueba activo a la vez. Pausa un endpoint existente antes de crear o reactivar otro.",
  failedCreateEndpoint: "No se pudo crear el endpoint",
  failedUpdateEndpoint: "No se pudo actualizar el endpoint",
  endpointNotFound: "Endpoint no encontrado",
  reinjectFailed: "Fallo al reinyectar",
  discardFailed: "Fallo al descartar",
  snapshotIdRequired: "Se requiere el parámetro de consulta snapshotId",
  snapshotNotFound: "Snapshot no encontrado",
  eventNotInDlq: "El evento no está en la cola de mensajes muertos",
  bodyRequired: "Se requiere el campo body",
  tagRequired: "Se requiere el campo tag",
  maintenanceFieldsRequired: "Se requieren title, starts_at y ends_at",
  operationFailed: "Operación fallida",
  missingAuthHeader: "Cabecera Authorization ausente o no válida",
  invalidToken: "Token no válido o caducado",
  authServiceError: "Error del servicio de autenticación",
  publicSinkHint:
    "Sink de prueba Primary Sentinel. Configúralo como URL de destino webhook (con esta ruta, no solo el dominio).",
  sloNote:
    "Objetivo de producto (beta). Las cifras publicadas en la landing deben rotularse como objetivo hasta contar con medición real (Fase 8).",
  billingNote:
    "Facturación self-service en roadmap; se aplican los límites del plan free en la API.",
  billingStripePlaceholder: "configurar Stripe — Fase 9",
  heuristicSlowDispatch:
    "Las entregas a destinos tardan más de 2,5 s de media: considera subir el timeout en Transform/webhook durante ventanas batch nocturnas.",
  heuristicLowSamples:
    "Pocas muestras de métricas en las últimas horas: envía tráfico de prueba o revisa el Worker.",
  atLeastOneDestination: "Se requiere al menos un destino",
  maxFiveDestinations: "Máximo 5 destinos por endpoint",
  schemaDestinationsTogether:
    "schema y destinations deben enviarse juntos al actualizar cualquiera de los dos",
  eventNotFound: "Evento no encontrado",
  onlyDeadReinject: "Solo se pueden reinyectar eventos en cola de mensajes muertos",
  onlyDeadDiscard: "Solo se pueden descartar eventos en cola de mensajes muertos",
  webhookEndpointSlugNotFound: "No hay endpoint con ese slug para este inquilino",
  endpointTenantMismatch: "El endpoint no pertenece a este inquilino",
  endpointInactive: "El endpoint no está activo",
  processingTimeout: "Tiempo de procesamiento agotado",
  badWebhookCommand: "Petición de webhook no válida (falta slug o id de endpoint)",
  endpointNotFoundWithDetail: "Endpoint no encontrado: {{detail}}",
  duplicateEvent: "Evento duplicado — ya fue procesado",
  globalProcessingTimeout: "Se superó el tiempo máximo de procesamiento global",
  healingDisabled: "La autocorrección está desactivada para este endpoint",
  maxHealingAttempts: "Se superó el máximo de intentos de autocorrección",
  llmGenerationFailed: "Fallo en la generación por LLM: {{detail}}",
  sandboxExecutionFailed: "Fallo en el sandbox: {{detail}}",
  transformedStillInvalid: "Los datos transformados siguen sin cumplir el esquema",
  noDestinationsConfigured:
    "No hay destinos configurados — añade al menos un destino de salida (p. ej. URL de webhook) para este endpoint",
  allDestinationsFailed: "Todos los destinos fallaron: {{detail}}",
  dispatchPartialSuccess:
    "Evento {{finalStatus}} — {{ok}}/{{total}} destinos respondieron correctamente",
  dispatchAllSuccess: "Evento {{finalStatus}} y enviado a los {{total}} destino(s)",
  statusLoaded: "procesado",
  statusHealed: "corregido",
} as const;

const EN: Record<keyof typeof ES, string> = {
  notFound: "Not found",
  internalServerError: "Internal server error",
  rateLimitExceeded: "Rate limit exceeded",
  invalidWebhookUrl: "Invalid webhook URL",
  invalidWebhookSignature: "Invalid webhook signature",
  invalidJsonPayload: "Invalid JSON payload",
  missingNameSchema: "Missing required fields: name, schema",
  missingDestination: "Missing required field: destination or destinations",
  freePlanEndpointLimit:
    "You can only have 1 active trial endpoint at a time. Pause an existing endpoint before creating or reactivating another.",
  failedCreateEndpoint: "Failed to create endpoint",
  failedUpdateEndpoint: "Failed to update endpoint",
  endpointNotFound: "Endpoint not found",
  reinjectFailed: "Reinject failed",
  discardFailed: "Discard failed",
  snapshotIdRequired: "snapshotId query required",
  snapshotNotFound: "Snapshot not found",
  eventNotInDlq: "Event not in DLQ",
  bodyRequired: "body required",
  tagRequired: "tag required",
  maintenanceFieldsRequired: "title, starts_at, ends_at required",
  operationFailed: "Failed",
  missingAuthHeader: "Missing or invalid Authorization header",
  invalidToken: "Invalid or expired token",
  authServiceError: "Authentication service error",
  publicSinkHint:
    "Primary Sentinel test sink. Configure it as your webhook destination URL (this path, not the bare domain).",
  sloNote:
    "Product goal (beta). Figures shown on the landing page should be labeled as a goal until real measurement exists (Phase 8).",
  billingNote: "Self-service billing is on the roadmap; free-plan limits are enforced by the API.",
  billingStripePlaceholder: "configure Stripe — Phase 9",
  heuristicSlowDispatch:
    "Deliveries to destinations average over 2.5s: consider raising the timeout in Transform/webhook during overnight batch windows.",
  heuristicLowSamples:
    "Few metric samples in recent hours: send test traffic or check the Worker.",
  atLeastOneDestination: "At least one destination is required",
  maxFiveDestinations: "Maximum 5 destinations per endpoint",
  schemaDestinationsTogether: "schema and destinations are required together when updating either",
  eventNotFound: "Event not found",
  onlyDeadReinject: "Only dead-letter events can be reinjected",
  onlyDeadDiscard: "Only dead-letter events can be discarded",
  webhookEndpointSlugNotFound: "No endpoint with that slug for this tenant",
  endpointTenantMismatch: "Endpoint does not belong to this tenant",
  endpointInactive: "Endpoint is not active",
  processingTimeout: "Processing timeout",
  badWebhookCommand: "Invalid webhook request (endpoint slug or id required)",
  endpointNotFoundWithDetail: "Endpoint not found: {{detail}}",
  duplicateEvent: "Duplicate event — already processed",
  globalProcessingTimeout: "Global processing timeout exceeded",
  healingDisabled: "Healing disabled for this endpoint",
  maxHealingAttempts: "Max healing attempts exceeded",
  llmGenerationFailed: "LLM generation failed: {{detail}}",
  sandboxExecutionFailed: "Sandbox execution failed: {{detail}}",
  transformedStillInvalid: "Transformed data still fails schema validation",
  noDestinationsConfigured:
    "No destinations configured — add at least one outbound destination (e.g. webhook URL) for this endpoint",
  allDestinationsFailed: "All destinations failed: {{detail}}",
  dispatchPartialSuccess:
    "Event {{finalStatus}} — {{ok}}/{{total}} destinations succeeded",
  dispatchAllSuccess: "Event {{finalStatus}} and dispatched to all {{total}} destination(s)",
  statusLoaded: "loaded",
  statusHealed: "healed",
};

export type ApiMessageKey = keyof typeof ES;

const byLocale: Record<ApiLocale, Record<ApiMessageKey, string>> = {
  es: ES,
  en: EN,
};

function interpolate(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template;
  let s = template;
  for (const [k, v] of Object.entries(vars)) {
    s = s.split(`{{${k}}}`).join(String(v));
  }
  return s;
}

export function apiT(locale: ApiLocale, key: ApiMessageKey, vars?: Record<string, string | number>): string {
  const table = byLocale[locale] ?? byLocale.es;
  const template = table[key] ?? byLocale.es[key] ?? String(key);
  return interpolate(template, vars);
}

/** Mensajes de error de dominio emitidos en inglés por los casos de uso → respuesta localizada. */
const EN_DOMAIN_EXACT: Partial<Record<string, ApiMessageKey>> = {
  "At least one destination is required": "atLeastOneDestination",
  "Maximum 5 destinations per endpoint": "maxFiveDestinations",
  "Endpoint not found": "endpointNotFound",
  "schema and destinations are required together when updating either": "schemaDestinationsTogether",
  "Event not found": "eventNotFound",
  "Only dead-letter events can be reinjected": "onlyDeadReinject",
  "Only dead-letter events can be discarded": "onlyDeadDiscard",
  "Endpoint tenant mismatch": "endpointTenantMismatch",
};

export function translateDomainError(
  locale: ApiLocale,
  err: unknown,
  fallbackKey: ApiMessageKey = "internalServerError"
): string {
  if (!(err instanceof Error)) return apiT(locale, fallbackKey);

  switch (err.name) {
    case "EndpointNotFoundError":
      return apiT(locale, "webhookEndpointSlugNotFound");
    case "EndpointInactiveError":
      return apiT(locale, "endpointInactive");
    case "ProcessingTimeoutError":
      return apiT(locale, "processingTimeout");
    default:
      break;
  }

  const mapped = EN_DOMAIN_EXACT[err.message];
  if (mapped) return apiT(locale, mapped);

  if (err.message.startsWith("Endpoint not found:")) {
    return apiT(locale, "endpointNotFoundWithDetail", {
      detail: err.message.replace(/^Endpoint not found:\s*/, "").trim(),
    });
  }
  if (err.message.startsWith("ProcessWebhookEvent:")) {
    return apiT(locale, "badWebhookCommand");
  }

  if (err.message.trim()) return err.message;
  return apiT(locale, fallbackKey);
}

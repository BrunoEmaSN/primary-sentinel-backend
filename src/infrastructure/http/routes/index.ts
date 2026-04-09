// src/infrastructure/http/routes/index.ts

import type { WorkerEnv, AuthContext } from "../middleware/auth.js";
import {
  authenticateRequest,
  validateWebhookSignature,
  jsonResponse,
  errorResponse,
  unauthorizedResponse,
  checkRateLimit,
} from "../middleware/auth.js";
import { ProcessWebhookEvent } from "../../../application/use-cases/ProcessWebhookEvent.js";
import {
  CreateEndpoint,
  ListEndpoints,
  GetEndpoint,
  DeleteEndpoint,
  UpdateEndpoint,
} from "../../../application/use-cases/ManageEndpoint.js";
import { ReinjectDlqEvent, DiscardDlqEvent } from "../../../application/use-cases/ManageDLQ.js";
import { buildDependencies } from "../../container.js";
import type { Dependencies } from "../../container.js";
import { generateId } from "../../utils/crypto.js";
import { createLogger } from "../../utils/logger.js";

const logger = createLogger("Router");

function buildProcessWebhookUseCase(deps: Dependencies): ProcessWebhookEvent {
  return new ProcessWebhookEvent(
    deps.eventRepo,
    deps.endpointRepo,
    deps.ruleRepo,
    deps.ruleCache,
    deps.llmService,
    deps.storageService,
    deps.sandboxService,
    deps.outputDispatcher,
    deps.incidentAlerts,
    deps.tenantInfra
  );
}

export async function handleRequest(request: Request, env: WorkerEnv): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  const deps = buildDependencies(env);

  try {
    if (method === "POST" && path.match(/^\/webhook\/[\w-]+\/[\w-]+$/)) {
      return await handleWebhook(request, url, env, deps);
    }

    if (path === "/health" && method === "GET") {
      return jsonResponse({ status: "ok", version: "2.0.0", ts: new Date().toISOString() });
    }

    if (path === "/api/public/slo" && method === "GET") {
      return jsonResponse({
        availabilityTargetPercent: 99.95,
        firstUsefulAlertGoalMinutes: 2,
        note:
          "Objetivo de producto (beta). Las cifras publicadas en la landing deben rotularse como objetivo hasta contar con medición real (Fase 8).",
        measured: false,
      });
    }

    const authResult = await authenticateRequest(request, env);
    if (authResult instanceof Response) return authResult;
    const auth = authResult as AuthContext;

    if (path === "/api/endpoints" && method === "POST") {
      return await handleCreateEndpoint(request, auth, deps, env);
    }
    if (path === "/api/endpoints" && method === "GET") {
      return await handleListEndpoints(auth, deps);
    }
    if (path.match(/^\/api\/endpoints\/[\w-]+$/) && method === "GET") {
      return await handleGetEndpoint(path.split("/").pop()!, auth, deps);
    }
    if (path.match(/^\/api\/endpoints\/[\w-]+$/) && method === "PATCH") {
      return await handleUpdateEndpoint(path.split("/").pop()!, request, auth, deps, env);
    }
    if (path.match(/^\/api\/endpoints\/[\w-]+$/) && method === "DELETE") {
      return await handleDeleteEndpoint(path.split("/").pop()!, auth, deps);
    }
    if (path.match(/^\/api\/endpoints\/[\w-]+\/events$/) && method === "GET") {
      return await handleListEvents(path.split("/")[3]!, auth, url, deps);
    }
    if (path.match(/^\/api\/endpoints\/[\w-]+\/rules$/) && method === "GET") {
      return await handleListRules(path.split("/")[3]!, auth, deps);
    }
    if (path === "/api/dlq" && method === "GET") {
      return await handleListDLQ(auth, url, deps);
    }
    if (path.match(/^\/api\/dlq\/[\w-]+\/reinject$/) && method === "POST") {
      const eventId = path.split("/")[3]!;
      return await handleReinjectDlq(eventId, request, auth, deps);
    }
    if (path.match(/^\/api\/dlq\/[\w-]+$/) && method === "DELETE") {
      const eventId = path.split("/").pop()!;
      return await handleDiscardDlq(eventId, auth, deps);
    }
    if (path.match(/^\/api\/dlq\/[\w-]+\/snapshots$/) && method === "GET") {
      const eventId = path.split("/")[3]!;
      return await handleListDlqSnapshots(eventId, auth, deps);
    }
    if (path.match(/^\/api\/dlq\/[\w-]+\/diff$/) && method === "GET") {
      const eventId = path.split("/")[3]!;
      return await handleDlqDiff(eventId, url, auth, deps);
    }

    if (path === "/api/settings" && method === "GET") {
      return await handleGetSettings(auth, deps);
    }
    if (path === "/api/settings" && method === "PUT") {
      return await handlePutSettings(request, auth, deps);
    }

    if (path === "/api/operations/dependency-graph" && method === "GET") {
      return await handleDependencyGraph(auth, deps);
    }
    if (path === "/api/operations/ai-history" && method === "GET") {
      return await handleAiHistory(url, auth, deps);
    }
    if (path === "/api/metrics/stages" && method === "GET") {
      return await handleStageMetrics(url, auth, deps);
    }
    if (path === "/api/suggestions/heuristics" && method === "GET") {
      return await handleHeuristicSuggestions(auth, deps);
    }

    if (path.match(/^\/api\/events\/[\w-]+\/notes$/) && method === "GET") {
      const eventId = path.split("/")[3]!;
      return await handleListEventNotes(eventId, auth, deps);
    }
    if (path.match(/^\/api\/events\/[\w-]+\/notes$/) && method === "POST") {
      const eventId = path.split("/")[3]!;
      return await handleAddEventNote(eventId, request, auth, deps);
    }
    if (path.match(/^\/api\/events\/[\w-]+\/tags$/) && method === "GET") {
      const eventId = path.split("/")[3]!;
      return await handleListEventTags(eventId, auth, deps);
    }
    if (path.match(/^\/api\/events\/[\w-]+\/tags$/) && method === "POST") {
      const eventId = path.split("/")[3]!;
      return await handleAddEventTag(eventId, request, auth, deps);
    }

    if (path === "/api/maintenance-windows" && method === "GET") {
      return await handleListMaintenanceWindows(auth, deps);
    }
    if (path === "/api/maintenance-windows" && method === "POST") {
      return await handleCreateMaintenanceWindow(request, auth, deps);
    }
    if (path.match(/^\/api\/maintenance-windows\/[\w-]+\/approve$/) && method === "POST") {
      const id = path.split("/")[3]!;
      return await handleApproveMaintenanceWindow(id, auth, deps);
    }

    if (path === "/api/billing/status" && method === "GET") {
      return await handleBillingStatus(auth, deps);
    }

    return errorResponse("Not found", 404);
  } catch (e) {
    logger.error("Unhandled error", { error: e, path, method });
    return errorResponse(e instanceof Error ? e.message : "Internal server error", 500);
  }
}

async function handleWebhook(
  request: Request,
  url: URL,
  env: WorkerEnv,
  deps: Dependencies
): Promise<Response> {
  const [, , tenantId, endpointSlug] = url.pathname.split("/");
  if (!tenantId || !endpointSlug) return errorResponse("Invalid webhook URL", 400);

  const { allowed } = await checkRateLimit(env.RULE_CACHE, `webhook:${tenantId}`, 1000, 60);
  if (!allowed) return errorResponse("Rate limit exceeded", 429);

  const body = await request.text();

  const signature = request.headers.get("X-Sentinel-Signature");
  if (signature) {
    const endpoint = await deps.endpointRepo.findBySlug({ tenantId, slug: endpointSlug });
    if (endpoint) {
      const valid = await validateWebhookSignature(request, body, endpoint.webhookSecret, signature);
      if (!valid) return unauthorizedResponse("Invalid webhook signature");
    }
  }

  let rawPayload: unknown;
  try {
    rawPayload = JSON.parse(body);
  } catch {
    return errorResponse("Invalid JSON payload", 400);
  }

  const eventId =
    request.headers.get("X-Event-ID") ??
    request.headers.get("X-Idempotency-Key") ??
    generateId();

  const requestHeaders: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    requestHeaders[key] = value;
  });

  const useCase = buildProcessWebhookUseCase(deps);

  const result = await useCase.execute({
    eventId,
    tenantId,
    endpointSlug,
    rawPayload,
    metadata: {
      contentType: request.headers.get("Content-Type") ?? "application/json",
      headers: requestHeaders,
      ...(request.headers.get("CF-Connecting-IP")
        ? { ipAddress: request.headers.get("CF-Connecting-IP")! }
        : {}),
      ...(request.headers.get("User-Agent") ? { userAgent: request.headers.get("User-Agent")! } : {}),
    },
    origin: request.headers.get("Origin") ?? url.origin,
  });

  return jsonResponse(result, result.status === "dead" ? 422 : 200);
}

async function handleCreateEndpoint(
  request: Request,
  auth: AuthContext,
  deps: Dependencies,
  env: WorkerEnv
): Promise<Response> {
  const body = (await request.json()) as Record<string, unknown>;

  if (!body["name"] || !body["schema"]) {
    return errorResponse("Missing required fields: name, schema", 400);
  }

  if (!body["destination"] && !body["destinations"]) {
    return errorResponse("Missing required field: destination or destinations", 400);
  }

  const settings = await deps.tenantInfra.getSettings(auth.tenantId);
  const activeCount = await deps.endpointRepo.countActiveByTenant(auth.tenantId);
  if (settings.billing_plan === "free" && activeCount >= 1) {
    return errorResponse(
      "Plan Gratis: solo 1 endpoint activo. Pausa un endpoint existente o actualiza el plan (véase facturación).",
      402
    );
  }

  const baseUrl =
    env.ENVIRONMENT === "production"
      ? "https://sentinel-saas-prod.yourworker.workers.dev"
      : env.WORKER_URL;

  const useCase = new CreateEndpoint(deps.endpointRepo, baseUrl, env.SENTINEL_DESTINATION_SECRET_KEY);

  try {
    const result = await useCase.execute({
      tenantId: auth.tenantId,
      name: body["name"] as string,
      schema: body["schema"] as Record<string, unknown>,
      ...(body["destination"]
        ? {
            destination: body["destination"] as import("../../../domain/events/entities/Endpoint.js").Destination,
          }
        : {}),
      ...(body["destinations"]
        ? {
            destinations: body["destinations"] as import("../../../domain/events/entities/Endpoint.js").Destination[],
          }
        : {}),
      ...(body["healingConfig"]
        ? {
            healingConfig: body["healingConfig"] as Partial<
              import("../../../domain/events/entities/Endpoint.js").HealingConfig
            >,
          }
        : {}),
      ...(body["environment"]
        ? {
            environment: body["environment"] as import("../../../domain/events/entities/Endpoint.js").DeploymentEnvironment,
          }
        : {}),
    });
    return jsonResponse(result, 201);
  } catch (e) {
    return errorResponse(e instanceof Error ? e.message : "Failed to create endpoint", 400);
  }
}

async function handleUpdateEndpoint(
  id: string,
  request: Request,
  auth: AuthContext,
  deps: Dependencies,
  env: WorkerEnv
): Promise<Response> {
  const body = (await request.json()) as Record<string, unknown>;
  const useCase = new UpdateEndpoint(deps.endpointRepo, env.SENTINEL_DESTINATION_SECRET_KEY);
  try {
    const result = await useCase.execute({
      tenantId: auth.tenantId,
      endpointId: id,
      ...(body["name"] !== undefined ? { name: body["name"] as string } : {}),
      ...(body["schema"] !== undefined ? { schema: body["schema"] as Record<string, unknown> } : {}),
      ...(body["destinations"] !== undefined
        ? {
            destinations: body["destinations"] as import("../../../domain/events/entities/Endpoint.js").Destination[],
          }
        : {}),
      ...(body["healingConfig"] !== undefined
        ? {
            healingConfig: body["healingConfig"] as Partial<
              import("../../../domain/events/entities/Endpoint.js").HealingConfig
            >,
          }
        : {}),
      ...(body["environment"] !== undefined
        ? {
            environment: body["environment"] as import("../../../domain/events/entities/Endpoint.js").DeploymentEnvironment,
          }
        : {}),
      ...(body["status"] !== undefined
        ? { status: body["status"] as import("../../../domain/events/entities/Endpoint.js").EndpointStatus }
        : {}),
    });
    return jsonResponse(result);
  } catch (e) {
    return errorResponse(e instanceof Error ? e.message : "Failed to update endpoint", 400);
  }
}

async function handleListEndpoints(auth: AuthContext, deps: Dependencies): Promise<Response> {
  const endpoints = await new ListEndpoints(deps.endpointRepo).execute(auth.tenantId);
  return jsonResponse({ data: endpoints, count: endpoints.length });
}

async function handleGetEndpoint(id: string, auth: AuthContext, deps: Dependencies): Promise<Response> {
  const endpoint = await new GetEndpoint(deps.endpointRepo).execute({
    endpointId: id,
    tenantId: auth.tenantId,
  });
  if (!endpoint) return errorResponse("Endpoint not found", 404);
  return jsonResponse(endpoint);
}

async function handleDeleteEndpoint(id: string, auth: AuthContext, deps: Dependencies): Promise<Response> {
  await new DeleteEndpoint(deps.endpointRepo).execute({
    endpointId: id,
    tenantId: auth.tenantId,
  });
  return jsonResponse({ deleted: true });
}

async function handleListEvents(
  endpointId: string,
  auth: AuthContext,
  url: URL,
  deps: Dependencies
): Promise<Response> {
  const status = url.searchParams.get("status") as
    | import("../../../domain/events/entities/RawEvent.js").EventStatus
    | null;
  const limit = parseInt(url.searchParams.get("limit") ?? "20", 10);
  const offset = parseInt(url.searchParams.get("offset") ?? "0", 10);

  const result = await deps.eventRepo.findByTenantAndEndpoint({
    tenantId: auth.tenantId,
    endpointId,
    ...(status ? { status } : {}),
    limit,
    offset,
  });

  return jsonResponse({
    data: result.events.map((e) => e.toSnapshot()),
    total: result.total,
    limit,
    offset,
  });
}

async function handleListRules(
  endpointId: string,
  auth: AuthContext,
  deps: Dependencies
): Promise<Response> {
  const rules = await deps.ruleRepo.findByEndpoint({
    tenantId: auth.tenantId,
    endpointId,
    limit: 50,
  });
  return jsonResponse({ data: rules.map((r) => r.toSnapshot()), count: rules.length });
}

async function handleListDLQ(auth: AuthContext, url: URL, deps: Dependencies): Promise<Response> {
  const limit = parseInt(url.searchParams.get("limit") ?? "20", 10);
  const offset = parseInt(url.searchParams.get("offset") ?? "0", 10);
  const endpointId = url.searchParams.get("endpointId");

  const result = await deps.eventRepo.findByTenantAndEndpoint({
    tenantId: auth.tenantId,
    ...(endpointId ? { endpointId } : {}),
    status: "dead",
    limit,
    offset,
  });

  return jsonResponse({ data: result.events.map((e) => e.toSnapshot()), total: result.total });
}

async function handleReinjectDlq(
  eventId: string,
  request: Request,
  auth: AuthContext,
  deps: Dependencies
): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const correctedPayload = body["correctedPayload"] as Record<string, unknown> | undefined;
  const snapshotName = typeof body["snapshotName"] === "string" ? body["snapshotName"] : undefined;

  const uc = new ReinjectDlqEvent(
    deps.eventRepo,
    deps.endpointRepo,
    buildProcessWebhookUseCase(deps),
    deps.tenantInfra
  );
  try {
    const result = await uc.execute({
      tenantId: auth.tenantId,
      eventId,
      correctedPayload,
      actorEmail: auth.email,
      snapshotName,
    });
    return jsonResponse(result);
  } catch (e) {
    return errorResponse(e instanceof Error ? e.message : "Reinject failed", 400);
  }
}

async function handleDiscardDlq(eventId: string, auth: AuthContext, deps: Dependencies): Promise<Response> {
  const uc = new DiscardDlqEvent(deps.eventRepo);
  try {
    await uc.execute({ tenantId: auth.tenantId, eventId });
    return jsonResponse({ discarded: true });
  } catch (e) {
    return errorResponse(e instanceof Error ? e.message : "Discard failed", 400);
  }
}

async function handleListDlqSnapshots(eventId: string, auth: AuthContext, deps: Dependencies): Promise<Response> {
  const rows = await deps.tenantInfra.listSnapshotsForEvent(auth.tenantId, eventId);
  return jsonResponse({ data: rows });
}

async function handleDlqDiff(eventId: string, url: URL, auth: AuthContext, deps: Dependencies): Promise<Response> {
  const snapshotId = url.searchParams.get("snapshotId");
  if (!snapshotId) return errorResponse("snapshotId query required", 400);

  const snap = await deps.tenantInfra.getSnapshotById(auth.tenantId, snapshotId);
  if (!snap || (snap as { event_id?: string }).event_id !== eventId) {
    return errorResponse("Snapshot not found", 404);
  }

  const ev = await deps.eventRepo.findById(eventId);
  if (!ev || ev.tenantId !== auth.tenantId || ev.status !== "dead") {
    return errorResponse("Event not in DLQ", 404);
  }

  const left = (snap as { payload?: unknown }).payload;
  const right = ev.rawPayload;
  return jsonResponse({
    snapshotId,
    eventId,
    left,
    right,
    sameJson: JSON.stringify(left) === JSON.stringify(right),
  });
}

async function handleGetSettings(auth: AuthContext, deps: Dependencies): Promise<Response> {
  const s = await deps.tenantInfra.getSettings(auth.tenantId);
  return jsonResponse(s);
}

async function handlePutSettings(request: Request, auth: AuthContext, deps: Dependencies): Promise<Response> {
  const body = (await request.json()) as Record<string, unknown>;
  await deps.tenantInfra.upsertSettings(auth.tenantId, {
    notify_email_healing: body["notify_email_healing"] as boolean | undefined,
    notify_email_dead: body["notify_email_dead"] as boolean | undefined,
    notify_email_pending_rules: body["notify_email_pending_rules"] as boolean | undefined,
    slack_on_incidents: body["slack_on_incidents"] as boolean | undefined,
    slack_incoming_webhook_url: body["slack_incoming_webhook_url"] as string | null | undefined,
    alert_webhook_url: body["alert_webhook_url"] as string | null | undefined,
    alert_webhook_secret: body["alert_webhook_secret"] as string | null | undefined,
  });
  return jsonResponse({ saved: true });
}

async function handleDependencyGraph(auth: AuthContext, deps: Dependencies): Promise<Response> {
  const endpoints = await deps.endpointRepo.findByTenantId(auth.tenantId);
  const nodes: unknown[] = [];
  const edges: { from: string; to: string; label: string }[] = [];

  for (const ep of endpoints) {
    const snap = ep.toSnapshot();
    nodes.push({ id: ep.id, type: "endpoint", name: ep.name, slug: ep.slug, environment: ep.environment });
    ep.destinations.forEach((d, i) => {
      const label = `${d.type} #${i + 1}`;
      edges.push({ from: ep.id, to: `${d.type}-${i}`, label });
    });
  }

  return jsonResponse({ nodes, edges });
}

async function handleAiHistory(url: URL, auth: AuthContext, deps: Dependencies): Promise<Response> {
  const limit = parseInt(url.searchParams.get("limit") ?? "40", 10);
  const rows = await deps.tenantInfra.listAiDecisionLogs(auth.tenantId, limit);
  return jsonResponse({ data: rows });
}

async function handleStageMetrics(url: URL, auth: AuthContext, deps: Dependencies): Promise<Response> {
  const hours = parseInt(url.searchParams.get("hours") ?? "24", 10);
  const since = new Date(Date.now() - hours * 3600 * 1000).toISOString();
  const rows = await deps.tenantInfra.listStageMetrics(auth.tenantId, since);
  return jsonResponse({ data: rows, hours });
}

async function handleHeuristicSuggestions(auth: AuthContext, deps: Dependencies): Promise<Response> {
  const since = new Date(Date.now() - 6 * 3600 * 1000).toISOString();
  const rows = (await deps.tenantInfra.listStageMetrics(auth.tenantId, since)) as {
    stage?: string;
    latency_ms?: number;
  }[];

  const dispatchLatencies = rows.filter((r) => r.stage === "dispatch").map((r) => r.latency_ms ?? 0);
  const avg =
    dispatchLatencies.length > 0
      ? dispatchLatencies.reduce((a, b) => a + b, 0) / dispatchLatencies.length
      : 0;

  const suggestions: { id: string; text: string; severity: string }[] = [];
  if (avg > 2500) {
    suggestions.push({
      id: "timeout-batch",
      text: "Las entregas a destinos tardan más de 2,5s de media: considera subir timeout en Transform/webhook durante ventanas batch nocturnas.",
      severity: "info",
    });
  }
  if (rows.length < 3) {
    suggestions.push({
      id: "instrumentation",
      text: "Pocas muestras de métricas en las últimas horas: envía tráfico de prueba o revisa el Worker.",
      severity: "low",
    });
  }

  return jsonResponse({ suggestions, basedOnSamples: rows.length });
}

async function handleListEventNotes(eventId: string, auth: AuthContext, deps: Dependencies): Promise<Response> {
  const rows = await deps.tenantInfra.listEventNotes(auth.tenantId, eventId);
  return jsonResponse({ data: rows });
}

async function handleAddEventNote(
  eventId: string,
  request: Request,
  auth: AuthContext,
  deps: Dependencies
): Promise<Response> {
  const body = (await request.json()) as Record<string, unknown>;
  const text = body["body"];
  if (typeof text !== "string" || !text.trim()) return errorResponse("body required", 400);
  await deps.tenantInfra.addEventNote({
    tenantId: auth.tenantId,
    eventId,
    authorId: auth.tenantId,
    body: text.trim(),
  });
  return jsonResponse({ created: true }, 201);
}

async function handleListEventTags(eventId: string, auth: AuthContext, deps: Dependencies): Promise<Response> {
  const rows = await deps.tenantInfra.listEventTags(auth.tenantId, eventId);
  return jsonResponse({ data: rows });
}

async function handleAddEventTag(
  eventId: string,
  request: Request,
  auth: AuthContext,
  deps: Dependencies
): Promise<Response> {
  const body = (await request.json()) as Record<string, unknown>;
  const tag = body["tag"];
  if (typeof tag !== "string" || !tag.trim()) return errorResponse("tag required", 400);
  await deps.tenantInfra.upsertEventTag({
    tenantId: auth.tenantId,
    eventId,
    tag: tag.trim().slice(0, 64),
    source: "manual",
  });
  return jsonResponse({ saved: true });
}

async function handleListMaintenanceWindows(auth: AuthContext, deps: Dependencies): Promise<Response> {
  const rows = await deps.tenantInfra.listMaintenanceWindows(auth.tenantId);
  return jsonResponse({ data: rows });
}

async function handleCreateMaintenanceWindow(
  request: Request,
  auth: AuthContext,
  deps: Dependencies
): Promise<Response> {
  const body = (await request.json()) as Record<string, unknown>;
  if (!body["title"] || !body["starts_at"] || !body["ends_at"]) {
    return errorResponse("title, starts_at, ends_at required", 400);
  }
  try {
    const row = await deps.tenantInfra.createMaintenanceWindow({
      tenantId: auth.tenantId,
      title: body["title"] as string,
      startsAt: body["starts_at"] as string,
      endsAt: body["ends_at"] as string,
      timezone: typeof body["timezone"] === "string" ? body["timezone"] : undefined,
      scope: typeof body["scope"] === "string" ? body["scope"] : undefined,
      endpointIds: Array.isArray(body["endpoint_ids"]) ? (body["endpoint_ids"] as string[]) : undefined,
      suppressNonCritical: typeof body["suppress_non_critical_alerts"] === "boolean"
        ? body["suppress_non_critical_alerts"]
        : undefined,
    });
    return jsonResponse(row, 201);
  } catch (e) {
    return errorResponse(e instanceof Error ? e.message : "Failed", 400);
  }
}

async function handleApproveMaintenanceWindow(id: string, auth: AuthContext, deps: Dependencies): Promise<Response> {
  try {
    await deps.tenantInfra.approveMaintenanceWindow(auth.tenantId, id);
    return jsonResponse({ approved: true });
  } catch (e) {
    return errorResponse(e instanceof Error ? e.message : "Failed", 400);
  }
}

async function handleBillingStatus(auth: AuthContext, deps: Dependencies): Promise<Response> {
  const s = await deps.tenantInfra.getSettings(auth.tenantId);
  return jsonResponse({
    plan: s.billing_plan,
    stripeCustomerId: s.billing_plan === "pro" ? "(configurar Stripe — Fase 9)" : null,
    portalUrl: null,
    note: "Facturación self-service en roadmap; límites del plan free aplicados en la API.",
  });
}

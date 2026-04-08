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
} from "../../../application/use-cases/ManageEndpoint.js";
import { buildDependencies } from "../../container.js";
import { generateId } from "../../utils/crypto.js";
import { createLogger } from "../../utils/logger.js";

const logger = createLogger("Router");

export async function handleRequest(request: Request, env: WorkerEnv): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  const deps = buildDependencies(env);

  try {
    // ── Public: webhook receiver ───────────────────────────────────────────
    if (method === "POST" && path.match(/^\/webhook\/[\w-]+\/[\w-]+$/)) {
      return await handleWebhook(request, url, env, deps);
    }

    // ── Health ─────────────────────────────────────────────────────────────
    if (path === "/health" && method === "GET") {
      return jsonResponse({ status: "ok", version: "2.0.0", ts: new Date().toISOString() });
    }

    // ── Protected routes ───────────────────────────────────────────────────
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

    return errorResponse("Not found", 404);
  } catch (e) {
    logger.error("Unhandled error", { error: e, path, method });
    return errorResponse(e instanceof Error ? e.message : "Internal server error", 500);
  }
}

// ── Route handlers ────────────────────────────────────────────────────────────

async function handleWebhook(
  request: Request,
  url: URL,
  env: WorkerEnv,
  deps: ReturnType<typeof buildDependencies>
): Promise<Response> {
  const [, , tenantId, endpointSlug] = url.pathname.split("/");
  if (!tenantId || !endpointSlug) return errorResponse("Invalid webhook URL", 400);

  const { allowed } = await checkRateLimit(env.RULE_CACHE, `webhook:${tenantId}`, 1000, 60);
  if (!allowed) return errorResponse("Rate limit exceeded", 429);

  const body = await request.text();

  // Optional signature verification
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
  request.headers.forEach((value, key) => { requestHeaders[key] = value; });

  const useCase = new ProcessWebhookEvent(
    deps.eventRepo,
    deps.endpointRepo,
    deps.ruleRepo,
    deps.ruleCache,
    deps.llmService,
    deps.storageService,
    deps.notificationService,
    deps.sandboxService,
    deps.outputDispatcher // NEW
  );

  const result = await useCase.execute({
    eventId,
    tenantId,
    endpointSlug,
    rawPayload,
    metadata: {
      contentType: request.headers.get("Content-Type") ?? "application/json",
      headers: requestHeaders,
      ...(request.headers.get("CF-Connecting-IP") ? { ipAddress: request.headers.get("CF-Connecting-IP")! } : {}),
      ...(request.headers.get("User-Agent") ? { userAgent: request.headers.get("User-Agent")! } : {}),
    },
    origin: request.headers.get("Origin") ?? url.origin,
  });

  return jsonResponse(result, result.status === "dead" ? 422 : 200);
}

async function handleCreateEndpoint(
  request: Request,
  auth: AuthContext,
  deps: ReturnType<typeof buildDependencies>,
  env: WorkerEnv
): Promise<Response> {
  const body = await request.json() as Record<string, unknown>;

  if (!body["name"] || !body["schema"]) {
    return errorResponse("Missing required fields: name, schema", 400);
  }

  // Must have at least one of: destination (single) or destinations (array)
  if (!body["destination"] && !body["destinations"]) {
    return errorResponse("Missing required field: destination or destinations", 400);
  }

  const baseUrl =
    env.ENVIRONMENT === "production"
      ? "https://sentinel-saas-prod.yourworker.workers.dev"
      : env.WORKER_URL;

  const useCase = new CreateEndpoint(
    deps.endpointRepo,
    baseUrl,
    env.SENTINEL_DESTINATION_SECRET_KEY
  );

  try {
    const result = await useCase.execute({
      tenantId: auth.tenantId,
      name: body["name"] as string,
      schema: body["schema"] as Record<string, unknown>,
      ...(body["destination"]  ? { destination: body["destination"] as import("../../../domain/events/entities/Endpoint.js").Destination } : {}),
      ...(body["destinations"] ? { destinations: body["destinations"] as import("../../../domain/events/entities/Endpoint.js").Destination[] } : {}),
      ...(body["healingConfig"] ? { healingConfig: body["healingConfig"] as Partial<import("../../../domain/events/entities/Endpoint.js").HealingConfig> } : {}),
    });
    return jsonResponse(result, 201);
  } catch (e) {
    return errorResponse(e instanceof Error ? e.message : "Failed to create endpoint", 400);
  }
}

async function handleListEndpoints(
  auth: AuthContext,
  deps: ReturnType<typeof buildDependencies>
): Promise<Response> {
  const endpoints = await new ListEndpoints(deps.endpointRepo).execute(auth.tenantId);
  return jsonResponse({ data: endpoints, count: endpoints.length });
}

async function handleGetEndpoint(
  id: string,
  auth: AuthContext,
  deps: ReturnType<typeof buildDependencies>
): Promise<Response> {
  const endpoint = await new GetEndpoint(deps.endpointRepo).execute({
    endpointId: id,
    tenantId: auth.tenantId,
  });
  if (!endpoint) return errorResponse("Endpoint not found", 404);
  return jsonResponse(endpoint);
}

async function handleDeleteEndpoint(
  id: string,
  auth: AuthContext,
  deps: ReturnType<typeof buildDependencies>
): Promise<Response> {
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
  deps: ReturnType<typeof buildDependencies>
): Promise<Response> {
  const status = url.searchParams.get("status") as
    import("../../../domain/events/entities/RawEvent.js").EventStatus | null;
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
  deps: ReturnType<typeof buildDependencies>
): Promise<Response> {
  const rules = await deps.ruleRepo.findByEndpoint({
    tenantId: auth.tenantId,
    endpointId,
    limit: 50,
  });
  return jsonResponse({ data: rules.map((r) => r.toSnapshot()), count: rules.length });
}

async function handleListDLQ(
  auth: AuthContext,
  url: URL,
  deps: ReturnType<typeof buildDependencies>
): Promise<Response> {
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

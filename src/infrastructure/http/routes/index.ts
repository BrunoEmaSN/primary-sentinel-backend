// src/infrastructure/http/routes/index.ts
// API Gateway router — maps HTTP requests to use cases

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

export async function handleRequest(
  request: Request,
  env: WorkerEnv
): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  // CORS preflight
  if (method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Sentinel-Signature",
      },
    });
  }

  const deps = buildDependencies(env);

  try {
    // ── Public: Webhook Receiver ─────────────────────────────────────────
    // POST /webhook/:tenantId/:endpointSlug
    if (method === "POST" && path.match(/^\/webhook\/[\w-]+\/[\w-]+$/)) {
      return await handleWebhook(request, url, env, deps);
    }

    // ── Health Check ─────────────────────────────────────────────────────
    if (path === "/health" && method === "GET") {
      return jsonResponse({ status: "ok", version: "1.0.0", ts: new Date().toISOString() });
    }

    // ── Protected API Routes (require JWT) ───────────────────────────────
    const authResult = await authenticateRequest(request, env);
    if (authResult instanceof Response) return authResult;
    const auth = authResult as AuthContext;

    // POST /api/endpoints — Create endpoint
    if (path === "/api/endpoints" && method === "POST") {
      return await handleCreateEndpoint(request, auth, deps, env);
    }

    // GET /api/endpoints — List endpoints
    if (path === "/api/endpoints" && method === "GET") {
      return await handleListEndpoints(auth, deps);
    }

    // GET /api/endpoints/:id — Get endpoint
    if (path.match(/^\/api\/endpoints\/[\w-]+$/) && method === "GET") {
      const id = path.split("/").pop()!;
      return await handleGetEndpoint(id, auth, deps);
    }

    // DELETE /api/endpoints/:id — Delete endpoint
    if (path.match(/^\/api\/endpoints\/[\w-]+$/) && method === "DELETE") {
      const id = path.split("/").pop()!;
      return await handleDeleteEndpoint(id, auth, deps);
    }

    // GET /api/endpoints/:id/events — List events for endpoint
    if (path.match(/^\/api\/endpoints\/[\w-]+\/events$/) && method === "GET") {
      const id = path.split("/")[3]!;
      return await handleListEvents(id, auth, url, deps);
    }

    // GET /api/endpoints/:id/rules — List transformation rules
    if (path.match(/^\/api\/endpoints\/[\w-]+\/rules$/) && method === "GET") {
      const id = path.split("/")[3]!;
      return await handleListRules(id, auth, deps);
    }

    // GET /api/dlq — List DLQ items
    if (path === "/api/dlq" && method === "GET") {
      return await handleListDLQ(auth, url, deps);
    }

    return errorResponse("Not found", 404);
  } catch (e) {
    logger.error("Unhandled error", { error: e, path, method });
    const message = e instanceof Error ? e.message : "Internal server error";
    return errorResponse(message, 500);
  }
}

// ── Route Handlers ───────────────────────────────────────────────────────────

async function handleWebhook(
  request: Request,
  url: URL,
  env: WorkerEnv,
  deps: ReturnType<typeof buildDependencies>
): Promise<Response> {
  const [, , tenantId, endpointSlug] = url.pathname.split("/");
  if (!tenantId || !endpointSlug) return errorResponse("Invalid webhook URL", 400);

  // Rate limiting: 1000 req/min per tenant
  const { allowed } = await checkRateLimit(env.RULE_CACHE, `webhook:${tenantId}`, 1000, 60);
  if (!allowed) return errorResponse("Rate limit exceeded", 429);

  const body = await request.text();

  // Validate webhook signature if provided
  const signature = request.headers.get("X-Sentinel-Signature");
  if (signature) {
    const endpoint = await deps.endpointRepo.findBySlug({ tenantId, slug: endpointSlug });
    if (endpoint) {
      const valid = await validateWebhookSignature(request, body, endpoint.webhookSecret);
      if (!valid) return unauthorizedResponse("Invalid webhook signature");
    }
  }

  let rawPayload: unknown;
  try {
    rawPayload = JSON.parse(body);
  } catch {
    return errorResponse("Invalid JSON payload", 400);
  }

  // Generate idempotency key from content hash or use provided header
  const eventId = request.headers.get("X-Event-ID") ??
    request.headers.get("X-Idempotency-Key") ??
    generateId();

  const useCase = new ProcessWebhookEvent(
    deps.eventRepo,
    deps.endpointRepo,
    deps.ruleRepo,
    deps.ruleCache,
    deps.llmService,
    deps.queueService,
    deps.storageService,
    deps.notificationService,
    deps.sandboxService
  );
  const requestHeaders: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    requestHeaders[key] = value;
  });
  const ipAddress = request.headers.get("CF-Connecting-IP");
  const userAgent = request.headers.get("User-Agent");

  const result = await useCase.execute({
    eventId,
    tenantId,
    endpointSlug,
    rawPayload,
    metadata: {
      contentType: request.headers.get("Content-Type") ?? "application/json",
      headers: requestHeaders,
      ...(ipAddress !== null ? { ipAddress } : {}),
      ...(userAgent !== null ? { userAgent } : {}),
    },
    origin: request.headers.get("Origin") ?? url.origin,
  });

  const statusCode = result.status === "dead" ? 422 : 200;
  return jsonResponse(result, statusCode);
}

async function handleCreateEndpoint(
  request: Request,
  auth: AuthContext,
  deps: ReturnType<typeof buildDependencies>,
  env: WorkerEnv
): Promise<Response> {
  const body = await request.json() as Record<string, unknown>;

  if (!body["name"] || !body["schema"] || !body["destination"]) {
    return errorResponse("Missing required fields: name, schema, destination", 400);
  }

  const useCase = new CreateEndpoint(
    deps.endpointRepo,
    `https://${env.ENVIRONMENT === "production" ? "api.sentinel.yourdomain.com" : "sentinel-saas-dev.yourworker.workers.dev"}`
  );
  const healingConfig = body["healingConfig"] as
    Partial<import("../../../domain/events/entities/Endpoint.js").HealingConfig> |
    undefined;

  const result = await useCase.execute({
    tenantId: auth.tenantId,
    name: body["name"] as string,
    schema: body["schema"] as Record<string, unknown>,
    destination: body["destination"] as import("../../../domain/events/entities/Endpoint.js").Destination,
    ...(healingConfig ? { healingConfig } : {}),
  });

  return jsonResponse(result, 201);
}

async function handleListEndpoints(
  auth: AuthContext,
  deps: ReturnType<typeof buildDependencies>
): Promise<Response> {
  const useCase = new ListEndpoints(deps.endpointRepo);
  const endpoints = await useCase.execute(auth.tenantId);
  return jsonResponse({ data: endpoints, count: endpoints.length });
}

async function handleGetEndpoint(
  id: string,
  auth: AuthContext,
  deps: ReturnType<typeof buildDependencies>
): Promise<Response> {
  const useCase = new GetEndpoint(deps.endpointRepo);
  const endpoint = await useCase.execute({ endpointId: id, tenantId: auth.tenantId });
  if (!endpoint) return errorResponse("Endpoint not found", 404);
  return jsonResponse(endpoint);
}

async function handleDeleteEndpoint(
  id: string,
  auth: AuthContext,
  deps: ReturnType<typeof buildDependencies>
): Promise<Response> {
  const useCase = new DeleteEndpoint(deps.endpointRepo);
  await useCase.execute({ endpointId: id, tenantId: auth.tenantId });
  return jsonResponse({ deleted: true });
}

async function handleListEvents(
  endpointId: string,
  auth: AuthContext,
  url: URL,
  deps: ReturnType<typeof buildDependencies>
): Promise<Response> {
  const status = url.searchParams.get("status") as import("../../../domain/events/entities/RawEvent.js").EventStatus | undefined;
  const limit = parseInt(url.searchParams.get("limit") ?? "20", 10);
  const offset = parseInt(url.searchParams.get("offset") ?? "0", 10);

  const result = await deps.eventRepo.findByTenantAndEndpoint({
    tenantId: auth.tenantId,
    endpointId,
    ...(status !== undefined ? { status } : {}),
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

  return jsonResponse({
    data: result.events.map((e) => e.toSnapshot()),
    total: result.total,
  });
}

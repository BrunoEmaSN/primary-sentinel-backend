// src/infrastructure/http/cors.ts

import type { WorkerEnv } from "./workerEnv.js";

function parseAllowedOrigins(env: WorkerEnv): string[] | null {
  const raw = env.ALLOWED_ORIGINS?.trim();
  if (!raw) return null;
  const list = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return list.length > 0 ? list : null;
}

function corsDevFallbackEnabled(env: WorkerEnv): boolean {
  const raw = env.ALLOW_CORS_DEV?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

/**
 * CORS for browser calls from Vercel (or any origin).
 * If `env.ALLOWED_ORIGINS` is set (comma-separated), only listed origins get ACAO;
 * requests without `Origin` (curl, server-to-server) still get `*` in that mode.
 * If unset/empty: en producción no se refleja `Origin` arbitrario (salvo `ALLOW_CORS_DEV`);
 * fuera de producción refleja `Origin` cuando está presente (dev), si no `*`.
 */
export function buildCorsHeaders(request: Request, env: WorkerEnv): Record<string, string> {
  const origin = request.headers.get("Origin");
  const allowlist = parseAllowedOrigins(env);
  const isProd = env.ENVIRONMENT === "production";

  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers":
      "Authorization, Content-Type, Accept-Language, X-Sentinel-Signature, X-Sentinel-Locale, X-Event-ID, X-Requested-With, X-Sentinel-Internal-Policy-Key",
    "Access-Control-Max-Age": "86400",
  };

  if (allowlist === null) {
    if (isProd && !corsDevFallbackEnabled(env)) {
      if (origin) {
        /* Intencionalmente sin ACAO: el navegador bloquea credenciales cross-site. */
        headers["Vary"] = "Origin";
      } else {
        headers["Access-Control-Allow-Origin"] = "*";
      }
      return headers;
    }
    if (origin) {
      headers["Access-Control-Allow-Origin"] = origin;
      headers["Vary"] = "Origin";
    } else {
      headers["Access-Control-Allow-Origin"] = "*";
    }
    return headers;
  }

  if (origin) {
    if (allowlist.includes(origin)) {
      headers["Access-Control-Allow-Origin"] = origin;
      headers["Vary"] = "Origin";
    }
  } else {
    headers["Access-Control-Allow-Origin"] = "*";
  }
  return headers;
}

export function preflightResponse(request: Request, env: WorkerEnv): Response {
  return new Response(null, {
    status: 204,
    headers: buildCorsHeaders(request, env),
  });
}

export function withCors(
  response: Response,
  request: Request,
  env: WorkerEnv
): Response {
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(buildCorsHeaders(request, env))) {
    headers.set(k, v);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function jsonErrorWithCors(
  request: Request,
  body: unknown,
  status: number,
  env: WorkerEnv
): Response {
  const headers = new Headers({ "Content-Type": "application/json" });
  for (const [k, v] of Object.entries(buildCorsHeaders(request, env))) {
    headers.set(k, v);
  }
  return new Response(JSON.stringify(body), { status, headers });
}

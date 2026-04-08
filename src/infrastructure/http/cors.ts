// src/infrastructure/http/cors.ts

/**
 * CORS for browser calls from Vercel (or any origin). Reflects `Origin` when present
 * so preflight and real responses always carry Access-Control-Allow-Origin (some stacks
 * mishandle wildcard + Authorization).
 */
export function buildCorsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get("Origin");
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers":
      "Authorization, Content-Type, X-Sentinel-Signature, X-Event-ID, X-Requested-With",
    "Access-Control-Max-Age": "86400",
  };
  if (origin) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Vary"] = "Origin";
  } else {
    headers["Access-Control-Allow-Origin"] = "*";
  }
  return headers;
}

export function preflightResponse(request: Request): Response {
  return new Response(null, {
    status: 204,
    headers: buildCorsHeaders(request),
  });
}

export function withCors(response: Response, request: Request): Response {
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(buildCorsHeaders(request))) {
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
  status: number
): Response {
  const headers = new Headers({ "Content-Type": "application/json" });
  for (const [k, v] of Object.entries(buildCorsHeaders(request))) {
    headers.set(k, v);
  }
  return new Response(JSON.stringify(body), { status, headers });
}

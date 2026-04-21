// src/infrastructure/http/middleware/auth.ts

import { createClient } from "@supabase/supabase-js";
import { createLogger } from "../../utils/logger.js";
import type { ApiLocale } from "../i18n/apiLocale.js";
import { apiT } from "../i18n/apiMessages.js";
import type { WorkerEnv } from "../workerEnv.js";

const logger = createLogger("AuthMiddleware");

export type AuthContext = {
  tenantId: string;
  email: string;
  role: string;
};

export type { WorkerEnv } from "../workerEnv.js";

export async function authenticateRequest(
  request: Request,
  env: WorkerEnv,
  locale: ApiLocale
): Promise<AuthContext | Response> {
  const authorization = request.headers.get("Authorization");
  if (!authorization?.startsWith("Bearer ")) {
    return unauthorizedResponse(apiT(locale, "missingAuthHeader"));
  }

  const token = authorization.slice(7);
  try {
    const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY);
    const { data: { user }, error } = await supabase.auth.getUser(token);

    if (error || !user) {
      logger.warn("Invalid token", { error: error?.message });
      return unauthorizedResponse(apiT(locale, "invalidToken"));
    }

    return {
      tenantId: user.id,
      email: user.email ?? "",
      role: user.role ?? "authenticated",
    };
  } catch (e) {
    logger.error("Auth check failed", { error: e });
    return unauthorizedResponse(apiT(locale, "authServiceError"));
  }
}

export async function validateWebhookSignature(
  _request: Request,
  body: string,
  secret: string,
  signature: string
): Promise<boolean> {
  if (!signature) return false;

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"]
  );

  const sigHex = signature.replace("sha256=", "");
  const sigBytes = new Uint8Array(
    sigHex.match(/.{2}/g)!.map((b) => parseInt(b, 16))
  );

  return await crypto.subtle.verify(
    "HMAC",
    key,
    sigBytes.buffer,
    encoder.encode(body)
  );
}

export async function checkRateLimit(
  kv: KVNamespace,
  key: string,
  limit: number,
  windowSeconds: number
): Promise<{ allowed: boolean; remaining: number }> {
  const kvKey = `ratelimit:${key}`;
  const current = await kv.get(kvKey);
  const count = current ? parseInt(current, 10) : 0;
  if (count >= limit) return { allowed: false, remaining: 0 };
  await kv.put(kvKey, String(count + 1), { expirationTtl: windowSeconds });
  return { allowed: true, remaining: limit - count - 1 };
}

export function unauthorizedResponse(message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status: 401, headers: { "Content-Type": "application/json" },
  });
}

export function errorResponse(message: string, status = 500): Response {
  return new Response(JSON.stringify({ error: message }), {
    status, headers: { "Content-Type": "application/json" },
  });
}

export function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "X-Sentinel-Version": "2.0.0",
    },
  });
}

declare global {
  interface KVNamespace {
    get(key: string): Promise<string | null>;
    put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  }
}

// src/infrastructure/http/middleware/auth.ts
// JWT + API Key authentication middleware for Cloudflare Workers

import { createClient } from "@supabase/supabase-js";
import { createLogger } from "../../utils/logger.js";

const logger = createLogger("AuthMiddleware");

export type AuthContext = {
  tenantId: string;
  email: string;
  role: string;
};

export type WorkerEnv = {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_KEY: string;
  ANTHROPIC_API_KEY: string;
  UPSTASH_REDIS_REST_URL: string;
  UPSTASH_REDIS_REST_TOKEN: string;
  UPSTASH_KAFKA_URL: string;
  UPSTASH_KAFKA_USERNAME: string;
  UPSTASH_KAFKA_PASSWORD: string;
  RESEND_API_KEY: string;
  SENTINEL_WEBHOOK_SECRET: string;
  RULE_CACHE: KVNamespace;
  DLQ_BUCKET: R2Bucket;
  EVENT_QUEUE: Queue;
  ENVIRONMENT: string;
};

/**
 * Validates a Bearer JWT from Supabase Auth
 */
export async function authenticateRequest(
  request: Request,
  env: WorkerEnv
): Promise<AuthContext | Response> {
  const authorization = request.headers.get("Authorization");

  if (!authorization?.startsWith("Bearer ")) {
    return unauthorizedResponse("Missing or invalid Authorization header");
  }

  const token = authorization.slice(7);

  try {
    const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY);
    const { data: { user }, error } = await supabase.auth.getUser(token);

    if (error || !user) {
      logger.warn("Invalid token", { error: error?.message });
      return unauthorizedResponse("Invalid or expired token");
    }

    return {
      tenantId: user.id, // User ID is the tenant ID in single-tenant-per-user model
      email: user.email ?? "",
      role: user.role ?? "authenticated",
    };
  } catch (e) {
    logger.error("Auth check failed", { error: e });
    return unauthorizedResponse("Authentication service error");
  }
}

/**
 * Validates HMAC-SHA256 webhook signature
 */
export async function validateWebhookSignature(
  request: Request,
  body: string,
  secret: string
): Promise<boolean> {
  const signature = request.headers.get("X-Sentinel-Signature");
  if (!signature) return false;

  const encoder = new TextEncoder();
  const keyData = encoder.encode(secret);
  const messageData = encoder.encode(body);

  const key = await crypto.subtle.importKey(
    "raw",
    keyData,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"]
  );

  const signatureBytes = hexToBytes(signature.replace("sha256=", ""));
  const signatureBuffer = signatureBytes.buffer.slice(
    signatureBytes.byteOffset,
    signatureBytes.byteOffset + signatureBytes.byteLength
  );
  return await crypto.subtle.verify("HMAC", key, signatureBuffer, messageData);
}

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

export function unauthorizedResponse(message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status: 401,
    headers: { "Content-Type": "application/json" },
  });
}

export function forbiddenResponse(message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status: 403,
    headers: { "Content-Type": "application/json" },
  });
}

export function errorResponse(message: string, status = 500): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "X-Sentinel-Version": "1.0.0",
    },
  });
}

// ── Rate Limiter (Cloudflare KV-based) ────────────────────────────────────

export async function checkRateLimit(
  kv: KVNamespace,
  key: string,
  limit: number,
  windowSeconds: number
): Promise<{ allowed: boolean; remaining: number }> {
  const kvKey = `ratelimit:${key}`;
  const current = await kv.get(kvKey);
  const count = current ? parseInt(current, 10) : 0;

  if (count >= limit) {
    return { allowed: false, remaining: 0 };
  }

  await kv.put(kvKey, String(count + 1), { expirationTtl: windowSeconds });
  return { allowed: true, remaining: limit - count - 1 };
}

declare global {
  interface KVNamespace {
    get(key: string): Promise<string | null>;
    put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  }
  interface Queue {
    send(message: unknown): Promise<void>;
  }
}

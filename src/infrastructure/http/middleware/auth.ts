// src/infrastructure/http/middleware/auth.ts

import { createClient } from "@supabase/supabase-js";
import { createLogger } from "../../utils/logger.js";
import { timingSafeEqualUint8 } from "../../utils/crypto.js";
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
  signatureHeader: string
): Promise<boolean> {
  const trimmed = signatureHeader.trim();
  if (!trimmed) return false;

  const sigHex = trimmed.startsWith("sha256=") ? trimmed.slice(7).trim() : trimmed;
  if (!/^[0-9a-fA-F]+$/.test(sigHex) || sigHex.length % 2 !== 0) return false;

  const sigBytes = new Uint8Array(sigHex.length / 2);
  for (let i = 0; i < sigBytes.length; i++) {
    sigBytes[i] = Number.parseInt(sigHex.slice(i * 2, i * 2 + 2), 16);
  }

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const mac = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, encoder.encode(body))
  );
  if (mac.length !== sigBytes.length) return false;
  return timingSafeEqualUint8(mac, sigBytes);
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


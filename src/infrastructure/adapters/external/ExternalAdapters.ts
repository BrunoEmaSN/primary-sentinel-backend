// src/infrastructure/adapters/external/ExternalAdapters.ts

import { Redis } from "@upstash/redis";
import { createClient } from "@supabase/supabase-js";
import type { IRuleCache } from "../../../domain/healing/repositories/ITransformationRuleRepository.js";
import type {
  IStorageService,
  INotificationService,
  NotificationPayload,
} from "../../../application/ports/index.js";
import {
  decryptTenantPayload,
  TENANT_CRYPTO_INFO_DLQ_R2,
} from "../../utils/tenantIngestionCrypto.js";

// ── Upstash Redis — rule cache ────────────────────────────────────────────────

export class UpstashRuleCache implements IRuleCache {
  private redis: Redis;
  private prefix = "sentinel:rule:";

  constructor(url: string, token: string) {
    this.redis = new Redis({ url, token });
  }

  async get(fingerprint: string): Promise<string | null> {
    return await this.redis.get<string>(`${this.prefix}${fingerprint}`);
  }

  async set(fingerprint: string, ruleId: string, ttlSeconds = 86400): Promise<void> {
    await this.redis.set(`${this.prefix}${fingerprint}`, ruleId, { ex: ttlSeconds });
  }

  async invalidate(fingerprint: string): Promise<void> {
    await this.redis.del(`${this.prefix}${fingerprint}`);
  }
}

/** Rate limiting atómico (INCR + EX) sobre Upstash; evita TOCTOU de KV get/put. */
export class UpstashSlidingRateLimiter {
  private readonly prefix = "sentinel:ratelimit:";

  constructor(private readonly redis: Redis) {}

  async check(
    key: string,
    limit: number,
    windowSeconds: number
  ): Promise<{ allowed: boolean; remaining: number }> {
    const fullKey = `${this.prefix}${key}`;
    const count = await this.redis.incr(fullKey);
    if (count === 1) {
      await this.redis.expire(fullKey, windowSeconds);
    }
    if (count > limit) {
      return { allowed: false, remaining: 0 };
    }
    return { allowed: true, remaining: limit - count };
  }
}

// ── Cloudflare R2 — Dead Letter Queue storage ─────────────────────────────────

const DLQ_KEY_PREFIX = /^dlq\/([^/]+)\//;

export class R2StorageAdapter implements IStorageService {
  constructor(
    private bucket: R2Bucket,
    private readonly ingestionSecretKey?: string
  ) {}

  async store(key: string, data: unknown): Promise<string> {
    await this.bucket.put(key, JSON.stringify(data, null, 2), {
      httpMetadata: { contentType: "application/json" },
    });
    return key;
  }

  async retrieve(key: string): Promise<unknown | null> {
    const obj = await this.bucket.get(key);
    if (!obj) return null;
    const parsed: unknown = JSON.parse(await obj.text());
    if (
      this.ingestionSecretKey &&
      parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      typeof (parsed as Record<string, unknown>)["__sentinel_dlq_v1"] === "string"
    ) {
      const m = key.match(DLQ_KEY_PREFIX);
      if (!m) return parsed;
      const tenantId = m[1]!;
      const enc = (parsed as Record<string, unknown>)["__sentinel_dlq_v1"] as string;
      const plain = await decryptTenantPayload(
        enc,
        this.ingestionSecretKey,
        tenantId,
        TENANT_CRYPTO_INFO_DLQ_R2
      );
      return JSON.parse(plain) as unknown;
    }
    return parsed;
  }

  async delete(key: string): Promise<void> {
    await this.bucket.delete(key);
  }
}

// ── Cloudflare Email — notifications (Workers binding, sin API key) ───────────

export class CloudflareEmailNotificationService implements INotificationService {
  private readonly fromEmail = "no-reply@primary-sentinel.com";

  constructor(
    private readonly emailBinding: SendEmail,
    private readonly supabaseUrl: string,
    private readonly supabaseKey: string
  ) {}

  async send(payload: NotificationPayload): Promise<void> {
    const { subject, html } = this.buildEmail(payload);

    const supabase = createClient(this.supabaseUrl, this.supabaseKey);
    const summaryTitle =
      payload.incidentSummary && typeof payload.incidentSummary["title"] === "string"
        ? (payload.incidentSummary["title"] as string)
        : subject;

    await supabase.from("notifications").insert({
      tenant_id: payload.tenantId,
      type: payload.type,
      title: summaryTitle,
      message: `Event ${payload.eventId} — ${payload.endpointName}`,
      endpoint_id: payload.endpointId ?? null,
      event_id: payload.eventId,
    });

    await this.emailBinding.send({
      from: this.fromEmail,
      to: payload.tenantEmail || "admin@primary-sentinel.com",
      subject,
      html,
    });
  }

  private buildEmail(payload: NotificationPayload): { subject: string; html: string } {
    if (payload.htmlBody) {
      return {
        subject:
          payload.type === "dead_letter"
            ? `🚨 Primary Sentinel — ${payload.endpointName}`
            : `✅ Primary Sentinel — ${payload.endpointName}`,
        html: payload.htmlBody,
      };
    }
    switch (payload.type) {
      case "healing_success":
        return {
          subject: `✅ Primary Sentinel: API mutation repaired — ${payload.endpointName}`,
          html: `
            <h2>🔧 Repair successful</h2>
            <p>Primary Sentinel corrected a schema mutation on <strong>${payload.endpointName}</strong>.</p>
            <ul>
              <li><strong>Event ID:</strong> ${payload.eventId}</li>
              <li><strong>Rule ID:</strong> ${payload.details["ruleId"]}</li>
              <li><strong>Method:</strong> ${payload.details["method"]}</li>
              <li><strong>Description:</strong> ${payload.details["description"]}</li>
            </ul>
          `,
        };
      case "dead_letter":
        return {
          subject: `🚨 ALERT: Primary Sentinel — Unrecoverable event on ${payload.endpointName}`,
          html: `
            <h2>💀 Dead Letter Alert</h2>
            <p>Primary Sentinel could not fix an event on <strong>${payload.endpointName}</strong>.</p>
            <ul>
              <li><strong>Event ID:</strong> ${payload.eventId}</li>
              <li><strong>Reason:</strong> ${payload.details["reason"]}</li>
            </ul>
            <pre>${JSON.stringify(payload.details["errorLog"], null, 2)}</pre>
          `,
        };
      case "rule_quarantined":
        return {
          subject: `⚠️ Primary Sentinel: Rule quarantined — ${payload.endpointName}`,
          html: `
            <h2>⚠️ Rule Quarantined</h2>
            <p>Rule ${payload.details["ruleId"]} quarantined (success rate: ${payload.details["successRate"]}).</p>
          `,
        };
      default:
        return {
          subject: `Primary Sentinel Notification — ${payload.type}`,
          html: `<pre>${JSON.stringify(payload, null, 2)}</pre>`,
        };
    }
  }
}

declare global {
  interface R2Bucket {
    put(key: string, value: string, options?: { httpMetadata?: { contentType?: string } }): Promise<void>;
    get(key: string): Promise<{ text(): Promise<string> } | null>;
    delete(key: string): Promise<void>;
  }
}

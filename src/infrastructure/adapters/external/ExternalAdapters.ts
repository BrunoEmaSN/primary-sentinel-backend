// src/infrastructure/adapters/cache/UpstashRuleCache.ts
import { Redis } from "@upstash/redis";
import type { IRuleCache } from "../../../domain/healing/repositories/ITransformationRuleRepository.js";

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


// ── Cloudflare R2 Storage (Dead Letter Queue) ─────────────────────────────

import type { IStorageService } from "../../../application/ports/index.js";

export class R2StorageAdapter implements IStorageService {
  constructor(private bucket: R2Bucket) {}

  async store(key: string, data: unknown): Promise<string> {
    const body = JSON.stringify(data, null, 2);
    await this.bucket.put(key, body, {
      httpMetadata: { contentType: "application/json" },
    });
    return key;
  }

  async retrieve(key: string): Promise<unknown | null> {
    const object = await this.bucket.get(key);
    if (!object) return null;
    const text = await object.text();
    return JSON.parse(text);
  }

  async delete(key: string): Promise<void> {
    await this.bucket.delete(key);
  }
}

// ── Resend Email Notifications ─────────────────────────────────────────────

import { Resend } from "resend";
import type {
  INotificationService,
  NotificationPayload,
} from "../../../application/ports/index.js";

export class ResendNotificationService implements INotificationService {
  private client: Resend;
  private fromEmail = "sentinel@notifications.yourdomain.com";

  constructor(apiKey: string) {
    this.client = new Resend(apiKey);
  }

  async send(payload: NotificationPayload): Promise<void> {
    const { subject, html } = this.buildEmail(payload);

    await this.client.emails.send({
      from: this.fromEmail,
      to: payload.tenantEmail || "admin@yourdomain.com",
      subject,
      html,
    });
  }

  private buildEmail(payload: NotificationPayload): { subject: string; html: string } {
    switch (payload.type) {
      case "healing_success":
        return {
          subject: `✅ Sentinel: API mutation auto-healed — ${payload.endpointName}`,
          html: `
            <h2>🔧 Auto-Healing Successful</h2>
            <p>Sentinel detected and fixed an API schema mutation on <strong>${payload.endpointName}</strong>.</p>
            <ul>
              <li><strong>Event ID:</strong> ${payload.eventId}</li>
              <li><strong>Rule ID:</strong> ${payload.details["ruleId"]}</li>
              <li><strong>Method:</strong> ${payload.details["method"]}</li>
              <li><strong>Description:</strong> ${payload.details["description"]}</li>
            </ul>
            <p>The transformation rule has been cached for future events.</p>
          `,
        };

      case "dead_letter":
        return {
          subject: `🚨 ALERT: Sentinel — Unrecoverable event on ${payload.endpointName}`,
          html: `
            <h2>💀 Dead Letter Alert</h2>
            <p>Sentinel could not automatically fix an event on <strong>${payload.endpointName}</strong>.</p>
            <ul>
              <li><strong>Event ID:</strong> ${payload.eventId}</li>
              <li><strong>Reason:</strong> ${payload.details["reason"]}</li>
            </ul>
            <h3>Error Log:</h3>
            <pre>${JSON.stringify(payload.details["errorLog"], null, 2)}</pre>
            <p>The raw payload has been preserved in the Dead Letter Queue (DLQ).</p>
          `,
        };

      case "rule_quarantined":
        return {
          subject: `⚠️ Sentinel: Transformation rule quarantined — ${payload.endpointName}`,
          html: `
            <h2>⚠️ Rule Quarantined</h2>
            <p>A transformation rule for <strong>${payload.endpointName}</strong> has been quarantined due to low success rate.</p>
            <ul>
              <li><strong>Rule ID:</strong> ${payload.details["ruleId"]}</li>
              <li><strong>Success Rate:</strong> ${payload.details["successRate"]}</li>
            </ul>
            <p>A new rule will be generated on the next healing attempt.</p>
          `,
        };

      default:
        return {
          subject: `Sentinel Notification — ${payload.type}`,
          html: `<pre>${JSON.stringify(payload, null, 2)}</pre>`,
        };
    }
  }
}

// Type augmentation for R2Bucket in Cloudflare Workers
declare global {
  interface R2Bucket {
    put(key: string, value: string, options?: { httpMetadata?: { contentType?: string } }): Promise<void>;
    get(key: string): Promise<{ text(): Promise<string> } | null>;
    delete(key: string): Promise<void>;
  }
}

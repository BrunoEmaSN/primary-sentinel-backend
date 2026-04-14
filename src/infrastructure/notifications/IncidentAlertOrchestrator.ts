import type { INotificationService } from "../../application/ports/index.js";
import type { NotificationPayload, NotificationType } from "../../application/ports/index.js";
import {
  buildIncidentSummary,
  incidentSummaryToHtml,
  incidentSummaryToPlainText,
  type IncidentKind,
} from "../../domain/notifications/incidentSummary.js";
import type { TenantInfraAdapter } from "../adapters/database/TenantInfraAdapter.js";
import { hmacSha256Hex } from "../utils/hmacSign.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("IncidentAlerts");

export class IncidentAlertOrchestrator {
  constructor(
    private readonly notifications: INotificationService,
    private readonly tenantInfra: TenantInfraAdapter
  ) {}

  async dispatch(params: {
    type: NotificationType;
    kind: IncidentKind;
    tenantId: string;
    endpointId: string;
    endpointName: string;
    eventId: string;
    environment?: string;
    reason?: string;
    details: Record<string, unknown>;
  }): Promise<void> {
    const settings = await this.tenantInfra.getSettings(params.tenantId);
    const email = await this.tenantInfra.resolveUserEmail(params.tenantId);

    const suppressNonCritical = await this.tenantInfra.isMaintenanceSuppressNonCritical(
      params.tenantId,
      params.endpointId
    );

    const summary = buildIncidentSummary({
      kind: params.kind,
      tenantId: params.tenantId,
      endpointId: params.endpointId,
      endpointName: params.endpointName,
      eventId: params.eventId,
      environment: params.environment,
      reason: params.reason,
      details: params.details,
    });

    const htmlBody = incidentSummaryToHtml(summary);
    const plain = incidentSummaryToPlainText(summary);

    const payloadBase: Omit<NotificationPayload, "tenantEmail"> = {
      tenantId: params.tenantId,
      endpointId: params.endpointId,
      type: params.type,
      endpointName: params.endpointName,
      eventId: params.eventId,
      details: params.details,
      htmlBody,
      incidentSummary: summary as unknown as Record<string, unknown>,
    };

    const sendEmail =
      params.kind === "dead_letter"
        ? settings.notify_email_dead
        : settings.notify_email_healing && !suppressNonCritical;

    if (sendEmail && email) {
      await this.notifications
        .send({
          ...payloadBase,
          tenantEmail: email,
        })
        .catch((e) => logger.error("Email alert failed", { error: String(e) }));
    }

    const slackAllowed =
      settings.slack_on_incidents &&
      settings.slack_incoming_webhook_url &&
      (params.kind === "dead_letter" || !suppressNonCritical);

    if (slackAllowed && settings.slack_incoming_webhook_url) {
      await fetch(settings.slack_incoming_webhook_url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: plain }),
      }).catch((e) => logger.error("Slack webhook failed", { error: String(e) }));
    }

    if (settings.alert_webhook_url && settings.alert_webhook_secret) {
      const bodyObj = { incident: summary };
      const raw = JSON.stringify(bodyObj);
      const sig = await hmacSha256Hex(settings.alert_webhook_secret, raw);
      try {
        await this.fetchWithRetry(settings.alert_webhook_url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Sentinel-Signature": `sha256=${sig}`,
            "X-Sentinel-Event": params.eventId,
          },
          body: raw,
        });
      } catch (e) {
        logger.error("Alert webhook failed after retries", { error: String(e) });
      }
    }
  }

  /** POST con reintentos y backoff ante fallos de red o HTTP no-2xx. */
  private async fetchWithRetry(
    url: string,
    options: RequestInit,
    attempts = 3
  ): Promise<Response> {
    for (let i = 0; i < attempts; i++) {
      try {
        const res = await fetch(url, options);
        if (res.ok) return res;
        if (i < attempts - 1) await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
      } catch (e) {
        if (i === attempts - 1) throw e;
        await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
      }
    }
    throw new Error("Alert webhook failed after retries");
  }
}

/**
 * Contrato único de “incident summary” (JSON) compartido por email, Slack y webhook firmado.
 */
export type IncidentKind = "dead_letter" | "healing_success";

export type IncidentSummaryV1 = {
  version: "1";
  kind: IncidentKind;
  title: string;
  occurredAt: string;
  tenantId: string;
  endpointId: string;
  endpointName: string;
  eventId: string;
  environment?: string;
  reason?: string;
  details: Record<string, unknown>;
};

export function buildIncidentSummary(params: {
  kind: IncidentKind;
  tenantId: string;
  endpointId: string;
  endpointName: string;
  eventId: string;
  environment?: string;
  reason?: string;
  details: Record<string, unknown>;
}): IncidentSummaryV1 {
  const title =
    params.kind === "dead_letter"
      ? `DLQ · ${params.endpointName}`
      : `Reparación IA · ${params.endpointName}`;

  return {
    version: "1",
    kind: params.kind,
    title,
    occurredAt: new Date().toISOString(),
    tenantId: params.tenantId,
    endpointId: params.endpointId,
    endpointName: params.endpointName,
    eventId: params.eventId,
    ...(params.environment ? { environment: params.environment } : {}),
    ...(params.reason ? { reason: params.reason } : {}),
    details: params.details,
  };
}

export function incidentSummaryToPlainText(s: IncidentSummaryV1): string {
  const lines = [
    `*${s.title}*`,
    `Event: \`${s.eventId}\``,
    `Endpoint: ${s.endpointName} (${s.endpointId})`,
  ];
  if (s.reason) lines.push(`Reason: ${s.reason}`);
  lines.push(`Time: ${s.occurredAt}`);
  return lines.join("\n");
}

export function incidentSummaryToHtml(s: IncidentSummaryV1): string {
  const detailJson = JSON.stringify(s.details, null, 2);
  return `
    <h2>${escapeHtml(s.title)}</h2>
    <ul>
      <li><strong>Event ID:</strong> ${escapeHtml(s.eventId)}</li>
      <li><strong>Endpoint:</strong> ${escapeHtml(s.endpointName)}</li>
      ${s.reason ? `<li><strong>Razón:</strong> ${escapeHtml(s.reason)}</li>` : ""}
      <li><strong>Instante:</strong> ${escapeHtml(s.occurredAt)}</li>
    </ul>
    <pre style="background:#0f1218;color:#b8c0cc;padding:12px;border-radius:8px;overflow:auto;font-size:12px;">${escapeHtml(detailJson)}</pre>
  `;
}

function escapeHtml(t: string): string {
  return t
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

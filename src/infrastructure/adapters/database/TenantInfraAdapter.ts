import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createLogger } from "../../utils/logger.js";
import {
  encryptTenantPayload,
  decryptTenantPayload,
  isTenantIngestionCiphertext,
  TENANT_CRYPTO_INFO_EVENT_SNAPSHOT,
} from "../../utils/tenantIngestionCrypto.js";

const logger = createLogger("TenantInfra");

export type PublicPricingPlan = {
  planKey: string;
  sortOrder: number;
  monthlyUsd: number;
  yearlyPerMonthUsd: number;
  currency: string;
  /** Precio piso (USD/mes o equivalente); por debajo la IA debe escalar a humano. */
  floorMonthlyUsd: number;
  floorYearlyPerMonthUsd: number;
};

export type NegotiationConcessionRow = {
  code: string;
  label: string;
  description: string | null;
  kind: string;
};

export type NegotiationControlRow = {
  maxNegotiationRounds: number;
  urgencyMultipliers: Record<string, number>;
  powerBandMaxDiscount: Record<string, number>;
};

export type PublicPricingDiscount = {
  code: string;
  label: string;
  description: string | null;
  percentOff: number;
  billingPeriod: string;
  appliesToPlanKeys: string[] | null;
  eligibility: Record<string, unknown>;
};

export type TenantSettingsRow = {
  notify_email_healing: boolean;
  notify_email_dead: boolean;
  notify_email_pending_rules: boolean;
  slack_on_incidents: boolean;
  slack_incoming_webhook_url: string | null;
  alert_webhook_url: string | null;
  alert_webhook_secret: string | null;
  billing_plan: string;
};

const DEFAULTS: TenantSettingsRow = {
  notify_email_healing: true,
  notify_email_dead: true,
  notify_email_pending_rules: true,
  slack_on_incidents: true,
  slack_incoming_webhook_url: null,
  alert_webhook_url: null,
  alert_webhook_secret: null,
  billing_plan: "free",
};

export class TenantInfraAdapter {
  private client: SupabaseClient;

  constructor(
    supabaseUrl: string,
    supabaseKey: string,
    private readonly ingestionSecretKey?: string
  ) {
    this.client = createClient(supabaseUrl, supabaseKey);
  }

  private async encodeSnapshotPayload(
    tenantId: string,
    payload: unknown
  ): Promise<unknown> {
    if (!this.ingestionSecretKey) return payload;
    const plain = JSON.stringify(payload);
    return encryptTenantPayload(
      plain,
      this.ingestionSecretKey,
      tenantId,
      TENANT_CRYPTO_INFO_EVENT_SNAPSHOT
    );
  }

  private async decodeSnapshotPayload(
    tenantId: string,
    payload: unknown
  ): Promise<unknown> {
    if (!this.ingestionSecretKey || !isTenantIngestionCiphertext(payload)) {
      return payload;
    }
    const json = await decryptTenantPayload(
      payload,
      this.ingestionSecretKey,
      tenantId,
      TENANT_CRYPTO_INFO_EVENT_SNAPSHOT
    );
    return JSON.parse(json) as unknown;
  }

  async getSettings(tenantId: string): Promise<TenantSettingsRow> {
    try {
      const { data, error } = await this.client
        .from("tenant_settings")
        .select("*")
        .eq("tenant_id", tenantId)
        .maybeSingle();
      if (error || !data) return DEFAULTS;
      return { ...DEFAULTS, ...data } as TenantSettingsRow;
    } catch (e) {
      logger.warn("tenant_settings unreadable; defaults", { error: String(e) });
      return DEFAULTS;
    }
  }

  async upsertSettings(
    tenantId: string,
    patch: Partial<
      Omit<TenantSettingsRow, "billing_plan"> & { billing_plan?: string }
    >
  ): Promise<void> {
    const cleaned: Record<string, unknown> = {
      tenant_id: tenantId,
      updated_at: new Date().toISOString(),
    };
    for (const [k, v] of Object.entries(patch)) {
      if (v !== undefined) cleaned[k] = v;
    }
    const { error } = await this.client.from("tenant_settings").upsert(cleaned, {
      onConflict: "tenant_id",
    });
    if (error) throw new Error(`tenant_settings: ${error.message}`);
  }

  async resolveUserEmail(tenantId: string): Promise<string> {
    try {
      const { data, error } = await this.client.auth.admin.getUserById(tenantId);
      if (error || !data.user?.email) return "";
      return data.user.email;
    } catch {
      return "";
    }
  }

  async isMaintenanceSuppressNonCritical(
    tenantId: string,
    endpointId: string
  ): Promise<boolean> {
    const now = new Date().toISOString();
    try {
      const { data, error } = await this.client
        .from("maintenance_windows")
        .select("id, scope, endpoint_ids, suppress_non_critical_alerts, status")
        .eq("tenant_id", tenantId)
        .eq("status", "approved")
        .lte("starts_at", now)
        .gte("ends_at", now);

      if (error || !data?.length) return false;

      for (const row of data) {
        if (!row.suppress_non_critical_alerts) continue;
        if (row.scope === "tenant") return true;
        const ids = row.endpoint_ids as string[] | null;
        if (row.scope === "endpoints" && ids?.includes(endpointId)) return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  async insertStageMetric(params: {
    tenantId: string;
    endpointId?: string;
    stage: string;
    latencyMs: number;
    backlogEstimate?: number;
  }): Promise<void> {
    try {
      await this.client.from("stage_metrics").insert({
        tenant_id: params.tenantId,
        endpoint_id: params.endpointId ?? null,
        stage: params.stage,
        latency_ms: params.latencyMs,
        backlog_estimate: params.backlogEstimate ?? null,
      });
    } catch (e) {
      logger.warn("stage_metrics insert failed", { error: String(e) });
    }
  }

  async insertSnapshot(params: {
    tenantId: string;
    eventId: string;
    name: string;
    payload: unknown;
    createdByEmail: string;
  }): Promise<void> {
    try {
      const payload = await this.encodeSnapshotPayload(params.tenantId, params.payload);
      await this.client.from("event_snapshots").insert({
        tenant_id: params.tenantId,
        event_id: params.eventId,
        name: params.name,
        payload,
        created_by_email: params.createdByEmail,
      });
    } catch (e) {
      logger.warn("event_snapshots insert failed", { error: String(e) });
    }
  }

  async insertAiDecisionLog(params: {
    tenantId: string;
    endpointId?: string;
    eventId?: string;
    ruleId?: string;
    action: string;
    detail: Record<string, unknown>;
    actor?: string;
  }): Promise<void> {
    try {
      await this.client.from("ai_decision_log").insert({
        tenant_id: params.tenantId,
        endpoint_id: params.endpointId ?? null,
        event_id: params.eventId ?? null,
        rule_id: params.ruleId ?? null,
        action: params.action,
        detail: params.detail,
        actor: params.actor ?? null,
      });
    } catch (e) {
      logger.warn("ai_decision_log insert failed", { error: String(e) });
    }
  }

  async listAiDecisionLogs(tenantId: string, limit = 50): Promise<unknown[]> {
    const { data, error } = await this.client
      .from("ai_decision_log")
      .select("*")
      .eq("tenant_id", tenantId)
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) return [];
    return data ?? [];
  }

  async listStageMetrics(tenantId: string, sinceIso: string): Promise<unknown[]> {
    const { data, error } = await this.client
      .from("stage_metrics")
      .select("*")
      .eq("tenant_id", tenantId)
      .gte("recorded_at", sinceIso)
      .order("recorded_at", { ascending: false })
      .limit(500);
    if (error) return [];
    return data ?? [];
  }

  async listEventNotes(tenantId: string, eventId: string): Promise<unknown[]> {
    const { data } = await this.client
      .from("event_notes")
      .select("*")
      .eq("tenant_id", tenantId)
      .eq("event_id", eventId)
      .order("created_at", { ascending: true });
    return data ?? [];
  }

  async addEventNote(params: {
    tenantId: string;
    eventId: string;
    authorId: string;
    body: string;
  }): Promise<void> {
    const { error } = await this.client.from("event_notes").insert({
      tenant_id: params.tenantId,
      event_id: params.eventId,
      author_id: params.authorId,
      body: params.body,
    });
    if (error) throw new Error(`event_notes: ${error.message}`);
  }

  async listEventTags(tenantId: string, eventId: string): Promise<unknown[]> {
    const { data } = await this.client
      .from("event_tags")
      .select("*")
      .eq("tenant_id", tenantId)
      .eq("event_id", eventId);
    return data ?? [];
  }

  async upsertEventTag(params: {
    tenantId: string;
    eventId: string;
    tag: string;
    source: "manual" | "auto";
  }): Promise<void> {
    const { error } = await this.client.from("event_tags").upsert(
      {
        tenant_id: params.tenantId,
        event_id: params.eventId,
        tag: params.tag,
        source: params.source,
      },
      { onConflict: "tenant_id,event_id,tag" }
    );
    if (error) throw new Error(`event_tags: ${error.message}`);
  }

  async listSnapshotsForEvent(tenantId: string, eventId: string): Promise<unknown[]> {
    const { data } = await this.client
      .from("event_snapshots")
      .select("*")
      .eq("tenant_id", tenantId)
      .eq("event_id", eventId)
      .order("created_at", { ascending: false });
    const rows = data ?? [];
    return Promise.all(
      rows.map(async (row) => {
        const r = row as Record<string, unknown>;
        const payload = await this.decodeSnapshotPayload(tenantId, r["payload"]);
        return { ...r, payload };
      })
    );
  }

  async getSnapshotById(tenantId: string, snapshotId: string): Promise<unknown | null> {
    const { data } = await this.client
      .from("event_snapshots")
      .select("*")
      .eq("tenant_id", tenantId)
      .eq("id", snapshotId)
      .maybeSingle();
    if (!data) return null;
    const r = data as Record<string, unknown>;
    const payload = await this.decodeSnapshotPayload(tenantId, r["payload"]);
    return { ...r, payload };
  }

  async listMaintenanceWindows(tenantId: string): Promise<unknown[]> {
    const { data } = await this.client
      .from("maintenance_windows")
      .select("*")
      .eq("tenant_id", tenantId)
      .order("starts_at", { ascending: false });
    return data ?? [];
  }

  async createMaintenanceWindow(params: {
    tenantId: string;
    title: string;
    startsAt: string;
    endsAt: string;
    timezone?: string;
    status?: string;
    scope?: string;
    endpointIds?: string[];
    suppressNonCritical?: boolean;
  }): Promise<unknown> {
    const { data, error } = await this.client
      .from("maintenance_windows")
      .insert({
        tenant_id: params.tenantId,
        title: params.title,
        starts_at: params.startsAt,
        ends_at: params.endsAt,
        timezone: params.timezone ?? "UTC",
        status: params.status ?? "draft",
        scope: params.scope ?? "tenant",
        endpoint_ids: params.endpointIds ?? [],
        suppress_non_critical_alerts: params.suppressNonCritical ?? true,
      })
      .select()
      .single();
    if (error) throw new Error(error.message);
    return data;
  }

  async approveMaintenanceWindow(tenantId: string, id: string): Promise<void> {
    const { error } = await this.client
      .from("maintenance_windows")
      .update({ status: "approved", updated_at: new Date().toISOString() })
      .eq("tenant_id", tenantId)
      .eq("id", id);
    if (error) throw new Error(error.message);
  }

  /** Catálogo público de precios (landing / facturación). Sin JWT. */
  async getPricingCatalog(): Promise<{
    plans: PublicPricingPlan[];
    discounts: PublicPricingDiscount[];
  }> {
    try {
      const [plansRes, discRes] = await Promise.all([
        this.client
          .from("pricing_plans")
          .select(
            "plan_key, sort_order, monthly_amount_usd, yearly_per_month_usd, currency, floor_monthly_usd, floor_yearly_per_month_usd"
          )
          .eq("active", true)
          .order("sort_order", { ascending: true }),
        this.client
          .from("pricing_discounts")
          .select("code, label, description, percent_off, billing_period, applies_to_plan_keys, eligibility")
          .eq("active", true)
          .order("sort_order", { ascending: true }),
      ]);
      if (plansRes.error) {
        logger.warn("pricing_plans", { error: plansRes.error.message });
      }
      if (discRes.error) {
        logger.warn("pricing_discounts", { error: discRes.error.message });
      }
      const plans: PublicPricingPlan[] = (plansRes.data ?? []).map((row: Record<string, unknown>) => ({
        planKey: String(row["plan_key"] ?? ""),
        sortOrder: Number(row["sort_order"] ?? 0),
        monthlyUsd: Number(row["monthly_amount_usd"] ?? 0),
        yearlyPerMonthUsd: Number(row["yearly_per_month_usd"] ?? 0),
        currency: String(row["currency"] ?? "USD"),
        floorMonthlyUsd: Number(row["floor_monthly_usd"] ?? row["monthly_amount_usd"] ?? 0),
        floorYearlyPerMonthUsd: Number(row["floor_yearly_per_month_usd"] ?? row["yearly_per_month_usd"] ?? 0),
      }));
      const discounts: PublicPricingDiscount[] = (discRes.data ?? []).map((row: Record<string, unknown>) => ({
        code: String(row["code"] ?? ""),
        label: String(row["label"] ?? ""),
        description: row["description"] != null ? String(row["description"]) : null,
        percentOff: Number(row["percent_off"] ?? 0),
        billingPeriod: String(row["billing_period"] ?? "both"),
        appliesToPlanKeys: Array.isArray(row["applies_to_plan_keys"])
          ? (row["applies_to_plan_keys"] as string[])
          : null,
        eligibility:
          row["eligibility"] != null &&
          typeof row["eligibility"] === "object" &&
          !Array.isArray(row["eligibility"])
            ? (row["eligibility"] as Record<string, unknown>)
            : {},
      }));
      return { plans, discounts };
    } catch (e) {
      logger.warn("getPricingCatalog failed", { error: String(e) });
      return { plans: [], discounts: [] };
    }
  }

  /**
   * Política completa para IA de ventas/negociación (concesiones + control).
   * Exponer solo vía `GET /api/public/negotiation-policy` con cabecera interna configurada en el Worker.
   */
  async getNegotiationPolicy(): Promise<{
    plans: PublicPricingPlan[];
    discounts: PublicPricingDiscount[];
    concessions: NegotiationConcessionRow[];
    control: NegotiationControlRow;
  }> {
    const catalog = await this.getPricingCatalog();
    const defaults: NegotiationControlRow = {
      maxNegotiationRounds: 3,
      urgencyMultipliers: { high: 0.5, medium: 0.75, low: 1 },
      powerBandMaxDiscount: { startup: 0.18, smb: 0.12, multinational: 0.08, unknown: 0.1 },
    };
    try {
      const [concRes, ctrlRes] = await Promise.all([
        this.client
          .from("negotiation_concessions")
          .select("code, label, description, kind")
          .eq("active", true)
          .order("sort_order", { ascending: true }),
        this.client.from("negotiation_control").select("*").eq("id", 1).maybeSingle(),
      ]);
      if (concRes.error) logger.warn("negotiation_concessions", { error: concRes.error.message });
      if (ctrlRes.error) logger.warn("negotiation_control", { error: ctrlRes.error.message });

      const concessions: NegotiationConcessionRow[] = (concRes.data ?? []).map((row: Record<string, unknown>) => ({
        code: String(row["code"] ?? ""),
        label: String(row["label"] ?? ""),
        description: row["description"] != null ? String(row["description"]) : null,
        kind: String(row["kind"] ?? "non_monetary"),
      }));

      const row = ctrlRes.data as Record<string, unknown> | null;
      let control = defaults;
      if (row) {
        const maxRounds = Number(row["max_negotiation_rounds"] ?? 3);
        const um = row["urgency_multipliers"];
        const pb = row["power_band_max_discount"];
        control = {
          maxNegotiationRounds: Number.isFinite(maxRounds) && maxRounds > 0 ? maxRounds : defaults.maxNegotiationRounds,
          urgencyMultipliers:
            um != null && typeof um === "object" && !Array.isArray(um)
              ? { ...defaults.urgencyMultipliers, ...(um as Record<string, number>) }
              : defaults.urgencyMultipliers,
          powerBandMaxDiscount:
            pb != null && typeof pb === "object" && !Array.isArray(pb)
              ? { ...defaults.powerBandMaxDiscount, ...(pb as Record<string, number>) }
              : defaults.powerBandMaxDiscount,
        };
      }

      return { ...catalog, concessions, control };
    } catch (e) {
      logger.warn("getNegotiationPolicy failed", { error: String(e) });
      return { ...catalog, concessions: [], control: defaults };
    }
  }
}

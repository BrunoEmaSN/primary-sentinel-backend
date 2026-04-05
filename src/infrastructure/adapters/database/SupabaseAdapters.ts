// src/infrastructure/adapters/database/SupabaseEventRepository.ts
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { RawEvent } from "../../../domain/events/entities/RawEvent.js";
import type { IEventRepository } from "../../../domain/events/repositories/IEventRepository.js";
import type { EventStatus } from "../../../domain/events/entities/RawEvent.js";

export class SupabaseEventRepository implements IEventRepository {
  private client: SupabaseClient;

  constructor(supabaseUrl: string, supabaseKey: string) {
    this.client = createClient(supabaseUrl, supabaseKey);
  }

  async save(event: RawEvent): Promise<void> {
    const snapshot = event.toSnapshot();
    const { error } = await this.client.from("events").insert({
      id: snapshot["id"],
      tenant_id: snapshot["tenantId"],
      endpoint_id: snapshot["endpointId"],
      raw_payload: snapshot["rawPayload"],
      source: snapshot["source"],
      metadata: snapshot["metadata"],
      status: snapshot["status"],
      validated_payload: snapshot["validatedPayload"],
      healing_attempts: snapshot["healingAttempts"],
      error_log: snapshot["errorLog"],
      transformation_rule_id: snapshot["transformationRuleId"],
      created_at: snapshot["createdAt"],
      updated_at: snapshot["updatedAt"],
    });

    if (error) throw new DatabaseError(`Failed to save event: ${error.message}`);
  }

  async findById(id: string): Promise<RawEvent | null> {
    const { data, error } = await this.client
      .from("events")
      .select("*")
      .eq("id", id)
      .single();

    if (error || !data) return null;
    return this.hydrate(data);
  }

  async findByTenantAndEndpoint(params: {
    tenantId: string;
    endpointId?: string;
    status?: EventStatus;
    limit?: number;
    offset?: number;
  }): Promise<{ events: RawEvent[]; total: number }> {
    let query = this.client
      .from("events")
      .select("*", { count: "exact" })
      .eq("tenant_id", params.tenantId)
      .order("created_at", { ascending: false });

    if (params.endpointId) {
      query = query.eq("endpoint_id", params.endpointId);
    }

    if (params.status) query = query.eq("status", params.status);
    if (params.limit) query = query.limit(params.limit);
    if (params.offset) query = query.range(params.offset, params.offset + (params.limit ?? 20) - 1);

    const { data, count, error } = await query;
    if (error) throw new DatabaseError(`Failed to query events: ${error.message}`);

    return {
      events: (data ?? []).map(this.hydrate),
      total: count ?? 0,
    };
  }

  async updateStatus(event: RawEvent): Promise<void> {
    const snapshot = event.toSnapshot();
    const { error } = await this.client
      .from("events")
      .update({
        status: snapshot["status"],
        validated_payload: snapshot["validatedPayload"],
        healing_attempts: snapshot["healingAttempts"],
        error_log: snapshot["errorLog"],
        transformation_rule_id: snapshot["transformationRuleId"],
        updated_at: snapshot["updatedAt"],
      })
      .eq("id", event.id);

    if (error) throw new DatabaseError(`Failed to update event status: ${error.message}`);
  }

  async existsById(id: string): Promise<boolean> {
    const { count, error } = await this.client
      .from("events")
      .select("id", { count: "exact", head: true })
      .eq("id", id);

    if (error) throw new DatabaseError(`Failed to check event existence: ${error.message}`);
    return (count ?? 0) > 0;
  }

  private hydrate(row: Record<string, unknown>): RawEvent {
    return RawEvent.reconstitute({
      id: row["id"] as string,
      tenantId: row["tenant_id"] as string,
      endpointId: row["endpoint_id"] as string,
      rawPayload: row["raw_payload"],
      source: row["source"] as import("../../../domain/events/entities/RawEvent.js").EventSource,
      metadata: row["metadata"] as import("../../../domain/events/entities/RawEvent.js").EventMetadata,
      status: row["status"] as EventStatus,
      validatedPayload: row["validated_payload"] ?? null,
      healingAttempts: row["healing_attempts"] as number,
      errorLog: (row["error_log"] as string[]) ?? [],
      transformationRuleId: (row["transformation_rule_id"] as string) ?? null,
      createdAt: new Date(row["created_at"] as string),
      updatedAt: new Date(row["updated_at"] as string),
    });
  }
}

// ── Endpoint Repository ─────────────────────────────────────────────────────

import { Endpoint } from "../../../domain/events/entities/Endpoint.js";
import type { IEndpointRepository } from "../../../domain/events/repositories/IEndpointRepository.js";

export class SupabaseEndpointRepository implements IEndpointRepository {
  private client: SupabaseClient;

  constructor(supabaseUrl: string, supabaseKey: string) {
    this.client = createClient(supabaseUrl, supabaseKey);
  }

  async save(endpoint: Endpoint): Promise<void> {
    const s = endpoint.toSnapshot();
    const { error } = await this.client.from("endpoints").insert({
      id: s["id"], tenant_id: s["tenantId"], name: s["name"], slug: s["slug"],
      schema: s["schema"], destination: s["destination"],
      healing_config: s["healingConfig"], status: s["status"],
      stats: s["stats"], webhook_secret: endpoint.webhookSecret,
      created_at: s["createdAt"], updated_at: s["updatedAt"],
    });
    if (error) throw new DatabaseError(`Failed to save endpoint: ${error.message}`);
  }

  async findById(id: string): Promise<Endpoint | null> {
    const { data, error } = await this.client.from("endpoints").select("*").eq("id", id).single();
    if (error || !data) return null;
    return this.hydrate(data);
  }

  async findBySlug(params: { tenantId: string; slug: string }): Promise<Endpoint | null> {
    const { data, error } = await this.client
      .from("endpoints").select("*")
      .eq("tenant_id", params.tenantId)
      .eq("slug", params.slug)
      .single();
    if (error || !data) return null;
    return this.hydrate(data);
  }

  async findByTenantId(tenantId: string): Promise<Endpoint[]> {
    const { data, error } = await this.client.from("endpoints").select("*").eq("tenant_id", tenantId);
    if (error) throw new DatabaseError(`Failed to list endpoints: ${error.message}`);
    return (data ?? []).map(this.hydrate);
  }

  async update(endpoint: Endpoint): Promise<void> {
    const s = endpoint.toSnapshot();
    const { error } = await this.client.from("endpoints").update({
      status: s["status"], stats: s["stats"],
      last_activity_at: s["lastActivityAt"], updated_at: s["updatedAt"],
    }).eq("id", endpoint.id);
    if (error) throw new DatabaseError(`Failed to update endpoint: ${error.message}`);
  }

  async delete(id: string): Promise<void> {
    const { error } = await this.client.from("endpoints").delete().eq("id", id);
    if (error) throw new DatabaseError(`Failed to delete endpoint: ${error.message}`);
  }

  private hydrate(row: Record<string, unknown>): Endpoint {
    return Endpoint.reconstitute({
      id: row["id"] as string,
      tenantId: row["tenant_id"] as string,
      name: row["name"] as string,
      slug: row["slug"] as string,
      schema: row["schema"] as Record<string, unknown>,
      destination: row["destination"] as import("../../../domain/events/entities/Endpoint.js").Destination,
      healingConfig: row["healing_config"] as import("../../../domain/events/entities/Endpoint.js").HealingConfig,
      status: row["status"] as import("../../../domain/events/entities/Endpoint.js").EndpointStatus,
      totalEventsReceived: (row["stats"] as Record<string, number>)?.["total"] ?? 0,
      totalEventsLoaded: (row["stats"] as Record<string, number>)?.["loaded"] ?? 0,
      totalEventsHealed: (row["stats"] as Record<string, number>)?.["healed"] ?? 0,
      totalEventsDead: (row["stats"] as Record<string, number>)?.["dead"] ?? 0,
      lastActivityAt: row["last_activity_at"] ? new Date(row["last_activity_at"] as string) : null,
      webhookSecret: row["webhook_secret"] as string,
      createdAt: new Date(row["created_at"] as string),
      updatedAt: new Date(row["updated_at"] as string),
    });
  }
}

// ── Transformation Rule Repository ─────────────────────────────────────────

import { TransformationRule } from "../../../domain/healing/entities/TransformationRule.js";
import type { ITransformationRuleRepository } from "../../../domain/healing/repositories/ITransformationRuleRepository.js";

export class SupabaseTransformationRuleRepository implements ITransformationRuleRepository {
  private client: SupabaseClient;

  constructor(supabaseUrl: string, supabaseKey: string) {
    this.client = createClient(supabaseUrl, supabaseKey);
  }

  async save(rule: TransformationRule): Promise<void> {
    const s = rule.toSnapshot();
    const { error } = await this.client.from("transformation_rules").insert({
      id: s["id"], tenant_id: s["tenantId"], endpoint_id: s["endpointId"],
      schema_version: s["schemaVersion"], error_fingerprint: s["errorFingerprint"],
      language: s["language"], script: s["script"], description: s["description"],
      status: s["status"], success_count: s["successCount"], failure_count: s["failureCount"],
      last_used_at: s["lastUsedAt"], generated_by: s["generatedBy"],
      created_at: s["createdAt"], updated_at: s["updatedAt"],
    });
    if (error) throw new DatabaseError(`Failed to save rule: ${error.message}`);
  }

  async findByFingerprint(params: {
    tenantId: string; endpointId: string; errorFingerprint: string;
  }): Promise<TransformationRule | null> {
    const { data, error } = await this.client
      .from("transformation_rules").select("*")
      .eq("tenant_id", params.tenantId)
      .eq("endpoint_id", params.endpointId)
      .eq("error_fingerprint", params.errorFingerprint)
      .eq("status", "active")
      .order("success_count", { ascending: false })
      .limit(1)
      .single();
    if (error || !data) return null;
    return this.hydrate(data);
  }

  async findById(id: string): Promise<TransformationRule | null> {
    const { data, error } = await this.client.from("transformation_rules").select("*").eq("id", id).single();
    if (error || !data) return null;
    return this.hydrate(data);
  }

  async findByEndpoint(params: { tenantId: string; endpointId: string; limit?: number; }): Promise<TransformationRule[]> {
    const { data, error } = await this.client
      .from("transformation_rules").select("*")
      .eq("tenant_id", params.tenantId)
      .eq("endpoint_id", params.endpointId)
      .order("created_at", { ascending: false })
      .limit(params.limit ?? 50);
    if (error) throw new DatabaseError(`Failed to list rules: ${error.message}`);
    return (data ?? []).map(this.hydrate);
  }

  async update(rule: TransformationRule): Promise<void> {
    const s = rule.toSnapshot();
    const { error } = await this.client.from("transformation_rules").update({
      status: s["status"], success_count: s["successCount"],
      failure_count: s["failureCount"], last_used_at: s["lastUsedAt"], updated_at: s["updatedAt"],
    }).eq("id", rule.id);
    if (error) throw new DatabaseError(`Failed to update rule: ${error.message}`);
  }

  private hydrate(row: Record<string, unknown>): TransformationRule {
    return TransformationRule.reconstitute({
      id: row["id"] as string,
      tenantId: row["tenant_id"] as string,
      endpointId: row["endpoint_id"] as string,
      schemaVersion: row["schema_version"] as string,
      errorFingerprint: row["error_fingerprint"] as string,
      language: row["language"] as import("../../../domain/healing/entities/TransformationRule.js").RuleLanguage,
      script: row["script"] as string,
      description: row["description"] as string,
      status: row["status"] as import("../../../domain/healing/entities/TransformationRule.js").RuleStatus,
      successCount: row["success_count"] as number,
      failureCount: row["failure_count"] as number,
      lastUsedAt: row["last_used_at"] ? new Date(row["last_used_at"] as string) : null,
      generatedBy: row["generated_by"] as string,
      createdAt: new Date(row["created_at"] as string),
      updatedAt: new Date(row["updated_at"] as string),
    });
  }
}

export class DatabaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DatabaseError";
  }
}

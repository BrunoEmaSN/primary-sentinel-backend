// src/domain/events/entities/Endpoint.ts
// Multi-destination fanout: supabase, webhook, http_api, postgres, mysql, bigquery

import { z } from "zod";

export type EndpointStatus = "active" | "paused" | "error";

const sqlIdent = z
  .string()
  .min(1)
  .regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/, "Must be a valid SQL identifier");

// ─── Destination types ────────────────────────────────────────────────────────

/** Normalizes apiKey → serviceKey; https *.supabase.co URL as connectionString → projectUrl */
export const SupabaseDestinationSchema = z
  .object({
    type: z.literal("supabase"),
    tableName: z.string().min(1),
    projectUrl: z.string().url().optional(),
    serviceKey: z.string().optional(),
    apiKey: z.string().optional(),
    connectionString: z.string().optional(),
  })
  .transform((x) => {
    const serviceKey = x.serviceKey ?? x.apiKey;
    let projectUrl = x.projectUrl;
    const cs = x.connectionString?.trim();
    if (cs) {
      try {
        const u = new URL(cs);
        if (u.protocol === "https:" && u.hostname.endsWith(".supabase.co")) {
          projectUrl = u.origin;
        } else {
          throw new Error("supabase connectionString must be an https URL under *.supabase.co");
        }
      } catch (e) {
        if (e instanceof TypeError) throw new Error("Invalid supabase connectionString URL");
        throw e;
      }
    }
    const out: {
      type: "supabase";
      tableName: string;
      projectUrl?: string;
      serviceKey?: string;
    } = { type: "supabase", tableName: x.tableName };
    if (projectUrl) out.projectUrl = projectUrl;
    if (serviceKey) out.serviceKey = serviceKey;
    return out;
  });

export const WebhookDestinationSchema = z.object({
  type: z.literal("webhook"),
  url: z.string().url(),
  method: z.enum(["POST", "PUT", "PATCH"]).default("POST"),
  headers: z.record(z.string()).optional(),
  wrapKey: z.string().optional(),
  retryOnFailure: z.boolean().default(true),
  timeoutMs: z.number().min(500).max(10000).default(5000),
});

export const HttpApiDestinationSchema = z.object({
  type: z.literal("http_api"),
  url: z.string().url(),
  method: z.enum(["POST", "PUT", "PATCH"]).default("POST"),
  authType: z.enum(["bearer", "basic", "api_key", "none"]).default("none"),
  authValue: z.string().optional(),
  authHeader: z.string().optional(),
  headers: z.record(z.string()).optional(),
  timeoutMs: z.number().min(500).max(10000).default(5000),
});

export const PostgresDestinationSchema = z.object({
  type: z.literal("postgres"),
  connectionString: z.string().min(1),
  schema: z.string().min(1).default("public"),
  table: sqlIdent,
  payloadColumn: sqlIdent.default("payload"),
});

export const MysqlDestinationSchema = z.object({
  type: z.literal("mysql"),
  connectionString: z.string().min(1),
  database: sqlIdent,
  table: sqlIdent,
  payloadColumn: sqlIdent.default("payload"),
});

export const BigQueryDestinationSchema = z.object({
  type: z.literal("bigquery"),
  projectId: z.string().min(1),
  datasetId: z.string().min(1),
  tableId: z.string().min(1),
  serviceAccountKey: z.string().min(1),
});

export const DestinationSchema = z.union([
  SupabaseDestinationSchema,
  WebhookDestinationSchema,
  HttpApiDestinationSchema,
  PostgresDestinationSchema,
  MysqlDestinationSchema,
  BigQueryDestinationSchema,
]);

export type SupabaseDestination = z.output<typeof SupabaseDestinationSchema>;
export type WebhookDestination = z.output<typeof WebhookDestinationSchema>;
export type HttpApiDestination = z.output<typeof HttpApiDestinationSchema>;
export type PostgresDestination = z.output<typeof PostgresDestinationSchema>;
export type MysqlDestination = z.output<typeof MysqlDestinationSchema>;
export type BigQueryDestination = z.output<typeof BigQueryDestinationSchema>;
export type Destination = z.output<typeof DestinationSchema>;

export type DestinationResult = {
  destinationType: Destination["type"];
  destinationIndex: number;
  success: boolean;
  statusCode?: number;
  error?: string;
  durationMs: number;
};

// ─── HealingConfig ─────────────────────────────────────────────────────────────

export type HealingConfig = {
  enabled: boolean;
  maxAttempts: number;
  autoApplyRules: boolean;
  notifyOnHealing: boolean;
  notifyOnDead: boolean;
};

// ─── Endpoint aggregate ───────────────────────────────────────────────────────

export class Endpoint {
  private constructor(
    public readonly id: string,
    public readonly tenantId: string,
    public readonly name: string,
    public readonly slug: string,
    public readonly schema: Record<string, unknown>,
    public readonly destinations: Destination[],
    public readonly healingConfig: HealingConfig,
    private _status: EndpointStatus,
    private _totalEventsReceived: number,
    private _totalEventsLoaded: number,
    private _totalEventsHealed: number,
    private _totalEventsDead: number,
    private _lastActivityAt: Date | null,
    public readonly webhookSecret: string,
    public readonly createdAt: Date,
    private _updatedAt: Date
  ) {}

  static create(params: {
    id: string;
    tenantId: string;
    name: string;
    slug: string;
    schema: Record<string, unknown>;
    destinations: Destination[];
    healingConfig?: Partial<HealingConfig>;
    webhookSecret: string;
  }): Endpoint {
    const defaultHealing: HealingConfig = {
      enabled: true,
      maxAttempts: 3,
      autoApplyRules: true,
      notifyOnHealing: true,
      notifyOnDead: true,
    };

    return new Endpoint(
      params.id,
      params.tenantId,
      params.name,
      params.slug,
      params.schema,
      params.destinations,
      { ...defaultHealing, ...params.healingConfig },
      "active",
      0, 0, 0, 0, null,
      params.webhookSecret,
      new Date(),
      new Date()
    );
  }

  static reconstitute(data: {
    id: string;
    tenantId: string;
    name: string;
    slug: string;
    schema: Record<string, unknown>;
    destinations: Destination[];
    healingConfig: HealingConfig;
    status: EndpointStatus;
    totalEventsReceived: number;
    totalEventsLoaded: number;
    totalEventsHealed: number;
    totalEventsDead: number;
    lastActivityAt: Date | null;
    webhookSecret: string;
    createdAt: Date;
    updatedAt: Date;
  }): Endpoint {
    return new Endpoint(
      data.id, data.tenantId, data.name, data.slug, data.schema,
      data.destinations, data.healingConfig, data.status,
      data.totalEventsReceived, data.totalEventsLoaded,
      data.totalEventsHealed, data.totalEventsDead,
      data.lastActivityAt, data.webhookSecret,
      data.createdAt, data.updatedAt
    );
  }

  get status(): EndpointStatus { return this._status; }

  get stats() {
    const total = this._totalEventsReceived;
    return {
      total,
      loaded: this._totalEventsLoaded,
      healed: this._totalEventsHealed,
      dead: this._totalEventsDead,
      successRate: total > 0
        ? (this._totalEventsLoaded + this._totalEventsHealed) / total
        : 0,
    };
  }

  get lastActivityAt(): Date | null { return this._lastActivityAt; }
  get updatedAt(): Date { return this._updatedAt; }

  incrementReceived(): void {
    this._totalEventsReceived += 1;
    this._lastActivityAt = new Date();
    this._updatedAt = new Date();
  }
  incrementLoaded(): void  { this._totalEventsLoaded += 1; this._updatedAt = new Date(); }
  incrementHealed(): void  { this._totalEventsHealed += 1; this._updatedAt = new Date(); }
  incrementDead(): void    { this._totalEventsDead += 1; this._updatedAt = new Date(); }
  activate(): void         { this._status = "active"; this._updatedAt = new Date(); }
  pause(): void            { this._status = "paused"; this._updatedAt = new Date(); }
  isActive(): boolean      { return this._status === "active"; }

  getWebhookUrl(baseUrl: string): string {
    return `${baseUrl}/webhook/${this.tenantId}/${this.slug}`;
  }

  buildZodSchema(): import("zod").ZodObject<import("zod").ZodRawShape> {
    const shape: import("zod").ZodRawShape = {};
    const props = this.schema["properties"];
    const required = this.schema["required"] as string[] | undefined;

    if (props && typeof props === "object") {
      for (const [key, value] of Object.entries(props as Record<string, Record<string, unknown>>)) {
        const isRequired = Array.isArray(required) && required.includes(key);
        let zodType: import("zod").ZodTypeAny;

        switch (value["type"]) {
          case "string":  zodType = z.string(); break;
          case "number":
          case "integer": zodType = z.number(); break;
          case "boolean": zodType = z.boolean(); break;
          case "array":   zodType = z.array(z.unknown()); break;
          case "object":  zodType = z.record(z.unknown()); break;
          default:        zodType = z.unknown();
        }

        shape[key] = isRequired ? zodType : zodType.optional();
      }
    }
    return z.object(shape);
  }

  toSnapshot(): Record<string, unknown> {
    return {
      id: this.id,
      tenantId: this.tenantId,
      tenant_id: this.tenantId,
      name: this.name,
      slug: this.slug,
      schema: this.schema,
      destinations: this.destinations,
      healingConfig: this.healingConfig,
      status: this._status,
      stats: this.stats,
      lastActivityAt: this._lastActivityAt?.toISOString() ?? null,
      createdAt: this.createdAt.toISOString(),
      updatedAt: this._updatedAt.toISOString(),
      created_at: this.createdAt.toISOString(),
      updated_at: this._updatedAt.toISOString(),
    };
  }
}

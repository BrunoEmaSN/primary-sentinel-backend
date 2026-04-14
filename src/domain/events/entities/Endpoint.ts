// src/domain/events/entities/Endpoint.ts
// Multi-destination fanout: supabase, webhook, http_api, postgres, mysql, bigquery

import { z } from "zod";
import type { ZodRawShape, ZodTypeAny } from "zod";

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

export type DeploymentEnvironment = "dev" | "staging" | "prod";

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
    public readonly environment: DeploymentEnvironment,
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
    environment?: DeploymentEnvironment;
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
      params.environment ?? "prod",
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
    environment?: DeploymentEnvironment;
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
      data.destinations, data.healingConfig, data.environment ?? "prod", data.status,
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

  withEnvironment(env: DeploymentEnvironment): Endpoint {
    return Endpoint.reconstitute({
      id: this.id,
      tenantId: this.tenantId,
      name: this.name,
      slug: this.slug,
      schema: this.schema,
      destinations: this.destinations,
      healingConfig: this.healingConfig,
      environment: env,
      status: this._status,
      totalEventsReceived: this._totalEventsReceived,
      totalEventsLoaded: this._totalEventsLoaded,
      totalEventsHealed: this._totalEventsHealed,
      totalEventsDead: this._totalEventsDead,
      lastActivityAt: this._lastActivityAt,
      webhookSecret: this.webhookSecret,
      createdAt: this.createdAt,
      updatedAt: new Date(),
    });
  }

  withHealingConfig(patch: Partial<HealingConfig>): Endpoint {
    return Endpoint.reconstitute({
      id: this.id,
      tenantId: this.tenantId,
      name: this.name,
      slug: this.slug,
      schema: this.schema,
      destinations: this.destinations,
      healingConfig: { ...this.healingConfig, ...patch },
      environment: this.environment,
      status: this._status,
      totalEventsReceived: this._totalEventsReceived,
      totalEventsLoaded: this._totalEventsLoaded,
      totalEventsHealed: this._totalEventsHealed,
      totalEventsDead: this._totalEventsDead,
      lastActivityAt: this._lastActivityAt,
      webhookSecret: this.webhookSecret,
      createdAt: this.createdAt,
      updatedAt: new Date(),
    });
  }

  withSchemaAndDestinations(
    schema: Record<string, unknown>,
    destinations: Destination[]
  ): Endpoint {
    return Endpoint.reconstitute({
      id: this.id,
      tenantId: this.tenantId,
      name: this.name,
      slug: this.slug,
      schema,
      destinations,
      healingConfig: this.healingConfig,
      environment: this.environment,
      status: this._status,
      totalEventsReceived: this._totalEventsReceived,
      totalEventsLoaded: this._totalEventsLoaded,
      totalEventsHealed: this._totalEventsHealed,
      totalEventsDead: this._totalEventsDead,
      lastActivityAt: this._lastActivityAt,
      webhookSecret: this.webhookSecret,
      createdAt: this.createdAt,
      updatedAt: new Date(),
    });
  }

  withStatus(status: EndpointStatus): Endpoint {
    return Endpoint.reconstitute({
      id: this.id,
      tenantId: this.tenantId,
      name: this.name,
      slug: this.slug,
      schema: this.schema,
      destinations: this.destinations,
      healingConfig: this.healingConfig,
      environment: this.environment,
      status,
      totalEventsReceived: this._totalEventsReceived,
      totalEventsLoaded: this._totalEventsLoaded,
      totalEventsHealed: this._totalEventsHealed,
      totalEventsDead: this._totalEventsDead,
      lastActivityAt: this._lastActivityAt,
      webhookSecret: this.webhookSecret,
      createdAt: this.createdAt,
      updatedAt: new Date(),
    });
  }

  withName(name: string): Endpoint {
    return Endpoint.reconstitute({
      id: this.id,
      tenantId: this.tenantId,
      name,
      slug: this.slug,
      schema: this.schema,
      destinations: this.destinations,
      healingConfig: this.healingConfig,
      environment: this.environment,
      status: this._status,
      totalEventsReceived: this._totalEventsReceived,
      totalEventsLoaded: this._totalEventsLoaded,
      totalEventsHealed: this._totalEventsHealed,
      totalEventsDead: this._totalEventsDead,
      lastActivityAt: this._lastActivityAt,
      webhookSecret: this.webhookSecret,
      createdAt: this.createdAt,
      updatedAt: new Date(),
    });
  }

  getWebhookUrl(baseUrl: string): string {
    return `${baseUrl}/webhook/${this.tenantId}/${this.slug}`;
  }

  /** Convierte un fragmento JSON Schema en un tipo Zod (incluye enum, format, objetos anidados y arrays tipados). */
  private buildZodField(value: Record<string, unknown>): ZodTypeAny {
    const enumVals = value["enum"];
    if (Array.isArray(enumVals) && enumVals.length > 0) {
      return this.jsonSchemaEnumToZod(enumVals);
    }

    const type = value["type"];

    if (type === "object" && value["properties"] && typeof value["properties"] === "object") {
      return this.buildZodObjectFromProps(
        value["properties"] as Record<string, Record<string, unknown>>,
        value["required"] as string[] | undefined
      );
    }

    if (type === "array") {
      const items = value["items"];
      if (items && typeof items === "object" && !Array.isArray(items)) {
        return z.array(this.buildZodField(items as Record<string, unknown>));
      }
      return z.array(z.unknown());
    }

    if (type === "string") {
      const fmt = value["format"];
      if (fmt === "email") return z.string().email();
      if (fmt === "uuid") return z.string().uuid();
      return z.string();
    }

    if (type === "number") return z.number();
    if (type === "integer") return z.number().int();
    if (type === "boolean") return z.boolean();

    if (type === "object") {
      return z.record(z.unknown());
    }

    return z.unknown();
  }

  private buildZodObjectFromProps(
    props: Record<string, Record<string, unknown>>,
    required: string[] | undefined
  ): z.ZodObject<ZodRawShape> {
    const shape: ZodRawShape = {};
    for (const [key, value] of Object.entries(props)) {
      const isRequired = Array.isArray(required) && required.includes(key);
      const zodType = this.buildZodField(value);
      shape[key] = isRequired ? zodType : zodType.optional();
    }
    return z.object(shape);
  }

  private jsonSchemaEnumToZod(values: unknown[]): ZodTypeAny {
    if (values.every((v): v is string => typeof v === "string")) {
      const strs = values as string[];
      if (strs.length === 1) return z.literal(strs[0]!);
      const [first, ...rest] = strs as [string, ...string[]];
      return z.enum([first, ...rest]);
    }
    if (values.length === 1) {
      return z.literal(values[0] as string | number | boolean);
    }
    const literals = values.map((v) => z.literal(v as string | number | boolean));
    return z.union(literals as unknown as [ZodTypeAny, ZodTypeAny, ...ZodTypeAny[]]);
  }

  buildZodSchema(): z.ZodObject<ZodRawShape> {
    const props = this.schema["properties"];
    const required = this.schema["required"] as string[] | undefined;

    if (props && typeof props === "object") {
      return this.buildZodObjectFromProps(
        props as Record<string, Record<string, unknown>>,
        required
      );
    }
    return z.object({});
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
      environment: this.environment,
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

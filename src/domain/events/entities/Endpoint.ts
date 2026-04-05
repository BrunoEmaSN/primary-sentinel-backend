// src/domain/events/entities/Endpoint.ts
// Represents a user-configured webhook endpoint with its expected schema

import { z } from "zod";

export type EndpointStatus = "active" | "paused" | "error";

export type DestinationType =
  | "supabase"
  | "postgres"
  | "bigquery"
  | "webhook"
  | "custom";

export type Destination = {
  type: DestinationType;
  connectionString?: string;
  tableName?: string;
  webhookUrl?: string;
  customConfig?: Record<string, unknown>;
};

export type HealingConfig = {
  enabled: boolean;
  maxAttempts: number;
  autoApplyRules: boolean;
  notifyOnHealing: boolean;
  notifyOnDead: boolean;
};

export class Endpoint {
  private constructor(
    public readonly id: string,
    public readonly tenantId: string,
    public readonly name: string,
    public readonly slug: string, // URL-safe identifier
    public readonly schema: Record<string, unknown>, // JSON Schema
    public readonly destination: Destination,
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
    destination: Destination;
    healingConfig?: Partial<HealingConfig>;
    webhookSecret: string;
  }): Endpoint {
    const defaultHealingConfig: HealingConfig = {
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
      params.destination,
      { ...defaultHealingConfig, ...params.healingConfig },
      "active",
      0,
      0,
      0,
      0,
      null,
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
    destination: Destination;
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
      data.id,
      data.tenantId,
      data.name,
      data.slug,
      data.schema,
      data.destination,
      data.healingConfig,
      data.status,
      data.totalEventsReceived,
      data.totalEventsLoaded,
      data.totalEventsHealed,
      data.totalEventsDead,
      data.lastActivityAt,
      data.webhookSecret,
      data.createdAt,
      data.updatedAt
    );
  }

  get status(): EndpointStatus {
    return this._status;
  }

  get stats() {
    return {
      total: this._totalEventsReceived,
      loaded: this._totalEventsLoaded,
      healed: this._totalEventsHealed,
      dead: this._totalEventsDead,
      successRate:
        this._totalEventsReceived > 0
          ? (this._totalEventsLoaded + this._totalEventsHealed) /
            this._totalEventsReceived
          : 0,
    };
  }

  get lastActivityAt(): Date | null {
    return this._lastActivityAt;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  incrementReceived(): void {
    this._totalEventsReceived += 1;
    this._lastActivityAt = new Date();
    this._updatedAt = new Date();
  }

  incrementLoaded(): void {
    this._totalEventsLoaded += 1;
    this._updatedAt = new Date();
  }

  incrementHealed(): void {
    this._totalEventsHealed += 1;
    this._updatedAt = new Date();
  }

  incrementDead(): void {
    this._totalEventsDead += 1;
    this._updatedAt = new Date();
  }

  pause(): void {
    this._status = "paused";
    this._updatedAt = new Date();
  }

  activate(): void {
    this._status = "active";
    this._updatedAt = new Date();
  }

  isActive(): boolean {
    return this._status === "active";
  }

  getWebhookUrl(baseUrl: string): string {
    return `${baseUrl}/webhook/${this.tenantId}/${this.slug}`;
  }

  validateSecret(providedSecret: string): boolean {
    // Timing-safe comparison would be ideal in production
    return this.webhookSecret === providedSecret;
  }

  buildZodSchema(): z.ZodObject<z.ZodRawShape> {
    // Dynamically build a Zod schema from JSON Schema
    // Simplified implementation — in production use @anatine/zod-openapi
    const shape: z.ZodRawShape = {};
    const schemaProperties = this.schema["properties"];
    const requiredFields = this.schema["required"];

    if (
      schemaProperties &&
      typeof schemaProperties === "object"
    ) {
      for (const [key, value] of Object.entries(schemaProperties)) {
        const fieldDef = value as Record<string, unknown>;
        const isRequired = Array.isArray(requiredFields) &&
          (requiredFields as string[]).includes(key);

        let zodType: z.ZodTypeAny;

        switch (fieldDef["type"]) {
          case "string":
            zodType = z.string();
            break;
          case "number":
          case "integer":
            zodType = z.number();
            break;
          case "boolean":
            zodType = z.boolean();
            break;
          case "array":
            zodType = z.array(z.unknown());
            break;
          case "object":
            zodType = z.record(z.unknown());
            break;
          default:
            zodType = z.unknown();
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
      name: this.name,
      slug: this.slug,
      schema: this.schema,
      destination: this.destination,
      healingConfig: this.healingConfig,
      status: this._status,
      stats: this.stats,
      lastActivityAt: this._lastActivityAt?.toISOString() ?? null,
      createdAt: this.createdAt.toISOString(),
      updatedAt: this._updatedAt.toISOString(),
    };
  }
}

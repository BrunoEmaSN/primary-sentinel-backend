// src/domain/events/entities/RawEvent.ts

import type { DestinationResult } from "./Endpoint.js";

export type EventStatus =
  | "received"
  | "validated"
  | "healing"
  | "healed"
  | "loaded"
  | "dead";

export type EventSource = {
  tenantId: string;
  endpointId: string;
  /** Origen HTTP (`Origin` / URL del worker) o URN interno p. ej. reinyección DLQ (`urn:sentinel:source:reinject`). */
  origin: string;
  receivedAt: Date;
};

export type EventMetadata = {
  contentType: string;
  headers: Record<string, string>;
  ipAddress?: string;
  userAgent?: string;
};

export class RawEvent {
  private constructor(
    public readonly id: string,
    public readonly tenantId: string,
    public readonly endpointId: string,
    public readonly rawPayload: unknown,
    public readonly source: EventSource,
    public readonly metadata: EventMetadata,
    private _status: EventStatus,
    private _validatedPayload: unknown | null,
    private _healingAttempts: number,
    private _errorLog: string[],
    private _transformationRuleId: string | null,
    // NEW: per-destination dispatch results for observability
    private _dispatchResults: DestinationResult[],
    public readonly createdAt: Date,
    private _updatedAt: Date
  ) {}

  static create(params: {
    id: string;
    tenantId: string;
    endpointId: string;
    rawPayload: unknown;
    source: EventSource;
    metadata: EventMetadata;
  }): RawEvent {
    return new RawEvent(
      params.id, params.tenantId, params.endpointId,
      params.rawPayload, params.source, params.metadata,
      "received", null, 0, [], null, [],
      new Date(), new Date()
    );
  }

  static reconstitute(data: {
    id: string;
    tenantId: string;
    endpointId: string;
    rawPayload: unknown;
    source: EventSource;
    metadata: EventMetadata;
    status: EventStatus;
    validatedPayload: unknown | null;
    healingAttempts: number;
    errorLog: string[];
    transformationRuleId: string | null;
    dispatchResults: DestinationResult[];
    createdAt: Date;
    updatedAt: Date;
  }): RawEvent {
    return new RawEvent(
      data.id, data.tenantId, data.endpointId,
      data.rawPayload, data.source, data.metadata,
      data.status, data.validatedPayload, data.healingAttempts,
      data.errorLog, data.transformationRuleId, data.dispatchResults,
      data.createdAt, data.updatedAt
    );
  }

  get status(): EventStatus                           { return this._status; }
  get validatedPayload(): unknown | null              { return this._validatedPayload; }
  get healingAttempts(): number                       { return this._healingAttempts; }
  get errorLog(): ReadonlyArray<string>               { return this._errorLog; }
  get transformationRuleId(): string | null           { return this._transformationRuleId; }
  get dispatchResults(): ReadonlyArray<DestinationResult> { return this._dispatchResults; }
  get updatedAt(): Date                               { return this._updatedAt; }

  markAsValidated(validatedPayload: unknown): void {
    this._status = "validated";
    this._validatedPayload = validatedPayload;
    this._updatedAt = new Date();
  }

  markAsHealing(): void {
    this._status = "healing";
    this._healingAttempts += 1;
    this._updatedAt = new Date();
  }

  markAsHealed(validatedPayload: unknown, ruleId: string): void {
    this._status = "healed";
    this._validatedPayload = validatedPayload;
    this._transformationRuleId = ruleId;
    this._updatedAt = new Date();
  }

  markAsLoaded(results: DestinationResult[]): void {
    this._status = "loaded";
    this._dispatchResults = results;
    this._updatedAt = new Date();
  }

  markAsDead(reason: string): void {
    this._status = "dead";
    this._errorLog.push(`[${new Date().toISOString()}] FATAL: ${reason}`);
    this._updatedAt = new Date();
  }

  addError(error: string): void {
    this._errorLog.push(`[${new Date().toISOString()}] ${error}`);
    this._updatedAt = new Date();
  }

  canAttemptHealing(maxAttempts = 3): boolean {
    return this._healingAttempts < maxAttempts;
  }

  toSnapshot(): Record<string, unknown> {
    return {
      id: this.id,
      tenantId: this.tenantId,
      endpointId: this.endpointId,
      rawPayload: this.rawPayload,
      source: this.source,
      metadata: this.metadata,
      status: this._status,
      validatedPayload: this._validatedPayload,
      healingAttempts: this._healingAttempts,
      errorLog: this._errorLog,
      transformationRuleId: this._transformationRuleId,
      dispatchResults: this._dispatchResults,
      createdAt: this.createdAt.toISOString(),
      updatedAt: this._updatedAt.toISOString(),
    };
  }
}

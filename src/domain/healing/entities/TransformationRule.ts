// src/domain/healing/entities/TransformationRule.ts

export type RuleLanguage = "javascript" | "json-map";
export type RuleStatus   = "active" | "deprecated" | "quarantined";

export class TransformationRule {
  private constructor(
    public readonly id: string,
    public readonly tenantId: string,
    public readonly endpointId: string,
    public readonly schemaVersion: string,
    public readonly errorFingerprint: string,
    public readonly language: RuleLanguage,
    public readonly script: string,
    public readonly description: string,
    private _status: RuleStatus,
    private _successCount: number,
    private _failureCount: number,
    private _lastUsedAt: Date | null,
    public readonly generatedBy: string,
    public readonly createdAt: Date,
    private _updatedAt: Date
  ) {}

  static create(params: {
    id: string;
    tenantId: string;
    endpointId: string;
    schemaVersion: string;
    errorFingerprint: string;
    language: RuleLanguage;
    script: string;
    description: string;
    generatedBy: string;
  }): TransformationRule {
    return new TransformationRule(
      params.id, params.tenantId, params.endpointId,
      params.schemaVersion, params.errorFingerprint,
      params.language, params.script, params.description,
      "active", 0, 0, null, params.generatedBy,
      new Date(), new Date()
    );
  }

  static reconstitute(data: {
    id: string; tenantId: string; endpointId: string;
    schemaVersion: string; errorFingerprint: string;
    language: RuleLanguage; script: string; description: string;
    status: RuleStatus; successCount: number; failureCount: number;
    lastUsedAt: Date | null; generatedBy: string;
    createdAt: Date; updatedAt: Date;
  }): TransformationRule {
    return new TransformationRule(
      data.id, data.tenantId, data.endpointId,
      data.schemaVersion, data.errorFingerprint,
      data.language, data.script, data.description,
      data.status, data.successCount, data.failureCount,
      data.lastUsedAt, data.generatedBy,
      data.createdAt, data.updatedAt
    );
  }

  get status(): RuleStatus        { return this._status; }
  get successCount(): number      { return this._successCount; }
  get failureCount(): number      { return this._failureCount; }
  get lastUsedAt(): Date | null   { return this._lastUsedAt; }
  get updatedAt(): Date           { return this._updatedAt; }

  get successRate(): number {
    const total = this._successCount + this._failureCount;
    return total === 0 ? 0 : this._successCount / total;
  }

  recordSuccess(): void {
    this._successCount += 1;
    this._lastUsedAt = new Date();
    this._updatedAt = new Date();
    if (this._successCount + this._failureCount >= 10 && this.successRate < 0.3) {
      this._status = "quarantined";
    }
  }

  recordFailure(): void {
    this._failureCount += 1;
    this._updatedAt = new Date();
  }

  deprecate(): void  { this._status = "deprecated"; this._updatedAt = new Date(); }
  quarantine(): void { this._status = "quarantined"; this._updatedAt = new Date(); }
  isUsable(): boolean { return this._status === "active"; }

  toSnapshot(): Record<string, unknown> {
    return {
      id: this.id, tenantId: this.tenantId, endpointId: this.endpointId,
      schemaVersion: this.schemaVersion, errorFingerprint: this.errorFingerprint,
      language: this.language, script: this.script, description: this.description,
      status: this._status, successCount: this._successCount,
      failureCount: this._failureCount, successRate: this.successRate,
      lastUsedAt: this._lastUsedAt?.toISOString() ?? null,
      generatedBy: this.generatedBy,
      createdAt: this.createdAt.toISOString(),
      updatedAt: this._updatedAt.toISOString(),
    };
  }
}

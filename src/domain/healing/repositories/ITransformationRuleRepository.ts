// src/domain/healing/repositories/ITransformationRuleRepository.ts
import type { TransformationRule } from "../entities/TransformationRule.js";

export interface ITransformationRuleRepository {
  save(rule: TransformationRule): Promise<void>;
  findByFingerprint(params: {
    tenantId: string;
    endpointId: string;
    errorFingerprint: string;
  }): Promise<TransformationRule | null>;
  findById(id: string): Promise<TransformationRule | null>;
  findByEndpoint(params: {
    tenantId: string;
    endpointId: string;
    limit?: number;
  }): Promise<TransformationRule[]>;
  update(rule: TransformationRule): Promise<void>;
}

export interface IRuleCache {
  get(fingerprint: string): Promise<string | null>;
  set(fingerprint: string, ruleId: string, ttlSeconds?: number): Promise<void>;
  invalidate(fingerprint: string): Promise<void>;
}

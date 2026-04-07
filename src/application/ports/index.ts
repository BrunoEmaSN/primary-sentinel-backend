// src/application/ports/index.ts

export type HealingRequest = {
  expectedSchema: Record<string, unknown>;
  receivedPayload: unknown;
  validationErrors: string[];
  endpointContext: string;
};

export type HealingResult = {
  success: boolean;
  script: string;
  description: string;
  language: "javascript" | "json-map";
  confidence: number;
  modelUsed: string;
};

export interface ILLMService {
  generateTransformationScript(request: HealingRequest): Promise<HealingResult>;
}

export interface IStorageService {
  store(key: string, data: unknown): Promise<string>;
  retrieve(key: string): Promise<unknown | null>;
  delete(key: string): Promise<void>;
}

export type NotificationType =
  | "healing_success"
  | "healing_failure"
  | "dead_letter"
  | "rule_quarantined";

export type NotificationPayload = {
  tenantId: string;
  endpointId?: string;
  type: NotificationType;
  tenantEmail: string;
  endpointName: string;
  eventId: string;
  details: Record<string, unknown>;
};

export interface INotificationService {
  send(payload: NotificationPayload): Promise<void>;
}

export type SandboxResult = {
  success: boolean;
  output: unknown;
  error?: string;
  executionTimeMs: number;
};

export interface ISandboxService {
  execute(script: string, input: unknown): Promise<SandboxResult>;
}

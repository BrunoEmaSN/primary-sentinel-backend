// src/application/ports/ILLMService.ts
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
  confidence: number; // 0-1
  modelUsed: string;
};

export interface ILLMService {
  generateTransformationScript(request: HealingRequest): Promise<HealingResult>;
}

// src/application/ports/IQueueService.ts
export type QueueMessage = {
  eventId: string;
  tenantId: string;
  endpointId: string;
  action: "validate" | "heal" | "load" | "dlq";
};

export interface IQueueService {
  enqueue(message: QueueMessage): Promise<void>;
  enqueueBatch(messages: QueueMessage[]): Promise<void>;
}

// src/application/ports/IStorageService.ts
export interface IStorageService {
  store(key: string, data: unknown): Promise<string>; // returns object URL
  retrieve(key: string): Promise<unknown | null>;
  delete(key: string): Promise<void>;
}

// src/application/ports/INotificationService.ts
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

// src/application/ports/ISandboxService.ts
export type SandboxResult = {
  success: boolean;
  output: unknown;
  error?: string;
  executionTimeMs: number;
};

export interface ISandboxService {
  execute(script: string, input: unknown): Promise<SandboxResult>;
}

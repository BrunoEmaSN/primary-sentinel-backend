// src/domain/events/repositories/IEventRepository.ts
import type { RawEvent, EventStatus } from "../entities/RawEvent.js";

export interface IEventRepository {
  save(event: RawEvent): Promise<void>;
  findById(id: string): Promise<RawEvent | null>;
  findByTenantAndEndpoint(params: {
    tenantId: string;
    endpointId: string;
    status?: EventStatus;
    limit?: number;
    offset?: number;
  }): Promise<{ events: RawEvent[]; total: number }>;
  updateStatus(event: RawEvent): Promise<void>;
  existsById(id: string): Promise<boolean>; // idempotency check
}

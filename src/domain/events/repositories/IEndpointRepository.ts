// src/domain/events/repositories/IEndpointRepository.ts
import type { Endpoint } from "../entities/Endpoint.js";

export interface IEndpointRepository {
  save(endpoint: Endpoint): Promise<void>;
  findById(id: string): Promise<Endpoint | null>;
  findBySlug(params: { tenantId: string; slug: string }): Promise<Endpoint | null>;
  findByTenantId(tenantId: string): Promise<Endpoint[]>;
  update(endpoint: Endpoint): Promise<void>;
  /** Actualiza configuración completa (schema, destinos, healing, entorno, nombre, estado). */
  updateFull(endpoint: Endpoint): Promise<void>;
  delete(id: string): Promise<void>;
  countActiveByTenant(tenantId: string): Promise<number>;
}

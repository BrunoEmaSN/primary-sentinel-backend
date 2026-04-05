// src/application/use-cases/ManageEndpoint.ts
import { Endpoint } from "../../domain/events/entities/Endpoint.js";
import type { IEndpointRepository } from "../../domain/events/repositories/IEndpointRepository.js";
import { generateId, generateWebhookSecret } from "../../infrastructure/utils/crypto.js";
import { createLogger } from "../../infrastructure/utils/logger.js";

const logger = createLogger("ManageEndpoint");

// ── Create ──────────────────────────────────────────────────────────────────

export type CreateEndpointCommand = {
  tenantId: string;
  name: string;
  schema: Record<string, unknown>;
  destination: import("../../domain/events/entities/Endpoint.js").Destination;
  healingConfig?: Partial<import("../../domain/events/entities/Endpoint.js").HealingConfig>;
};

export type CreateEndpointResult = {
  endpoint: Record<string, unknown>;
  webhookUrl: string;
  webhookSecret: string;
};

export class CreateEndpoint {
  constructor(
    private readonly endpointRepo: IEndpointRepository,
    private readonly baseUrl: string
  ) {}

  async execute(command: CreateEndpointCommand): Promise<CreateEndpointResult> {
    const slug = generateSlug(command.name);
    const webhookSecret = generateWebhookSecret();

    const endpoint = Endpoint.create({
      id: generateId(),
      tenantId: command.tenantId,
      name: command.name,
      slug,
      schema: command.schema,
      destination: command.destination,
      ...(command.healingConfig ? { healingConfig: command.healingConfig } : {}),
      webhookSecret,
    });

    await this.endpointRepo.save(endpoint);
    logger.info("Endpoint created", { endpointId: endpoint.id, tenantId: command.tenantId });

    return {
      endpoint: endpoint.toSnapshot(),
      webhookUrl: endpoint.getWebhookUrl(this.baseUrl),
      webhookSecret, // Only exposed once at creation
    };
  }
}

// ── List ────────────────────────────────────────────────────────────────────

export class ListEndpoints {
  constructor(private readonly endpointRepo: IEndpointRepository) {}

  async execute(tenantId: string): Promise<Record<string, unknown>[]> {
    const endpoints = await this.endpointRepo.findByTenantId(tenantId);
    return endpoints.map((e) => e.toSnapshot());
  }
}

// ── Get ─────────────────────────────────────────────────────────────────────

export class GetEndpoint {
  constructor(private readonly endpointRepo: IEndpointRepository) {}

  async execute(params: {
    endpointId: string;
    tenantId: string;
  }): Promise<Record<string, unknown> | null> {
    const endpoint = await this.endpointRepo.findById(params.endpointId);
    if (!endpoint || endpoint.tenantId !== params.tenantId) return null;
    return endpoint.toSnapshot();
  }
}

// ── Delete ───────────────────────────────────────────────────────────────────

export class DeleteEndpoint {
  constructor(private readonly endpointRepo: IEndpointRepository) {}

  async execute(params: { endpointId: string; tenantId: string }): Promise<void> {
    const endpoint = await this.endpointRepo.findById(params.endpointId);
    if (!endpoint || endpoint.tenantId !== params.tenantId) {
      throw new Error("Endpoint not found");
    }
    await this.endpointRepo.delete(params.endpointId);
    logger.info("Endpoint deleted", params);
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function generateSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 50);
}

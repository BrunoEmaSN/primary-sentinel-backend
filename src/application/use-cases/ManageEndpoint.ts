// src/application/use-cases/ManageEndpoint.ts

import { Endpoint } from "../../domain/events/entities/Endpoint.js";
import {
  DestinationSchema,
  type Destination,
  type HealingConfig,
  type DeploymentEnvironment,
  type EndpointStatus,
} from "../../domain/events/entities/Endpoint.js";
import type { IEndpointRepository } from "../../domain/events/repositories/IEndpointRepository.js";
import { generateId, generateWebhookSecret } from "../../infrastructure/utils/crypto.js";
import { createLogger } from "../../infrastructure/utils/logger.js";
import { encryptDestinationsWithKey } from "../../infrastructure/utils/destinationSecretsCodec.js";
import { toPublicEndpointSnapshot } from "../../infrastructure/http/endpointSerialization.js";

const logger = createLogger("ManageEndpoint");

// ── Create ────────────────────────────────────────────────────────────────────

export type CreateEndpointCommand = {
  tenantId: string;
  name: string;
  schema: Record<string, unknown>;
  // Accept single destination (backwards compat) or array (fanout)
  destination?: Destination;
  destinations?: Destination[];
  healingConfig?: Partial<HealingConfig>;
  environment?: DeploymentEnvironment;
};

export type CreateEndpointResult = {
  endpoint: Record<string, unknown>;
  webhookUrl: string;
  webhookSecret: string;
};

export class CreateEndpoint {
  constructor(
    private readonly endpointRepo: IEndpointRepository,
    private readonly baseUrl: string,
    private readonly destinationCryptoKey?: string
  ) {}

  async execute(command: CreateEndpointCommand): Promise<CreateEndpointResult> {
    // Support both single `destination` and `destinations` array
    let destinations: Destination[];

    if (command.destinations && command.destinations.length > 0) {
      destinations = command.destinations.map((d) => DestinationSchema.parse(d));
    } else if (command.destination) {
      destinations = [DestinationSchema.parse(command.destination)];
    } else {
      throw new Error("At least one destination is required");
    }

    if (destinations.length > 5) {
      throw new Error("Maximum 5 destinations per endpoint");
    }

    if (this.destinationCryptoKey) {
      destinations = await encryptDestinationsWithKey(destinations, this.destinationCryptoKey);
    } else {
      logger.warn(
        "SENTINEL_DESTINATION_SECRET_KEY not set — destination secrets will be stored as plaintext in the database"
      );
    }

    const slug = generateSlug(command.name);
    const webhookSecret = generateWebhookSecret();

    const endpoint = Endpoint.create({
      id: generateId(),
      tenantId: command.tenantId,
      name: command.name,
      slug,
      schema: command.schema,
      destinations,
      ...(command.healingConfig ? { healingConfig: command.healingConfig } : {}),
      ...(command.environment ? { environment: command.environment } : {}),
      webhookSecret,
    });

    await this.endpointRepo.save(endpoint);
    logger.info("Endpoint created", { endpointId: endpoint.id, tenantId: command.tenantId });

    return {
      endpoint: toPublicEndpointSnapshot(endpoint.toSnapshot()),
      webhookUrl: endpoint.getWebhookUrl(this.baseUrl),
      webhookSecret, // only exposed once at creation
    };
  }
}

// ── List ──────────────────────────────────────────────────────────────────────

export class ListEndpoints {
  constructor(private readonly endpointRepo: IEndpointRepository) {}

  async execute(tenantId: string): Promise<Record<string, unknown>[]> {
    const endpoints = await this.endpointRepo.findByTenantId(tenantId);
    return endpoints.map((e) => toPublicEndpointSnapshot(e.toSnapshot()));
  }
}

// ── Get ───────────────────────────────────────────────────────────────────────

export class GetEndpoint {
  constructor(private readonly endpointRepo: IEndpointRepository) {}

  async execute(params: {
    endpointId: string;
    tenantId: string;
  }): Promise<Record<string, unknown> | null> {
    const endpoint = await this.endpointRepo.findById(params.endpointId);
    if (!endpoint || endpoint.tenantId !== params.tenantId) return null;
    return toPublicEndpointSnapshot(endpoint.toSnapshot());
  }
}

// ── Delete ────────────────────────────────────────────────────────────────────

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

// ── Update ────────────────────────────────────────────────────────────────────

export type UpdateEndpointCommand = {
  tenantId: string;
  endpointId: string;
  name?: string;
  schema?: Record<string, unknown>;
  destinations?: Destination[];
  healingConfig?: Partial<HealingConfig>;
  environment?: DeploymentEnvironment;
  status?: EndpointStatus;
};

export class UpdateEndpoint {
  constructor(
    private readonly endpointRepo: IEndpointRepository,
    private readonly destinationCryptoKey?: string
  ) {}

  async execute(command: UpdateEndpointCommand): Promise<Record<string, unknown>> {
    const ep = await this.endpointRepo.findById(command.endpointId);
    if (!ep || ep.tenantId !== command.tenantId) {
      throw new Error("Endpoint not found");
    }

    let next = ep;
    if (command.name !== undefined) next = next.withName(command.name);
    if (command.environment !== undefined) next = next.withEnvironment(command.environment);
    if (command.healingConfig) next = next.withHealingConfig(command.healingConfig);
    if (command.status !== undefined) next = next.withStatus(command.status);

    if (command.schema !== undefined || command.destinations !== undefined) {
      if (!command.schema || !command.destinations) {
        throw new Error("schema and destinations are required together when updating either");
      }
      if (command.destinations.length > 5) throw new Error("Maximum 5 destinations per endpoint");
      let destinations = command.destinations.map((d) => DestinationSchema.parse(d));
      if (this.destinationCryptoKey) {
        destinations = await encryptDestinationsWithKey(destinations, this.destinationCryptoKey);
      }
      next = next.withSchemaAndDestinations(command.schema, destinations);
    }

    await this.endpointRepo.updateFull(next);
    return toPublicEndpointSnapshot(next.toSnapshot());
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function generateSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 50);
}

import { ProcessWebhookEvent } from "./ProcessWebhookEvent.js";
import type { RawEvent } from "../../domain/events/entities/RawEvent.js";
import type { IEventRepository } from "../../domain/events/repositories/IEventRepository.js";
import type { IEndpointRepository } from "../../domain/events/repositories/IEndpointRepository.js";
import { generateId } from "../../infrastructure/utils/crypto.js";
import type { TenantInfraAdapter } from "../../infrastructure/adapters/database/TenantInfraAdapter.js";

export class ReinjectDlqEvent {
  constructor(
    private readonly eventRepo: IEventRepository,
    private readonly endpointRepo: IEndpointRepository,
    private readonly processWebhook: ProcessWebhookEvent,
    private readonly tenantInfra?: TenantInfraAdapter
  ) {}

  async execute(params: {
    tenantId: string;
    eventId: string;
    correctedPayload?: unknown;
    actorEmail: string;
    snapshotName?: string;
  }): Promise<{ status: string; message: string; newEventId?: string }> {
    const event = await this.eventRepo.findById(params.eventId);
    if (!event || event.tenantId !== params.tenantId) {
      throw new Error("Event not found");
    }
    if (event.status !== "dead") {
      throw new Error("Only dead-letter events can be reinjected");
    }

    const endpoint = await this.endpointRepo.findById(event.endpointId);
    if (!endpoint || endpoint.tenantId !== params.tenantId) {
      throw new Error("Endpoint not found");
    }

    const payload = params.correctedPayload ?? event.rawPayload;

    if (params.snapshotName) {
      await this.tenantInfra
        ?.insertSnapshot({
          tenantId: params.tenantId,
          eventId: params.eventId,
          name: params.snapshotName,
          payload: event.toSnapshot(),
          createdByEmail: params.actorEmail,
        })
        .catch(() => undefined);
    }

    const newEventId = generateId();

    const result = await this.processWebhook.execute({
      eventId: newEventId,
      tenantId: params.tenantId,
      endpointSlug: endpoint.slug,
      rawPayload: payload,
      metadata: {
        contentType: "application/json",
        headers: { "X-Sentinel-Reinject": "true" },
      },
      origin: "https://sentinel.reinject/local",
    });

    await this.eventRepo.deleteById(params.eventId);

    return {
      status: result.status,
      message: result.message,
      newEventId: result.eventId,
    };
  }
}

export class DiscardDlqEvent {
  constructor(private readonly eventRepo: IEventRepository) {}

  async execute(params: { tenantId: string; eventId: string }): Promise<void> {
    const event = await this.eventRepo.findById(params.eventId);
    if (!event || event.tenantId !== params.tenantId) {
      throw new Error("Event not found");
    }
    if (event.status !== "dead") {
      throw new Error("Only dead-letter events can be discarded");
    }
    await this.eventRepo.deleteById(params.eventId);
  }
}

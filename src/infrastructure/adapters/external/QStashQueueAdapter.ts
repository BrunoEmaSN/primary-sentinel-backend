// src/infrastructure/adapters/external/QStashQueueAdapter.ts
// Reemplaza UpstashQueueService (Kafka) con QStash — mejor opción para Cloudflare Workers

import type { IQueueService, QueueMessage } from "../../../application/ports/index.js";
import { createLogger } from "../../utils/logger.js";

const logger = createLogger("QStashQueueAdapter");

export class QStashQueueAdapter implements IQueueService {
  private readonly token: string;
  private readonly workerUrl: string; // URL del propio Worker que va a procesar el mensaje
  private readonly baseUrl = "https://qstash.upstash.io/v2";

  constructor(token: string, workerUrl: string) {
    this.token = token;
    this.workerUrl = workerUrl;
  }

  async enqueue(message: QueueMessage): Promise<void> {
    const endpoint = `${this.workerUrl}/internal/queue`;

    const response = await fetch(`${this.baseUrl}/publish/${encodeURIComponent(endpoint)}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
        // Reintentos automáticos en caso de fallo
        "Upstash-Retries": "3",
        "Upstash-Retry-Delay": "5s",
        // Deduplicación por eventId (idempotencia)
        "Upstash-Deduplication-Id": message.eventId,
      },
      body: JSON.stringify(message),
    });

    if (!response.ok) {
      const error = await response.text();
      logger.error("QStash enqueue failed", { status: response.status, error, message });
      throw new QStashError(`Failed to enqueue message: ${error}`);
    }

    const result = await response.json() as { messageId: string };
    logger.info("Message enqueued to QStash", {
      messageId: result.messageId,
      eventId: message.eventId,
      action: message.action,
    });
  }

  async enqueueBatch(messages: QueueMessage[]): Promise<void> {
    // QStash soporta batch publish
    const entries = messages.map((message) => ({
      destination: `${this.workerUrl}/internal/queue`,
      headers: {
        "Content-Type": "application/json",
        "Upstash-Retries": "3",
        "Upstash-Deduplication-Id": message.eventId,
      },
      body: JSON.stringify(message),
    }));

    const response = await fetch(`${this.baseUrl}/batch`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(entries),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new QStashError(`Batch enqueue failed: ${error}`);
    }

    logger.info("Batch enqueued to QStash", { count: messages.length });
  }
}

export class QStashError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QStashError";
  }
}

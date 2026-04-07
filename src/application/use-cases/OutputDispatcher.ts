// src/application/use-cases/OutputDispatcher.ts
// Dispatches a validated payload to ALL configured destinations in parallel.

import { createClient } from "@supabase/supabase-js";
import postgres from "postgres";
import mysql from "mysql2/promise";
import * as jose from "jose";
import type {
  Destination,
  DestinationResult,
  SupabaseDestination,
  WebhookDestination,
  HttpApiDestination,
  PostgresDestination,
  MysqlDestination,
  BigQueryDestination,
} from "../../domain/events/entities/Endpoint.js";
import { createLogger } from "../../infrastructure/utils/logger.js";

const logger = createLogger("OutputDispatcher");

export class OutputDispatcher {
  constructor(
    private readonly defaultSupabaseUrl: string,
    private readonly defaultSupabaseKey: string
  ) {}

  async dispatch(
    destinations: Destination[],
    payload: unknown
  ): Promise<DestinationResult[]> {
    if (destinations.length === 0) return [];

    const tasks = destinations.map((dest, index) =>
      this.dispatchOne(dest, index, payload)
    );

    const settled = await Promise.allSettled(tasks);

    return settled.map((result, index) => {
      if (result.status === "fulfilled") return result.value;
      const dest = destinations[index]!;
      logger.error("Destination dispatch threw unexpectedly", {
        type: dest.type,
        index,
        error: String(result.reason),
      });
      return {
        destinationType: dest.type,
        destinationIndex: index,
        success: false,
        error: result.reason instanceof Error
          ? result.reason.message
          : String(result.reason),
        durationMs: 0,
      } satisfies DestinationResult;
    });
  }

  private async dispatchOne(
    dest: Destination,
    index: number,
    payload: unknown
  ): Promise<DestinationResult> {
    const start = Date.now();
    let statusCode: number | undefined;
    try {
      switch (dest.type) {
        case "supabase":
          await this.toSupabase(dest, payload);
          break;
        case "webhook":
          statusCode = await this.toWebhook(dest, payload);
          break;
        case "http_api":
          statusCode = await this.toHttpApi(dest, payload);
          break;
        case "postgres":
          await this.toPostgres(dest, payload);
          break;
        case "mysql":
          await this.toMysql(dest, payload);
          break;
        case "bigquery":
          statusCode = await this.toBigQuery(dest, payload);
          break;
      }
      const durationMs = Date.now() - start;
      logger.info("Destination dispatch success", { type: dest.type, index, durationMs });
      return {
        destinationType: dest.type,
        destinationIndex: index,
        success: true,
        durationMs,
        ...(statusCode !== undefined ? { statusCode } : {}),
      };
    } catch (err) {
      const durationMs = Date.now() - start;
      const error = err instanceof Error ? err.message : String(err);
      logger.warn("Destination dispatch failed", { type: dest.type, index, error, durationMs });
      return { destinationType: dest.type, destinationIndex: index, success: false, error, durationMs };
    }
  }

  private async toSupabase(dest: SupabaseDestination, payload: unknown): Promise<void> {
    const url = dest.projectUrl ?? this.defaultSupabaseUrl;
    const key = dest.serviceKey ?? this.defaultSupabaseKey;
    const client = createClient(url, key);
    const { error } = await client.from(dest.tableName).insert(payload);
    if (error) throw new Error(`Supabase insert error: ${error.message}`);
  }

  private async toWebhook(dest: WebhookDestination, payload: unknown): Promise<number> {
    const body = dest.wrapKey
      ? JSON.stringify({ [dest.wrapKey]: payload })
      : JSON.stringify(payload);

    const run = async (): Promise<number> => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), dest.timeoutMs);
      try {
        const res = await fetch(dest.url, {
          method: dest.method,
          headers: { "Content-Type": "application/json", ...(dest.headers ?? {}) },
          body,
          signal: controller.signal,
        });
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          throw new Error(`Webhook ${res.status}: ${text.slice(0, 200)}`);
        }
        return res.status;
      } finally {
        clearTimeout(timer);
      }
    };

    try {
      return await run();
    } catch (first) {
      if (!dest.retryOnFailure) throw first;
      logger.info("Webhook retry after failure", { url: dest.url });
      return await run();
    }
  }

  private async toHttpApi(dest: HttpApiDestination, payload: unknown): Promise<number> {
    const authHeaders: Record<string, string> = {};

    switch (dest.authType) {
      case "bearer":
        authHeaders["Authorization"] = `Bearer ${dest.authValue ?? ""}`;
        break;
      case "basic":
        authHeaders["Authorization"] = `Basic ${btoa(dest.authValue ?? ":")}`;
        break;
      case "api_key":
        authHeaders[dest.authHeader ?? "X-Api-Key"] = dest.authValue ?? "";
        break;
      case "none":
        break;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), dest.timeoutMs);

    try {
      const res = await fetch(dest.url, {
        method: dest.method,
        headers: {
          "Content-Type": "application/json",
          ...authHeaders,
          ...(dest.headers ?? {}),
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`HTTP API ${res.status}: ${text.slice(0, 200)}`);
      }
      return res.status;
    } finally {
      clearTimeout(timer);
    }
  }

  private async toPostgres(dest: PostgresDestination, payload: unknown): Promise<void> {
    const sql = postgres(dest.connectionString, {
      max: 1,
      idle_timeout: 5,
      connect_timeout: 20,
    });
    try {
      const schema = dest.schema;
      const table = dest.table;
      const col = dest.payloadColumn;
      await sql.unsafe(
        `insert into "${schema}"."${table}" ("${col}") values ($1::jsonb)`,
        [JSON.stringify(payload ?? null)]
      );
    } finally {
      await sql.end({ timeout: 5 }).catch(() => undefined);
    }
  }

  private async toMysql(dest: MysqlDestination, payload: unknown): Promise<void> {
    const conn = await mysql.createConnection(dest.connectionString);
    try {
      const db = dest.database;
      const table = dest.table;
      const col = dest.payloadColumn;
      const q = `INSERT INTO \`${db}\`.\`${table}\` (\`${col}\`) VALUES (CAST(? AS JSON))`;
      await conn.execute(q, [JSON.stringify(payload ?? null)]);
    } finally {
      await conn.end().catch(() => undefined);
    }
  }

  private async toBigQuery(dest: BigQueryDestination, payload: unknown): Promise<number> {
    let sa: { client_email: string; private_key: string };
    try {
      sa = JSON.parse(dest.serviceAccountKey) as { client_email: string; private_key: string };
    } catch {
      throw new Error("BigQuery serviceAccountKey must be valid JSON");
    }
    if (!sa.client_email || !sa.private_key) {
      throw new Error("BigQuery service account JSON missing client_email or private_key");
    }

    const pk = await jose.importPKCS8(sa.private_key, "RS256");
    const now = Math.floor(Date.now() / 1000);
    const jwt = await new jose.SignJWT({
      scope: "https://www.googleapis.com/auth/bigquery.insertdata",
    })
      .setProtectedHeader({ alg: "RS256", typ: "JWT" })
      .setIssuer(sa.client_email)
      .setSubject(sa.client_email)
      .setAudience("https://oauth2.googleapis.com/token")
      .setIssuedAt(now)
      .setExpirationTime(now + 3600)
      .sign(pk);

    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: jwt,
      }),
    });
    const tokenJson = (await tokenRes.json()) as { access_token?: string; error?: string };
    if (!tokenJson.access_token) {
      throw new Error(`BigQuery OAuth failed: ${tokenJson.error ?? tokenRes.statusText}`);
    }

    const rowJson =
      payload !== null && typeof payload === "object" && !Array.isArray(payload)
        ? (payload as Record<string, unknown>)
        : { _sentinel_payload: payload as string | number | boolean | null };

    const url =
      `https://bigquery.googleapis.com/bigquery/v2/projects/${encodeURIComponent(dest.projectId)}` +
      `/datasets/${encodeURIComponent(dest.datasetId)}/tables/${encodeURIComponent(dest.tableId)}/insertAll`;

    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokenJson.access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        kind: "bigquery#tableDataInsertAllRequest",
        rows: [{ json: rowJson }],
      }),
    });

    const text = await res.text();
    let parsed: { insertErrors?: unknown[]; error?: { message?: string } };
    try {
      parsed = JSON.parse(text) as typeof parsed;
    } catch {
      throw new Error(`BigQuery insertAll: ${res.status} ${text.slice(0, 300)}`);
    }

    if (!res.ok) {
      throw new Error(
        `BigQuery insertAll ${res.status}: ${parsed.error?.message ?? text.slice(0, 200)}`
      );
    }
    if (parsed.insertErrors && parsed.insertErrors.length > 0) {
      throw new Error(`BigQuery row errors: ${JSON.stringify(parsed.insertErrors).slice(0, 400)}`);
    }
    return res.status;
  }
}

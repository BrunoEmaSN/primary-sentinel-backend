import { describe, it, expect } from "vitest";
import {
  DestinationSchema,
  SupabaseDestinationSchema,
} from "../../src/domain/events/entities/Endpoint.js";

describe("DestinationSchema", () => {
  it("normalizes supabase apiKey to serviceKey", () => {
    const out = SupabaseDestinationSchema.parse({
      type: "supabase",
      tableName: "events",
      apiKey: "secret-key",
    });
    expect(out.serviceKey).toBe("secret-key");
    expect("apiKey" in out).toBe(false);
  });

  it("accepts https *.supabase.co as connectionString as projectUrl", () => {
    const out = SupabaseDestinationSchema.parse({
      type: "supabase",
      tableName: "t",
      connectionString: "https://abcxyz.supabase.co",
    });
    expect(out.projectUrl).toBe("https://abcxyz.supabase.co");
  });

  it("parses postgres destination", () => {
    const d = DestinationSchema.parse({
      type: "postgres",
      connectionString: "postgresql://u:p@host/db",
      table: "ingest",
      schema: "public",
    });
    expect(d.type).toBe("postgres");
    if (d.type === "postgres") {
      expect(d.payloadColumn).toBe("payload");
    }
  });

  it("parses bigquery destination", () => {
    const d = DestinationSchema.parse({
      type: "bigquery",
      projectId: "p",
      datasetId: "d",
      tableId: "t",
      serviceAccountKey: "{}",
    });
    expect(d.type).toBe("bigquery");
  });

  it("accepts webhook URL with root path (expansion at dispatch uses WORKER_URL)", () => {
    const d = DestinationSchema.parse({
      type: "webhook",
      url: "https://localhost:3000",
      method: "POST",
      retryOnFailure: false,
      timeoutMs: 5000,
    });
    expect(d.type).toBe("webhook");
    if (d.type === "webhook") expect(d.url).toContain("localhost");
  });

  it("accepts webhook URL with a non-root path", () => {
    const d = DestinationSchema.parse({
      type: "webhook",
      url: "https://httpbin.org/post",
      method: "POST",
      retryOnFailure: false,
      timeoutMs: 5000,
    });
    expect(d.type).toBe("webhook");
    if (d.type === "webhook") expect(d.url).toContain("/post");
  });

  it("rejects webhook URL pointing to link-local metadata IP", () => {
    const r = DestinationSchema.safeParse({
      type: "webhook",
      url: "https://169.254.169.254/latest/meta-data",
      method: "POST",
      retryOnFailure: false,
      timeoutMs: 5000,
    });
    expect(r.success).toBe(false);
  });
});

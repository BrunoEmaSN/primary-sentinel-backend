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
    expect(d.payloadColumn).toBe("payload");
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
});

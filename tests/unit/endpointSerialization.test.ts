import { describe, it, expect } from "vitest";
import { toPublicEndpointSnapshot } from "../../src/infrastructure/http/endpointSerialization.js";
import type { Destination } from "../../src/domain/events/entities/Endpoint.js";

describe("toPublicEndpointSnapshot", () => {
  it("redacts sensitive destination fields", () => {
    const destinations: Destination[] = [
      {
        type: "supabase",
        tableName: "t",
        serviceKey: "super-secret",
      },
      {
        type: "postgres",
        connectionString: "postgresql://x",
        schema: "public",
        table: "rows",
        payloadColumn: "payload",
      },
    ];
    const snap = toPublicEndpointSnapshot({
      id: "1",
      tenantId: "t",
      destinations,
    });
    const pub = snap["destinations"] as Array<Record<string, unknown>>;
    expect(pub[0]!["serviceKey"]).toBe("[REDACTED]");
    expect(pub[1]!["connectionString"]).toBe("[REDACTED]");
  });
});

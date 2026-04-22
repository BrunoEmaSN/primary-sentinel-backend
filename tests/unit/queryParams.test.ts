import { describe, it, expect } from "vitest";
import { parseBoundedInt, MAX_LIST_LIMIT } from "../../src/infrastructure/http/queryParams.js";

describe("parseBoundedInt", () => {
  it("uses fallback when param absent", () => {
    expect(parseBoundedInt(null, 20, 1, 100)).toBe(20);
  });

  it("clamps to max", () => {
    expect(parseBoundedInt("999999", 20, 1, MAX_LIST_LIMIT)).toBe(MAX_LIST_LIMIT);
  });

  it("clamps negatives to min", () => {
    expect(parseBoundedInt("-5", 0, 0, 10)).toBe(0);
  });
});

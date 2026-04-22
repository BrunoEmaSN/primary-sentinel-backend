import { describe, expect, it } from "vitest";
import {
  assertScriptPassesAstPolicy,
  SandboxScriptPolicyError,
} from "../../src/infrastructure/adapters/sandbox/scriptAstPolicy.js";

describe("assertScriptPassesAstPolicy", () => {
  it("allows dot member access and return", () => {
    expect(() =>
      assertScriptPassesAstPolicy("return { x: input.body.id };")
    ).not.toThrow();
  });

  it("rejects computed member (bracket literal)", () => {
    expect(() => assertScriptPassesAstPolicy("return input['body'];")).toThrow(
      SandboxScriptPolicyError,
    );
  });

  it("rejects computed member (dynamic key)", () => {
    expect(() => assertScriptPassesAstPolicy("const k = 'x'; return input[k];")).toThrow(
      SandboxScriptPolicyError,
    );
  });

  it("rejects optional chaining with computed member", () => {
    expect(() => assertScriptPassesAstPolicy("return input?.[0];")).toThrow(
      SandboxScriptPolicyError,
    );
  });

  it("rejects new Function", () => {
    expect(() =>
      assertScriptPassesAstPolicy("return new Function('return 1')();")
    ).toThrow(SandboxScriptPolicyError);
  });

  it("rejects new (Function) with parentheses", () => {
    expect(() =>
      assertScriptPassesAstPolicy("return new (Function)('return 2')();")
    ).toThrow(SandboxScriptPolicyError);
  });

  it("rejects new on qualified Function property", () => {
    expect(() =>
      assertScriptPassesAstPolicy("const o = {}; return new o.Function('return 1');")
    ).toThrow(SandboxScriptPolicyError);
  });

  it("throws SandboxScriptPolicyError on syntax error", () => {
    expect(() => assertScriptPassesAstPolicy("return {")).toThrow(SandboxScriptPolicyError);
  });

  it("does not reject Function() call without new (AST policy scope)", () => {
    expect(() =>
      assertScriptPassesAstPolicy("return Function('return 1')();")
    ).not.toThrow();
  });
});

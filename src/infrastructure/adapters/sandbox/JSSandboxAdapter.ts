// src/infrastructure/adapters/sandbox/JSSandboxAdapter.ts

import type { ISandboxService, SandboxResult } from "../../../application/ports/index.js";
import { createLogger } from "../../utils/logger.js";

const logger = createLogger("JSSandboxAdapter");

const MAX_EXECUTION_TIME_MS = 5000;
const MAX_OUTPUT_SIZE_BYTES = 1024 * 512; // 512KB

export class JSSandboxAdapter implements ISandboxService {
  async execute(script: string, input: unknown): Promise<SandboxResult> {
    const start = Date.now();
    try {
      this.validateScript(script);
      const transformFn = this.compileScript(script);
      const output = await this.runWithTimeout(transformFn, input, MAX_EXECUTION_TIME_MS);

      const outputStr = JSON.stringify(output);
      if (outputStr.length > MAX_OUTPUT_SIZE_BYTES) {
        return {
          success: false, output: null,
          error: `Output exceeds max size (${MAX_OUTPUT_SIZE_BYTES} bytes)`,
          executionTimeMs: Date.now() - start,
        };
      }

      const executionTimeMs = Date.now() - start;
      logger.info("Sandbox execution ok", { executionTimeMs });
      return { success: true, output, executionTimeMs };
    } catch (error) {
      const executionTimeMs = Date.now() - start;
      const message = error instanceof Error ? error.message : String(error);
      logger.error("Sandbox execution failed", { error: message, executionTimeMs });
      return { success: false, output: null, error: message, executionTimeMs };
    }
  }

  private validateScript(script: string): void {
    // Patrones estructurales (p. ej. input["constructor"]) además de substring includes().
    const dangerous =
      /\[\s*['"`]constructor['"`]\s*\]|__proto__|prototype\s*\[|\.constructor\b/;
    if (dangerous.test(script)) {
      throw new SandboxSecurityError("Forbidden pattern detected");
    }
    const forbidden = [
      "globalThis",
      "process",
      "require(",
      "import(",
      "__dirname",
      "__filename",
      "eval(",
      "Function(",
      "setTimeout",
      "setInterval",
      "fetch(",
      "XMLHttpRequest",
      "WebSocket",
      "constructor",
      "prototype",
      "__proto__",
      "Reflect",
      "Proxy",
      "Symbol",
      "arguments.callee",
      ".constructor",
    ];
    for (const pattern of forbidden) {
      if (script.includes(pattern)) {
        throw new SandboxSecurityError(`Forbidden pattern: '${pattern}'`);
      }
    }
    if (script.length > 10_000) {
      throw new SandboxSecurityError("Script exceeds max length (10,000 chars)");
    }
  }

  private compileScript(script: string): (input: unknown) => unknown {
    try {
      // eslint-disable-next-line no-new-func
      const fn = new Function(
        "input",
        `"use strict";
         const JSON_parse = JSON.parse;
         const JSON_stringify = JSON.stringify;
         const Array_isArray = Array.isArray;
         const Object_keys = Object.keys;
         const Object_values = Object.values;
         const Object_entries = Object.entries;
         const Object_assign = Object.assign;
         ${script}`
      );
      return fn as (input: unknown) => unknown;
    } catch (e) {
      throw new SandboxCompileError(`Compile failed: ${String(e)}`);
    }
  }

  private runWithTimeout(
    fn: (input: unknown) => unknown,
    input: unknown,
    timeoutMs: number
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new SandboxTimeoutError(`Exceeded ${timeoutMs}ms`)),
        timeoutMs
      );
      try {
        const result = fn(input);
        clearTimeout(timer);
        if (result instanceof Promise) {
          result.then(resolve).catch(reject).finally(() => clearTimeout(timer));
        } else {
          resolve(result);
        }
      } catch (e) {
        clearTimeout(timer);
        reject(e);
      }
    });
  }
}

export class SandboxSecurityError extends Error {
  constructor(msg: string) { super(msg); this.name = "SandboxSecurityError"; }
}
export class SandboxCompileError extends Error {
  constructor(msg: string) { super(msg); this.name = "SandboxCompileError"; }
}
export class SandboxTimeoutError extends Error {
  constructor(msg: string) { super(msg); this.name = "SandboxTimeoutError"; }
}

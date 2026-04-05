// src/infrastructure/adapters/sandbox/JSSandboxAdapter.ts
// Runs AI-generated transformation scripts in a secure isolated context
// In Cloudflare Workers, we use a restrictive eval-like approach with timeouts.
// For production, consider using Cloudflare's Durable Objects or WASM sandbox.

import type { ISandboxService, SandboxResult } from "../../../application/ports/index.js";
import { createLogger } from "../../utils/logger.js";

const logger = createLogger("JSSandboxAdapter");

const MAX_EXECUTION_TIME_MS = 5000;
const MAX_OUTPUT_SIZE_BYTES = 1024 * 512; // 512KB

export class JSSandboxAdapter implements ISandboxService {
  async execute(script: string, input: unknown): Promise<SandboxResult> {
    const start = Date.now();

    try {
      // Security: validate script doesn't contain dangerous patterns
      this.validateScript(script);

      // Wrap in a function and execute
      const transformFn = this.compileScript(script);
      const output = await this.runWithTimeout(transformFn, input, MAX_EXECUTION_TIME_MS);

      // Validate output size
      const outputStr = JSON.stringify(output);
      if (outputStr.length > MAX_OUTPUT_SIZE_BYTES) {
        return {
          success: false,
          output: null,
          error: `Output exceeds max size (${MAX_OUTPUT_SIZE_BYTES} bytes)`,
          executionTimeMs: Date.now() - start,
        };
      }

      const executionTimeMs = Date.now() - start;
      logger.info("Sandbox execution successful", { executionTimeMs });

      return { success: true, output, executionTimeMs };
    } catch (error) {
      const executionTimeMs = Date.now() - start;
      const message = error instanceof Error ? error.message : String(error);
      logger.error("Sandbox execution failed", { error: message, executionTimeMs });
      return { success: false, output: null, error: message, executionTimeMs };
    }
  }

  private validateScript(script: string): void {
    // Block dangerous globals in Cloudflare Workers environment
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
    ];

    for (const pattern of forbidden) {
      if (script.includes(pattern)) {
        throw new SandboxSecurityError(`Forbidden pattern detected: '${pattern}'`);
      }
    }

    if (script.length > 10_000) {
      throw new SandboxSecurityError("Script exceeds maximum length (10,000 chars)");
    }
  }

  private compileScript(script: string): (input: unknown) => unknown {
    // In Cloudflare Workers, we create a sandboxed function
    // The script body is wrapped in a function that only has access to safe primitives
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
    } catch (compileError) {
      throw new SandboxCompileError(
        `Script compilation failed: ${String(compileError)}`
      );
    }
  }

  private runWithTimeout(
    fn: (input: unknown) => unknown,
    input: unknown,
    timeoutMs: number
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new SandboxTimeoutError(`Execution exceeded ${timeoutMs}ms`));
      }, timeoutMs);

      try {
        const result = fn(input);
        clearTimeout(timer);

        if (result instanceof Promise) {
          result
            .then((v) => resolve(v))
            .catch((e) => reject(e))
            .finally(() => clearTimeout(timer));
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
  constructor(message: string) {
    super(message);
    this.name = "SandboxSecurityError";
  }
}

export class SandboxCompileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxCompileError";
  }
}

export class SandboxTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxTimeoutError";
  }
}

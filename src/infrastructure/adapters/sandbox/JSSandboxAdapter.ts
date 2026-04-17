// src/infrastructure/adapters/sandbox/JSSandboxAdapter.ts

import releaseSync from "@jitl/quickjs-wasmfile-release-sync";
import {
  newQuickJSWASMModuleFromVariant,
  newVariant,
  shouldInterruptAfterDeadline,
} from "quickjs-emscripten";
import type { ISandboxService, SandboxResult } from "../../../application/ports/index.js";
import { createLogger } from "../../utils/logger.js";

/** Pre-bundled by Wrangler (`[[rules]]` CompiledWasm); avoids fetch / instantiateStreaming in Workers. */
import quickjsWasmModule from "../../../../node_modules/@jitl/quickjs-wasmfile-release-sync/dist/emscripten-module.wasm";

const logger = createLogger("JSSandboxAdapter");

const MAX_EXECUTION_TIME_MS = 5000;
const MAX_OUTPUT_SIZE_BYTES = 1024 * 512;
const QUICKJS_MEMORY_LIMIT_BYTES = 4 * 1024 * 1024;

type QuickJsModule = Awaited<ReturnType<typeof newQuickJSWASMModuleFromVariant>>;

let quickJsSingleton: Promise<QuickJsModule> | null = null;

function getQuickJsModule(): Promise<QuickJsModule> {
  if (!quickJsSingleton) {
    const variant = newVariant(releaseSync, { wasmModule: quickjsWasmModule });
    quickJsSingleton = newQuickJSWASMModuleFromVariant(variant);
  }
  return quickJsSingleton;
}

export class JSSandboxAdapter implements ISandboxService {
  async execute(script: string, input: unknown): Promise<SandboxResult> {
    const start = Date.now();
    try {
      this.validateScript(script);
      const output = await this.runInQuickJs(script, input);

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

  private async runInQuickJs(script: string, input: unknown): Promise<unknown> {
    const QuickJS = await getQuickJsModule();
    const inputLiteral = JSON.stringify(input);
    const wrapped = `"use strict";
(function(input) {
${script}
})(JSON.parse(${JSON.stringify(inputLiteral)}));`;

    try {
      const result = QuickJS.evalCode(wrapped, {
        shouldInterrupt: shouldInterruptAfterDeadline(Date.now() + MAX_EXECUTION_TIME_MS),
        memoryLimitBytes: QUICKJS_MEMORY_LIMIT_BYTES,
      });
      return result;
    } catch (e) {
      throw new SandboxCompileError(`Execution failed: ${String(e)}`);
    }
  }

  private validateScript(script: string): void {
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

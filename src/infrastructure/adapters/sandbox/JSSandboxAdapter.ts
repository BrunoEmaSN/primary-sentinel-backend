// src/infrastructure/adapters/sandbox/JSSandboxAdapter.ts

import releaseSync from "@jitl/quickjs-wasmfile-release-sync";
import {
  newQuickJSWASMModuleFromVariant,
  newVariant,
  shouldInterruptAfterDeadline,
} from "quickjs-emscripten";
import type { ISandboxService, SandboxResult } from "../../../application/ports/index.js";
import { createLogger } from "../../utils/logger.js";
import { assertScriptPassesAstPolicy } from "./scriptAstPolicy.js";

/** Pre-bundled by Wrangler (`[[rules]]` CompiledWasm); avoids fetch / instantiateStreaming in Workers. */
import quickjsWasmModule from "../../../../node_modules/@jitl/quickjs-wasmfile-release-sync/dist/emscripten-module.wasm";

const logger = createLogger("JSSandboxAdapter");

const MAX_EXECUTION_TIME_MS = 5000;
const MAX_OUTPUT_SIZE_BYTES = 1024 * 512;
const QUICKJS_MEMORY_LIMIT_BYTES = 4 * 1024 * 1024;
/** Operational cap (not a security boundary): avoids huge payloads before eval. */
const MAX_SCRIPT_LENGTH = 10_000;

type QuickJsModule = Awaited<ReturnType<typeof newQuickJSWASMModuleFromVariant>>;

let quickJsSingleton: Promise<QuickJsModule> | null = null;

function getQuickJsModule(): Promise<QuickJsModule> {
  if (!quickJsSingleton) {
    const variant = newVariant(releaseSync, { wasmModule: quickjsWasmModule });
    quickJsSingleton = newQuickJSWASMModuleFromVariant(variant);
  }
  return quickJsSingleton;
}

/**
 * Runs tenant JS in QuickJS (WASM). Before eval, Acorn walks the AST to reject computed
 * member access and `new Function` (defense in depth; not a full capability boundary).
 * Execution is still bounded by QuickJS memory limit, `shouldInterruptAfterDeadline`, and
 * max serialized output size.
 */
export class JSSandboxAdapter implements ISandboxService {
  async execute(script: string, input: unknown): Promise<SandboxResult> {
    const start = Date.now();
    try {
      if (script.length > MAX_SCRIPT_LENGTH) {
        throw new SandboxCompileError(
          `Script exceeds max length (${MAX_SCRIPT_LENGTH} chars)`,
        );
      }
      assertScriptPassesAstPolicy(script);
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
}

export class SandboxCompileError extends Error {
  constructor(msg: string) { super(msg); this.name = "SandboxCompileError"; }
}
export class SandboxTimeoutError extends Error {
  constructor(msg: string) { super(msg); this.name = "SandboxTimeoutError"; }
}

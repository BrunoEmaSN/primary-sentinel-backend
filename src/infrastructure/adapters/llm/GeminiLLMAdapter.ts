// src/infrastructure/adapters/llm/GeminiLLMAdapter.ts

import { GoogleGenerativeAI, type GenerativeModel } from "@google/generative-ai";
import type { ILLMService, HealingRequest, HealingResult } from "../../../application/ports/index.js";
import { createLogger } from "../../utils/logger.js";

const logger = createLogger("GeminiLLMAdapter");

/** Below this threshold the script is not executed in the sandbox (event goes to DLQ). */
const MIN_SANDBOX_CONFIDENCE = 0.4;

const SYSTEM_PROMPT = `You are Primary Sentinel, an expert data transformation engine.
Your task is to analyze a broken API payload and generate a JavaScript transformation function
that converts the received payload into the expected schema format.

RULES:
1. Return ONLY a valid JSON object — no markdown, no code blocks, no prose.
2. The JSON must have exactly these fields:
   - "script": string — a JavaScript function body (not arrow function, just the body)
   - "description": string — one sentence explaining what the transformation does
   - "language": "javascript"
   - "confidence": number between 0 and 1

3. The script will be executed as:
   function transform(input) { <YOUR SCRIPT HERE> }
   So use "return" to return the transformed object.

4. Handle null/undefined defensively.
5. If you cannot generate a reliable transformation (confidence < 0.5), still return the JSON
   with the best attempt and the actual confidence score.

Example output:
{
  "script": "return { id: input.user_id || input.id, name: input.full_name || input.name, email: input.email_address || input.email };",
  "description": "Maps legacy field names (user_id, full_name, email_address) to standard schema fields.",
  "language": "javascript",
  "confidence": 0.95
}`;

/**
 * Default flash model for `generateContent`. Older aliases like `gemini-1.5-flash` return 404 on current API.
 * Override with `GEMINI_MODEL` if needed (`ListModels` in Google AI Studio shows valid ids).
 */
export const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash";

const MAX_429_ATTEMPTS = 5;
const MAX_RETRY_WAIT_MS = 90_000;

export type GeminiLLMOptions = {
  modelId?: string;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRateLimitError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    msg.includes("429") ||
    msg.includes("Too Many Requests") ||
    msg.includes("RESOURCE_EXHAUSTED") ||
    /rate.?limit|quota exceeded/i.test(msg)
  );
}

function isModelNotFoundError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    msg.includes("404") &&
    (/not found for API version|is not found|not supported for generateContent/i.test(msg) ||
      /models\/[^ ]+ is not found/i.test(msg))
  );
}

/** Parses "Please retry in 30.14s" from Google API error bodies. */
function parseRetryAfterMs(err: unknown): number | null {
  const msg = err instanceof Error ? err.message : String(err);
  const m = msg.match(/Please retry in ([\d.]+)s/i);
  if (!m) return null;
  return Math.ceil(parseFloat(m[1]) * 1000);
}

const CIRCUIT_FAILURE_THRESHOLD = 5;
const CIRCUIT_OPEN_MS = 60_000;

export class GeminiLLMAdapter implements ILLMService {
  private readonly genAI: GoogleGenerativeAI;
  /** Active model id (may switch to {@link DEFAULT_GEMINI_MODEL} after 404/429 on a non-default model). */
  private modelId: string;
  private model: GenerativeModel;
  private geminiFailures = 0;
  private geminiCircuitOpenUntil = 0;

  constructor(apiKey: string, options?: GeminiLLMOptions) {
    this.genAI = new GoogleGenerativeAI(apiKey);
    this.modelId = (options?.modelId?.trim() || DEFAULT_GEMINI_MODEL).trim();
    this.model = this.createModel();
  }

  private createModel(): GenerativeModel {
    return this.genAI.getGenerativeModel({
      model: this.modelId,
      systemInstruction: SYSTEM_PROMPT,
    });
  }

  /**
   * If `GEMINI_MODEL` is deprecated, unknown, or rate-limited, switch once to {@link DEFAULT_GEMINI_MODEL}
   * and retry immediately (no backoff).
   */
  private trySwitchToDefaultModel(reason: "404" | "429"): boolean {
    if (this.modelId === DEFAULT_GEMINI_MODEL) return false;
    logger.warn(`Gemini ${reason} on configured model; switching to default model without delay`, {
      from: this.modelId,
      to: DEFAULT_GEMINI_MODEL,
    });
    this.modelId = DEFAULT_GEMINI_MODEL;
    this.model = this.createModel();
    return true;
  }

  async generateTransformationScript(request: HealingRequest): Promise<HealingResult> {
    if (Date.now() < this.geminiCircuitOpenUntil) {
      throw new Error("Gemini temporarily unavailable (circuit open)");
    }
    const userMessage = this.buildPrompt(request);
    logger.info("Calling Gemini API for transformation generation", { model: this.modelId });

    let result;
    try {
      result = await this.generateContentWith429Retries(userMessage);
    } catch (e) {
      this.geminiFailures++;
      if (this.geminiFailures >= CIRCUIT_FAILURE_THRESHOLD) {
        this.geminiCircuitOpenUntil = Date.now() + CIRCUIT_OPEN_MS;
        this.geminiFailures = 0;
        logger.warn("Gemini circuit breaker opened after repeated errors", {
          openMs: CIRCUIT_OPEN_MS,
        });
      }
      throw e;
    }
    const response = result.response;
    const rawText = response.text();

    const usage = response.usageMetadata;
    logger.info("LLM response received", {
      model: this.modelId,
      promptTokenCount: usage?.promptTokenCount,
      candidatesTokenCount: usage?.candidatesTokenCount,
    });

    const parsed = this.parseResponse(rawText);

    if (parsed.confidence < MIN_SANDBOX_CONFIDENCE) {
      throw new LLMLowConfidenceError(
        `LLM confidence too low: ${parsed.confidence}. Sending to DLQ.`
      );
    }

    this.geminiFailures = 0;
    return {
      success: true,
      script: parsed.script,
      description: parsed.description,
      language: parsed.language,
      confidence: parsed.confidence,
      modelUsed: this.modelId,
    };
  }

  private async generateContentWith429Retries(userMessage: string) {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= MAX_429_ATTEMPTS; attempt++) {
      try {
        return await this.model.generateContent(userMessage);
      } catch (err) {
        lastErr = err;
        if (isModelNotFoundError(err) && this.trySwitchToDefaultModel("404")) {
          attempt -= 1;
          continue;
        }
        if (!isRateLimitError(err)) {
          throw err;
        }
        if (this.trySwitchToDefaultModel("429")) {
          attempt -= 1;
          continue;
        }
        if (attempt === MAX_429_ATTEMPTS) {
          throw err;
        }
        const fromApi = parseRetryAfterMs(err);
        const backoff = Math.min(
          MAX_RETRY_WAIT_MS,
          fromApi ?? Math.min(60_000, 1000 * 2 ** (attempt - 1))
        );
        logger.warn("Gemini rate limited (429), waiting before retry", {
          attempt,
          maxAttempts: MAX_429_ATTEMPTS,
          waitMs: backoff,
          model: this.modelId,
        });
        await sleep(backoff);
      }
    }
    throw lastErr;
  }

  private buildPrompt(request: HealingRequest): string {
    return `## Context
${request.endpointContext}

## Expected Schema (JSON Schema format)
${JSON.stringify(request.expectedSchema, null, 2)}

## Received Payload (broken)
${JSON.stringify(request.receivedPayload, null, 2)}

## Validation Errors
${request.validationErrors.map((e, i) => `${i + 1}. ${e}`).join("\n")}

Generate a JavaScript transformation to fix the received payload into the expected schema.`;
  }

  private parseResponse(rawText: string): {
    script: string;
    description: string;
    language: "javascript" | "json-map";
    confidence: number;
  } {
    const cleaned = rawText
      .replace(/```json\n?/gi, "")
      .replace(/```\n?/gi, "")
      .trim();

    let parsed: {
      script: string;
      description: string;
      language: "javascript" | "json-map";
      confidence: number;
    };

    try {
      parsed = JSON.parse(cleaned);
    } catch {
      logger.error("Failed to parse LLM response as JSON", { rawText });
      throw new LLMParseError("LLM returned invalid JSON");
    }

    if (!parsed.script || typeof parsed.script !== "string") {
      throw new LLMParseError("LLM response missing 'script' field");
    }

    return {
      script: parsed.script,
      description: parsed.description ?? "AI-generated transformation",
      language: parsed.language ?? "javascript",
      confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.5,
    };
  }
}

export class LLMParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LLMParseError";
  }
}

export class LLMLowConfidenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LLMLowConfidenceError";
  }
}

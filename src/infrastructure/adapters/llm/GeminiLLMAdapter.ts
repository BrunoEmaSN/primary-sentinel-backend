// src/infrastructure/adapters/llm/GeminiLLMAdapter.ts

import { GoogleGenerativeAI } from "@google/generative-ai";
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

/** Google AI Studio / Gemini API — flash tier for latency and cost. */
const MODEL_ID = "gemini-2.0-flash";

export class GeminiLLMAdapter implements ILLMService {
  private readonly model;

  constructor(apiKey: string) {
    const genAI = new GoogleGenerativeAI(apiKey);
    this.model = genAI.getGenerativeModel({
      model: MODEL_ID,
      systemInstruction: SYSTEM_PROMPT,
    });
  }

  async generateTransformationScript(request: HealingRequest): Promise<HealingResult> {
    const userMessage = this.buildPrompt(request);
    logger.info("Calling Gemini API for transformation generation");

    const result = await this.model.generateContent(userMessage);
    const response = result.response;
    const rawText = response.text();

    const usage = response.usageMetadata;
    logger.info("LLM response received", {
      promptTokenCount: usage?.promptTokenCount,
      candidatesTokenCount: usage?.candidatesTokenCount,
    });

    const parsed = this.parseResponse(rawText);

    if (parsed.confidence < MIN_SANDBOX_CONFIDENCE) {
      throw new LLMLowConfidenceError(
        `LLM confidence too low: ${parsed.confidence}. Sending to DLQ.`
      );
    }

    return {
      success: true,
      script: parsed.script,
      description: parsed.description,
      language: parsed.language,
      confidence: parsed.confidence,
      modelUsed: MODEL_ID,
    };
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

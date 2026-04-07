// src/infrastructure/adapters/llm/AnthropicLLMAdapter.ts

import Anthropic from "@anthropic-ai/sdk";
import type { ILLMService, HealingRequest, HealingResult } from "../../../application/ports/index.js";
import { createLogger } from "../../utils/logger.js";

const logger = createLogger("AnthropicLLMAdapter");

const SYSTEM_PROMPT = `You are SentinelAI, an expert data transformation engine.
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

export class AnthropicLLMAdapter implements ILLMService {
  private client: Anthropic;
  private model = "claude-sonnet-4-20250514";

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  async generateTransformationScript(request: HealingRequest): Promise<HealingResult> {
    const userMessage = this.buildPrompt(request);
    logger.info("Calling Anthropic API for transformation generation");

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userMessage }],
    });

    const rawText = response.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { type: "text"; text: string }).text)
      .join("");

    logger.info("LLM response received", { usage: response.usage });
    return this.parseResponse(rawText);
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

  private parseResponse(rawText: string): HealingResult {
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
      success: true,
      script: parsed.script,
      description: parsed.description ?? "AI-generated transformation",
      language: parsed.language ?? "javascript",
      confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.5,
      modelUsed: this.model,
    };
  }
}

export class LLMParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LLMParseError";
  }
}

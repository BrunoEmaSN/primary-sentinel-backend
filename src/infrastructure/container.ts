// src/infrastructure/container.ts
// Dependency Injection — wires all adapters to use cases

import type { WorkerEnv } from "./http/middleware/auth.js";
import {
  SupabaseEventRepository,
  SupabaseEndpointRepository,
  SupabaseTransformationRuleRepository,
} from "./adapters/database/SupabaseAdapters.js";
import {
  UpstashRuleCache,
  UpstashQueueService,
  R2StorageAdapter,
  ResendNotificationService,
} from "./adapters/external/ExternalAdapters.js";
import { AnthropicLLMAdapter } from "./adapters/llm/AnthropicLLMAdapter.js";
import { JSSandboxAdapter } from "./adapters/sandbox/JSSandboxAdapter.js";

export type Dependencies = ReturnType<typeof buildDependencies>;

// Singleton cache per Worker invocation (lives for the duration of the request)
let _deps: Dependencies | null = null;

export function buildDependencies(env: WorkerEnv): Dependencies {
  if (_deps) return _deps;

  // ── Database (Supabase / PostgreSQL) ─────────────────────────────────
  const eventRepo = new SupabaseEventRepository(
    env.SUPABASE_URL,
    env.SUPABASE_SERVICE_KEY
  );

  const endpointRepo = new SupabaseEndpointRepository(
    env.SUPABASE_URL,
    env.SUPABASE_SERVICE_KEY
  );

  const ruleRepo = new SupabaseTransformationRuleRepository(
    env.SUPABASE_URL,
    env.SUPABASE_SERVICE_KEY
  );

  // ── Cache (Upstash Redis) ─────────────────────────────────────────────
  const ruleCache = new UpstashRuleCache(
    env.UPSTASH_REDIS_REST_URL,
    env.UPSTASH_REDIS_REST_TOKEN
  );

  // ── Event Queue (Upstash Kafka) ───────────────────────────────────────
  const queueService = new UpstashQueueService(
    env.UPSTASH_KAFKA_URL,
    env.UPSTASH_KAFKA_USERNAME,
    env.UPSTASH_KAFKA_PASSWORD
  );

  // ── Object Storage (Cloudflare R2) ────────────────────────────────────
  const storageService = new R2StorageAdapter(env.DLQ_BUCKET);

  // ── LLM (Anthropic Claude) ────────────────────────────────────────────
  const llmService = new AnthropicLLMAdapter(env.ANTHROPIC_API_KEY);

  // ── Notifications (Resend) ────────────────────────────────────────────
  const notificationService = new ResendNotificationService(env.RESEND_API_KEY);

  // ── Sandbox (JS runtime) ──────────────────────────────────────────────
  const sandboxService = new JSSandboxAdapter();

  _deps = {
    eventRepo,
    endpointRepo,
    ruleRepo,
    ruleCache,
    queueService,
    storageService,
    llmService,
    notificationService,
    sandboxService,
  };

  return _deps;
}

// Reset singleton between tests
export function resetDependencies(): void {
  _deps = null;
}

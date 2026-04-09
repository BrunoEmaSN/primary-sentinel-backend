// src/infrastructure/container.ts

import type { WorkerEnv } from "./http/middleware/auth.js";
import {
  SupabaseEventRepository,
  SupabaseEndpointRepository,
  SupabaseTransformationRuleRepository,
} from "./adapters/database/SupabaseAdapters.js";
import {
  UpstashRuleCache,
  R2StorageAdapter,
  ResendNotificationService,
} from "./adapters/external/ExternalAdapters.js";
import { TenantInfraAdapter } from "./adapters/database/TenantInfraAdapter.js";
import { IncidentAlertOrchestrator } from "./notifications/IncidentAlertOrchestrator.js";
import { AnthropicLLMAdapter } from "./adapters/llm/AnthropicLLMAdapter.js";
import { JSSandboxAdapter } from "./adapters/sandbox/JSSandboxAdapter.js";
import { OutputDispatcher } from "../application/use-cases/OutputDispatcher.js";

export type Dependencies = {
  eventRepo: SupabaseEventRepository;
  endpointRepo: SupabaseEndpointRepository;
  ruleRepo: SupabaseTransformationRuleRepository;
  ruleCache: UpstashRuleCache;
  storageService: R2StorageAdapter;
  llmService: AnthropicLLMAdapter;
  notificationService: ResendNotificationService;
  tenantInfra: TenantInfraAdapter;
  incidentAlerts: IncidentAlertOrchestrator;
  sandboxService: JSSandboxAdapter;
  outputDispatcher: OutputDispatcher;
};

let _deps: Dependencies | null = null;

export function buildDependencies(env: WorkerEnv): Dependencies {
  if (_deps) return _deps;

  const eventRepo = new SupabaseEventRepository(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY);
  const endpointRepo = new SupabaseEndpointRepository(
    env.SUPABASE_URL,
    env.SUPABASE_SERVICE_KEY,
    env.SENTINEL_DESTINATION_SECRET_KEY
  );
  const ruleRepo = new SupabaseTransformationRuleRepository(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY);
  const ruleCache = new UpstashRuleCache(env.UPSTASH_REDIS_REST_URL, env.UPSTASH_REDIS_REST_TOKEN);
  const storageService = new R2StorageAdapter(env.DLQ_BUCKET);
  const llmService = new AnthropicLLMAdapter(env.ANTHROPIC_API_KEY);
  const notificationService = new ResendNotificationService(
    env.RESEND_API_KEY,
    env.SUPABASE_URL,
    env.SUPABASE_SERVICE_KEY
  );
  const tenantInfra = new TenantInfraAdapter(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY);
  const incidentAlerts = new IncidentAlertOrchestrator(notificationService, tenantInfra);
  const sandboxService = new JSSandboxAdapter();
  const outputDispatcher = new OutputDispatcher(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY);

  _deps = {
    eventRepo, endpointRepo, ruleRepo, ruleCache,
    storageService, llmService, notificationService, tenantInfra, incidentAlerts,
    sandboxService, outputDispatcher,
  };

  return _deps;
}

export function resetDependencies(): void {
  _deps = null;
}

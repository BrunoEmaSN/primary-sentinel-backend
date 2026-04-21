// src/infrastructure/container.ts

import type { WorkerEnv } from "./http/workerEnv.js";
import {
  SupabaseEventRepository,
  SupabaseEndpointRepository,
  SupabaseTransformationRuleRepository,
} from "./adapters/database/SupabaseAdapters.js";
import {
  UpstashRuleCache,
  R2StorageAdapter,
  CloudflareEmailNotificationService,
} from "./adapters/external/ExternalAdapters.js";
import { TenantInfraAdapter } from "./adapters/database/TenantInfraAdapter.js";
import { IncidentAlertOrchestrator } from "./notifications/IncidentAlertOrchestrator.js";
import { GeminiLLMAdapter } from "./adapters/llm/GeminiLLMAdapter.js";
import { JSSandboxAdapter } from "./adapters/sandbox/JSSandboxAdapter.js";
import { OutputDispatcher } from "../application/use-cases/OutputDispatcher.js";

export type Dependencies = {
  eventRepo: SupabaseEventRepository;
  endpointRepo: SupabaseEndpointRepository;
  ruleRepo: SupabaseTransformationRuleRepository;
  ruleCache: UpstashRuleCache;
  storageService: R2StorageAdapter;
  llmService: GeminiLLMAdapter;
  notificationService: CloudflareEmailNotificationService;
  tenantInfra: TenantInfraAdapter;
  incidentAlerts: IncidentAlertOrchestrator;
  sandboxService: JSSandboxAdapter;
  outputDispatcher: OutputDispatcher;
  /** HKDF root for per-tenant encryption of ingestion artifacts (optional in dev). */
  ingestionSecretKey?: string;
};

let _deps: Dependencies | null = null;

export function buildDependencies(env: WorkerEnv): Dependencies {
  if (_deps) return _deps;

  const eventRepo = new SupabaseEventRepository(
    env.SUPABASE_URL,
    env.SUPABASE_SERVICE_KEY,
    env.SENTINEL_INGESTION_SECRET_KEY
  );
  const endpointRepo = new SupabaseEndpointRepository(
    env.SUPABASE_URL,
    env.SUPABASE_SERVICE_KEY,
    env.SENTINEL_DESTINATION_SECRET_KEY
  );
  const ruleRepo = new SupabaseTransformationRuleRepository(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY);
  const ruleCache = new UpstashRuleCache(env.UPSTASH_REDIS_REST_URL, env.UPSTASH_REDIS_REST_TOKEN);
  const storageService = new R2StorageAdapter(env.DLQ_BUCKET, env.SENTINEL_INGESTION_SECRET_KEY);
  const llmService = new GeminiLLMAdapter(env.AI_API_KEY, {
    modelId: env.GEMINI_MODEL,
  });
  const notificationService = new CloudflareEmailNotificationService(
    env.EMAIL,
    env.SUPABASE_URL,
    env.SUPABASE_SERVICE_KEY
  );
  const tenantInfra = new TenantInfraAdapter(
    env.SUPABASE_URL,
    env.SUPABASE_SERVICE_KEY,
    env.SENTINEL_INGESTION_SECRET_KEY
  );
  const incidentAlerts = new IncidentAlertOrchestrator(notificationService, tenantInfra);
  const sandboxService = new JSSandboxAdapter();
  const loopbackSink =
    env.SENTINEL_LOOPBACK_ROOT_USES_WORKER_SINK === "1" ||
    env.SENTINEL_LOOPBACK_ROOT_USES_WORKER_SINK === "true";
  const outputDispatcher = new OutputDispatcher(
    env.SUPABASE_URL,
    env.SUPABASE_SERVICE_KEY,
    env.WORKER_URL,
    loopbackSink
  );

  _deps = {
    eventRepo,
    endpointRepo,
    ruleRepo,
    ruleCache,
    storageService,
    llmService,
    notificationService,
    tenantInfra,
    incidentAlerts,
    sandboxService,
    outputDispatcher,
    ingestionSecretKey: env.SENTINEL_INGESTION_SECRET_KEY,
  };

  return _deps;
}

export function resetDependencies(): void {
  _deps = null;
}

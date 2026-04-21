// Bindings y variables del Worker (wrangler / .dev.vars).

export type WorkerEnv = {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_KEY: string;
  /** Base64-encoded 32-byte AES key; encrypts destination secrets at rest */
  SENTINEL_DESTINATION_SECRET_KEY?: string;
  /** Base64-encoded 32-byte root for HKDF; encrypts ingestion payloads (events, DLQ R2, snapshots) per tenant */
  SENTINEL_INGESTION_SECRET_KEY?: string;
  /** Google AI Studio API key (Gemini) for healing / transformation generation */
  AI_API_KEY: string;
  /** Optional Gemini model id (default: gemini-2.5-flash). Set in wrangler vars or .dev.vars */
  GEMINI_MODEL?: string;
  /** Optional wall-clock ms for one webhook run (default 180000). Clamped 15s–5min. */
  WEBHOOK_PROCESSING_TIMEOUT_MS?: string;
  UPSTASH_REDIS_REST_URL: string;
  UPSTASH_REDIS_REST_TOKEN: string;
  EMAIL: SendEmail;
  SENTINEL_WEBHOOK_SECRET: string;
  RULE_CACHE: KVNamespace;
  DLQ_BUCKET: R2Bucket;
  ENVIRONMENT: string;
  LOG_LEVEL: string;
  WORKER_URL: string;
  /**
   * Si el Worker está montado bajo una ruta (p. ej. `/gateway`) y `WORKER_URL` no la incluye,
   * fijala aquí. Si no se define, se infiere del pathname de `WORKER_URL`.
   */
  SENTINEL_HTTP_PATH_PREFIX?: string;
  /**
   * Dev: "1" / "true" — si el destino webhook es solo `/` en loopback (p. ej. :3000),
   * reenvía al sink del Worker (`WORKER_URL`) para evitar "Cannot POST /" del frontend.
   */
  SENTINEL_LOOPBACK_ROOT_USES_WORKER_SINK?: string;
  /** Comma-separated exact origins for CORS (e.g. https://app.vercel.app). Empty/absent = permissive dev behavior. */
  ALLOWED_ORIGINS?: string;
};

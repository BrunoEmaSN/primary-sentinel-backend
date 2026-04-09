-- Roadmap: tenant settings, notas, tags, ventanas, snapshots, métricas, auditoría IA
-- Aplicar en el proyecto Supabase (SQL editor o CLI). El Worker usa SERVICE_ROLE.

-- Endpoints: entorno de despliegue
ALTER TABLE endpoints
  ADD COLUMN IF NOT EXISTS environment text NOT NULL DEFAULT 'prod'
  CHECK (environment IN ('dev', 'staging', 'prod'));

CREATE INDEX IF NOT EXISTS idx_endpoints_tenant_env ON endpoints (tenant_id, environment);

-- Preferencias de notificación y billing por tenant (tenant_id = auth.users.id)
CREATE TABLE IF NOT EXISTS tenant_settings (
  tenant_id uuid PRIMARY KEY REFERENCES auth.users (id) ON DELETE CASCADE,
  notify_email_healing boolean NOT NULL DEFAULT true,
  notify_email_dead boolean NOT NULL DEFAULT true,
  notify_email_pending_rules boolean NOT NULL DEFAULT true,
  slack_on_incidents boolean NOT NULL DEFAULT true,
  slack_incoming_webhook_url text,
  alert_webhook_url text,
  alert_webhook_secret text,
  billing_plan text NOT NULL DEFAULT 'free' CHECK (billing_plan IN ('free', 'pro', 'enterprise')),
  stripe_customer_id text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Notas humanas por evento
CREATE TABLE IF NOT EXISTS event_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  event_id text NOT NULL,
  author_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_event_notes_event ON event_notes (tenant_id, event_id);

-- Tags (manual + sugeridos)
CREATE TABLE IF NOT EXISTS event_tags (
  tenant_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  event_id text NOT NULL,
  tag text NOT NULL,
  source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'auto')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, event_id, tag)
);

-- Ventanas de mantenimiento
CREATE TABLE IF NOT EXISTS maintenance_windows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  title text NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  timezone text NOT NULL DEFAULT 'UTC',
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'cancelled')),
  scope text NOT NULL DEFAULT 'tenant' CHECK (scope IN ('tenant', 'endpoints')),
  endpoint_ids uuid[] DEFAULT '{}',
  suppress_non_critical_alerts boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mw_tenant_time ON maintenance_windows (tenant_id, starts_at, ends_at);

-- Snapshots antes de reintentos
CREATE TABLE IF NOT EXISTS event_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  event_id text NOT NULL,
  name text NOT NULL,
  payload jsonb NOT NULL,
  created_by_email text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_snapshots_event ON event_snapshots (tenant_id, event_id);

-- Métricas por etapa (Worker inserta)
CREATE TABLE IF NOT EXISTS pipeline_stage_metrics (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  endpoint_id uuid,
  stage text NOT NULL,
  latency_ms integer NOT NULL,
  backlog_estimate integer,
  recorded_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_psm_tenant_time ON pipeline_stage_metrics (tenant_id, recorded_at DESC);

-- Historial IA / overrides
CREATE TABLE IF NOT EXISTS ai_decision_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  endpoint_id uuid,
  event_id text,
  rule_id text,
  action text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}',
  actor text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_log_tenant ON ai_decision_log (tenant_id, created_at DESC);

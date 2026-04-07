-- =============================================================================
-- Sentinel SaaS v2 — Supabase Database Schema
-- Adds: destinations[] array (fanout), dispatch_results per event
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- =============================================================================
-- profiles (extends Supabase Auth)
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.profiles (
  id         UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email      TEXT NOT NULL,
  full_name  TEXT,
  plan       TEXT NOT NULL DEFAULT 'free' CHECK (plan IN ('free', 'pro', 'enterprise')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (id, email, full_name)
  VALUES (NEW.id, NEW.email, NEW.raw_user_meta_data->>'full_name');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- =============================================================================
-- endpoints — NEW: destinations JSONB[] instead of single destination JSONB
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.endpoints (
  id               UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id        UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name             TEXT        NOT NULL,
  slug             TEXT        NOT NULL,
  schema           JSONB       NOT NULL DEFAULT '{}',

  -- NEW: array of destination configs (webhook, http_api, supabase)
  -- Each element: { type, url, method, authType, authValue, ... }
  destinations     JSONB       NOT NULL DEFAULT '[]',

  -- Kept for backward compat — single destination (deprecated in v2)
  destination      JSONB,

  healing_config   JSONB       NOT NULL DEFAULT '{
    "enabled": true,
    "maxAttempts": 3,
    "autoApplyRules": true,
    "notifyOnHealing": true,
    "notifyOnDead": true
  }',
  status           TEXT        NOT NULL DEFAULT 'active'
                   CHECK (status IN ('active', 'paused', 'error')),
  stats            JSONB       NOT NULL DEFAULT '{
    "total": 0, "loaded": 0, "healed": 0, "dead": 0, "successRate": 0
  }',
  webhook_secret   TEXT        NOT NULL,
  last_activity_at TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (tenant_id, slug)
);

CREATE INDEX IF NOT EXISTS idx_endpoints_tenant_id ON public.endpoints (tenant_id);
CREATE INDEX IF NOT EXISTS idx_endpoints_slug ON public.endpoints USING GIN (slug gin_trgm_ops);

-- =============================================================================
-- events — NEW: dispatch_results JSONB[] for per-destination observability
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.events (
  id                     TEXT        PRIMARY KEY,
  tenant_id              UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  endpoint_id            UUID        NOT NULL REFERENCES public.endpoints(id) ON DELETE CASCADE,
  raw_payload            JSONB       NOT NULL,
  source                 JSONB       NOT NULL DEFAULT '{}',
  metadata               JSONB       NOT NULL DEFAULT '{}',
  status                 TEXT        NOT NULL DEFAULT 'received'
                         CHECK (status IN ('received','validated','healing','healed','loaded','dead')),
  validated_payload      JSONB,
  healing_attempts       INTEGER     NOT NULL DEFAULT 0,
  error_log              TEXT[]      NOT NULL DEFAULT '{}',
  transformation_rule_id UUID,

  -- NEW: per-destination dispatch results for observability
  -- [{ destinationType, destinationIndex, success, statusCode, error, durationMs }]
  dispatch_results       JSONB       NOT NULL DEFAULT '[]',

  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_events_tenant_id   ON public.events (tenant_id);
CREATE INDEX IF NOT EXISTS idx_events_endpoint_id ON public.events (endpoint_id);
CREATE INDEX IF NOT EXISTS idx_events_status      ON public.events (status);
CREATE INDEX IF NOT EXISTS idx_events_created_at  ON public.events (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_composite
  ON public.events (tenant_id, endpoint_id, status, created_at DESC);

-- =============================================================================
-- transformation_rules
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.transformation_rules (
  id                UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id         UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  endpoint_id       UUID        NOT NULL REFERENCES public.endpoints(id) ON DELETE CASCADE,
  schema_version    TEXT        NOT NULL DEFAULT '1',
  error_fingerprint TEXT        NOT NULL,
  language          TEXT        NOT NULL DEFAULT 'javascript'
                    CHECK (language IN ('javascript', 'json-map')),
  script            TEXT        NOT NULL,
  description       TEXT        NOT NULL DEFAULT '',
  status            TEXT        NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'deprecated', 'quarantined')),
  success_count     INTEGER     NOT NULL DEFAULT 0,
  failure_count     INTEGER     NOT NULL DEFAULT 0,
  last_used_at      TIMESTAMPTZ,
  generated_by      TEXT        NOT NULL DEFAULT 'claude-sonnet-4-20250514',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rules_tenant_id    ON public.transformation_rules (tenant_id);
CREATE INDEX IF NOT EXISTS idx_rules_endpoint_id  ON public.transformation_rules (endpoint_id);
CREATE INDEX IF NOT EXISTS idx_rules_fingerprint  ON public.transformation_rules (tenant_id, endpoint_id, error_fingerprint);
CREATE INDEX IF NOT EXISTS idx_rules_status       ON public.transformation_rules (status);

-- =============================================================================
-- notifications (for dashboard)
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.notifications (
  id          UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id   UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  type        TEXT        NOT NULL,
  title       TEXT        NOT NULL,
  message     TEXT        NOT NULL DEFAULT '',
  endpoint_id UUID,
  event_id    TEXT,
  read        BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notifications_tenant ON public.notifications (tenant_id, created_at DESC);

-- =============================================================================
-- Row Level Security
-- =============================================================================

ALTER TABLE public.profiles             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.endpoints            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.events               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.transformation_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notifications        ENABLE ROW LEVEL SECURITY;

CREATE POLICY "profiles_owner"    ON public.profiles             FOR ALL USING (auth.uid() = id);
CREATE POLICY "endpoints_owner"   ON public.endpoints            FOR ALL USING (auth.uid() = tenant_id);
CREATE POLICY "events_owner"      ON public.events               FOR ALL USING (auth.uid() = tenant_id);
CREATE POLICY "rules_owner"       ON public.transformation_rules FOR ALL USING (auth.uid() = tenant_id);
CREATE POLICY "notif_owner"       ON public.notifications         FOR ALL USING (auth.uid() = tenant_id);

-- =============================================================================
-- updated_at trigger
-- =============================================================================

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER set_endpoints_updated_at BEFORE UPDATE ON public.endpoints
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER set_events_updated_at BEFORE UPDATE ON public.events
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER set_rules_updated_at BEFORE UPDATE ON public.transformation_rules
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- =============================================================================
-- Stats view
-- =============================================================================

CREATE OR REPLACE VIEW public.tenant_stats AS
SELECT
  ep.tenant_id,
  COUNT(DISTINCT ep.id)                                              AS total_endpoints,
  COUNT(ev.id)                                                       AS total_events,
  COUNT(ev.id) FILTER (WHERE ev.status = 'loaded')                  AS events_loaded,
  COUNT(ev.id) FILTER (WHERE ev.status = 'healed')                  AS events_healed,
  COUNT(ev.id) FILTER (WHERE ev.status = 'dead')                    AS events_dead,
  COUNT(ev.id) FILTER (WHERE ev.status IN ('received','healing','validated')) AS events_pending,
  COUNT(DISTINCT r.id) FILTER (WHERE r.status = 'active')           AS active_rules,
  ROUND(
    100.0 * COUNT(ev.id) FILTER (WHERE ev.status IN ('loaded','healed')) /
    NULLIF(COUNT(ev.id) FILTER (WHERE ev.status NOT IN ('received','healing','validated')), 0),
    2
  ) AS success_rate_pct
FROM public.endpoints ep
LEFT JOIN public.events ev ON ev.endpoint_id = ep.id
LEFT JOIN public.transformation_rules r ON r.endpoint_id = ep.id
GROUP BY ep.tenant_id;

-- =============================================================================
-- Migration: upgrade existing single-destination rows to destinations array
-- Run this once if you have existing data from v1
-- =============================================================================

-- UPDATE public.endpoints
-- SET destinations = jsonb_build_array(destination)
-- WHERE destination IS NOT NULL AND destinations = '[]'::jsonb;

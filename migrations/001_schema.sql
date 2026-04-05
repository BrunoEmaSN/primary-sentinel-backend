-- =============================================================================
-- Sentinel SaaS — Supabase Database Schema
-- Run these migrations in order in your Supabase SQL editor
-- =============================================================================

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm"; -- for fuzzy text search on slugs

-- =============================================================================
-- 001: tenants / profiles (extends Supabase Auth users)
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.profiles (
  id          UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email       TEXT NOT NULL,
  full_name   TEXT,
  plan        TEXT NOT NULL DEFAULT 'free' CHECK (plan IN ('free', 'pro', 'enterprise')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Auto-create profile on user signup
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
-- 002: endpoints
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.endpoints (
  id                UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id         UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name              TEXT        NOT NULL,
  slug              TEXT        NOT NULL,
  schema            JSONB       NOT NULL DEFAULT '{}',
  destination       JSONB       NOT NULL DEFAULT '{}',
  healing_config    JSONB       NOT NULL DEFAULT '{
    "enabled": true,
    "maxAttempts": 3,
    "autoApplyRules": true,
    "notifyOnHealing": true,
    "notifyOnDead": true
  }',
  status            TEXT        NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'paused', 'error')),
  stats             JSONB       NOT NULL DEFAULT '{
    "total": 0,
    "loaded": 0,
    "healed": 0,
    "dead": 0,
    "successRate": 0
  }',
  webhook_secret    TEXT        NOT NULL,
  last_activity_at  TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (tenant_id, slug)
);

CREATE INDEX idx_endpoints_tenant_id ON public.endpoints (tenant_id);
CREATE INDEX idx_endpoints_slug ON public.endpoints USING GIN (slug gin_trgm_ops);

-- =============================================================================
-- 003: events
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.events (
  id                      TEXT        PRIMARY KEY, -- idempotency key (external or UUID)
  tenant_id               UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  endpoint_id             UUID        NOT NULL REFERENCES public.endpoints(id) ON DELETE CASCADE,
  raw_payload             JSONB       NOT NULL,
  source                  JSONB       NOT NULL DEFAULT '{}',
  metadata                JSONB       NOT NULL DEFAULT '{}',
  status                  TEXT        NOT NULL DEFAULT 'received'
                          CHECK (status IN ('received','validated','healing','healed','loaded','dead')),
  validated_payload       JSONB,
  healing_attempts        INTEGER     NOT NULL DEFAULT 0,
  error_log               TEXT[]      NOT NULL DEFAULT '{}',
  transformation_rule_id  UUID,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_events_tenant_id    ON public.events (tenant_id);
CREATE INDEX idx_events_endpoint_id  ON public.events (endpoint_id);
CREATE INDEX idx_events_status       ON public.events (status);
CREATE INDEX idx_events_created_at   ON public.events (created_at DESC);

-- Composite index for dashboard queries
CREATE INDEX idx_events_tenant_endpoint_status
  ON public.events (tenant_id, endpoint_id, status, created_at DESC);

-- =============================================================================
-- 004: transformation_rules (the learned healing library)
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

CREATE INDEX idx_rules_tenant_id         ON public.transformation_rules (tenant_id);
CREATE INDEX idx_rules_endpoint_id       ON public.transformation_rules (endpoint_id);
CREATE INDEX idx_rules_fingerprint       ON public.transformation_rules (tenant_id, endpoint_id, error_fingerprint);
CREATE INDEX idx_rules_status            ON public.transformation_rules (status);

-- =============================================================================
-- 005: Row-Level Security (RLS) — tenants can only see their own data
-- =============================================================================

ALTER TABLE public.profiles            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.endpoints           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.events              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.transformation_rules ENABLE ROW LEVEL SECURITY;

-- Profiles: own row only
CREATE POLICY "profiles_owner" ON public.profiles
  FOR ALL USING (auth.uid() = id);

-- Endpoints: own rows only
CREATE POLICY "endpoints_owner" ON public.endpoints
  FOR ALL USING (auth.uid() = tenant_id);

-- Events: own rows only
CREATE POLICY "events_owner" ON public.events
  FOR ALL USING (auth.uid() = tenant_id);

-- Rules: own rows only
CREATE POLICY "rules_owner" ON public.transformation_rules
  FOR ALL USING (auth.uid() = tenant_id);

-- Service role bypasses RLS (for Worker using SUPABASE_SERVICE_KEY)
-- The Worker uses service key, so all the above policies are bypassed server-side

-- =============================================================================
-- 006: updated_at auto-trigger
-- =============================================================================

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER set_endpoints_updated_at
  BEFORE UPDATE ON public.endpoints
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER set_events_updated_at
  BEFORE UPDATE ON public.events
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER set_rules_updated_at
  BEFORE UPDATE ON public.transformation_rules
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- =============================================================================
-- 007: Stats view for dashboard
-- =============================================================================

CREATE OR REPLACE VIEW public.tenant_stats AS
SELECT
  e.tenant_id,
  COUNT(DISTINCT ep.id)                                         AS total_endpoints,
  COUNT(ev.id)                                                  AS total_events,
  COUNT(ev.id) FILTER (WHERE ev.status = 'loaded')             AS events_loaded,
  COUNT(ev.id) FILTER (WHERE ev.status = 'healed')             AS events_healed,
  COUNT(ev.id) FILTER (WHERE ev.status = 'dead')               AS events_dead,
  COUNT(ev.id) FILTER (WHERE ev.status IN ('received','healing','validated')) AS events_pending,
  COUNT(DISTINCT r.id) FILTER (WHERE r.status = 'active')      AS active_rules,
  ROUND(
    100.0 * COUNT(ev.id) FILTER (WHERE ev.status IN ('loaded','healed')) /
    NULLIF(COUNT(ev.id) FILTER (WHERE ev.status NOT IN ('received','healing','validated')), 0),
    2
  )                                                             AS success_rate_pct
FROM public.endpoints e
LEFT JOIN public.endpoints ep ON ep.tenant_id = e.tenant_id
LEFT JOIN public.events ev ON ev.tenant_id = e.tenant_id
LEFT JOIN public.transformation_rules r ON r.tenant_id = e.tenant_id
GROUP BY e.tenant_id;

-- =============================================================================
-- 008: Demo seed data (optional — for local testing)
-- =============================================================================

-- Uncomment and replace UUIDs to seed test data:
/*
INSERT INTO public.endpoints (id, tenant_id, name, slug, schema, destination, webhook_secret)
VALUES (
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  'YOUR-USER-UUID-HERE',
  'Stripe Webhooks',
  'stripe-webhooks',
  '{
    "type": "object",
    "required": ["id", "type", "data"],
    "properties": {
      "id": {"type": "string"},
      "type": {"type": "string"},
      "data": {"type": "object"},
      "created": {"type": "number"}
    }
  }',
  '{"type": "supabase", "tableName": "stripe_events"}',
  'demo_secret_replace_me'
);
*/

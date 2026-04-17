-- Worker: INSERT/UPDATE en events incluye dispatch_results; UPDATE en endpoints usa stats y last_activity_at.
-- Bases sin el esquema completo de migrations/001_schema.sql fallan en POST /webhook/... con DatabaseError.

ALTER TABLE public.events
  ADD COLUMN IF NOT EXISTS dispatch_results jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN public.events.dispatch_results IS
  'Resultados por destino tras el fan-out ([{ destinationType, destinationIndex, success, durationMs, ... }]).';

ALTER TABLE public.endpoints
  ADD COLUMN IF NOT EXISTS stats jsonb NOT NULL DEFAULT '{
    "total": 0,
    "loaded": 0,
    "healed": 0,
    "dead": 0,
    "successRate": 0
  }'::jsonb;

ALTER TABLE public.endpoints
  ADD COLUMN IF NOT EXISTS last_activity_at timestamptz;

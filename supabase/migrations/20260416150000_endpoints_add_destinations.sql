-- Fan-out multi-destino: la API y el worker persisten `destinations` (JSONB array).
-- Bases creadas solo con la columna legacy `destination` fallan en PostgREST sin esta columna.

ALTER TABLE public.endpoints
  ADD COLUMN IF NOT EXISTS destinations jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN public.endpoints.destinations IS
  'Array de configuraciones de destino; reemplaza el uso exclusivo de destination para fan-out.';

-- Backfill: filas con `destination` y array vacío -> un elemento en el array
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'endpoints'
      AND column_name = 'destination'
  ) THEN
    UPDATE public.endpoints
    SET destinations = jsonb_build_array(destination)
    WHERE destination IS NOT NULL
      AND jsonb_array_length(destinations) = 0;
  END IF;
END $$;

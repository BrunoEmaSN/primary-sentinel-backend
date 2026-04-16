-- =============================================================================
-- Usuario de prueba (Auth) — alternativa al script: scripts/seed-test-user.mjs
-- Ejecutar en SQL Editor de Supabase tras aplicar migrations/001_schema.sql
-- (y migraciones en supabase/migrations/). Preferimos el script JS: el esquema
-- de auth.* puede variar entre versiones de Supabase.
-- =============================================================================
-- Email:    sentinel-test@example.local
-- Password: SentinelTest123!
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$
DECLARE
  test_id uuid := 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'::uuid;
  test_email text := 'sentinel-test@example.com';
  test_password text := 'SentinelTest123!';
BEGIN
  -- Evitar duplicados si se vuelve a ejecutar
  DELETE FROM auth.users WHERE id = test_id OR email = test_email;

  INSERT INTO auth.users (
    id,
    instance_id,
    aud,
    role,
    email,
    encrypted_password,
    email_confirmed_at,
    raw_app_meta_data,
    raw_user_meta_data,
    created_at,
    updated_at,
    confirmation_token,
    email_change,
    email_change_token_new,
    recovery_token
  ) VALUES (
    test_id,
    '00000000-0000-0000-0000-000000000000',
    'authenticated',
    'authenticated',
    test_email,
    crypt(test_password, gen_salt('bf')),
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    jsonb_build_object('full_name', 'Usuario de prueba Sentinel'),
    now(),
    now(),
    '',
    '',
    '',
    ''
  );

  INSERT INTO auth.identities (
    id,
    user_id,
    identity_data,
    provider,
    provider_id,
    last_sign_in_at,
    created_at,
    updated_at
  ) VALUES (
    gen_random_uuid(),
    test_id,
    jsonb_build_object('sub', test_id::text, 'email', test_email),
    'email',
    test_id::text,
    now(),
    now(),
    now()
  );
END $$;

-- El trigger public.handle_new_user crea la fila en public.profiles.

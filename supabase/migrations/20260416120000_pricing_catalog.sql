-- Catálogo de precios y promociones (lectura vía Worker /api/public/pricing)

CREATE TABLE IF NOT EXISTS pricing_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_key text NOT NULL UNIQUE,
  sort_order int NOT NULL DEFAULT 0,
  monthly_amount_usd numeric(12, 2) NOT NULL,
  yearly_per_month_usd numeric(12, 2) NOT NULL,
  currency text NOT NULL DEFAULT 'USD',
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pricing_plans_sort ON pricing_plans (sort_order) WHERE active = true;

CREATE TABLE IF NOT EXISTS pricing_discounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  label text NOT NULL,
  description text,
  percent_off numeric(6, 2) NOT NULL CHECK (percent_off >= 0 AND percent_off <= 100),
  billing_period text NOT NULL DEFAULT 'both' CHECK (billing_period IN ('monthly', 'yearly', 'both')),
  applies_to_plan_keys text[],
  eligibility jsonb NOT NULL DEFAULT '{}',
  active boolean NOT NULL DEFAULT true,
  sort_order int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pricing_discounts_sort ON pricing_discounts (sort_order) WHERE active = true;

-- Datos iniciales (alinear con landing: Básico / Profesional / Empresa)
INSERT INTO pricing_plans (plan_key, sort_order, monthly_amount_usd, yearly_per_month_usd, currency)
VALUES
  ('basic', 0, 0, 0, 'USD'),
  ('professional', 1, 15.00, 12.00, 'USD'),
  ('enterprise', 2, 50.00, 42.00, 'USD')
ON CONFLICT (plan_key) DO UPDATE SET
  sort_order = EXCLUDED.sort_order,
  monthly_amount_usd = EXCLUDED.monthly_amount_usd,
  yearly_per_month_usd = EXCLUDED.yearly_per_month_usd,
  currency = EXCLUDED.currency,
  updated_at = now();

-- Ejemplo: usuarios nuevos, 15% en facturación anual el primer año (planes de pago)
INSERT INTO pricing_discounts (code, label, description, percent_off, billing_period, applies_to_plan_keys, eligibility, sort_order)
VALUES (
  'new_user_annual_first_year',
  'Bienvenida anual',
  '25% de descuento para cuentas nuevas en suscripción anual durante el primer año (Profesional y Empresa).',
  25.00,
  'yearly',
  ARRAY['professional', 'enterprise']::text[],
  '{"new_tenant_only": true, "first_subscription_year_only": true}'::jsonb,
  0
)
ON CONFLICT (code) DO NOTHING;

ALTER TABLE pricing_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE pricing_discounts ENABLE ROW LEVEL SECURITY;

-- Sin políticas para roles autenticados/anónimos: solo service_role (Worker) accede.

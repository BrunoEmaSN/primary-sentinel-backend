-- Política de negociación IA: línea roja (pisos), concesiones give-to-get, control de rondas y urgencia

ALTER TABLE pricing_plans
  ADD COLUMN IF NOT EXISTS floor_monthly_usd numeric(12, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS floor_yearly_per_month_usd numeric(12, 2) NOT NULL DEFAULT 0;

-- Línea roja por plan (por debajo: escalar a humano; la IA no puede comprometer)
UPDATE pricing_plans SET floor_monthly_usd = 0, floor_yearly_per_month_usd = 0 WHERE plan_key = 'basic';
UPDATE pricing_plans SET floor_monthly_usd = 12.00, floor_yearly_per_month_usd = 10.00 WHERE plan_key = 'professional';
UPDATE pricing_plans SET floor_monthly_usd = 40.00, floor_yearly_per_month_usd = 35.00 WHERE plan_key = 'enterprise';

-- Configuración global (singleton id=1)
CREATE TABLE IF NOT EXISTS negotiation_control (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  max_negotiation_rounds int NOT NULL DEFAULT 3,
  urgency_multipliers jsonb NOT NULL DEFAULT '{"high": 0.5, "medium": 0.75, "low": 1.0}'::jsonb,
  power_band_max_discount jsonb NOT NULL DEFAULT '{"startup": 0.18, "smb": 0.12, "multinational": 0.08, "unknown": 0.10}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO negotiation_control (id) VALUES (1)
ON CONFLICT (id) DO NOTHING;

-- Concesiones no monetarias / contractuales que la IA puede pedir a cambio de precio
CREATE TABLE IF NOT EXISTS negotiation_concessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  label text NOT NULL,
  description text,
  kind text NOT NULL DEFAULT 'non_monetary' CHECK (kind IN ('non_monetary', 'contract', 'payment', 'support')),
  active boolean NOT NULL DEFAULT true,
  sort_order int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO negotiation_concessions (code, label, description, kind, sort_order)
VALUES
  (
    'logo_website',
    'Logo en web',
    'Uso del logo del cliente en la página de clientes o casos de éxito (marca reconocida a cambio de margen).',
    'non_monetary',
    0
  ),
  (
    'min_term_12m',
    'Compromiso de permanencia 12 meses',
    'Contrato o pedido con compromiso mínimo de 12 meses para justificar descuento recurrente.',
    'contract',
    1
  ),
  (
    'prepay_annual',
    'Pago anual por adelantado',
    'Facturación anual anticipada (mejora cash flow; habilita descuentos mayores que mensual).',
    'payment',
    2
  ),
  (
    'support_tickets_only',
    'Soporte solo por ticket',
    'En lugar de canal prioritario (Slack), soporte acotado a tickets con SLA estándar.',
    'support',
    3
  )
ON CONFLICT (code) DO NOTHING;

ALTER TABLE negotiation_control ENABLE ROW LEVEL SECURITY;
ALTER TABLE negotiation_concessions ENABLE ROW LEVEL SECURITY;

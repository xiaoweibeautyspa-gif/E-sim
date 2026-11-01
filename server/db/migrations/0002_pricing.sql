-- Seeds the pricing defaults used by server/services/pricing.ts.
--
-- This migration is idempotent: every statement can be re-run on an existing
-- database without error. Run after 0001_init.sql.
--
-- Scope: pricing settings + a couple of illustrative price_overrides rows for
-- the admin dashboard. No real supplier data is inserted here — that comes
-- only from the /package/list sync job.

BEGIN;

-- ---------------------------------------------------------------------------
-- Global markup default (percent, expressed as a JSON number).
-- server/services/pricing.ts reads:
--   settings.key = 'pricing.globalMarkupPercent'
-- and accepts a bare number, a numeric string, or { percent: n }.
-- 30 == 1.30x wholesale. Admin overrides this in the dashboard.
-- ---------------------------------------------------------------------------
INSERT INTO settings (key, value)
VALUES ('pricing.globalMarkupPercent', '30'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Low-balance alert threshold (USD). Used by the fulfilment phase when it
-- checks /balance/query before ordering. Declared here next to the other
-- pricing/settings defaults so all money thresholds live in one migration.
-- ---------------------------------------------------------------------------
INSERT INTO settings (key, value)
VALUES ('supplier.lowBalanceThresholdUsd', '50'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Example per-country overrides (documentation for admins; harmless if left
-- in place, and safe to edit/remove in the dashboard). Overrides take
-- precedence over the global markup; per-package overrides still win.
-- ---------------------------------------------------------------------------
INSERT INTO price_overrides (scope, target, markup_percent)
VALUES
  ('country', 'sg', 25),  -- Singapore: slightly tighter margin (competitive market)
  ('country', 'jp', 35)   -- Japan: higher margin (strong demand, less price pressure)
ON CONFLICT (scope, target) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Seed the last-balance snapshot used by the admin low-balance alert so the
-- dashboard has a definite "unknown" state before the first /balance/query
-- call. Value 0 with an old timestamp means "never queried".
-- ---------------------------------------------------------------------------
INSERT INTO supplier_balance_snapshots (balance_usd, created_at)
SELECT '0', '1970-01-01T00:00:00Z'::timestamptz
WHERE NOT EXISTS (SELECT 1 FROM supplier_balance_snapshots);

COMMIT;

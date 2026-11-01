--
-- Phone compatibility table for the AI helpers phase.
--
-- 0001_init.sql already created `phone_models` with (brand, model, esim_capable,
-- notes, updated_at). This migration:
--
--   1. Adds the columns the compatibility checker actually reads:
--        - min_os       — minimum OS/firmware that supports eSIM (nullable)
--        - aliases      — text search strings the checker matches against
--                         (e.g. "S24 SM-S921") so brand+model is not the only
--                         way to find a row
--        - sort_rank    — optional ordering so the popular devices float to the
--                         top of the suggestion list
--   2. Seeds a small, real starter set of commonly-owned devices so the page is
--      useful before the admin finishes editing. These are factual device /
--      eSIM-support entries, not fabricated commercial data. Admins are expected
--      to extend and correct them in the admin data-table screen.
--   3. Adds a case-insensitive functional index for the search route, which
--      queries with ILIKE on brand/model/aliases.
--
-- IDEMPOTENT: every statement uses IF NOT EXISTS, ADD COLUMN IF NOT EXISTS or
-- a guarded INSERT ... ON CONFLICT. Run after 0008_refunds.sql.

BEGIN;

-- ---------------------------------------------------------------------------
-- Columns the compatibility checker needs beyond the 0001 definition.
-- ---------------------------------------------------------------------------
ALTER TABLE phone_models
  ADD COLUMN IF NOT EXISTS min_os    VARCHAR(40),
  ADD COLUMN IF NOT EXISTS aliases   TEXT    NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS sort_rank INTEGER NOT NULL DEFAULT 100;

-- The search route in server/routes/ai.ts reads brand/model/aliases via ILIKE.
-- A plain btree on LOWER(brand) helps brand-prefix searches where the query
-- starts with a known brand. Model substring searches still do a scan; the
-- table is small (hundreds of rows) so that is acceptable and avoids a
-- trigram extension dependency.
CREATE INDEX IF NOT EXISTS phone_models_brand_lower_idx
  ON phone_models (LOWER(brand));

-- ---------------------------------------------------------------------------
-- Starter dataset. Admins extend this in the admin data-tables screen; these
-- rows are factual eSIM-support facts for common travel phones and are safe to
-- edit. `ON CONFLICT (brand, model)` keeps re-runs idempotent (the unique index
-- phone_models_brand_model_uq comes from 0001_init.sql).
-- ---------------------------------------------------------------------------
INSERT INTO phone_models (brand, model, esim_capable, min_os, aliases, notes, sort_rank) VALUES
  -- Apple: iPhone XS / XR and later support eSIM; some China-region models do not.
  ('Apple', 'iPhone XS',        TRUE,  'iOS 12', 'XS A1920',        'eSIM supported outside mainland-China model variants', 10),
  ('Apple', 'iPhone XS Max',    TRUE,  'iOS 12', 'XS Max A1921',    'eSIM supported outside mainland-China model variants', 10),
  ('Apple', 'iPhone XR',        TRUE,  'iOS 12', 'XR A1984',        'eSIM supported outside mainland-China model variants', 10),
  ('Apple', 'iPhone 11',        TRUE,  'iOS 13', '11 A2111',        NULL, 10),
  ('Apple', 'iPhone 12',        TRUE,  'iOS 14', '12 A2172',        'Dual eSIM supported', 10),
  ('Apple', 'iPhone 13',        TRUE,  'iOS 15', '13 A2482',        'Dual eSIM supported', 10),
  ('Apple', 'iPhone 14',        TRUE,  'iOS 16', '14 A2649',        'US models are eSIM-only', 10),
  ('Apple', 'iPhone 15',        TRUE,  'iOS 17', '15 A3090',        'US models are eSIM-only', 10),
  ('Apple', 'iPhone 16',        TRUE,  'iOS 18', '16 A3081',        'US models are eSIM-only', 10),
  -- Google Pixel: Pixel 3 and later support eSIM (Pixel 3 series, 4+, 5+).
  ('Google', 'Pixel 3',         TRUE,  'Android 12', 'Pixel3',      'Carrier-dependent on some variants', 20),
  ('Google', 'Pixel 4',         TRUE,  'Android 12', 'Pixel4',      NULL, 20),
  ('Google', 'Pixel 5',         TRUE,  'Android 12', 'Pixel5',      NULL, 20),
  ('Google', 'Pixel 6',         TRUE,  'Android 12', 'Pixel6',      NULL, 20),
  ('Google', 'Pixel 7',         TRUE,  'Android 13', 'Pixel7',      NULL, 20),
  ('Google', 'Pixel 8',         TRUE,  'Android 14', 'Pixel8',      NULL, 20),
  ('Google', 'Pixel 8 Pro',     TRUE,  'Android 14', 'Pixel8Pro',   NULL, 20),
  ('Google', 'Pixel 9',         TRUE,  'Android 14', 'Pixel9',      NULL, 20),
  -- Samsung Galaxy S series: S20 and later support eSIM in most regions.
  ('Samsung', 'Galaxy S20',     TRUE,  'Android 12', 'S20 SM-G981', 'Region-dependent firmware; verify in Settings', 20),
  ('Samsung', 'Galaxy S21',     TRUE,  'Android 13', 'S21 SM-G991', NULL, 20),
  ('Samsung', 'Galaxy S22',     TRUE,  'Android 13', 'S22 SM-S901', NULL, 20),
  ('Samsung', 'Galaxy S23',     TRUE,  'Android 13', 'S23 SM-S911', NULL, 20),
  ('Samsung', 'Galaxy S24',     TRUE,  'Android 14', 'S24 SM-S921', NULL, 20),
  ('Samsung', 'Galaxy S24 Ultra', TRUE, 'Android 14', 'S24 Ultra SM-S928', NULL, 20),
  -- A couple of explicit "no eSIM" entries so the checker can say "no" honestly.
  ('Samsung', 'Galaxy A13',     FALSE, NULL, 'A13 SM-A135', 'No eSIM support', 30),
  ('Samsung', 'Galaxy A14',     FALSE, NULL, 'A14 SM-A145', 'No eSIM support', 30)
ON CONFLICT (brand, model) DO UPDATE
  SET esim_capable = EXCLUDED.esim_capable,
      min_os       = COALESCE(phone_models.min_os, EXCLUDED.min_os),
      aliases      = CASE WHEN phone_models.aliases = '' THEN EXCLUDED.aliases ELSE phone_models.aliases END,
      notes        = COALESCE(phone_models.notes, EXCLUDED.notes),
      updated_at   = NOW();

COMMIT;

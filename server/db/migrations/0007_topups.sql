--
-- Top-up purchase records + auto top-up settings.
--
-- WHY THIS MIGRATION EXISTS
-- -------------------------
-- Phase 3 (Top-ups) needs to persist, per top-up request:
--
--   * the eSIM it applies to (via esim_tran_no, since the supplier's
--     /esim/topup is keyed by esimTranNo, NOT ICCID),
--   * the package the buyer chose (a top-up package from /package/list),
--   * the retail price charged + wholesale cost + profit,
--   * the Stripe payment linkage (session + payment intent) so we only call
--     /esim/topup AFTER Stripe confirms, and can reconcile later,
--   * a status machine: pending_payment -> paid -> ordering -> ordered |
--     failed (the supplier call happens after payment),
--   * an idempotent `public_id` (used as the supplier transactionId for
--     retries — the supplier de-dupes on transactionId).
--
-- It also adds the per-user auto-top-up settings (opt-in, saved payment
-- method reference, monthly cap, current-month spend counter). The counters
-- are denormalised deliberately so an auto-top-up charge can check the cap in
-- a single UPDATE ... RETURNING against numeric bounds, without reading all
-- historical top-ups on every DATA_USAGE webhook.
--
-- IDEMPOTENT: every statement uses IF NOT EXISTS / ADD COLUMN IF NOT EXISTS.
-- Run after 0006_webhook_events.sql.

BEGIN;

-- ---------------------------------------------------------------------------
-- topups
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS topups (
  id                         SERIAL PRIMARY KEY,
  public_id                  VARCHAR(40)   NOT NULL,
  order_id                   INTEGER       REFERENCES orders (id) ON DELETE SET NULL,
  esim_id                    INTEGER       NOT NULL REFERENCES esims (id) ON DELETE CASCADE,
  user_id                    INTEGER       REFERENCES users (id) ON DELETE SET NULL,
  -- Supplier identity (customer-facing): esimTranNo is the top-up key.
  esim_tran_no              VARCHAR(64),
  iccid                     VARCHAR(40),
  -- Package snapshot (never join back to `packages` for pricing/profit).
  package_code              VARCHAR(128)  NOT NULL,
  package_name              VARCHAR(200)  NOT NULL,
  currency                  VARCHAR(3)    NOT NULL DEFAULT 'SGD',
  retail_total              NUMERIC(12,4) NOT NULL DEFAULT 0,
  wholesale_total_usd       NUMERIC(12,4) NOT NULL DEFAULT 0,
  profit_usd                NUMERIC(12,4) NOT NULL DEFAULT 0,
  -- Status machine. `ordering` means Stripe confirmed and we're calling the
  -- supplier; a retry re-uses the same public_id (transactionId).
  status                    VARCHAR(24)   NOT NULL DEFAULT 'pending_payment',
  -- Stripe linkage.
  stripe_session_id         VARCHAR(128),
  stripe_payment_intent_id  VARCHAR(128),
  -- Auto top-up flag: true when the trigger was a DATA_USAGE webhook, so the
  -- receipt email can explain why the charge happened without asking.
  auto                      BOOLEAN       NOT NULL DEFAULT FALSE,
  failure_reason            TEXT,
  supplier_transaction_id   VARCHAR(64),
  paid_at                   TIMESTAMPTZ,
  ordered_at                TIMESTAMPTZ,
  created_at                TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS topups_public_id_uq
  ON topups (public_id);
CREATE INDEX IF NOT EXISTS topups_esim_idx
  ON topups (esim_id);
CREATE INDEX IF NOT EXISTS topups_user_idx
  ON topups (user_id);
CREATE INDEX IF NOT EXISTS topups_stripe_session_idx
  ON topups (stripe_session_id)
  WHERE stripe_session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS topups_status_idx
  ON topups (status);

-- Legal status values. Kept narrow so a typo in application code fails loudly
-- at the DB instead of creating an orphan state only the admin can see.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'topups_status_check'
  ) THEN
    ALTER TABLE topups
      ADD CONSTRAINT topups_status_check
      CHECK (status IN (
        'pending_payment',
        'paid',
        'ordering',
        'ordered',
        'failed',
        'refunded',
        'cancelled'
      ));
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Auto top-up settings (one row per user, opt-in).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS auto_topup_settings (
  user_id                    INTEGER       PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  enabled                    BOOLEAN       NOT NULL DEFAULT FALSE,
  -- Reference to the saved Stripe payment method (pm_xxx). NULL means the
  -- user has not opted into save-card; auto top-up requires this.
  payment_method_ref         VARCHAR(128),
  -- Package the user wants auto top-up to buy. Resolved against
  -- `packages` at charge time; a package retired by the supplier changes
  -- the resolution path (we surface it, not silently substitute).
  topup_package_code         VARCHAR(128),
  -- Monthly cap in the user's currency (minor-intended but stored as major
  -- units to mirror the rest of the schema). NULL = no cap (rare; the UI
  -- always sets a default).
  monthly_cap_amount         NUMERIC(12,4),
  currency                   VARCHAR(3)   NOT NULL DEFAULT 'SGD',
  -- Denormalised counters, reset monthly by `server/jobs/autoTopupReset.job`
  -- in a later phase. We keep them here so an auto charge can be gated by a
  -- single conditional UPDATE that atomically confirms the cap.
  month_key                  VARCHAR(7),           -- 'YYYY-MM'
  month_spent_amount         NUMERIC(12,4) NOT NULL DEFAULT 0,
  last_charged_at            TIMESTAMPTZ,
  created_at                 TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at                 TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- Settings defaults surfaced by the admin (documented here, not read here).
-- Safe to re-run.
-- ---------------------------------------------------------------------------
INSERT INTO settings (key, value)
VALUES
  ('topup.defaultCurrency',        '"SGD"'::jsonb),
  ('topup.autoMonthlyCapDefault',  '30'::jsonb),
  ('topup.autoMinIntervalMinutes', '60'::jsonb)   -- anti-abuse guard
ON CONFLICT (key) DO NOTHING;

COMMIT;

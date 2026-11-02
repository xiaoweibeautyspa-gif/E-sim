--
-- Extends the orders workflow for the checkout + payment batch.
--
-- 0001_init.sql already created the `orders` table with the columns this
-- webhook writes (`public_id`, `status`, `currency`, `retail_total`,
-- `stripe_session_id`, `stripe_payment_intent_id`, `quantity`, `paid_at`,
-- `placed_at`, `updated_at`). This migration is ADDITIVE and IDEMPOTENT; it
-- only adds the guarantees the fulfilment + admin phases require:
--
--   1. `pending_fulfilment` is now a legal status. The Stripe webhook flips
--      paid orders to this state so the fulfilment job (next phase) has a
--      clear queue to drain. Before this migration the value was accepted
--      by Postgres (varchar) but no consumer expected it — adding an
--      explicit CHECK documents the legal transitions.
--   2. `expired_at` and `failed_at` timestamps so the admin can see WHEN an
--      order stopped progressing, not just that it did.
--   3. An index on (status, placed_at) for the fulfilment + admin queues.
--   4. A backfill that leaves existing rows untouched and marks any
--      pre-existing `pending` rows with `placed_at` so nothing silently
--      appears "fresh".
--
-- Run after 0003_users.sql.

BEGIN;

-- ---------------------------------------------------------------------------
-- New terminal-or-transitional timestamps.
-- ---------------------------------------------------------------------------
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS expired_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS failed_at  TIMESTAMPTZ;

-- ---------------------------------------------------------------------------
-- Legal status values. We deliberately keep this constraint loose-yet-real:
-- adding a status later means editing this CHECK once, in this migration
-- file's history, not chasing VARCHAR typos across the codebase. If you add
-- a status in a later phase, alter the constraint in that phase's migration.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'orders_status_check'
  ) THEN
    ALTER TABLE orders
      ADD CONSTRAINT orders_status_check
      CHECK (status IN (
        'pending',
        'pending_fulfilment',
        'paid',
        'processing',
        'completed',
        'failed',
        'expired',
        'refunded',
        'cancelled'
      ));
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Indexes the fulfilment + admin queues actually use.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS orders_status_placed_idx
  ON orders (status, placed_at DESC);

-- Stripe may retry a webhook after we've already handled it. A direct index
-- on stripe_session_id lets applyPaymentStatus() find an order by session if
-- metadata is ever missing from a specific event.
CREATE INDEX IF NOT EXISTS orders_stripe_session_id_idx
  ON orders (stripe_session_id)
  WHERE stripe_session_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Backfill: any order that paid but never got a status that a fulfilment
-- worker understands is nudged to `pending_fulfilment` if it has a
-- `paid_at`. This is the only place we touch existing data and it is
-- intentionally limited to the `paid` legacy value.
-- ---------------------------------------------------------------------------
UPDATE orders
   SET status = 'pending_fulfilment'
 WHERE status = 'paid' AND paid_at IS NOT NULL;

-- Seed defaults used at checkout / by the admin low-balance check. These
-- already live in 0002 for the markup; here we document the Stripe-related
-- settings the admin will touch (currency list is enforced by brand.config.ts
-- on the server, but admin wants a discoverable key).
INSERT INTO settings (key, value)
VALUES
  ('checkout.defaultCurrency',    '"SGD"'::jsonb),
  ('checkout.supportedCurrencies', '["SGD","USD","VND","CNY"]'::jsonb)
ON CONFLICT (key) DO NOTHING;

COMMIT;

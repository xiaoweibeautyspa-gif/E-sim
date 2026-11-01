--
-- Refund requests + manual support review queue for the money-back guarantee.
--
-- WHY THIS MIGRATION EXISTS
-- -------------------------
-- The money-back guarantee ("Full refund if the eSIM is never installed") needs
-- a durable record of:
--
--   * every refund request (who asked, which eSIM, why, when),
--   * the decision taken (auto-refunded vs. routed to manual review),
--   * the Stripe refund linkage (payment intent + refund id) so a failed
--     Stripe call is visible and retryable,
--   * the supplier-side cancellation outcome (RELEASED / GOT_RESOURCE only —
--     activated eSIMs cannot be cancelled by the supplier).
--
-- `esims.refund_status` (from 0001_init.sql) already carries the eSIM-level
-- state machine ('none' | 'requested' | 'refunded' | 'review' | 'rejected').
-- This migration adds a first-class `refund_requests` table so we keep the
-- full audit trail, and a partial-unique index so the same eSIM cannot have
-- two open requests at once.
--
-- IDEMPOTENT: every statement uses IF NOT EXISTS / ADD COLUMN IF NOT EXISTS.
-- Run after 0007_topups.sql.

BEGIN;

-- ---------------------------------------------------------------------------
-- refund_requests
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS refund_requests (
  id                          SERIAL PRIMARY KEY,
  public_id                   VARCHAR(40)   NOT NULL,
  user_id                     INTEGER       REFERENCES users (id) ON DELETE SET NULL,
  order_id                    INTEGER       NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  esim_id                     INTEGER       NOT NULL REFERENCES esims (id) ON DELETE CASCADE,
  -- Buyer reason, free-text. Optional but the UI encourages it.
  reason                      TEXT,
  -- Status machine:
  --   'requested'   — customer submitted; not yet processed
  --   'auto_refunded' — supplier cancel + Stripe refund both succeeded
  --   'review'      — installed/activated; queued for manual support
  --   'rejected'    — manual reviewer declined (e.g. used data past threshold)
  --   'failed'      — auto path errored on Stripe or supplier
  status                      VARCHAR(24)   NOT NULL DEFAULT 'requested',
  -- Supplier cancellation outcome (only set when we attempted it).
  -- 'not_attempted' | 'cancelled' | 'refused' | 'error'
  supplier_cancel_status      VARCHAR(24)   NOT NULL DEFAULT 'not_attempted',
  supplier_cancel_reason      TEXT,
  -- Stripe refund linkage.
  stripe_refund_id            VARCHAR(128),
  stripe_refund_amount        NUMERIC(12,4),
  stripe_refund_currency      VARCHAR(3),
  -- Manual review bookkeeping.
  reviewed_by                 INTEGER       REFERENCES users (id) ON DELETE SET NULL,
  reviewed_at                 TIMESTAMPTZ,
  review_note                 TEXT,
  failure_reason              TEXT,
  created_at                  TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS refund_requests_public_id_uq
  ON refund_requests (public_id);
CREATE INDEX IF NOT EXISTS refund_requests_user_idx
  ON refund_requests (user_id);
CREATE INDEX IF NOT EXISTS refund_requests_order_idx
  ON refund_requests (order_id);
CREATE INDEX IF NOT EXISTS refund_requests_esim_idx
  ON refund_requests (esim_id);
CREATE INDEX IF NOT EXISTS refund_requests_status_idx
  ON refund_requests (status);
-- One open request per eSIM at a time. A closed/rejected request is excluded
-- so the customer can retry after review is resolved.
CREATE UNIQUE INDEX IF NOT EXISTS refund_requests_open_per_esim_uq
  ON refund_requests (esim_id)
  WHERE status IN ('requested', 'review');

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'refund_requests_status_check'
  ) THEN
    ALTER TABLE refund_requests
      ADD CONSTRAINT refund_requests_status_check
      CHECK (status IN (
        'requested',
        'auto_refunded',
        'review',
        'rejected',
        'failed'
      ));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'refund_requests_supplier_cancel_check'
  ) THEN
    ALTER TABLE refund_requests
      ADD CONSTRAINT refund_requests_supplier_cancel_check
      CHECK (supplier_cancel_status IN (
        'not_attempted',
        'cancelled',
        'refused',
        'error'
      ));
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Settings defaults. Documented here so the admin can discover them.
-- ---------------------------------------------------------------------------
INSERT INTO settings (key, value)
VALUES
  ('refunds.guaranteeWindowDays', '30'::jsonb),
  ('refunds.autoRefundRequireUnused', 'true'::jsonb),
  ('refunds.supportEmail', '"support@example.com"'::jsonb)
ON CONFLICT (key) DO NOTHING;

COMMIT;

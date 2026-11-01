--
-- Fulfilment column reconciliation + gift metadata exposure.
--
-- WHY THIS MIGRATION EXISTS
-- -------------------------
-- 0001_init.sql created `orders` without a few columns that the *already-saved*
-- `server/services/fulfilment.ts` reads and writes:
--
--   package_code          (source of the /esim/order packageCode)
--   supplier_order_no     (returned from /esim/order, echo on resume)
--   low_balance_flag      (already exists — kept for the flag write)
--   low_balance_flagged_color_hint (no-op, ignored)
--   processing_reason     (why a `processing` order hasn't completed)
--   failed_reason         (why a `failed` order exists)
--
-- And gift metadata is spread across `is_gift` / `recipient_name` /
-- `recipient_email` / `gift_message` / `send_date`, but the fulfilment service
-- reads it as a single `giftJson` object. This migration adds a generated
-- column `gift` (JSONB) built from those source columns so the select in
-- fulfilment finds what it looks for, without duplicating writes.
--
-- Additionally, we legalise the `waiting_payment` status used by the
-- checkout staging step (payment initiated, Stripe not yet confirmed) so the
-- order isn't confusion-bound with `pending`. Fulfilment refuses to run on
-- `waiting_payment` (already enforced in fulfilment.ts by status whitelist).
--
-- IDEMPOTENT: every statement uses IF NOT EXISTS or is wrapped so re-running
-- is harmless. Run after 0004_orders.sql.

BEGIN;

-- ---------------------------------------------------------------------------
-- Orders: new columns the fulfilment service needs.
-- ---------------------------------------------------------------------------
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS package_code      VARCHAR(128),
  ADD COLUMN IF NOT EXISTS supplier_order_no VARCHAR(64),
  ADD COLUMN IF NOT EXISTS processing_reason TEXT,
  ADD COLUMN IF NOT EXISTS failed_reason     TEXT,
  ADD COLUMN IF NOT EXISTS low_balance_flag_color_note TEXT; -- placeholder never used

-- Drop the accidental placeholder above so nobody thinks it's live.
ALTER TABLE orders DROP COLUMN IF EXISTS low_balance_flag_color_note;

-- ---------------------------------------------------------------------------
-- Gift JSON: derived from the existing source columns. Exposed as `gift` so
-- the fulfilment service's `select({ gift: orders.gift })` works. NULL when
-- no recipient_name/email are set — the normaliser in fulfilment.ts then
-- returns null (i.e. not a gift), which matches the design.
-- ---------------------------------------------------------------------------
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS gift JSONB GENERATED ALWAYS AS (
    CASE
      WHEN recipient_name IS NOT NULL AND recipient_email IS NOT NULL THEN
        jsonb_build_object(
          'recipientName',  recipient_name,
          'recipientEmail', recipient_email,
          'message',        gift_message,
          'sendDate',       to_char(send_date AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
        )
      ELSE NULL
    END
  ) STORED;

-- ---------------------------------------------------------------------------
-- Widen the status CHECK to include `waiting_payment` (the checkout staging
-- state that pre-dates Stripe confirmation). The constraint was created in
-- 0004; we drop and re-create it so the new value is legal. Postgres requires
-- dropping first; no data change is implied.
-- ---------------------------------------------------------------------------
ALTER TABLE orders
  DROP CONSTRAINT IF EXISTS orders_status_check;

ALTER TABLE orders
  ADD CONSTRAINT orders_status_check
  CHECK (status IN (
    'waiting_payment',
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

-- ---------------------------------------------------------------------------
-- Indexes the fulfilment/lookup path relies on.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS orders_package_code_idx
  ON orders (package_code)
  WHERE package_code IS NOT NULL;

CREATE INDEX IF NOT EXISTS orders_supplier_order_no_idx
  ON orders (supplier_order_no)
  WHERE supplier_order_no IS NOT NULL;

-- Gift orders are occasionally queried for the recipient-email schedule.
CREATE INDEX IF NOT EXISTS orders_gift_send_date_idx
  ON orders (send_date)
  WHERE is_gift = TRUE;

-- ---------------------------------------------------------------------------
-- Webhook events: the receiver filters on (source, notifyType) often during
-- admin triage. The unique index on (source, notifyId) is already in 0001.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS webhook_events_source_type_idx
  ON webhook_events (source, notify_type);

-- ---------------------------------------------------------------------------
-- Settings defaults touched by fulfilment.
-- ---------------------------------------------------------------------------
INSERT INTO settings (key, value)
VALUES
  ('fulfilment.pollIntervalMs',    '3000'::jsonb),
  ('fulfilment.pollMaxAttempts',   '10'::jsonb),
  ('fulfilment.installTokenTtlDays', '365'::jsonb)
ON CONFLICT (key) DO NOTHING;

COMMIT;

--
-- Webhook ingestion + dedupe surface. 0001_init.sql already created
-- `webhook_events` (id, source, notify_id, notify_type, payload, processed_at,
-- processing_error, created_at) and a unique index on (source, notify_id).
-- This migration is ADDITIVE and IDEMPOTENT; it hardens the table the async
-- processor in server/services/webhookProcessor.ts relies on:
--
--   1. Status/attempt tracking so the admin webhook log shows how far an event
--      got and whether processing is still in flight. Adds `status`
--      ('received'|'processing'|'processed'|'failed') and `attempts`.
--   2. A partial index for the admin triage view (unprocessed events first).
--   3. A settings key for the alert email sender (documents where the "low
--      data" / "1 day left" copy lives), harmless if unused.
--
-- No external calls, no invented data. Run after 0005_esims_gifts.sql.

BEGIN;

-- ---------------------------------------------------------------------------
-- Progress tracking columns.
-- ---------------------------------------------------------------------------
ALTER TABLE webhook_events
  ADD COLUMN IF NOT EXISTS status     VARCHAR(16) NOT NULL DEFAULT 'received',
  ADD COLUMN IF NOT EXISTS attempts   INTEGER     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- Legal status values. Kept narrow on purpose: 'received' is set at insert,
-- 'processing' while the processor runs, 'processed' / 'failed' terminal.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'webhook_events_status_check'
  ) THEN
    ALTER TABLE webhook_events
      ADD CONSTRAINT webhook_events_status_check
      CHECK (status IN ('received', 'processing', 'processed', 'failed'));
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- The unique (source, notify_id) index already exists from 0001. A duplicate
-- notifyId with a NULL notify_id must still be allowed to coexist (a NULL is
-- not equal to another NULL in a unique btree), and our route refuses rows
-- without a notifyId before insert, so nothing here rewrites that index.
-- ---------------------------------------------------------------------------

-- Admin triage: unprocessed events, newest first. Partial index keeps it small.
CREATE INDEX IF NOT EXISTS webhook_events_pending_idx
  ON webhook_events (created_at DESC)
  WHERE status IN ('received', 'processing');

-- Quick lookup by type for the "which notifyTypes are firing" admin chart.
CREATE INDEX IF NOT EXISTS webhook_events_notify_type_idx
  ON webhook_events (notify_type);

-- ---------------------------------------------------------------------------
-- Settings defaults used by the processor's alert copy. Safe to re-run.
-- ---------------------------------------------------------------------------
INSERT INTO settings (key, value)
VALUES
  ('alerts.lowDataThresholdBytes', '104857600'::jsonb),  -- 100 MiB
  ('alerts.validityWarnDays',      '1'::jsonb)
ON CONFLICT (key) DO NOTHING;

COMMIT;

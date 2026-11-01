-- Push subscription store for the alerts phase.
--
-- One row per browser/device endpoint. `endpoint` is globally unique (the
-- browser guarantees it), and we join back to the owner through `user_id`.
-- `p256dh` and `auth` are the browser-generated keys the web-push library
-- needs; they are NOT secret in the crypto sense (the endpoint is), but we
-- treat the whole row as personal data and never log the values.
--
-- `server/services/notifications.ts` reads this table with a raw SQL join on
-- `esims.user_id = push_subscriptions.user_id`. The column names below MUST
-- keep matching that query: endpoint, p256dh, auth.

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id          serial PRIMARY KEY,
  user_id     integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint    text NOT NULL,
  p256dh      text NOT NULL,
  auth        text NOT NULL,
  user_agent  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Endpoint uniqueness powers the ON CONFLICT upsert in server/routes/push.ts.
CREATE UNIQUE INDEX IF NOT EXISTS push_subscriptions_endpoint_uq
  ON push_subscriptions (endpoint);

-- Push fan-out lookups are by user (one user → many devices).
CREATE INDEX IF NOT EXISTS push_subscriptions_user_id_idx
  ON push_subscriptions (user_id);

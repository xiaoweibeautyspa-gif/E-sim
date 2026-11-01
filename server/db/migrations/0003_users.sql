-- Accounts + sessions hardening.
--
-- 0001_init.sql already created `users` and `sessions`. This migration is
-- ADDITIVE and IDEMPOTENT: it brings the tables in line with
-- server/services/authService.ts (scrypt hashes, google_id linking, locale,
-- preferred_currency) and closes two gaps that 0001 left open:
--
--   1. Email uniqueness is case-sensitive in 0001 because it indexes the raw
--      `email` column. authService normalises emails to lowercase before insert
--      and lookup, but a manual row or a legacy import could still sneak a
--      mixed-case duplicate past the unique index. A functional unique index
--      on LOWER(email) makes the guarantee total.
--   2. There is no "last seen" column, so the admin dashboard can't tell a
--      dormant account from an active one. Add `last_login_at`.
--
-- Every statement can be re-run on the existing schema without error.
-- Run after 0002_pricing.sql.

BEGIN;

-- ---------------------------------------------------------------------------
-- users: last login timestamp (nullable — NULL == never logged in)
-- ---------------------------------------------------------------------------
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;

-- ---------------------------------------------------------------------------
-- users: case-insensitive email uniqueness.
-- The 0001 index is on the raw column. Lower-casing every row before the
-- concern is that a mixed-case duplicate could already exist. We defensively
-- lower existing rows first (no-op for rows authService wrote, since it already
-- lowercases), then build the functional unique index. If a true duplicate
-- different-case pair exists, Postgres refuses to build UQ and this migration
-- fails loudly — which is the correct, visible outcome (manual cleanup needed)
-- rather than silently picking a winner.
-- ---------------------------------------------------------------------------
UPDATE users
   SET email = LOWER(email)
 WHERE email <> LOWER(email);

CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_uq
  ON users (LOWER(email));

-- ---------------------------------------------------------------------------
-- users: help the Google "returning user" lookup
-- (authService.findOrCreateUserByGoogle queries by google_id).
-- 0001 already created users_google_id_idx; we re-assert it with IF NOT EXISTS
-- so this migration is self-contained and safe to run on a DB where 0001 was
-- partially applied.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS users_google_id_idx
  ON users (google_id);

-- ---------------------------------------------------------------------------
-- sessions: speed up the opportunistic expiry sweep
-- (authService.createSession deletes WHERE expires_at < now()).
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS sessions_expires_at_idx
  ON sessions (expires_at);

-- ---------------------------------------------------------------------------
-- Seed defaults for accounts that authService.createSession touches.
-- preferred_currency is a column default in 0001, but the storefront reads it
-- from GET /api/auth/me, so keep an explicit setting record alongside so it's
-- discoverable from the admin settings screen. Safe to re-run.
-- ---------------------------------------------------------------------------
INSERT INTO settings (key, value)
VALUES ('accounts.defaultCurrency', '"SGD"'::jsonb)
ON CONFLICT (key) DO NOTHING;

COMMIT;

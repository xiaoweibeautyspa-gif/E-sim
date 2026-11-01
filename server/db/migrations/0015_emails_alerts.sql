--
-- Lifecycle emails, price-drop alerts, and WhatsApp linkage.
--
-- WHY THIS MIGRATION EXISTS
-- -------------------------
-- The three saved lifecycle email jobs (abandonedCart / reviewRequest /
-- winBack) each require markers on `orders` or users that the earlier
-- migrations didn't add. And the two services in this batch need two new
-- tables:
--
--   1. `price_alert_subscriptions` — per (country, email) baseline used by
--      `server/services/priceAlerts.ts` to detect and de-dupe price drops.
--
--   2. `whatsapp_link` — one row per (phone, user) so the WhatsApp bot in
--      `server/routes/whatsapp.ts` can resolve a sender's phone to their
--      account. Kept in its own table (not `users.phone`) so a single user
--      can link multiple phone numbers and can un-link.
--
-- This migration also adds the marker columns the lifecycle jobs read:
--
--   orders.abandoned_cart_email_sent_at  TIMESTAMPTZ
--     Set by abandonedCart.job.ts when the reminder email is sent. Its
--     absence re-sends every tick — the whole reason this column exists.
--
--   orders.review_request_sent_at        TIMESTAMPTZ
--     Set by reviewRequest.job.ts after the post-trip review prompt.
--
--   order_items.review_request_sent_at   TIMESTAMPTZ
--     For multi-country orders: each country gets its own prompt when the
--     traveller returns from that segment. Nullable, and set alongside the
--     order-level marker where applicable.
--
--   (Campaign-style suppression for the win-back job is provided by
--    `win_back_sent_at` on users. The job already reads this column;
--    adding it here lets the job write honestly on a fresh DB.)
--
-- IDEMPOTENT: every statement uses IF NOT EXISTS / ADD COLUMN IF NOT EXISTS.
-- Run after 0014_growth.sql.
--
-- COLUMN CONTRACTS (must match the two services in this batch)
-- ------------------------------------------------------------
--   price_alert_subscriptions(
--     id, country_code, email, user_id (nullable), currency,
--     last_seen_price NUMERIC(12,4),       -- price the visitor last saw
--     last_notified_price NUMERIC(12,4),   -- dedupe marker for the email
--     created_at, updated_at)
--     UNIQUE (country_code, email)
--
--   whatsapp_link(
--     id, user_id, phone_e164, verified BOOLEAN, verified_at,
--     created_at, updated_at)
--     UNIQUE (phone_e164)  -- one WhatsApp identity maps to one account
--
-- The underlying `packages.retail_price_usd` column is created by the
-- catalogue/pricing migrations; the price-alert service reads it and returns
-- "no price" honestly when the column is absent.

BEGIN;

-- ===========================================================================
-- 1. orders — abandoned-cart and review-request markers.
-- ===========================================================================
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS abandoned_cart_email_sent_at TIMESTAMPTZ;

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS review_request_sent_at TIMESTAMPTZ;

-- Cheap index so the abandoned-cart scan doesn't seq-scan a large orders
-- table on every 10-minute tick.
CREATE INDEX IF NOT EXISTS orders_abandoned_cart_due_idx
  ON orders (checkout_created_at)
  WHERE abandoned_cart_email_sent_at IS NULL
    AND status IN ('waiting_payment', 'pending_payment');

CREATE INDEX IF NOT EXISTS orders_review_request_due_idx
  ON orders (paid_at)
  WHERE review_request_sent_at IS NULL;

-- ===========================================================================
-- 2. order_items — per-country review prompt marker.
--
-- Multi-country order: the buyer's trip through each country ends on a
-- different date, and the review is per country (the reviews table keys on
-- (order_id, country_code)). The review_request.job already reads
-- review_requests (created in 0013); this marker on order_items lets the job
-- distinguish "prompted about this country" without duplicating state.
-- ===========================================================================
ALTER TABLE order_items
  ADD COLUMN IF NOT EXISTS review_request_sent_at TIMESTAMPTZ;

-- ===========================================================================
-- 3. users — win-back suppression marker.
--
-- The win-back job (server/jobs/winBack.job.ts) marks users it has written to
-- so we don't email them every run. It also stores the baseline
-- (`win_back_anchor_at`) as the moment the user's last paid order completed,
-- so a genuinely-inactive user is measured from that, not from "last time we
-- emailed them".
-- ===========================================================================
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS win_back_sent_at TIMESTAMPTZ;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS win_back_anchor_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS users_win_back_due_idx
  ON users (win_back_anchor_at)
  WHERE win_back_sent_at IS NULL;

-- ===========================================================================
-- 4. price_alert_subscriptions
--
-- One row per (country, email). `last_seen_price` is what the visitor saw at
-- subscribe time; `last_notified_price` records the price we last emailed
-- them about (never re-notified at the same or higher level).
--
-- We store `last_seen_price` in USD — the packages table's pricing currency.
-- The service converts for display without inventing an FX rate; if the
-- subscriber wanted SGD the email says USD. When a real FX table exists, the
-- service can migrate to storing that subscriber's currency.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS price_alert_subscriptions (
  id                    serial PRIMARY KEY,

  country_code          varchar(8)    NOT NULL,           -- lower ISO alpha-2
  email                 varchar(320)  NOT NULL,
  user_id               integer       NULL,                -- soft join to users.id
  currency              varchar(3)    NOT NULL DEFAULT 'USD',

  last_seen_price       numeric(12,4) NOT NULL CHECK (last_seen_price >= 0),
  last_notified_price   numeric(12,4)          CHECK (last_notified_price IS NULL OR last_notified_price >= 0),

  created_at            timestamptz   NOT NULL DEFAULT now(),
  updated_at            timestamptz   NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS price_alert_subscriptions_country_email_uq
  ON price_alert_subscriptions (country_code, email);

CREATE INDEX IF NOT EXISTS price_alert_subscriptions_country_active_idx
  ON price_alert_subscriptions (country_code, last_seen_price);

CREATE INDEX IF NOT EXISTS price_alert_subscriptions_user_idx
  ON price_alert_subscriptions (user_id)
  WHERE user_id IS NOT NULL;

-- ===========================================================================
-- 5. whatsapp_link
--
-- One phone number → at most one user account. The resolver in
-- server/routes/whatsapp.ts looks up by phone and expects `verified = TRUE`
-- before serving data; an unverified number (just linked, awaiting a
-- confirmation message in a later UI) is not eligible.
--
-- We require E.164 format at the DB level (`+?\d{6,15}`). WhatsApp Cloud API
-- delivers `wa_id` as digits without the plus; the resolver normalises and
-- adds `+` before matching.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS whatsapp_link (
  id           serial PRIMARY KEY,
  user_id      integer      NOT NULL,
  phone_e164   varchar(20)  NOT NULL CHECK (phone_e164 ~ '^\+?\d{6,15}$'),
  verified     boolean      NOT NULL DEFAULT FALSE,
  verified_at  timestamptz,
  created_at   timestamptz  NOT NULL DEFAULT now(),
  updated_at   timestamptz  NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_link_phone_uq
  ON whatsapp_link (phone_e164);

CREATE INDEX IF NOT EXISTS whatsapp_link_user_idx
  ON whatsapp_link (user_id);

-- ===========================================================================
-- 6. settings defaults surfaced by this batch (documented for admin).
--
-- These are read/written by later admin tooling; defaults let the storefront
-- boot without a call to the admin phase.
-- ===========================================================================
INSERT INTO settings (key, value)
VALUES
  ('alerts.priceDropEmailEnabled',    'true'::jsonb),
  ('alerts.whatsappBotEnabled',       'true'::jsonb),
  ('alerts.whatsappSupportCta',       '"Reply SUPPORT for a human."'::jsonb),
  ('alerts.winBackInactivityDays',    '90'::jsonb),
  ('alerts.reviewRequestDelayDays',   '3'::jsonb),
  ('alerts.abandonedCartWindowMinutes', '60'::jsonb)
ON CONFLICT (key) DO NOTHING;

COMMIT;

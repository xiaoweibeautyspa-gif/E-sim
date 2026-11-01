--
-- Conversion features: admin-managed carrier roaming prices, verified reviews
-- per country with a post-trip request queue, admin network speed ratings, the
-- settings keys the exit-intent popup and weekly-purchase counter read.
--
-- WHY THIS MIGRATION EXISTS
-- -------------------------
-- Phase 7 (conversion) exposes:
--   1. A roaming savings calculator: "Roaming with [carrier] costs $X, our
--      eSIM costs $Y, you save $Z." Carrier roaming prices are an admin-managed
--      table  -> `roaming_prices`.
--   2. Verified reviews per country, requested after the trip.
--      -> `reviews` + a request-tracking table `review_requests`.
--   3. Network speed ratings shown on plan cards, admin-managed.
--      -> `network_speed_ratings`.
--   4. Toggleable exit-intent discount popup + review-request window setting.
--      -> `settings` keys.
--
-- The weekly purchase counter ("X people bought [Country] eSIMs this week")
-- does NOT need a new table: it reads `orders` + `order_items` created in
-- earlier phases. The service computes it from `orders.placed_at`/`paid_at`
-- and the per-item country code. If those columns don't exist yet, the counter
-- returns null and the UI hides the badge — it never fabricates a number.
--
-- COLUMN CONTRACTS (must match server/services/socialProof.ts)
-- ------------------------------------------------------------
--   roaming_prices(
--     id, country_code, carrier_key, carrier_label, currency,
--     price_per_day       NUMERIC,   -- per-day roaming price in `currency`
--     data_gb_per_day     NUMERIC,   -- GB included per day (nullable)
--     notes, active, sort_order, updated_at)
--
--   reviews(
--     id, country_code, order_id (nullable), user_id (nullable),
--     author_display, rating SMALLINT, body, verified BOOLEAN,
--     status ('pending'|'published'|'rejected'),
--     created_at, published_at)
--
--   review_requests(
--     id, order_id, esim_id (nullable), user_id (nullable),
--     country_code, scheduled_for DATE, sent_at TIMESTAMPTZ,
--     status ('pending'|'sent'|'skipped'),
--     UNIQUE(order_id, country_code))
--
--   network_speed_ratings(
--     id, country_code (nullable for regions), network_label,
--     median_mbps NUMERIC, rating SMALLINT (1..5), sampled_at, active)
--
-- All the routes read via `db.execute(sql\`…\`)` so this migration's column
-- names are the only contract that matters — it does not depend on the
-- Drizzle table definitions in server/db/schema.ts staying identical.
--
-- IDEMPOTENT. Safe to re-run. Guarded with IF NOT EXISTS / ADD COLUMN IF NOT
-- EXISTS / ON CONFLICT DO NOTHING so a partially applied prior run is fixable.

BEGIN;

-- ===========================================================================
-- roaming_prices — admin-managed carrier roaming table used by the savings
-- calculator. One row per (country, carrier) pricing tier. A NULL
-- data_gb_per_day means the carrier's plan is "unlimited-ish"; we still need
-- a price_per_day to compute savings against a fixed-GB eSIM.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS roaming_prices (
  id                serial PRIMARY KEY,
  country_code      varchar(8)    NOT NULL,                 -- ISO-3166 alpha-2 (lowercase)
  carrier_key       varchar(64)   NOT NULL,                 -- stable slug, e.g. 'singtel'
  carrier_label     varchar(120)  NOT NULL,                 -- display, e.g. 'Singtel'
  currency          varchar(3)    NOT NULL DEFAULT 'SGD',
  price_per_day     numeric(12,4) NOT NULL
                    CHECK (price_per_day >= 0),
  data_gb_per_day   numeric(6,2)
                    CHECK (data_gb_per_day IS NULL OR data_gb_per_day > 0),
  notes             text,
  active            boolean       NOT NULL DEFAULT TRUE,
  sort_order        integer       NOT NULL DEFAULT 100,
  created_at        timestamptz   NOT NULL DEFAULT now(),
  updated_at        timestamptz   NOT NULL DEFAULT now()
);

-- One price row per (country, carrier, currency). Admins edit in place.
CREATE UNIQUE INDEX IF NOT EXISTS roaming_prices_country_carrier_currency_uq
  ON roaming_prices (country_code, carrier_key, currency);

CREATE INDEX IF NOT EXISTS roaming_prices_country_active_idx
  ON roaming_prices (country_code, active)
  WHERE active = TRUE;

-- ===========================================================================
-- reviews — verified per-country reviews.
--
-- `verified` is set TRUE only when the review is linked to a paid order for
-- that country (the service's `markReviewVerified` path). Unverified reviews
-- (admin-imported) are allowed but never rendered as "verified". `status`
-- gates publication: the review-request email lands in 'pending' and the
-- customer's authoring flow moves it to 'published' after moderation.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS reviews (
  id              serial PRIMARY KEY,
  country_code    varchar(8)    NOT NULL,
  order_id        integer       REFERENCES orders(id) ON DELETE SET NULL,
  user_id         integer       REFERENCES users(id)  ON DELETE SET NULL,
  author_display  varchar(80)   NOT NULL DEFAULT 'Traveller',
  rating          smallint      NOT NULL CHECK (rating BETWEEN 1 AND 5),
  body            text          NOT NULL,
  verified        boolean       NOT NULL DEFAULT FALSE,
  status          varchar(16)   NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'published', 'rejected')),
  created_at      timestamptz   NOT NULL DEFAULT now(),
  published_at    timestamptz
);

-- At most one review per order (a group order that bought 3 countries can
-- review each country once, hence keying on order+country).
CREATE UNIQUE INDEX IF NOT EXISTS reviews_order_country_uq
  ON reviews (order_id, country_code)
  WHERE order_id IS NOT NULL;

-- Listing query: published reviews for a country, newest first.
CREATE INDEX IF NOT EXISTS reviews_country_published_idx
  ON reviews (country_code, published_at DESC)
  WHERE status = 'published';

-- Moderation queue.
CREATE INDEX IF NOT EXISTS reviews_pending_idx
  ON reviews (created_at DESC)
  WHERE status = 'pending';

-- ===========================================================================
-- review_requests — the post-trip request queue.
--
-- A row is created when an order is fulfilled with a known trip end-date (we
-- use the eSIM's expiry as the "you're probably back" moment when the
-- customer didn't tell us their return date). The `reviewRequest.job` (a later
-- batch) scans `WHERE status='pending' AND scheduled_for <= CURRENT_DATE`.
-- The unique (order_id, country_code) index makes job re-runs idempotent.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS review_requests (
  id              serial PRIMARY KEY,
  order_id        integer       NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  esim_id         integer       REFERENCES esims(id) ON DELETE SET NULL,
  user_id         integer       REFERENCES users(id)  ON DELETE SET NULL,
  country_code    varchar(8)    NOT NULL,
  scheduled_for   date          NOT NULL,
  sent_at         timestamptz,
  status          varchar(16)   NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'sent', 'skipped')),
  created_at      timestamptz   NOT NULL DEFAULT now(),
  updated_at      timestamptz   NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS review_requests_order_country_uq
  ON review_requests (order_id, country_code);

CREATE INDEX IF NOT EXISTS review_requests_due_idx
  ON review_requests (scheduled_for)
  WHERE status = 'pending';

-- ===========================================================================
-- network_speed_ratings — admin-managed speed data surfaced on plan cards.
--
-- A row may target a specific country (country_code set) or a region
-- (country_code NULL, e.g. "Europe"). The plan card reads by country first,
-- then falls back to region. `rating` is an admin's 1..5 summary because
-- median_mbps alone confuses travellers.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS network_speed_ratings (
  id              serial PRIMARY KEY,
  country_code    varchar(8),                            -- NULL = regional row
  network_label   varchar(120)  NOT NULL,                -- e.g. 'Singtel 5G'
  median_mbps     numeric(8,2)  CHECK (median_mbps IS NULL OR median_mbps >= 0),
  rating          smallint      NOT NULL CHECK (rating BETWEEN 1 AND 5),
  sampled_at      date,
  active          boolean       NOT NULL DEFAULT TRUE,
  notes           text,
  updated_at      timestamptz   NOT NULL DEFAULT now()
);

-- One rating row per (country, network). NULL country is treated as a distinct
-- scope: Postgres treats NULLs as distinct, so we add a partial unique index
-- for the regional rows specifically.
CREATE UNIQUE INDEX IF NOT EXISTS network_speed_ratings_country_uq
  ON network_speed_ratings (country_code, network_label)
  WHERE country_code IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS network_speed_ratings_region_uq
  ON network_speed_ratings (network_label)
  WHERE country_code IS NULL;

CREATE INDEX IF NOT EXISTS network_speed_ratings_country_active_idx
  ON network_speed_ratings (country_code, active)
  WHERE active = TRUE;

-- ===========================================================================
-- Settings — the toggleable exit-intent discount popup and the lead-time for
-- the review request after a trip. Documented here; the routes/jobs read them
-- via `settings` and default sensibly when the row is absent.
-- ===========================================================================
INSERT INTO settings (key, value)
VALUES
  ('conversion.exitPopupEnabled',      'true'::jsonb),
  ('conversion.exitPopupDiscountCode', '""'::jsonb),
  ('conversion.exitPopupPercent',      '5'::jsonb),
  ('reviews.requestDelayDays',         '3'::jsonb),
  ('reviews.minimumVisible',           '3'::jsonb),
  ('network.ratingSourceUpdatedAt',    'null'::jsonb)
ON CONFLICT (key) DO NOTHING;

COMMIT;

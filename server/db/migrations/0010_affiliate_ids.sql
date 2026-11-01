--
-- Affiliate IDs + "Complete your trip" links for the AI trip planner.
--
-- WHY THIS MIGRATION EXISTS
-- -------------------------
-- `server/routes/tripPlanner.ts` reads affiliate links from a table named
-- `trip_affiliate_links` (via `lookupAffiliateLinks`). That table does not
-- exist yet — the route fails-safe and returns `[]`, which hides the
-- "Complete your trip" section. This migration creates the table and the two
-- admin-editable stores the spec calls for:
--
--   1. `trip_affiliate_links`  — the resolved URL rows the planner emits,
--      one per slot (hotel | tour | transfer | insurance). Admins edit rows
--      here to change where "Complete your trip" points.
--
--   2. `affiliate_settings`    — the raw affiliate IDs per program
--      (booking.com, klook, getyourguide, safetywing, …) so the admin UI can
--      rebuild the resolved URLs when an ID changes without touching every
--      row. This is a simple key/value store scoped to the affiliate domain.
--
-- CONTRACT THAT MUST HOLD (route side)
-- ------------------------------------
-- The route executes:
--
--   db.select().from(tripAffiliateLinks)
--     .where(eq(tripAffiliateLinks.active, true))
--
-- and then maps rows to `{ slot, label, url }`, filtering `slot` against
-- `IN ('hotel','tour','transfer','insurance')` and dropping empty URLs.
-- So this table must expose columns with exactly those names:
--
--   id, slot, label, url, active
--
-- `url` is the fully-resolved, final click URL (including the affiliate ID
-- and any tracking parameters). Storing the resolved URL here — not a
-- template — means the route never has to concatenate strings, which is why
-- the earlier comment in `tripPlanner.ts` mentioned a "base_url + affiliate_id"
-- model: this migration replaces that model with pre-resolved URLs, which is
-- safer and matches the admin-editable "affiliate IDs" requirement.
--
-- IDEMPOTENT: `CREATE TABLE IF NOT EXISTS` + `ON CONFLICT DO NOTHING` on
-- seed rows, so re-running is harmless. No DEFAULT rows carry real affiliate
-- IDs — see the SEED section below.
--
-- The presence of a seed row with `active = FALSE` is intentional: the admin
-- UI can toggle visibility per slot without having to pre-create rows for
-- every slot up-front.

BEGIN;

-- ---------------------------------------------------------------------------
-- trip_affiliate_links — the rows the planner streams in the `affiliates` event.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS trip_affiliate_links (
  id          serial PRIMARY KEY,

  -- Slot must be one of the four supported slots. A CHECK constraint keeps
  -- the route's filter honest even if an admin tries to insert via psql.
  slot        varchar(16) NOT NULL
              CHECK (slot IN ('hotel', 'tour', 'transfer', 'insurance')),

  -- Short, human label, e.g. "Hotels", "Tours & tickets", "Airport transfer",
  -- "Travel insurance". The route passes this through verbatim.
  label       varchar(80) NOT NULL,

  -- Fully-resolved, absolute click URL. Must start with http(s) so a bad
  -- admin row can't smuggle a `javascript:` URL into a <a href>. The route
  -- also filters non-http(s) URLs client-safely, but we enforce at rest too.
  url         text NOT NULL CHECK (url ~* '^https?://'),

  -- Whether the row is live. Route filters on `active = TRUE`.
  active      boolean NOT NULL DEFAULT TRUE,

  -- Free-form note for admins ("booked via Klook sg-lite"). Never shown
  -- publicly.
  note        text,

  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Fast lookup by the route predicate. Partial: only live rows are ever read.
CREATE INDEX IF NOT EXISTS trip_affiliate_links_active_idx
  ON trip_affiliate_links (active)
  WHERE active = TRUE;

-- Sort order for the panel: cheapest/most-useful partner first, etc. Kept as
-- a separate column so admins can reorder without touching the row order.
ALTER TABLE trip_affiliate_links
  ADD COLUMN IF NOT EXISTS sort_order integer NOT NULL DEFAULT 100;

CREATE INDEX IF NOT EXISTS trip_affiliate_links_sort_idx
  ON trip_affiliate_links (sort_order)
  WHERE active = TRUE;

-- ---------------------------------------------------------------------------
-- affiliate_settings — the raw affiliate IDs, one row per program.
--
-- Kept in its own table so:
--   - the admin UI can list "which programs do we have IDs for?",
--   - revoking a program (delete the ID, keep the row) doesn't break the
--     planner,
--   - rotating an ID updates one place, and the admin UI can optionally
--     rewrite resolved `trip_affiliate_links.url` rows from it.
--
-- The route does NOT read this table (it reads resolved URLs from
-- trip_affiliate_links), so a missing row here only affects admin tooling,
-- not the planner.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS affiliate_settings (
  id          serial PRIMARY KEY,

  -- Program key, e.g. 'booking', 'klook', 'getyourguide', 'safetywing'.
  -- Unique so ON CONFLICT upserts work.
  program     varchar(64) NOT NULL UNIQUE,

  -- Affiliate / tracking ID as provided by the program. Empty string means
  -- "we don't have an ID for this program yet" (distinct from NULL which we
  -- disallow so admin queries can't hide rows behind a null check).
  affiliate_id text NOT NULL DEFAULT '' CHECK (length(affiliate_id) <= 200),

  -- Optional human note.
  note        text,

  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- SEED — inactive placeholder rows.
--
-- We only seed *inactive* rows so the schema demonstrates the shape without
-- pretending we have a live affiliate. Admins flip `active` and set `url`
-- once real affiliate IDs are in Replit Secrets and confirmed with each
-- network. The route's `lookupAffiliateLinks` returns [] until a row is
-- active, and CompleteYourTrip renders nothing when the list is empty — so
-- this seed is safe on first deploy.
--
-- ON CONFLICT we use a stable unique key on (slot, label) — added below —
-- so re-running never duplicates seed rows.
-- ---------------------------------------------------------------------------

-- Add the unique key used by the seed upsert. Slot alone is not unique
-- (we may want two hotel partners later), so pair it with label.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'trip_affiliate_links_slot_label_uq'
  ) THEN
    ALTER TABLE trip_affiliate_links
      ADD CONSTRAINT trip_affiliate_links_slot_label_uq UNIQUE (slot, label);
  END IF;
END $$;

INSERT INTO trip_affiliate_links (slot, label, url, active, sort_order, note)
VALUES
  ('hotel',    'Hotels',              'https://example.invalid/hotels',    FALSE, 10,  'Set affiliate ID, then flip active'),
  ('tour',     'Tours & tickets',     'https://example.invalid/tours',     FALSE, 20,  'Set affiliate ID, then flip active'),
  ('transfer', 'Airport transfer',    'https://example.invalid/transfer',  FALSE, 30,  'Set affiliate ID, then flip active'),
  ('insurance','Travel insurance',    'https://example.invalid/insurance', FALSE, 40,  'Set affiliate ID, then flip active')
ON CONFLICT ON CONSTRAINT trip_affiliate_links_slot_label_uq DO NOTHING;

-- ---------------------------------------------------------------------------
-- Updated-at trigger (small and dependency-free so migrations don't require
-- a custom extension in Replit's managed Postgres).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trip_affiliate_touch_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trip_affiliate_links_touch_updated_at
  ON trip_affiliate_links;
CREATE TRIGGER trip_affiliate_links_touch_updated_at
  BEFORE UPDATE ON trip_affiliate_links
  FOR EACH ROW
  EXECUTE FUNCTION trip_affiliate_touch_updated_at();

DROP TRIGGER IF EXISTS affiliate_settings_touch_updated_at
  ON affiliate_settings;
CREATE TRIGGER affiliate_settings_touch_updated_at
  BEFORE UPDATE ON affiliate_settings
  FOR EACH ROW
  EXECUTE FUNCTION trip_affiliate_touch_updated_at();

COMMIT;

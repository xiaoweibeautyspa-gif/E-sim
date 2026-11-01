--
-- Growth + retention phase: referrals, Traveler Pass memberships, gift cards,
-- discount codes. Also closes the contracts that the already-saved services
-- (server/services/referrals.ts, membership.ts, giftCards.ts) expect.
--
-- WHY THIS MIGRATION EXISTS
-- -------------------------
-- The three saved services were written to injected DB adapters whose column
-- contracts were never materialised. This migration creates those tables and
-- the two new ones the discount-code service needs:
--
--   referrals                 — pending → qualified → paid credit lifecycle
--   memberships               — Traveler Pass subscription state (one row / user)
--   gift_cards                — fixed-value cards with a balance
--   discount_codes            — percent or fixed codes, usage-limited
--   discount_reservations     — one row per reserve() so we can release
--
-- The routes in server/routes/growth.ts build the adapters that run against
-- these tables via SQL. Column names below are the contract the route's SQL
-- assumes: id, public_id, *_user_id, *_minor, currency, expires_at, etc.
--
-- IDEMPOTENT: every CREATE uses IF NOT EXISTS; ADD COLUMN uses IF NOT EXISTS.
-- Run after 0013_reviews_roaming_speed.sql.

BEGIN;

-- ===========================================================================
-- referrals
--
-- Lifecycle:
--   pending   — friend registered with the referrer's code, hasn't bought yet.
--               The friend's $3 off is applied by checkout while in pending.
--   qualified — friend bought; referrer's $3 credit is owed.
--   paid      — referrer's credit actually landed (Stripe balance credit).
--   rejected  — admin disqualified (fraud, self-referral caught post-hoc).
--
-- Unique on referred_user_id: a friend can only ever be referred once, ever.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS referrals (
  id                    serial PRIMARY KEY,
  public_id             varchar(80)  NOT NULL,

  referrer_user_id      integer      NOT NULL,
  referred_user_id      integer      NOT NULL,

  friend_discount_minor integer      NOT NULL DEFAULT 0
                        CHECK (friend_discount_minor >= 0),
  referrer_credit_minor integer      NOT NULL DEFAULT 0
                        CHECK (referrer_credit_minor >= 0),
  currency              varchar(3)   NOT NULL DEFAULT 'SGD',

  status                varchar(16)  NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'qualified', 'paid', 'rejected')),

  qualified_at          timestamptz,
  qualified_order       varchar(80),
  paid_at               timestamptz,
  stripe_credit_ref     varchar(128),

  created_at            timestamptz  NOT NULL DEFAULT now(),
  updated_at            timestamptz  NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS referrals_public_id_uq
  ON referrals (public_id);
CREATE UNIQUE INDEX IF NOT EXISTS referrals_referred_user_uq
  ON referrals (referred_user_id);
CREATE INDEX IF NOT EXISTS referrals_referrer_status_idx
  ON referrals (referrer_user_id, status);
CREATE INDEX IF NOT EXISTS referrals_status_idx
  ON referrals (status)
  WHERE status <> 'paid';

-- Soft FK comment: we do NOT FK to users(id) because users.id is managed by
-- 0003 and may be restructured; the app relies on user ids being stable.

-- Touch updated_at.
CREATE OR REPLACE FUNCTION referrals_touch_updated_at()
RETURNS trigger AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS referrals_touch_updated_at ON referrals;
CREATE TRIGGER referrals_touch_updated_at
  BEFORE UPDATE ON referrals
  FOR EACH ROW EXECUTE FUNCTION referrals_touch_updated_at();

-- ===========================================================================
-- memberships (Traveler Pass).
--
-- One row per user. `status` mirrors the Stripe subscription status we care
-- about. `current_period_end` is the moment the discount stops applying if
-- the user doesn't renew; computeMemberDiscount() checks the end date.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS memberships (
  id                     serial PRIMARY KEY,
  user_id                integer      NOT NULL,
  status                 varchar(16)  NOT NULL DEFAULT 'incomplete'
                         CHECK (status IN ('active', 'past_due', 'canceled', 'incomplete')),
  stripe_subscription_id varchar(128),
  stripe_customer_id     varchar(128),
  price_minor            integer      NOT NULL DEFAULT 0
                         CHECK (price_minor >= 0),
  currency               varchar(3)   NOT NULL DEFAULT 'SGD',
  started_at             timestamptz,
  current_period_end     timestamptz,
  canceled_at            timestamptz,
  created_at             timestamptz  NOT NULL DEFAULT now(),
  updated_at             timestamptz  NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS memberships_user_id_uq
  ON memberships (user_id);
CREATE INDEX IF NOT EXISTS memberships_status_idx
  ON memberships (status);
CREATE INDEX IF NOT EXISTS memberships_subscription_idx
  ON memberships (stripe_subscription_id)
  WHERE stripe_subscription_id IS NOT NULL;

CREATE OR REPLACE FUNCTION memberships_touch_updated_at()
RETURNS trigger AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS memberships_touch_updated_at ON memberships;
CREATE TRIGGER memberships_touch_updated_at
  BEFORE UPDATE ON memberships
  FOR EACH ROW EXECUTE FUNCTION memberships_touch_updated_at();

-- ===========================================================================
-- gift_cards
--
-- `code` is the FLAT form (no dashes), uppercase. The service normalises
-- whatever the buyer types to this form before lookup. Balance is in minor
-- units keyed by currency (VND: dong, others: cents).
-- ===========================================================================
CREATE TABLE IF NOT EXISTS gift_cards (
  id                 serial PRIMARY KEY,
  code               varchar(40)  NOT NULL,
  currency           varchar(3)   NOT NULL,
  original_minor     integer      NOT NULL CHECK (original_minor > 0),
  balance_minor      integer      NOT NULL CHECK (balance_minor >= 0 AND balance_minor <= original_minor),
  expires_at         timestamptz,
  created_by_user_id integer      NOT NULL,
  created_at         timestamptz  NOT NULL DEFAULT now(),
  updated_at         timestamptz  NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS gift_cards_code_uq
  ON gift_cards (code);
CREATE INDEX IF NOT EXISTS gift_cards_currency_balance_idx
  ON gift_cards (currency)
  WHERE balance_minor > 0;

CREATE OR REPLACE FUNCTION gift_cards_touch_updated_at()
RETURNS trigger AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS gift_cards_touch_updated_at ON gift_cards;
CREATE TRIGGER gift_cards_touch_updated_at
  BEFORE UPDATE ON gift_cards
  FOR EACH ROW EXECUTE FUNCTION gift_cards_touch_updated_at();

-- ===========================================================================
-- discount_codes
--
-- `kind` is 'percent' or 'fixed'. Exactly one of (`percent`) or
-- (`fixed_minor`, `currency`) is non-null — enforced by CHECK. `code` is the
-- FLAT form for matching normaliseDiscountCode() (upper, no dashes).
-- ===========================================================================
CREATE TABLE IF NOT EXISTS discount_codes (
  id                 serial PRIMARY KEY,
  code               varchar(64)  NOT NULL,
  label              varchar(120) NOT NULL,
  kind               varchar(8)   NOT NULL CHECK (kind IN ('percent', 'fixed')),

  percent            integer      CHECK (percent IS NULL OR (percent BETWEEN 1 AND 99)),
  fixed_minor        integer      CHECK (fixed_minor IS NULL OR fixed_minor > 0),
  currency           varchar(3),

  expires_at         timestamptz,
  starts_at          timestamptz,
  usage_limit        integer      CHECK (usage_limit IS NULL OR usage_limit > 0),
  used_count         integer      NOT NULL DEFAULT 0 CHECK (used_count >= 0),

  country_code       varchar(2),

  active             boolean      NOT NULL DEFAULT TRUE,

  created_by_user_id integer      NOT NULL,
  created_at         timestamptz  NOT NULL DEFAULT now(),
  updated_at         timestamptz  NOT NULL DEFAULT now(),

  -- Exactly one discount shape:
  CONSTRAINT discount_codes_kind_ck CHECK (
    (kind = 'percent' AND percent IS NOT NULL AND fixed_minor IS NULL AND currency IS NULL)
    OR
    (kind = 'fixed'   AND percent IS NULL AND fixed_minor IS NOT NULL AND currency IS NOT NULL)
  ),

  -- used_count cannot exceed its usage_limit (unless limit is NULL).
  CONSTRAINT discount_codes_used_ck CHECK (
    usage_limit IS NULL OR used_count <= usage_limit
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS discount_codes_code_uq
  ON discount_codes (code);
CREATE INDEX IF NOT EXISTS discount_codes_active_expiry_idx
  ON discount_codes (active, expires_at)
  WHERE active = TRUE;
CREATE INDEX IF NOT EXISTS discount_codes_country_active_idx
  ON discount_codes (country_code, active)
  WHERE active = TRUE AND country_code IS NOT NULL;

CREATE OR REPLACE FUNCTION discount_codes_touch_updated_at()
RETURNS trigger AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS discount_codes_touch_updated_at ON discount_codes;
CREATE TRIGGER discount_codes_touch_updated_at
  BEFORE UPDATE ON discount_codes
  FOR EACH ROW EXECUTE FUNCTION discount_codes_touch_updated_at();

-- ===========================================================================
-- discount_reservations
--
-- One row per `reserveDiscountCode()` call. Status:
--   pending   — reserve succeeded, waiting for payment confirmation.
--   committed — payment succeeded; code is burned.
--   (released by DELETE, which also decrements `discount_codes.used_count`.)
--
-- The atomicallyReserve() SQL in server/routes/growth.ts increments
-- discount_codes.used_count and inserts this row in one CTE. A unique
-- constraint on public_id keeps the operation idempotent.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS discount_reservations (
  id             serial PRIMARY KEY,
  public_id      varchar(80)   NOT NULL,
  flat_code      varchar(64)   NOT NULL,
  order_ref      varchar(80)   NOT NULL,
  discount_minor integer       NOT NULL CHECK (discount_minor > 0),
  currency       varchar(3)    NOT NULL,
  status         varchar(16)   NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'committed', 'expired')),
  created_at     timestamptz   NOT NULL DEFAULT now(),
  committed_at   timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS discount_reservations_public_id_uq
  ON discount_reservations (public_id);
CREATE INDEX IF NOT EXISTS discount_reservations_order_ref_idx
  ON discount_reservations (order_ref);
CREATE INDEX IF NOT EXISTS discount_reservations_pending_idx
  ON discount_reservations (created_at DESC)
  WHERE status = 'pending';

-- ===========================================================================
-- Settings defaults the admin panel reads (documented here so they exist on
-- first boot). Referral amounts mirror `REFERRAL_FRIEND_DISCOUNT_MAJOR` /
-- `REFERRAL_REFERRER_CREDIT_MAJOR` in server/services/referrals.ts; changing
-- them here does NOT change the constants — the admin form should edit both.
-- ===========================================================================
INSERT INTO settings (key, value)
VALUES
  ('growth.referralFriendDiscountMajor', '"3"'::jsonb),
  ('growth.referralReferrerCreditMajor', '"3"'::jsonb),
  ('growth.membershipPriceMajor',        '"29"'::jsonb),
  ('growth.membershipPriceCurrency',     '"SGD"'::jsonb),
  ('growth.membershipDiscountPercent',   '"10"'::jsonb)
ON CONFLICT (key) DO NOTHING;

COMMIT;

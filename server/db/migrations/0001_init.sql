-- Initial schema for the eSIM retail platform.
-- Mirrors server/db/schema.ts. Apply with: psql "$DATABASE_URL" -f server/db/migrations/0001_init.sql
-- All statements are idempotent-safe (IF NOT EXISTS) so re-running is harmless.

BEGIN;

-- ---------------------------------------------------------------------------
-- Users & sessions
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id                       SERIAL PRIMARY KEY,
  email                    VARCHAR(320) NOT NULL,
  password_hash            TEXT,
  google_id                VARCHAR(128),
  name                     VARCHAR(200),
  locale                   VARCHAR(8)   NOT NULL DEFAULT 'en',
  is_admin                 BOOLEAN      NOT NULL DEFAULT FALSE,
  membership_status        VARCHAR(32)  NOT NULL DEFAULT 'none',
  membership_expires_at    TIMESTAMPTZ,
  stripe_customer_id       VARCHAR(128),
  credit_balance           NUMERIC(12,4) NOT NULL DEFAULT 0,
  preferred_currency       VARCHAR(3)   NOT NULL DEFAULT 'SGD',
  created_at               TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS users_email_uq
  ON users (email);
CREATE INDEX IF NOT EXISTS users_google_id_idx
  ON users (google_id);

CREATE TABLE IF NOT EXISTS sessions (
  id          VARCHAR(64) PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id);

-- ---------------------------------------------------------------------------
-- Catalog
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS packages (
  id                       SERIAL PRIMARY KEY,
  code                     VARCHAR(128) NOT NULL,
  name                     VARCHAR(200) NOT NULL,
  countries                TEXT         NOT NULL DEFAULT '',
  country_slug             VARCHAR(64),
  region                   VARCHAR(64),
  data_gb                  NUMERIC(10,2),
  duration_days            INTEGER,
  is_daily_plan            BOOLEAN      NOT NULL DEFAULT FALSE,
  wholesale_price_usd      NUMERIC(12,4) NOT NULL DEFAULT 0,
  support_top_up_type      INTEGER      NOT NULL DEFAULT 0,
  operator_names           TEXT         NOT NULL DEFAULT '',
  package_type             VARCHAR(16)  NOT NULL DEFAULT 'PACKAGE',
  active                   BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at               TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS packages_code_uq ON packages (code);
CREATE INDEX IF NOT EXISTS packages_country_idx   ON packages (country_slug);
CREATE INDEX IF NOT EXISTS packages_region_idx    ON packages (region);

CREATE TABLE IF NOT EXISTS price_overrides (
  id              SERIAL PRIMARY KEY,
  scope           VARCHAR(16)  NOT NULL,
  target          VARCHAR(128) NOT NULL,
  markup_percent  NUMERIC(6,2) NOT NULL,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS price_overrides_scope_target_uq
  ON price_overrides (scope, target);

-- ---------------------------------------------------------------------------
-- Orders
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS orders (
  id                         SERIAL PRIMARY KEY,
  public_id                  VARCHAR(32)  NOT NULL,
  user_id                    INTEGER REFERENCES users (id) ON DELETE SET NULL,
  guest_email                VARCHAR(320),
  buyer_name                 VARCHAR(200),
  currency                   VARCHAR(3)   NOT NULL DEFAULT 'SGD',
  retail_total               NUMERIC(12,4) NOT NULL DEFAULT 0,
  wholesale_total_usd        NUMERIC(12,4) NOT NULL DEFAULT 0,
  profit_usd                 NUMERIC(12,4) NOT NULL DEFAULT 0,
  status                     VARCHAR(32)  NOT NULL DEFAULT 'pending',
  stripe_session_id          VARCHAR(128),
  stripe_payment_intent_id   VARCHAR(128),
  supplier_transaction_id    VARCHAR(64),
  quantity                   INTEGER      NOT NULL DEFAULT 1,
  is_gift                    BOOLEAN      NOT NULL DEFAULT FALSE,
  recipient_name             VARCHAR(200),
  recipient_email            VARCHAR(320),
  gift_message               TEXT,
  send_date                  TIMESTAMPTZ,
  applied_codes              TEXT         NOT NULL DEFAULT '',
  referral_code              VARCHAR(64),
  affiliate_code             VARCHAR(64),
  partner_code               VARCHAR(64),
  low_balance_flag           BOOLEAN      NOT NULL DEFAULT FALSE,
  failure_reason             TEXT,
  placed_at                  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  paid_at                    TIMESTAMPTZ,
  created_at                 TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at                 TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS orders_public_id_uq
  ON orders (public_id);
CREATE INDEX IF NOT EXISTS orders_user_idx ON orders (user_id);
CREATE INDEX IF NOT EXISTS orders_status_idx ON orders (status);
CREATE INDEX IF NOT EXISTS orders_stripe_session_idx ON orders (stripe_session_id);

CREATE TABLE IF NOT EXISTS order_items (
  id                       SERIAL PRIMARY KEY,
  order_id                 INTEGER NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  package_id               INTEGER NOT NULL REFERENCES packages (id) ON DELETE RESTRICT,
  package_code_snapshot    VARCHAR(128) NOT NULL,
  package_name_snapshot    VARCHAR(200) NOT NULL,
  unit_price               NUMERIC(12,4) NOT NULL,
  unit_wholesale_usd       NUMERIC(12,4) NOT NULL,
  quantity                 INTEGER       NOT NULL DEFAULT 1,
  created_at               TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS order_items_order_idx ON order_items (order_id);

-- ---------------------------------------------------------------------------
-- eSIMs
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS esims (
  id                    SERIAL PRIMARY KEY,
  order_id              INTEGER NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  order_item_id         INTEGER REFERENCES order_items (id) ON DELETE SET NULL,
  package_id            INTEGER NOT NULL REFERENCES packages (id) ON DELETE RESTRICT,
  install_token         VARCHAR(64) NOT NULL,
  iccid                 VARCHAR(40),
  esim_tran_no          VARCHAR(64),
  imsi                  VARCHAR(40),
  lpa_code              TEXT,
  qr_code_url           TEXT,
  status                VARCHAR(32) NOT NULL DEFAULT 'pending',
  support_top_up_type   INTEGER     NOT NULL DEFAULT 0,
  total_bytes           NUMERIC(20,0),
  used_bytes            NUMERIC(20,0) NOT NULL DEFAULT 0,
  expires_at            TIMESTAMPTZ,
  usage_updated_at      TIMESTAMPTZ,
  installed_at          TIMESTAMPTZ,
  gift_delivered_at     TIMESTAMPTZ,
  refund_status         VARCHAR(32) NOT NULL DEFAULT 'none',
  refund_review_note    TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS esims_install_token_uq ON esims (install_token);
CREATE INDEX IF NOT EXISTS esims_order_idx         ON esims (order_id);
CREATE INDEX IF NOT EXISTS esims_iccid_idx         ON esims (iccid);
CREATE INDEX IF NOT EXISTS esims_esim_tran_no_idx  ON esims (esim_tran_no);

-- ---------------------------------------------------------------------------
-- Webhook events & supplier audit
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS webhook_events (
  id                SERIAL PRIMARY KEY,
  source            VARCHAR(32) NOT NULL,
  notify_id         VARCHAR(128),
  notify_type       VARCHAR(64),
  payload           JSONB       NOT NULL,
  processed_at      TIMESTAMPTZ,
  processing_error  TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS webhook_events_notify_uq
  ON webhook_events (source, notify_id);
CREATE INDEX IF NOT EXISTS webhook_events_source_idx
  ON webhook_events (source);

CREATE TABLE IF NOT EXISTS supplier_balance_snapshots (
  id           SERIAL PRIMARY KEY,
  balance_usd  NUMERIC(12,4) NOT NULL,
  created_at   TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- Reviews, speed ratings, phone models, roaming prices
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reviews (
  id            SERIAL PRIMARY KEY,
  user_id       INTEGER REFERENCES users (id) ON DELETE SET NULL,
  country_slug  VARCHAR(64),
  rating        INTEGER NOT NULL,
  body          TEXT,
  author_name   VARCHAR(120),
  verified      BOOLEAN NOT NULL DEFAULT FALSE,
  published     BOOLEAN NOT NULL DEFAULT FALSE,
  order_id      INTEGER REFERENCES orders (id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS reviews_country_idx ON reviews (country_slug);

CREATE TABLE IF NOT EXISTS speed_ratings (
  id             SERIAL PRIMARY KEY,
  country_slug   VARCHAR(64)  NOT NULL,
  operator_name  VARCHAR(120) NOT NULL,
  network_type   VARCHAR(16),
  score          INTEGER      NOT NULL DEFAULT 3,
  notes          TEXT,
  updated_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS speed_ratings_country_op_uq
  ON speed_ratings (country_slug, operator_name);

CREATE TABLE IF NOT EXISTS phone_models (
  id            SERIAL PRIMARY KEY,
  brand         VARCHAR(64)  NOT NULL,
  model         VARCHAR(120) NOT NULL,
  esim_capable  BOOLEAN      NOT NULL DEFAULT TRUE,
  notes         TEXT,
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS phone_models_brand_model_uq
  ON phone_models (brand, model);
CREATE INDEX IF NOT EXISTS phone_models_brand_idx ON phone_models (brand);

CREATE TABLE IF NOT EXISTS roaming_prices (
  id            SERIAL PRIMARY KEY,
  carrier       VARCHAR(120) NOT NULL,
  country_slug  VARCHAR(64),
  price_model   VARCHAR(16)  NOT NULL DEFAULT 'per_mb_usd',
  price_value   NUMERIC(12,4) NOT NULL,
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- Settings (admin-managed key/value)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS settings (
  key         VARCHAR(64) PRIMARY KEY,
  value       JSONB NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMIT;

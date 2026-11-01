import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";

/**
 * Drizzle schema for the whole platform.
 *
 * Conventions:
 * - All money stored as `numeric(12,4)` (USD by default; currency column on
 *   orders names the currency the buyer paid in). Retail/wholesale values are
 *   produced by the pricing engine; supplier wholesale is API value / 10000.
 * - All byte sizes are `bigint` (Postgres) represented here as `numeric(20,0)`
 *   because JS numbers are lossy above 2^53 for raw byte counts.
 * - Timestamps are timezone-aware and default to now().
 * - Every supplier/webhook/order interaction gets an audit trail (webhook_events)
 *   so failures are debuggable from the admin dashboard.
 * - Fields the API doesn't populate yet are nullable; do not invent values.
 */

// ---------------------------------------------------------------------------
// Users & auth
// ---------------------------------------------------------------------------
export const users = pgTable(
  "users",
  {
    id: serial("id").primaryKey(),
    email: varchar("email", { length: 320 }).notNull(),
    /** bcrypt/argon hash; null for OAuth-only accounts until a password is set. */
    passwordHash: text("password_hash"),
    googleId: varchar("google_id", { length: 128 }),
    name: varchar("name", { length: 200 }),
    locale: varchar("locale", { length: 8 }).notNull().default("en"),
    /** Admin flag gates admin dashboard access. */
    isAdmin: boolean("is_admin").notNull().default(false),
    /** Traveller Pass membership. */
    membershipStatus: varchar("membership_status", { length: 32 })
      .notNull()
      .default("none"), // none | active | cancelled | past_due
    membershipExpiresAt: timestamp("membership_expires_at", { withTimezone: true }),
    stripeCustomerId: varchar("stripe_customer_id", { length: 128 }),
    /** $ credit earned from referrals / gift-card balance at checkout. */
    creditBalance: numeric("credit_balance", { precision: 12, scale: 4 })
      .notNull()
      .default("0"),
    /** Preferred currency for display; pay currency on order is separate. */
    preferredCurrency: varchar("preferred_currency", { length: 3 })
      .notNull()
      .default("SGD"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    emailIdx: uniqueIndex("users_email_uq").on(t.email),
    googleIdIdx: index("users_google_id_idx").on(t.googleId),
  }),
);

// Session store (opaque token in an HttpOnly cookie).
export const sessions = pgTable(
  "sessions",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userIdx: index("sessions_user_idx").on(t.userId),
  }),
);

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------
export const packages = pgTable(
  "packages",
  {
    id: serial("id").primaryKey(),
    /** Supplier package code (from /package/list). Stable across syncs. */
    code: varchar("code", { length: 128 }).notNull(),
    name: varchar("name", { length: 200 }).notNull(),
    /** ISO country codes (may be multiple for regional plans). Comma-separated. */
    countries: text("countries").notNull().default(""),
    /** Single slug for a country-only plan; null for regional/global. */
    countrySlug: varchar("country_slug", { length: 64 }),
    region: varchar("region", { length: 64 }),
    /** GB total. Null for unlimited/daily plans. */
    dataGb: numeric("data_gb", { precision: 10, scale: 2 }),
    /** Days validity. */
    durationDays: integer("duration_days"),
    /** True for per-day daily-unlimited style plans. */
    isDailyPlan: boolean("is_daily_plan").notNull().default(false),
    /** Raw supplier price in USD (API value / 10000). */
    wholesalePriceUsd: numeric("wholesale_price_usd", { precision: 12, scale: 4 })
      .notNull()
      .default("0"),
    /** supportTopUpType from supplier (2 == top-up allowed). */
    supportTopUpType: integer("support_top_up_type").notNull().default(0),
    /** Operator / network names for "Runs on X 5G" copy. */
    operatorNames: text("operator_names").notNull().default(""),
    /** Supplier slug: package/list type (PACKAGE | TOPUP). */
    packageType: varchar("package_type", { length: 16 }).notNull().default("PACKAGE"),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    codeUq: uniqueIndex("packages_code_uq").on(t.code),
    countryIdx: index("packages_country_idx").on(t.countrySlug),
    regionIdx: index("packages_region_idx").on(t.region),
  }),
);

/** Per-country / per-package markup overrides for the pricing engine. */
export const priceOverrides = pgTable(
  "price_overrides",
  {
    id: serial("id").primaryKey(),
    scope: varchar("scope", { length: 16 }).notNull(), // "country" | "package"
    target: varchar("target", { length: 128 }).notNull(), // slug or package code
    markupPercent: numeric("markup_percent", { precision: 6, scale: 2 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    scopeTargetUq: uniqueIndex("price_overrides_scope_target_uq").on(t.scope, t.target),
  }),
);

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------
export const orders = pgTable(
  "orders",
  {
    id: serial("id").primaryKey(),
    /** Human/URL-safe public id used in emails, admin, and as supplier transactionId. */
    publicId: varchar("public_id", { length: 32 }).notNull(),
    userId: integer("user_id").references(() => users.id, { onDelete: "set null" }),
    /** Guest checkout keeps a contact email without a user row. */
    guestEmail: varchar("guest_email", { length: 320 }),
    buyerName: varchar("buyer_name", { length: 200 }),
    currency: varchar("currency", { length: 3 }).notNull().default("SGD"),
    /** Amount charged to the buyer (after discounts/credits). */
    retailTotal: numeric("retail_total", { precision: 12, scale: 4 }).notNull().default("0"),
    /** Sum of wholesale (supplier cost) across the order's eSIMs. */
    wholesaleTotalUsd: numeric("wholesale_total_usd", { precision: 12, scale: 4 })
      .notNull()
      .default("0"),
    /** retailTotal_usd - wholesaleTotal_usd. */
    profitUsd: numeric("profit_usd", { precision: 12, scale: 4 }).notNull().default("0"),
    status: varchar("status", { length: 32 }).notNull().default("pending"),
    // pending | paid | fulfilling | fulfilled | processing | failed | refunded | cancelled
    stripeSessionId: varchar("stripe_session_id", { length: 128 }),
    stripePaymentIntentId: varchar("stripe_payment_intent_id", { length: 128 }),
    /** Supplier-side transactionId = our publicId. Ensures idempotency. */
    supplierTransactionId: varchar("supplier_transaction_id", { length: 64 }),
    /** Group orders: count of eSIMs. Each eSIM has its own row. */
    quantity: integer("quantity").notNull().default(1),
    /** True when this order is a gift. */
    isGift: boolean("is_gift").notNull().default(false),
    recipientName: varchar("recipient_name", { length: 200 }),
    recipientEmail: varchar("recipient_email", { length: 320 }),
    giftMessage: text("gift_message"),
    /** Optional ISO date on which to send the gift email. */
    sendDate: timestamp("send_date", { withTimezone: true }),
    /** Applied discount / gift-card codes (comma-separated). */
    appliedCodes: text("applied_codes").notNull().default(""),
    /** Referral code used on this order. */
    referralCode: varchar("referral_code", { length: 64 }),
    /** Attribution cookie tracked on affiliate/partner links. */
    affiliateCode: varchar("affiliate_code", { length: 64 }),
    partnerCode: varchar("partner_code", { length: 64 }),
    /** Set when supplier balance is too low and we can't fulfil. Admin-flagged. */
    lowBalanceFlag: boolean("low_balance_flag").notNull().default(false),
    failureReason: text("failure_reason"),
    placedAt: timestamp("placed_at", { withTimezone: true }).notNull().defaultNow(),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    publicIdUq: uniqueIndex("orders_public_id_uq").on(t.publicId),
    userIdx: index("orders_user_idx").on(t.userId),
    statusIdx: index("orders_status_idx").on(t.status),
    stripeSessionIdx: index("orders_stripe_session_idx").on(t.stripeSessionId),
  }),
);

/** Per-item line in an order. One row per eSIM purchased. */
export const orderItems = pgTable(
  "order_items",
  {
    id: serial("id").primaryKey(),
    orderId: integer("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    packageId: integer("package_id")
      .notNull()
      .references(() => packages.id, { onDelete: "restrict" }),
    /** Snapshot of package at time of purchase (price may change later). */
    packageCodeSnapshot: varchar("package_code_snapshot", { length: 128 }).notNull(),
    packageNameSnapshot: varchar("package_name_snapshot", { length: 200 }).notNull(),
    /** Retail price per unit in the order currency. */
    unitPrice: numeric("unit_price", { precision: 12, scale: 4 }).notNull(),
    /** Wholesale cost per unit in USD. */
    unitWholesaleUsd: numeric("unit_wholesale_usd", { precision: 12, scale: 4 }).notNull(),
    quantity: integer("quantity").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    orderIdx: index("order_items_order_idx").on(t.orderId),
  }),
);

// ---------------------------------------------------------------------------
// eSIMs
// ---------------------------------------------------------------------------
export const esims = pgTable(
  "esims",
  {
    id: serial("id").primaryKey(),
    orderId: integer("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    orderItemId: integer("order_item_id").references(() => orderItems.id, {
      onDelete: "set null",
    }),
    packageId: integer("package_id")
      .notNull()
      .references(() => packages.id, { onDelete: "restrict" }),
    /** Our stable id used in shareable install URLs. */
    installToken: varchar("install_token", { length: 64 }).notNull(),
    iccid: varchar("iccid", { length: 40 }),
    /** Supplier id used for top-ups (not ICCID). */
    esimTranNo: varchar("esim_tran_no", { length: 64 }),
    imsi: varchar("imsi", { length: 40 }),
    /** Manual LPA code (re-viewable). */
    lpaCode: text("lpa_code"),
    /** QR URL from supplier (re-viewable). */
    qrCodeUrl: text("qr_code_url"),
    status: varchar("status", { length: 32 }).notNull().default("pending"),
    // pending | ordered | released | got_resource | installed | in_use | expired | refunded | cancelled
    /** Supplier supportTopUpType snapshot; only 2 enables top-up. */
    supportTopUpType: integer("support_top_up_type").notNull().default(0),
    /** Total data quota in bytes (as aggregated by supplier). */
    totalBytes: numeric("total_bytes", { precision: 20, scale: 0 }),
    usedBytes: numeric("used_bytes", { precision: 20, scale: 0 }).notNull().default("0"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    /** When the usage poller last updated this row. */
    usageUpdatedAt: timestamp("usage_updated_at", { withTimezone: true }),
    /** When the supplier last fired ESIM_STATUS for this eSIM (installed/in-use). */
    installedAt: timestamp("installed_at", { withTimezone: true }),
    /** Gift recipient notified flag (only relevant for gift orders). */
    giftDeliveredAt: timestamp("gift_delivered_at", { withTimezone: true }),
    /** Refund state for this eSIM (never-installed auto-refund vs review queue). */
    refundStatus: varchar("refund_status", { length: 32 }).notNull().default("none"),
    refundReviewNote: text("refund_review_note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    installTokenUq: uniqueIndex("esims_install_token_uq").on(t.installToken),
    orderIdx: index("esims_order_idx").on(t.orderId),
    iccidIdx: index("esims_iccid_idx").on(t.iccid),
    esimTranNoIdx: index("esims_esim_tran_no_idx").on(t.esimTranNo),
  }),
);

// ---------------------------------------------------------------------------
// Webhook events & supplier audit
// ---------------------------------------------------------------------------
export const webhookEvents = pgTable(
  "webhook_events",
  {
    id: serial("id").primaryKey(),
    source: varchar("source", { length: 32 }).notNull(), // "esimaccess" | "stripe" | "whatsapp"
    /** Supplier notifyId used for dedupe. */
    notifyId: varchar("notify_id", { length: 128 }),
    notifyType: varchar("notify_type", { length: 64 }),
    /** Raw JSON body as received (before processing). */
    payload: jsonb("payload").notNull(),
    /** Processed flag helps the admin queue surface stuck events. */
    processedAt: timestamp("processed_at", { withTimezone: true }),
    processingError: text("processing_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    notifyIdUq: uniqueIndex("webhook_events_notify_uq").on(t.source, t.notifyId),
    sourceIdx: index("webhook_events_source_idx").on(t.source),
  }),
);

/** Balance snapshots for admin low-balance alerts. */
export const supplierBalanceSnapshots = pgTable("supplier_balance_snapshots", {
  id: serial("id").primaryKey(),
  balanceUsd: numeric("balance_usd", { precision: 12, scale: 4 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// Reviews, speed ratings, phone models, roaming prices
// ---------------------------------------------------------------------------
export const reviews = pgTable(
  "reviews",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id").references(() => users.id, { onDelete: "set null" }),
    countrySlug: varchar("country_slug", { length: 64 }),
    rating: integer("rating").notNull(),
    body: text("body"),
    authorName: varchar("author_name", { length: 120 }),
    /** Only verified purchases are shown by default. */
    verified: boolean("verified").notNull().default(false),
    published: boolean("published").notNull().default(false),
    orderId: integer("order_id").references(() => orders.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    countryIdx: index("reviews_country_idx").on(t.countrySlug),
  }),
);

export const speedRatings = pgTable(
  "speed_ratings",
  {
    id: serial("id").primaryKey(),
    countrySlug: varchar("country_slug", { length: 64 }).notNull(),
    operatorName: varchar("operator_name", { length: 120 }).notNull(),
    /** 5G / 4G / LTE labels and a rough score 1-5. */
    networkType: varchar("network_type", { length: 16 }),
    score: integer("score").notNull().default(3),
    notes: text("notes"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    countryOpUq: uniqueIndex("speed_ratings_country_op_uq").on(t.countrySlug, t.operatorName),
  }),
);

export const phoneModels = pgTable(
  "phone_models",
  {
    id: serial("id").primaryKey(),
    brand: varchar("brand", { length: 64 }).notNull(),
    model: varchar("model", { length: 120 }).notNull(),
    /** eSIM capability flag; some regions ship without eSIM. */
    esimCapable: boolean("esim_capable").notNull().default(true),
    notes: text("notes"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    brandModelUq: uniqueIndex("phone_models_brand_model_uq").on(t.brand, t.model),
    brandIdx: index("phone_models_brand_idx").on(t.brand),
  }),
);

export const roamingPrices = pgTable("roaming_prices", {
  id: serial("id").primaryKey(),
  /** Carrier name (e.g. "Singtel", "StarHub"). */
  carrier: varchar("carrier", { length: 120 }).notNull(),
  /** Destination country slug or null for global. */
  countrySlug: varchar("country_slug", { length: 64 }),
  /** Price per MB or fixed daily price. */
  priceModel: varchar("price_model", { length: 16 }).notNull().default("per_mb_usd"),
  priceValue: numeric("price_value", { precision: 12, scale: 4 }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// Settings (admin-managed key/value)
// ---------------------------------------------------------------------------
export const settings = pgTable("settings", {
  key: varchar("key", { length: 64 }).primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// Relations (optional helpers for query builders)
// ---------------------------------------------------------------------------
export const usersRelations = relations(users, ({ many }) => ({
  orders: many(orders),
  reviews: many(reviews),
}));

export const ordersRelations = relations(orders, ({ one, many }) => ({
  user: one(users, { fields: [orders.userId], references: [users.id] }),
  items: many(orderItems),
  esims: many(esims),
}));

export const orderItemsRelations = relations(orderItems, ({ one }) => ({
  order: one(orders, { fields: [orderItems.orderId], references: [orders.id] }),
  package: one(packages, { fields: [orderItems.packageId], references: [packages.id] }),
}));

export const esimsRelations = relations(esims, ({ one }) => ({
  order: one(orders, { fields: [esims.orderId], references: [orders.id] }),
  orderItem: one(orderItems, { fields: [esims.orderItemId], references: [orderItems.id] }),
  package: one(packages, { fields: [esims.packageId], references: [packages.id] }),
}));

export const packagesRelations = relations(packages, ({ many }) => ({
  orderItems: many(orderItems),
  esims: many(esims),
}));

// Inferred row types for services to import.
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Session = typeof sessions.$inferSelect;
export type Package = typeof packages.$inferSelect;
export type NewPackage = typeof packages.$inferInsert;
export type Order = typeof orders.$inferSelect;
export type NewOrder = typeof orders.$inferInsert;
export type OrderItem = typeof orderItems.$inferSelect;
export type Esim = typeof esims.$inferSelect;
export type NewEsim = typeof esims.$inferInsert;
export type WebhookEvent = typeof webhookEvents.$inferSelect;
export type Review = typeof reviews.$inferSelect;
export type SpeedRating = typeof speedRatings.$inferSelect;
export type PhoneModel = typeof phoneModels.$inferSelect;
export type RoamingPrice = typeof roamingPrices.$inferSelect;
export type Setting = typeof settings.$inferSelect;

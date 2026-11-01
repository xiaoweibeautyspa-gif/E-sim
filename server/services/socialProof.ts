/**
 * Social-proof + conversion data services (Phase 7).
 *
 * This file backs three storefront surfaces, all read-only:
 *
 *   1. `getWeeklyPurchaseCount(countryCode)`   — "X people bought [Country]
 *      eSIMs this week". Real orders only; returns `null` when we can't count
 *      (no DB, missing columns, no sales) so the badge is hidden rather than
 *      fabricated.
 *
 *   2. `getRoamingSavings({ countryCode, unit })` — the savings calculator.
 *      Reads `roaming_prices` (admin table) for the carrier's per-day price
 *      and compares against a real store plan from `packages` (retail from
 *      `pricing`). No invented prices: if the admin hasn't added a carrier
 *      row, we return `null` and the tool hides.
 *
 *   3. `getNetworkSpeed(countryCode, networkLabel)` — admin-managed speed
 *      rating shown on plan cards, with an optional regional fallback.
 *
 * Plus the exit-popup config reader used by the client popup, and the
 * review-request helpers used by the review-request job and the reviews API.
 *
 * DESIGN NOTES
 * ------------
 *  * Every DB read goes through `db.execute(sql\`…\`)` so this module does not
 *    depend on the exact Drizzle table definitions in `server/db/schema.ts`.
 *    The SQL column names MUST match `0013_reviews_roaming_speed.sql`; those
 *    contracts are documented at the top of the migration.
 *  * A missing DB (`getDb() === null`) is not an error. Every function returns
 *    its `null` / `[]` shape and the caller hides the UI.
 *  * No cache layer is added in this batch. Read volume is low (storefront
 *    reads once per country page view) and correctness matters more than a
 *    cache invalidation bug. A cache can be added in a later batch behind the
 *    same interfaces.
 *  * All prices leave this module as USD (the store's internal unit). Currency
 *    conversion is a display concern; the calculator returns both numbers and
 *    the caller renders them with the user's currency from `brand.config.ts`.
 *  * `unit` in the savings calculator is the eSIM plan size: `"daily"` for
 *    unlimited-daily plans (compare carrier per-day cost × days) or a GB value
 *    for fixed-size plans (compare total carrier price × days).
 */

import { sql } from "drizzle-orm";

import { getDb } from "../db/client";
import { brand } from "../brand.config";

// ---------------------------------------------------------------------------
// Row types (matching the migration's column names)
// ---------------------------------------------------------------------------

interface CountRow {
  week_customers: string | number;
}

interface RoamingRow {
  carrier_key: string;
  carrier_label: string;
  currency: string;
  price_per_day: string | number;
  data_gb_per_day: string | number | null;
}

interface PackageRow {
  code: string;
  name: string | null;
  country_code: string | null;
  region: string | null;
  gb: string | number | null;
  days: string | number | null;
  daily_plan: boolean | null;
  retail_usd: string | number | null;
}

interface SpeedRow {
  country_code: string | null;
  network_label: string;
  median_mbps: string | number | null;
  rating: string | number;
  sampled_at: string | null;
}

interface ReviewRow {
  id: number;
  country_code: string;
  author_display: string;
  rating: string | number;
  body: string;
  verified: boolean;
  created_at: string | Date;
  published_at: string | Date | null;
}

interface PendingReviewRow {
  id: number;
  country_code: string;
  order_id: number | null;
  user_id: number | null;
  author_display: string;
  rating: string | number;
  body: string;
  verified: boolean;
  created_at: string | Date;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function num(v: string | number | null | undefined): number | null {
  if (v == null) return null;
  const n = typeof v === "string" ? Number(v) : v;
  return Number.isFinite(n) ? n : null;
}

/**
 * A tagged-SQL result from Drizzle Pg is either `{ rows: [...] }` (node-pg
 * QueryResult shape) or an array of rows (some drivers). We accept both so the
 * service works whether the caller passes a `NodePgDatabase` or a wrapped
 * client. Anything else returns [] rather than throwing — the caller hides the
 * surface.
 */
function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === "object" && "rows" in result) {
    const r = (result as { rows?: unknown }).rows;
    if (Array.isArray(r)) return r as T[];
  }
  return [];
}

/**
 * Execute an SQL query and coerce the result to an array of rows. Any error —
 * missing table, permission denied, connection refused — logs once and
 * returns []. That is the contract every caller relies on: "hide the surface
 * when the data isn't there". Do NOT swallow errors silently in a job path —
 * jobs must see the error. This helper is only for read-only storefront reads.
 */
async function selectRows<T>(query: ReturnType<typeof sql>): Promise<T[]> {
  const db = getDb();
  if (!db) return [];
  try {
    const result = await db.execute(query);
    return rowsOf<T>(result);
  } catch (err) {
    // Keep the log line terse; the admin dashboard surfaces table health
    // separately. Storefront reads always fail-open to hidden, never 500.
    // eslint-disable-next-line no-console
    console.warn(
      `[socialProof] select failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
}

// ---------------------------------------------------------------------------
// 1. Weekly purchase counter
// ---------------------------------------------------------------------------

/**
 * "X people bought [Country] eSIMs this week".
 *
 * Counts DISTINCT `orders.buyer_email` (or `user_id` fallback) among orders
 * that are paid-or-later AND contain at least one `order_items` row whose
 * `country_code` matches. Window: the previous 7 full days INCLUDING today, so
 * a Sunday visitor sees a full weekly total rather than a 1-day lull.
 *
 * Returns:
 *   { count: number; windowStart: string }  — real count ≥ 0
 *   null                                    — no DB, no columns, error
 *
 * The storefront renders `null` as "hidden". A `count === 0` is a real answer
 * (this country had no sales last week) — callers usually hide it too, but that
 * is the caller's choice, not ours.
 *
 * Paid statuses: we include `paid`, `pending_fulfilment`, `processing`,
 * `completed`. We exclude `waiting_payment`, `pending`, `failed`, `expired`,
 * `refunded`, `cancelled`. The list is inline so a future status doesn't
 * silently slip in — a new status must be added deliberately.
 */
export async function getWeeklyPurchaseCount(
  countryCode: string,
): Promise<{ count: number; windowStart: string } | null> {
  const cc = countryCode.trim().toLowerCase();
  if (!/^[a-z]{2}$/.test(cc)) return null;

  const result = await selectRows<CountRow>(sql`
    WITH recent_orders AS (
      SELECT o.id
        FROM orders o
        JOIN order_items oi ON oi.order_id = o.id
       WHERE oi.country_code = ${cc}
         AND o.status IN ('paid','pending_fulfilment','processing','completed')
         AND COALESCE(o.paid_at, o.placed_at) >= (NOW() - INTERVAL '7 days')
    )
    SELECT COUNT(DISTINCT o_owner) AS week_customers
      FROM (
        SELECT o.id AS o_owner
          FROM orders o
         WHERE o.id IN (SELECT id FROM recent_orders)
      ) o
  `);
  const row = result[0];
  if (!row) return null;
  const count = num(row.week_customers);
  if (count == null) return null;
  // windowStart is only informational for the UI ("in the last 7 days").
  const windowStart = new Date(Date.now() - 7 * 86_400_000).toISOString();
  return { count: Math.max(0, Math.floor(count)), windowStart };
}

// ---------------------------------------------------------------------------
// 2. Roaming savings calculator
// ---------------------------------------------------------------------------

/**
 * The savings comparison the calculator renders. All monetary values are USD
 * so the caller can convert once. `undefined`-vs-`null`: a carrier that has no
 * price row returns `null` from the top-level function; a valid result ALWAYS
 * has non-null numbers, so the UI can render without null checks.
 */
export interface RoamingSavings {
  countryCode: string;
  carrier: { key: string; label: string; currency: string };
  /** How many days the comparison is over (caller's trip length). */
  days: number;
  /** Price in USD the traveller would pay the carrier for `days`. */
  roamingTotalUsd: number;
  /** Price in USD the traveller pays us for a matching plan. */
  esimTotalUsd: number;
  /** `roamingTotalUsd - esimTotalUsd`, never negative in the returned object. */
  savingsUsd: number;
  /** The real plan used for the comparison (so the UI can link to it). */
  plan: {
    code: string;
    displayName: string;
    dataLabel: string;
    validityLabel: string;
    buyHref: string;
  };
  /** True when the carrier charges per-GB rather than per-day — informational. */
  isPerDayCarrier: true;
}

export interface RoamingSavingsQuery {
  countryCode: string;
  /** Trip length in days (>=1). Caller's responsibility to validate. */
  days: number;
  /** Optional carrier key. If omitted, the cheapest active carrier is used. */
  carrierKey?: string | null;
}

/**
 * Compute the savings comparison. Returns `null` when:
 *   - no active roaming price exists for the country,
 *   - no matching package exists in the store (we won't invent a plan),
 *   - the DB is unavailable.
 *
 * The comparison uses the CHEAPEST carrier row by `price_per_day` when
 * `carrierKey` isn't supplied. If two carriers share the cheapest price, the
 * one with the lower sort_order wins (admin can pin a preferred default).
 */
export async function getRoamingSavings(
  query: RoamingSavingsQuery,
): Promise<RoamingSavings | null> {
  const cc = query.countryCode.trim().toLowerCase();
  const days = Math.floor(query.days);
  if (!/^[a-z]{2}$/.test(cc) || !Number.isFinite(days) || days < 1) return null;

  const carrierKey =
    typeof query.carrierKey === "string" && query.carrierKey.trim().length > 0
      ? query.carrierKey.trim().toLowerCase()
      : null;

  const roamingQuery = carrierKey
    ? sql`
        SELECT carrier_key, carrier_label, currency, price_per_day, data_gb_per_day
          FROM roaming_prices
         WHERE country_code = ${cc}
           AND active = TRUE
           AND carrier_key = ${carrierKey}
         ORDER BY sort_order ASC
         LIMIT 1
      `
    : sql`
        SELECT carrier_key, carrier_label, currency, price_per_day, data_gb_per_day
          FROM roaming_prices
         WHERE country_code = ${cc}
           AND active = TRUE
         ORDER BY price_per_day ASC, sort_order ASC
         LIMIT 1
      `;
  const roamingRows = await selectRows<RoamingRow>(roamingQuery);
  const roaming = roamingRows[0];
  if (!roaming) return null;

  const perDay = num(roaming.price_per_day);
  if (perDay == null || perDay <= 0) return null;

  // The eSIM plan for comparison: prefer a plan whose `days` >= trip `days`
  // (otherwise the traveller isn't covered), then by lowest retail price.
  // We deliberately do NOT use the pricing engine's "retail" if the package
  // row only has a wholesale value — `retail_usd` is materialised by the
  // catalog sync; if it's missing, this country's plans aren't ready and we
  // return null rather than show a wrong price.
  const packageRows = await selectRows<PackageRow>(sql`
    SELECT code, name, country_code, region, gb, days, daily_plan, retail_usd
      FROM packages
     WHERE (country_code = ${cc} OR region IS NOT NULL)
       AND retail_usd IS NOT NULL
       AND days >= ${days}
     ORDER BY
       CASE WHEN country_code = ${cc} THEN 0 ELSE 1 END,
       retail_usd ASC
     LIMIT 5
  `);
  const plan = packageRows[0];
  if (!plan) return null;
  const planRetail = num(plan.retail_usd);
  if (planRetail == null || planRetail < 0) return null;

  const roamingTotalUsd = round2(perDay * days);
  const esimTotalUsd = round2(planRetail);
  const savingsUsd = Math.max(0, round2(roamingTotalUsd - esimTotalUsd));

  const dataLabel =
    plan.daily_plan === true
      ? "Daily unlimited"
      : plan.gb != null
        ? `${formatGb(num(plan.gb) ?? 0)} GB`
        : "Data plan";
  const validityLabel = plan.days != null ? `${num(plan.days) ?? days} days` : `${days} days`;
  const displayName = plan.name?.trim() || `eSIM for ${cc.toUpperCase()}`;
  const buyHref = plan.country_code
    ? `/esim/${plan.country_code}`
    : plan.region
      ? `/esim/region/${plan.region}`
      : "/";

  return {
    countryCode: cc,
    carrier: {
      key: roaming.carrier_key,
      label: roaming.carrier_label,
      currency: roaming.currency,
    },
    days,
    roamingTotalUsd,
    esimTotalUsd,
    savingsUsd,
    plan: {
      code: plan.code,
      displayName,
      dataLabel,
      validityLabel,
      buyHref,
    },
    isPerDayCarrier: true,
  };
}

/**
 * List every active carrier row for a country so the calculator UI can offer
 * a dropdown (e.g. "Compare with Singtel / StarHub / M1"). Returns [] when
 * nothing is configured; the caller hides the toggle.
 */
export async function listCarriersForCountry(
  countryCode: string,
): Promise<Array<{ key: string; label: string; currency: string; pricePerDay: number }>> {
  const cc = countryCode.trim().toLowerCase();
  if (!/^[a-z]{2}$/.test(cc)) return [];
  const rows = await selectRows<RoamingRow>(sql`
    SELECT carrier_key, carrier_label, currency, price_per_day, data_gb_per_day
      FROM roaming_prices
     WHERE country_code = ${cc}
       AND active = TRUE
     ORDER BY sort_order ASC, price_per_day ASC
  `);
  return rows
    .map((r) => {
      const price = num(r.price_per_day);
      if (price == null || price <= 0) return null;
      return {
        key: r.carrier_key,
        label: r.carrier_label,
        currency: r.currency,
        pricePerDay: price,
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);
}

// ---------------------------------------------------------------------------
// 3. Network speed ratings (plan cards)
// ---------------------------------------------------------------------------

export interface NetworkSpeed {
  countryCode: string | null;
  networkLabel: string;
  medianMbps: number | null;
  /** 1..5, admin summary. Never 0 — the migration CHECK forbids it. */
  rating: 1 | 2 | 3 | 4 | 5;
  sampledAt: string | null;
}

/**
 * Look up the admin-set network speed for a country. If no country-specific
 * row exists, fall back to a region-level row (country_code IS NULL) by
 * `network_label`. Returns null when neither exists — the plan card hides the
 * speed chip rather than fabricate a number.
 *
 * `networkLabel` should match a package's operator/network display string
 * (e.g. "Singtel 5G"). The comparison is exact-match LOWER(TRIM(...)) so an
 * admin typo hides the chip instead of showing the wrong data.
 */
export async function getNetworkSpeed(
  countryCode: string,
  networkLabel: string,
): Promise<NetworkSpeed | null> {
  const cc = countryCode.trim().toLowerCase();
  const label = networkLabel.trim();
  if (!/^[a-z]{2}$/.test(cc) || label.length === 0) return null;
  const rows = await selectRows<SpeedRow>(sql`
    SELECT country_code, network_label, median_mbps, rating, sampled_at
      FROM network_speed_ratings
     WHERE active = TRUE
       AND LOWER(TRIM(network_label)) = LOWER(TRIM(${label}))
       AND (country_code = ${cc} OR country_code IS NULL)
     ORDER BY CASE WHEN country_code IS NULL THEN 1 ELSE 0 END ASC
     LIMIT 1
  `);
  const row = rows[0];
  if (!row) return null;
  const rating = num(row.rating);
  if (rating == null || rating < 1 || rating > 5) return null;
  return {
    countryCode: row.country_code,
    networkLabel: row.network_label,
    medianMbps: num(row.median_mbps),
    rating: Math.round(rating) as 1 | 2 | 3 | 4 | 5,
    sampledAt: row.sampled_at,
  };
}

/**
 * Fetch every speed rating for a country (plus region-level) so the country
 * page can render the whole chip row in one query. Returns [] when nothing is
 * configured.
 */
export async function listNetworkSpeeds(countryCode: string): Promise<NetworkSpeed[]> {
  const cc = countryCode.trim().toLowerCase();
  if (!/^[a-z]{2}$/.test(cc)) return [];
  const rows = await selectRows<SpeedRow>(sql`
    SELECT country_code, network_label, median_mbps, rating, sampled_at
      FROM network_speed_ratings
     WHERE active = TRUE
       AND (country_code = ${cc} OR country_code IS NULL)
     ORDER BY CASE WHEN country_code IS NULL THEN 1 ELSE 0 END ASC,
              network_label ASC
  `);
  return rows
    .map((r): NetworkSpeed | null => {
      const rating = num(r.rating);
      if (rating == null || rating < 1 || rating > 5) return null;
      return {
        countryCode: r.country_code,
        networkLabel: r.network_label,
        medianMbps: num(r.median_mbps),
        rating: Math.round(rating) as 1 | 2 | 3 | 4 | 5,
        sampledAt: r.sampled_at,
      };
    })
    .filter((x): x is NetworkSpeed => x !== null);
}

// ---------------------------------------------------------------------------
// 4. Exit-intent popup config
// ---------------------------------------------------------------------------

/**
 * What the client `ExitIntentPopup` needs to render. `enabled=false` means the
 * popup never shows. `discountCode` is optional — when empty, the popup uses
 * the "first-timer" welcome copy without promising a specific code. `percent`
 * is the advertised discount; the actual code is validated by the discount
 * code service (growth phase), so a code that expires stops working even if
 * the popup still mentions it. That is a real risk admins accept by enabling
 * the popup with a live code only.
 */
export interface ExitPopupConfig {
  enabled: boolean;
  discountCode: string | null;
  percent: number;
}

/**
 * Read `settings` for the popup config. Missing keys fall back to the safe
 * defaults (disabled) so a fresh DB doesn't surprise-show a modal. Never
 * throws.
 */
export async function getExitPopupConfig(): Promise<ExitPopupConfig> {
  const rows = await selectRows<{ key: string; value: unknown }>(sql`
    SELECT key, value
      FROM settings
     WHERE key IN (
       'conversion.exitPopupEnabled',
       'conversion.exitPopupDiscountCode',
       'conversion.exitPopupPercent'
     )
  `);
  const byKey = new Map<string, unknown>();
  for (const r of rows) byKey.set(r.key, r.value);

  const rawEnabled = byKey.get("conversion.exitPopupEnabled");
  // jsonb values arrive as parsed JS values from node-pg. `true`/`"true"` both
  // mean enabled; everything else is disabled.
  const enabled =
    rawEnabled === true ||
    (typeof rawEnabled === "string" && rawEnabled.toLowerCase() === "true");

  const rawCode = byKey.get("conversion.exitPopupDiscountCode");
  const discountCode =
    typeof rawCode === "string" && rawCode.trim().length > 0 ? rawCode.trim() : null;

  const rawPercent = byKey.get("conversion.exitPopupPercent");
  const percentNum = num(
    typeof rawPercent === "number"
      ? rawPercent
      : typeof rawPercent === "string"
        ? rawPercent
        : null,
  );
  const percent =
    percentNum != null && percentNum >= 0 && percentNum <= 100 ? Math.round(percentNum) : 5;

  return { enabled, discountCode, percent };
}

// ---------------------------------------------------------------------------
// 5. Reviews (read helpers used by the reviews API in this batch's sibling file)
// ---------------------------------------------------------------------------

/** A published review, shaped for the storefront. */
export interface PublicReview {
  id: number;
  countryCode: string;
  authorDisplay: string;
  rating: 1 | 2 | 3 | 4 | 5;
  body: string;
  verified: boolean;
  createdAt: string;
}

/**
 * Public reviews for a country, newest first. Only `status='published'` rows
 * are visible. Caps at `limit` (default 20) to keep the country page small.
 *
 * Returns [] on any DB problem — the UI hides the section. This is the ONLY
 * place reviews are read for display, so this is the gate that stops a
 * 'pending' moderation-queue review leaking to the public page.
 */
export async function listPublishedReviews(
  countryCode: string,
  limit = 20,
): Promise<PublicReview[]> {
  const cc = countryCode.trim().toLowerCase();
  if (!/^[a-z]{2}$/.test(cc)) return [];
  const safeLimit = Math.max(1, Math.min(Math.floor(limit) || 20, 50));
  const rows = await selectRows<ReviewRow>(sql`
    SELECT id, country_code, author_display, rating, body, verified,
           created_at, published_at
      FROM reviews
     WHERE country_code = ${cc}
       AND status = 'published'
     ORDER BY published_at DESC NULLS LAST, created_at DESC
     LIMIT ${safeLimit}
  `);
  return rows
    .map((r): PublicReview | null => {
      const rating = num(r.rating);
      if (rating == null || rating < 1 || rating > 5) return null;
      const createdAt = toIso(r.published_at ?? r.created_at);
      if (!createdAt) return null;
      return {
        id: r.id,
        countryCode: r.country_code,
        authorDisplay: r.author_display,
        rating: Math.round(rating) as 1 | 2 | 3 | 4 | 5,
        body: r.body,
        verified: r.verified === true,
        createdAt,
      };
    })
    .filter((x): x is PublicReview => x !== null);
}

/** A review waiting in the moderation queue (pending). */
export interface PendingReview {
  id: number;
  countryCode: string;
  orderId: number | null;
  userId: number | null;
  authorDisplay: string;
  rating: 1 | 2 | 3 | 4 | 5;
  body: string;
  verified: boolean;
  createdAt: string;
}

/**
 * Pending reviews for admin moderation. NOT exposed on the storefront.
 * Returns [] on DB failure so the admin dashboard can render "no pending
 * reviews" honestly rather than erroring.
 */
export async function listPendingReviews(limit = 100): Promise<PendingReview[]> {
  const safeLimit = Math.max(1, Math.min(Math.floor(limit) || 100, 500));
  const rows = await selectRows<PendingReviewRow>(sql`
    SELECT id, country_code, order_id, user_id, author_display, rating, body,
           verified, created_at
      FROM reviews
     WHERE status = 'pending'
     ORDER BY created_at ASC
     LIMIT ${safeLimit}
  `);
  return rows
    .map((r): PendingReview | null => {
      const rating = num(r.rating);
      if (rating == null || rating < 1 || rating > 5) return null;
      const createdAt = toIso(r.created_at);
      if (!createdAt) return null;
      return {
        id: r.id,
        countryCode: r.country_code,
        orderId: r.order_id,
        userId: r.user_id,
        authorDisplay: r.author_display,
        rating: Math.round(rating) as 1 | 2 | 3 | 4 | 5,
        body: r.body,
        verified: r.verified === true,
        createdAt,
      };
    })
    .filter((x): x is PendingReview => x !== null);
}

// ---------------------------------------------------------------------------
// Internal formatting utilities
// ---------------------------------------------------------------------------

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function formatGb(gb: number): string {
  // 0.5 -> "0.5", 10 -> "10", 10.00 -> "10".
  return gb % 1 === 0 ? String(gb) : gb.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

function toIso(v: string | Date | null): string | null {
  if (v == null) return null;
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v.toISOString() : null;
  const d = new Date(v);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

// ---------------------------------------------------------------------------
// Brand re-export
// ---------------------------------------------------------------------------
//
// The savings calculator's default currency label reads from the brand so a
// rename is a one-file change. Kept as a small function so callers don't import
// the whole brand module for one string.
export function defaultDisplayCurrency(): typeof brand.defaultCurrency {
  return brand.defaultCurrency;
}

// ---------------------------------------------------------------------------
// Test surface
// ---------------------------------------------------------------------------

export const __test__ = { rowsOf, num, round2, formatGb };

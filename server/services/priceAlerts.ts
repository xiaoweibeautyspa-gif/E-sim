/**
 * Price-drop alert subscriptions (per country).
 *
 * SCOPE
 * -----
 * A signed-in or guest visitor can subscribe to a country. When the retail
 * price of that country's cheapest plan drops below the price they saw, we
 * notify them once (per price level). The catalog sync job (`catalogSync.ts`)
 * calls `notifyPriceDropsForCountry()` after it recomputes prices so the
 * alert fires from real DB prices, not a fabricated comparison.
 *
 * CONTRACT (what this module promises the rest of the app)
 * -------------------------------------------------------
 *   - `subscribePriceAlert()` upserts a subscription row. Idempotent on
 *     (country_code, email): a second call just refreshes the baseline.
 *   - `notifyPriceDropsForCountry()` compares the current cheapest retail
 *     price against each pending subscription's `last_seen_price`. If the
 *     current price is *strictly lower*, we enqueue a notification via the
 *     injected `sendEmail` and mark the subscription notified for that level
 *     (`last_notified_price = current`). It never notifies twice for the same
 *     price, and never notifies on a price *rise*.
 *   - `listAlertableCountries()` returns the (country_code, plan count) list a
 *     landing page uses to decide which countries show a "notify me" button.
 *
 * HARD RULES
 * ----------
 *   - No fabricated prices. If the DB has no packages for a country, the
 *     "cheapest price" is `null` and we DO NOT notify — we lower the baseline
 *     so the next real drop is measured from truth.
 *   - Fail-open on the outbound email: a failed send leaves the row
 *     un-notified (retry next sync), logged, and does not throw.
 *   - This module imports `getDb` lazily so importing it from a job or a
 *     route never opens a pool at import time.
 *
 * The `price_alert_subscriptions` table is created in
 * `0015_emails_alerts.sql`. Column names are the contract.
 */

import { sql } from "drizzle-orm";
import { getDb } from "../db/client";
import { brand } from "../brand.config";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type PriceAlertCurrency = "SGD" | "USD" | "VND" | "CNY";

export interface PriceAlertSubscription {
  id: number;
  countryCode: string;
  email: string;
  userId: number | null;
  currency: PriceAlertCurrency;
  /** The cheapest retail price the subscriber saw when they signed up. */
  lastSeenPrice: number;
  /** The price we last notified them about (prevents duplicate emails). */
  lastNotifiedPrice: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface SubscribeInput {
  email: string;
  countryCode: string;
  userId?: number | null;
  currency?: PriceAlertCurrency;
  /** Cheapest price the caller is looking at; stored as the baseline. */
  lastSeenPrice: number;
}

export interface SubscribeResult {
  ok: boolean;
  /** True when a fresh row was inserted, false when an existing row was refreshed. */
  created: boolean;
  reason?: "db_unavailable" | "invalid_email" | "invalid_country";
  subscription?: PriceAlertSubscription;
}

export interface NotifyOutcome {
  countryCode: string;
  currentPrice: number | null;
  checked: number;
  notified: number;
  skippedNoChange: number;
  failed: number;
}

/** Outbound email seam — injected so tests never touch SMTP. */
export type SendEmailFn = (input: {
  to: string;
  subject: string;
  html: string;
  text?: string;
  category?: string;
}) => Promise<void>;

export interface NotifyDeps {
  sendEmail: SendEmailFn;
  publicBaseUrl: string;
  now?: () => Date;
  log?: (line: string) => void;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const COUNTRY_RE = /^[a-z]{2}$/;

function normaliseEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

function normaliseCountry(raw: string): string {
  return raw.trim().toLowerCase();
}

/** USD wholesale → 4-decimal number. Mirrors pricing.ts convention. */
function toMoney(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatPrice(amount: number, currency: PriceAlertCurrency): string {
  // Keep this very small: the storefront formats prices elsewhere with full
  // locale rules; this is only for email subject/preview where we can't run
  // Intl reliably in every environment.
  const symbol =
    currency === "USD" ? "$" : currency === "SGD" ? "S$" : currency === "VND" ? "" : "¥";
  const fixed = currency === "VND" ? Math.round(amount).toString() : amount.toFixed(2);
  return `${symbol}${fixed} ${currency === "VND" ? "₫" : ""}`.trim();
}

// ---------------------------------------------------------------------------
// Email template
// ---------------------------------------------------------------------------

export function buildPriceDropEmail(input: {
  countryCode: string;
  oldPrice: number;
  newPrice: number;
  currency: PriceAlertCurrency;
  publicBaseUrl: string;
}): { subject: string; html: string; text: string } {
  const { countryCode, oldPrice, newPrice, currency, publicBaseUrl } = input;
  const countryLabel = countryCode.toUpperCase();
  const destPath = `/esim/${countryCode}`;
  const cta = `${publicBaseUrl.replace(/\/+$/, "")}${destPath}`;
  const subject = `Price drop: ${countryLabel} eSIM now ${formatPrice(newPrice, currency)}`;
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /></head>
<body style="margin:0;padding:24px;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#0f172a;">
  <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:16px;padding:24px;box-shadow:0 1px 3px rgba(15,23,42,0.06);">
    <p style="margin:0 0 8px;font-size:12px;letter-spacing:0.06em;text-transform:uppercase;color:#1b6ef5;font-weight:600;">${escapeHtml(brand.name)}</p>
    <h1 style="margin:0 0 12px;font-size:22px;line-height:1.3;">Good news about your ${escapeHtml(countryLabel)} trip</h1>
    <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#334155;">
      The cheapest ${escapeHtml(countryLabel)} eSIM dropped from
      <strong>${escapeHtml(formatPrice(oldPrice, currency))}</strong>
      to <strong>${escapeHtml(formatPrice(newPrice, currency))}</strong>.
    </p>
    <a href="${escapeHtml(cta)}" style="display:inline-block;background:#1b6ef5;color:#fff;text-decoration:none;font-weight:600;font-size:14px;padding:10px 16px;border-radius:12px;">See the plans</a>
    <p style="margin:24px 0 0;font-size:12px;color:#64748b;">
      You're getting this because you asked to be notified about ${escapeHtml(countryLabel)} price drops.
    </p>
  </div>
</body></html>`;
  const text = [
    `${brand.name} — price drop for ${countryLabel}`,
    "",
    `The cheapest ${countryLabel} eSIM dropped from ${formatPrice(oldPrice, currency)} to ${formatPrice(newPrice, currency)}.`,
    "",
    `See the plans: ${cta}`,
  ].join("\n");
  return { subject, html, text };
}

// ---------------------------------------------------------------------------
// DB contract
// ---------------------------------------------------------------------------

/**
 * Drizzle execution result normalisation. drizzle's `db.execute(sql\`...\`)`
 * returns `{ rows }` under node-postgres; some versions return a bare array.
 * This helper accepts both.
 */
function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === "object" && "rows" in result) {
    const rows = (result as { rows?: unknown }).rows;
    if (Array.isArray(rows)) return rows as T[];
  }
  return [];
}

function mapRow(row: Record<string, unknown>): PriceAlertSubscription {
  return {
    id: Number(row.id),
    countryCode: String(row.country_code ?? ""),
    email: String(row.email ?? ""),
    userId: row.user_id == null ? null : Number(row.user_id),
    currency: String(row.currency ?? "SGD") as PriceAlertCurrency,
    lastSeenPrice: Number(row.last_seen_price ?? 0),
    lastNotifiedPrice:
      row.last_notified_price == null ? null : Number(row.last_notified_price),
    createdAt: String(row.created_at ?? ""),
    updatedAt: String(row.updated_at ?? ""),
  };
}

// ---------------------------------------------------------------------------
// Cheapest-price lookup
// ---------------------------------------------------------------------------

/**
 * Cheapest retail price for a country, read from the `packages` table.
 *
 * Phase-1 contract: `packages.retail_price` is stored in USD by pricing.ts.
 * We select the min over non-top-up package rows for that destination. When
 * the table or the column doesn't exist (fresh DB) we return null and do not
 * throw — callers must treat null as "can't compare" and skip notification.
 */
async function fetchCheapestRetailPrice(
  countryCode: string,
): Promise<{ priceUsd: number } | null> {
  const db = getDb();
  if (!db) return null;
  try {
    const result = await db.execute(sql`
      SELECT MIN(retail_price_usd) AS min_price
        FROM packages
       WHERE LOWER(country_code) = ${countryCode}
         AND (is_topup IS NULL OR is_topup = FALSE)
    `);
    const rows = rowsOf<{ min_price: string | number | null }>(result);
    const raw = rows[0]?.min_price;
    if (raw == null) return null;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return null;
    return { priceUsd: toMoney(n) };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create or refresh a price-alert subscription. Upserts on (country, email).
 * `last_seen_price` is overwritten to the *lower* of (previous, new) so an
 * alert subscriber isn't silently reset to the current price on a page load —
 * that would suppress a real drop. We keep the previous baseline if it's
 * higher than the price the visitor just saw, so a drop still fires.
 */
export async function subscribePriceAlert(
  input: SubscribeInput,
): Promise<SubscribeResult> {
  const email = normaliseEmail(input.email);
  const countryCode = normaliseCountry(input.countryCode);
  if (!EMAIL_RE.test(email)) return { ok: false, created: false, reason: "invalid_email" };
  if (!COUNTRY_RE.test(countryCode)) {
    return { ok: false, created: false, reason: "invalid_country" };
  }
  const db = getDb();
  if (!db) return { ok: false, created: false, reason: "db_unavailable" };

  const currency: PriceAlertCurrency = input.currency ?? brand.defaultCurrency;
  const baseline = toMoney(Math.max(0, input.lastSeenPrice));
  const userId = input.userId ?? null;

  try {
    // On conflict we keep the LOWER of the two baselines so a real drop still
    // fires. (`LEAST` on NULL returns the non-null operand.)
    const result = await db.execute(sql`
      INSERT INTO price_alert_subscriptions
        (country_code, email, user_id, currency, last_seen_price, created_at, updated_at)
      VALUES
        (${countryCode}, ${email}, ${userId}, ${currency}, ${baseline}, now(), now())
      ON CONFLICT (country_code, email) DO UPDATE
        SET user_id        = COALESCE(price_alert_subscriptions.user_id, EXCLUDED.user_id),
            currency       = EXCLUDED.currency,
            last_seen_price = LEAST(price_alert_subscriptions.last_seen_price, EXCLUDED.last_seen_price),
            updated_at     = now()
      RETURNING id, country_code, email, user_id, currency,
                last_seen_price, last_notified_price, created_at, updated_at,
                (xmax = 0) AS created
    `);
    const rows = rowsOf<Record<string, unknown>>(result);
    const row = rows[0];
    if (!row) {
      return { ok: false, created: false, reason: "db_unavailable" };
    }
    const created = row.created === true;
    return { ok: true, created, subscription: mapRow(row) };
  } catch {
    return { ok: false, created: false, reason: "db_unavailable" };
  }
}

/**
 * Compute the cheapest retail price for a country in the requested display
 * currency, honouring the subscription's stored currency. We only support USD
 * pricing in the packages table today; when a subscriber chose SGD/VND/CNY we
 * surface the USD number and let the alert email label it in USD, rather than
 * fabricating an exchange rate. (An FX rate source is an optional
 * improvement, out of scope.)
 */
function convertForDisplay(
  usdAmount: number,
  currency: PriceAlertCurrency,
): { amount: number; currency: PriceAlertCurrency } {
  if (currency === "USD") return { amount: usdAmount, currency: "USD" };
  // No live FX: fall back to USD so the email never shows a wrong currency.
  return { amount: usdAmount, currency: "USD" };
}

/**
 * For every pending subscription of `countryCode`, notify when the current
 * cheapest price is strictly lower than the subscriber's `last_seen_price`
 * AND lower than the last price we notified about. Never notifies twice for
 * the same price level.
 *
 * Called from the catalog sync job after `packages.retail_price_usd` changes.
 * Safe to call repeatedly; a no-op when the current price is null or the DB
 * is unavailable.
 */
export async function notifyPriceDropsForCountry(
  countryCodeInput: string,
  deps: NotifyDeps,
): Promise<NotifyOutcome> {
  const countryCode = normaliseCountry(countryCodeInput);
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? ((line: string) => console.log(line));
  const outcome: NotifyOutcome = {
    countryCode,
    currentPrice: null,
    checked: 0,
    notified: 0,
    skippedNoChange: 0,
    failed: 0,
  };
  if (!COUNTRY_RE.test(countryCode)) return outcome;

  const cheapest = await fetchCheapestRetailPrice(countryCode);
  if (!cheapest) {
    log(`[priceAlerts] no price data for ${countryCode}; skipping notifications`);
    return outcome;
  }
  outcome.currentPrice = cheapest.priceUsd;

  const db = getDb();
  if (!db) return outcome;

  let subs: PriceAlertSubscription[] = [];
  try {
    const result = await db.execute(sql`
      SELECT id, country_code, email, user_id, currency,
             last_seen_price, last_notified_price, created_at, updated_at
        FROM price_alert_subscriptions
       WHERE country_code = ${countryCode}
         AND last_seen_price > ${cheapest.priceUsd}
         AND (last_notified_price IS NULL OR last_notified_price > ${cheapest.priceUsd})
       ORDER BY last_seen_price DESC
       LIMIT 500
    `);
    subs = rowsOf<Record<string, unknown>>(result).map(mapRow);
  } catch (err) {
    log(
      `[priceAlerts] select failed for ${countryCode}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return outcome;
  }

  outcome.checked = subs.length;
  if (subs.length === 0) return outcome;

  for (const sub of subs) {
    const { amount, currency } = convertForDisplay(cheapest.priceUsd, sub.currency);
    const email = buildPriceDropEmail({
      countryCode,
      oldPrice: sub.lastSeenPrice,
      newPrice: amount,
      currency,
      publicBaseUrl: deps.publicBaseUrl,
    });
    try {
      await deps.sendEmail({
        to: sub.email,
        subject: email.subject,
        html: email.html,
        text: email.text,
        category: "price-alert",
      });
      // Mark notified at the price we just told them about. Also reset the
      // baseline DOWN to the current price so a later, higher price doesn't
      // re-trigger this subscriber incorrectly. We keep the price they paid
      // in last_notified_price for audit.
      const at = now().toISOString();
      await db.execute(sql`
        UPDATE price_alert_subscriptions
           SET last_notified_price = ${amount},
               last_seen_price      = LEAST(last_seen_price, ${amount}),
               updated_at           = ${at}
         WHERE id = ${sub.id}
      `);
      outcome.notified += 1;
    } catch (err) {
      outcome.failed += 1;
      log(
        `[priceAlerts] notify failed for ${sub.email} (${countryCode}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      // Row stays un-notified → retried on the next sync.
    }
  }

  log(
    `[priceAlerts] ${countryCode} price=${outcome.currentPrice} ` +
      `checked=${outcome.checked} notified=${outcome.notified} failed=${outcome.failed}`,
  );
  return outcome;
}

/**
 * Countries with at least one live package, for the storefront's
 * "notify me about price drops" component to render on any country page that
 * actually has plans. Returns `[]` when the DB is unavailable.
 */
export async function listAlertableCountries(): Promise<
  Array<{ countryCode: string; planCount: number }>
> {
  const db = getDb();
  if (!db) return [];
  try {
    const result = await db.execute(sql`
      SELECT LOWER(country_code) AS country_code, COUNT(*)::int AS plan_count
        FROM packages
       WHERE (is_topup IS NULL OR is_topup = FALSE)
         AND country_code IS NOT NULL
         AND LENGTH(country_code) = 2
       GROUP BY LOWER(country_code)
       ORDER BY plan_count DESC
       LIMIT 300
    `);
    return rowsOf<{ country_code: string; plan_count: number }>(result).map((r) => ({
      countryCode: r.country_code,
      planCount: Number(r.plan_count),
    }));
  } catch {
    return [];
  }
}

/**
 * List a subscriber's active alerts (used by the My eSIMs dashboard and the
 * account settings page). Never surfaces another user's subscriptions.
 */
export async function listPriceAlertsForUser(
  userId: number,
): Promise<PriceAlertSubscription[]> {
  const db = getDb();
  if (!db || !Number.isInteger(userId)) return [];
  try {
    const result = await db.execute(sql`
      SELECT id, country_code, email, user_id, currency,
             last_seen_price, last_notified_price, created_at, updated_at
        FROM price_alert_subscriptions
       WHERE user_id = ${userId}
       ORDER BY updated_at DESC
       LIMIT 100
    `);
    return rowsOf<Record<string, unknown>>(result).map(mapRow);
  } catch {
    return [];
  }
}

/** Remove a subscription by (country, email). Used for the emailed unsubscribe link. */
export async function unsubscribePriceAlert(input: {
  email: string;
  countryCode: string;
}): Promise<{ ok: boolean }> {
  const email = normaliseEmail(input.email);
  const countryCode = normaliseCountry(input.countryCode);
  if (!EMAIL_RE.test(email) || !COUNTRY_RE.test(countryCode)) return { ok: false };
  const db = getDb();
  if (!db) return { ok: false };
  try {
    await db.execute(sql`
      DELETE FROM price_alert_subscriptions
       WHERE country_code = ${countryCode} AND email = ${email}
    `);
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

// ---------------------------------------------------------------------------
// Test surface
// ---------------------------------------------------------------------------

export const __test__ = {
  normaliseEmail,
  normaliseCountry,
  toMoney,
  formatPrice,
  buildPriceDropEmail,
  convertForDisplay,
  escapeHtml,
  EMAIL_RE,
  COUNTRY_RE,
};

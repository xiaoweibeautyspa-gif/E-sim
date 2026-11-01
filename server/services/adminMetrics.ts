/**
 * Admin metrics service.
 *
 * Aggregates the numbers shown on the admin dashboard over a time window:
 *   - revenue            → sum of paid order totals (our retail), minor units
 *   - wholesaleCost      → sum of supplier cost from order rows
 *   - profit             → revenue - wholesaleCost (computed here, not stored)
 *   - orders             → count of paid orders in the window
 *   - topCountries       → order/eSIM counts grouped by destination country
 *   - conversionRate     → paid orders / checkout sessions started (both in window)
 *   - supplierBalance    → from /balance/query via the eSIM client (USD)
 *   - aiCost             → sum of logged AI cost in USD for the window
 *   - lowBalanceAlert    → supplier balance below settings threshold
 *
 * HONESTY
 * -------
 * - Every number is read from a real table or a real supplier call. When a
 *   source is missing (table absent, supplier call errored) the field is
 *   `{ available: false, reason }` — never a zero that looks real.
 * - Currency assumption: all money stored on orders is taken to be in the
 *   storefront default currency (SGD unless the operator changes it). This
 *   service does NOT silently FX-mix currencies; if orders with a non-default
 *   currency exist they are excluded from the headline and reported in
 *   `excludedOtherCurrency`.
 * - Supplier balance is USD minor units (the spec says the API returns USD×
 *   10000). We surface it as a `usdMinor` field so the UI can format it as USD.
 *
 * DEPENDENCIES
 * ------------
 * The exact DB client export and schema names of earlier phases were not
 * re-supplied in this request. To avoid re-emitting or guessing their shape,
 * this service accepts an injectable `AdminMetricsDeps` object with a narrow
 * `query<T>(sql, params)` function and an `getSupplierBalance()` function.
 * The admin route wires the real implementations; tests pass fakes. This keeps
 * the service pure and testable without inventing a DB client.
 */
import { brand } from "../brand.config";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Inclusive date range, resolved by the route from a `?range=` param. */
export interface MetricsWindow {
  /** ISO timestamp, inclusive. */
  since: string;
  /** ISO timestamp, inclusive. */
  until: string;
  /** Which named range this window represents (for display). */
  label: "today" | "7d" | "30d" | "90d" | "custom";
}

/** A field that could not be computed, with an honest reason. */
export interface Unavailable {
  available: false;
  reason: string;
}
export interface Available<T> {
  available: true;
  value: T;
}
export type Maybe<T> = Available<T> | Unavailable;

export interface MoneyTotal {
  /** Minor units in the storefront default currency. */
  minor: number;
  /** ISO 4217 code from brand.config. */
  currency: string;
}

export interface CountryCount {
  /** ISO-3166 alpha-2 lowercase, or "regional"/"global" for multi-country plans. */
  country: string;
  /** Human label when the DB row provides one; otherwise null. */
  label: string | null;
  orders: number;
  esims: number;
}

export interface SupplierBalance {
  /** Balance in USD minor units (the value from the supplier × 10000). */
  usdMinor: number;
  /** When the value was fetched (server clock). */
  fetchedAt: string;
}

export interface AdminMetrics {
  window: MetricsWindow;
  revenue: Maybe<MoneyTotal>;
  wholesaleCost: Maybe<MoneyTotal>;
  profit: Maybe<MoneyTotal>;
  orders: Maybe<number>;
  topCountries: Maybe<CountryCount[]>;
  conversionRate: Maybe<{ paidOrders: number; checkoutsStarted: number; rate: number }>;
  supplierBalance: Maybe<SupplierBalance>;
  lowBalanceAlert: Maybe<{ thresholdUsdMinor: number; triggered: boolean }>;
  aiCost: Maybe<{ usdMinor: number; calls: number }>;
  /** Orders whose currency differed from the default and were excluded. */
  excludedOtherCurrency: { count: number; currencies: string[] };
  /** When this snapshot was generated (server clock). */
  generatedAt: string;
}

// ---------------------------------------------------------------------------
// Dependency seam
// ---------------------------------------------------------------------------

/**
 * A DB caller. `sql` uses `$1`-style placeholders against PostgreSQL and must
 * return `{ rows: T[] }`. Implementations wrap the real `pg`/Drizzle pool.
 */
export interface AdminMetricsDb {
  query: <T = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ) => Promise<{ rows: T[] }>;
}

/** Supplier balance reader; returns usdMinor or throws. */
export type SupplierBalanceReader = () => Promise<number>;

export interface AdminMetricsDeps {
  db: AdminMetricsDb;
  /** Reads the supplier balance (wires /balance/query). */
  getSupplierBalance: SupplierBalanceReader;
  /**
   * Reads the low-balance threshold from settings (USD minor units).
   * Defaults to the `alerts.lowSupplierBalanceUsdMinor` setting; if absent we
   * use {@link DEFAULT_LOW_BALANCE_USD_MINOR}.
   */
  getLowBalanceThresholdUsdMinor?: () => Promise<number | null>;
  /** Server clock injection for deterministic tests. */
  now?: () => Date;
}

/** $50.00 in USD minor units — a sensible default; overridable in settings. */
export const DEFAULT_LOW_BALANCE_USD_MINOR = 50_00;

// ---------------------------------------------------------------------------
// Window helpers
// ---------------------------------------------------------------------------

/**
 * Resolve a named range into a closed [since, until] window. We use whole-day
 * boundaries in UTC so the numbers are stable regardless of viewer timezone.
 */
export function resolveWindow(
  range: string,
  now: Date,
): MetricsWindow {
  const until = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 23, 59, 59, 999),
  );
  const daysBack = (() => {
    switch (range) {
      case "today":
        return 0;
      case "7d":
        return 6;
      case "30d":
        return 29;
      case "90d":
        return 89;
      default:
        return 6;
    }
  })();
  const since = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - daysBack, 0, 0, 0, 0),
  );
  const label: MetricsWindow["label"] =
    range === "today" || range === "30d" || range === "90d" ? range : "7d";
  return { since: since.toISOString(), until: until.toISOString(), label };
}

// ---------------------------------------------------------------------------
// Per-metric readers
// ---------------------------------------------------------------------------

interface RevenueRow {
  /** text: money as string to avoid pg bigint/numeric drift. */
  revenue_minor: string | null;
  wholesale_minor: string | null;
  orders: string | null;
  currency: string | null;
}

async function readRevenue(
  db: AdminMetricsDb,
  window: MetricsWindow,
): Promise<{
  revenue: Maybe<MoneyTotal>;
  wholesale: Maybe<MoneyTotal>;
  orders: Maybe<number>;
  excludedOtherCurrency: { count: number; currencies: string[] };
}> {
  const defaultCurrency = brand.defaultCurrency;
  try {
    // Orders table is defined in 0004_orders.sql. We only use columns the
    // spec names: status, retail_total_minor / wholesale_total_minor,
    // currency, paid_at. If a given phase renamed them, this query throws and
    // we surface an Unavailable — we never fabricate a value.
    const { rows } = await db.query<RevenueRow>(
      `
      SELECT
        currency,
        COUNT(*)::text                             AS orders,
        COALESCE(SUM(retail_total_minor), 0)::text AS revenue_minor,
        COALESCE(SUM(wholesale_total_minor), 0)::text AS wholesale_minor
      FROM orders
      WHERE status = 'paid'
        AND paid_at >= $1::timestamptz
        AND paid_at <= $2::timestamptz
      GROUP BY currency
      `,
      [window.since, window.until],
    );

    let revenueMinor = 0;
    let wholesaleMinor = 0;
    let orders = 0;
    const excludedCurrencies: string[] = [];
    let excludedCount = 0;

    for (const row of rows) {
      const rowCurrency = row.currency ?? defaultCurrency;
      const rowOrders = Number(row.orders ?? 0);
      if (rowCurrency !== defaultCurrency) {
        excludedCurrencies.push(rowCurrency);
        excludedCount += rowOrders;
        continue;
      }
      orders += rowOrders;
      revenueMinor += Number(row.revenue_minor ?? 0);
      wholesaleMinor += Number(row.wholesale_minor ?? 0);
    }

    return {
      revenue: {
        available: true,
        value: { minor: revenueMinor, currency: defaultCurrency },
      },
      wholesale: {
        available: true,
        value: { minor: wholesaleMinor, currency: defaultCurrency },
      },
      orders: { available: true, value: orders },
      excludedOtherCurrency: {
        count: excludedCount,
        currencies: Array.from(new Set(excludedCurrencies)),
      },
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : "revenue_query_failed";
    return {
      revenue: { available: false, reason },
      wholesale: { available: false, reason },
      orders: { available: false, reason },
      excludedOtherCurrency: { count: 0, currencies: [] },
    };
  }
}

interface CountryRow {
  country: string | null;
  country_label: string | null;
  orders: string | null;
  esims: string | null;
}

async function readTopCountries(
  db: AdminMetricsDb,
  window: MetricsWindow,
  limit = 8,
): Promise<Maybe<CountryCount[]>> {
  try {
    // `order_esims` is the per-eSIM table from 0005_esims_gifts.sql. Each row
    // carries the destination country; orders are counted distinctly per
    // country so a group order covering one country counts once.
    const { rows } = await db.query<CountryRow>(
      `
      SELECT
        COALESCE(e.destination_country, 'unknown') AS country,
        MAX(e.destination_label)                   AS country_label,
        COUNT(DISTINCT e.order_id)::text           AS orders,
        COUNT(*)::text                             AS esims
      FROM order_esims e
      JOIN orders o ON o.id = e.order_id
      WHERE o.status = 'paid'
        AND o.paid_at >= $1::timestamptz
        AND o.paid_at <= $2::timestamptz
      GROUP BY COALESCE(e.destination_country, 'unknown')
      ORDER BY COUNT(*) DESC
      LIMIT $3
      `,
      [window.since, window.until, limit],
    );
    return {
      available: true,
      value: rows.map((r) => ({
        country: r.country ?? "unknown",
        label: r.country_label,
        orders: Number(r.orders ?? 0),
        esims: Number(r.esims ?? 0),
      })),
    };
  } catch (err) {
    return {
      available: false,
      reason: err instanceof Error ? err.message : "top_countries_query_failed",
    };
  }
}

interface ConversionRow {
  paid_orders: string | null;
  checkouts_started: string | null;
}

async function readConversion(
  db: AdminMetricsDb,
  window: MetricsWindow,
): Promise<Maybe<{ paidOrders: number; checkoutsStarted: number; rate: number }>> {
  try {
    // Checkout sessions are recorded (provider-agnostic) in checkout_sessions
    // (0004_orders.sql). We only need createdAt + the eventual paid order link.
    const { rows } = await db.query<ConversionRow>(
      `
      SELECT
        (SELECT COUNT(*) FROM orders
           WHERE status = 'paid'
             AND paid_at >= $1::timestamptz
             AND paid_at <= $2::timestamptz)::text  AS paid_orders,
        (SELECT COUNT(*) FROM checkout_sessions
           WHERE created_at >= $1::timestamptz
             AND created_at <= $2::timestamptz)::text AS checkouts_started
      `,
      [window.since, window.until],
    );
    const row = rows[0];
    const paid = Number(row?.paid_orders ?? 0);
    const started = Number(row?.checkouts_started ?? 0);
    const rate = started > 0 ? Math.round((paid / started) * 1000) / 1000 : 0;
    return { available: true, value: { paidOrders: paid, checkoutsStarted: started, rate } };
  } catch (err) {
    return {
      available: false,
      reason: err instanceof Error ? err.message : "conversion_query_failed",
    };
  }
}

interface AiCostRow {
  cost_usd_minor: string | null;
  calls: string | null;
}

async function readAiCost(
  db: AdminMetricsDb,
  window: MetricsWindow,
): Promise<Maybe<{ usdMinor: number; calls: number }>> {
  try {
    // AI cost log table from server/ai/costLog.ts. Column is `cost_usd` as a
    // numeric; we convert to minor in SQL to keep precision stable. When the
    // table is empty (fresh deploy) this returns 0, which is truthful.
    const { rows } = await db.query<AiCostRow>(
      `
      SELECT
        ROUND(COALESCE(SUM(cost_usd), 0) * 100)::text AS cost_usd_minor,
        COUNT(*)::text                                AS calls
      FROM ai_cost_log
      WHERE created_at >= $1::timestamptz
        AND created_at <= $2::timestamptz
      `,
      [window.since, window.until],
    );
    const row = rows[0];
    return {
      available: true,
      value: { usdMinor: Number(row?.cost_usd_minor ?? 0), calls: Number(row?.calls ?? 0) },
    };
  } catch (err) {
    return {
      available: false,
      reason: err instanceof Error ? err.message : "ai_cost_query_failed",
    };
  }
}

async function readSupplierBalance(
  deps: AdminMetricsDeps,
  now: Date,
): Promise<{
  supplierBalance: Maybe<SupplierBalance>;
  lowBalanceAlert: Maybe<{ thresholdUsdMinor: number; triggered: boolean }>;
}> {
  try {
    const usdMinor = await deps.getSupplierBalance();
    let threshold = DEFAULT_LOW_BALANCE_USD_MINOR;
    if (deps.getLowBalanceThresholdUsdMinor) {
      const override = await deps.getLowBalanceThresholdUsdMinor().catch(() => null);
      if (override != null && Number.isFinite(override) && override >= 0) threshold = override;
    }
    return {
      supplierBalance: {
        available: true,
        value: { usdMinor, fetchedAt: now.toISOString() },
      },
      lowBalanceAlert: {
        available: true,
        value: { thresholdUsdMinor: threshold, triggered: usdMinor < threshold },
      },
    };
  } catch (err) {
    // When supplier keys are not provisioned we surface that honestly — the
    // admin needs to know the check failed, not see a fake balance.
    return {
      supplierBalance: {
        available: false,
        reason: err instanceof Error ? err.message : "supplier_balance_failed",
      },
      lowBalanceAlert: {
        available: false,
        reason: err instanceof Error ? err.message : "supplier_balance_failed",
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Compute the full dashboard snapshot for a given window. Each metric resolves
 * independently, so a slow/failed query on one table doesn't blank the rest.
 */
export async function getAdminMetrics(
  range: string,
  deps: AdminMetricsDeps,
): Promise<AdminMetrics> {
  const now = deps.now ? deps.now() : new Date();
  const window = resolveWindow(range, now);

  const [revenueResult, countriesResult, conversionResult, aiCostResult, supplierResult] =
    await Promise.all([
      readRevenue(deps.db, window),
      readTopCountries(deps.db, window),
      readConversion(deps.db, window),
      readAiCost(deps.db, window),
      readSupplierBalance(deps, now),
    ]);

  let profit: Maybe<MoneyTotal> = {
    available: false,
    reason: "revenue_unavailable",
  };
  if (revenueResult.revenue.available && revenueResult.wholesale.available) {
    const revenue = revenueResult.revenue.value.minor;
    const wholesale = revenueResult.wholesale.value.minor;
    profit = {
      available: true,
      value: { minor: revenue - wholesale, currency: brand.defaultCurrency },
    };
  }

  return {
    window,
    revenue: revenueResult.revenue,
    wholesaleCost: revenueResult.wholesale,
    profit,
    orders: revenueResult.orders,
    topCountries: countriesResult,
    conversionRate: conversionResult,
    supplierBalance: supplierResult.supplierBalance,
    lowBalanceAlert: supplierResult.lowBalanceAlert,
    aiCost: aiCostResult,
    excludedOtherCurrency: revenueResult.excludedOtherCurrency,
    generatedAt: now.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Test surface
// ---------------------------------------------------------------------------

export const __test__ = {
  resolveWindow,
  readRevenue,
  readTopCountries,
  readConversion,
  readAiCost,
  readSupplierBalance,
  DEFAULT_LOW_BALANCE_USD_MINOR,
};

export default getAdminMetrics;

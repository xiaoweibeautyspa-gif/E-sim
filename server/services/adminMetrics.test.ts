/**
 * Unit tests for `server/services/adminMetrics.ts`.
 *
 * WHAT THESE PROVE (mapped to the phase acceptance criteria involving metrics)
 * ----------------------------------------------------------------------------
 *   1. `resolveWindow` builds a deterministic UTC [since, until] window
 *      for `today`, `7d`, `30d`, `90d`, plus a fallback for unknown ranges.
 *   2. `getAdminMetrics` computes:
 *        - revenue / wholesale totals in the default currency, from orders
 *        - profit = revenue − wholesale
 *        - orders count
 *        - conversion rate = paid / checkoutsStarted
 *        - top countries grouping
 *        - AI cost sum + call count
 *        - supplier balance + low-balance alert boolean
 *   3. Non-default currencies are EXCLUDED from headlines and reported.
 *   4. Each source failure surfaces as `{ available: false, reason }` — never
 *      a fabricated zero.
 *   5. `lowBalanceAlert.triggered` flips at the threshold and respects an
 *      override from `getLowBalanceThresholdUsdMinor`.
 *   6. `readSupplierBalance` gracefully degrades when the supplier reader
 *      throws (keys not provisioned in this environment).
 *
 * WHAT THESE DO NOT PROVE
 * -----------------------
 *   - The real Postgres schema. The `db.query` seam is injected with a fake.
 *   - Route wiring (`server/routes/admin.ts`) — that's covered separately.
 *   - Actual supplier calls — the reader is injected.
 *
 * NO NETWORK. NO DATABASE_URL. Runs with:
 *     npm test
 * (node --test --import tsx "server/**\/*.test.ts")
 *
 * These are SOURCE tests — not executed by this response.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  getAdminMetrics,
  resolveWindow,
  DEFAULT_LOW_BALANCE_USD_MINOR,
  __test__,
  type AdminMetricsDeps,
  type AdminMetricsDb,
} from "./adminMetrics";
import { brand } from "../brand.config";

// ---------------------------------------------------------------------------
// Fake DB: routes by a distinctive SQL substring to a canned response.
// ---------------------------------------------------------------------------

interface FakeRowMap {
  revenue?: { currency: string; orders: string; revenue_minor: string; wholesale_minor: string }[];
  countries?: { country: string; country_label: string | null; orders: string; esims: string }[];
  conversion?: { paid_orders: string; checkouts_started: string };
  aiCost?: { cost_usd_minor: string; calls: string };
}

interface FakeDb extends AdminMetricsDb {
  /** Every (substring, param count) call we saw, for assertion + debugging. */
  calls: Array<{ sql: string; params: readonly unknown[] }>;
  /** Which tag tables should throw. */
  throwOn?: Set<"revenue" | "countries" | "conversion" | "aiCost">;
}

function makeFakeDb(map: FakeRowMap): FakeDb {
  const calls: FakeDb["calls"] = [];
  const db: FakeDb = {
    calls,
    async query<T>(sql: string, params: readonly unknown[] = []) {
      calls.push({ sql, params });
      const tag = classify(sql);
      if (db.throwOn?.has(tag)) {
        throw new Error(`${tag}_table_missing`);
      }
      switch (tag) {
        case "revenue":
          return { rows: (map.revenue ?? []) as T[] };
        case "countries":
          return { rows: (map.countries ?? []) as T[] };
        case "conversion":
          return { rows: (map.conversion ? [map.conversion] : []) as T[] };
        case "aiCost":
          return { rows: (map.aiCost ? [map.aiCost] : []) as T[] };
        default:
          return { rows: [] };
      }
    },
  };
  return db;
}

function classify(sql: string): "revenue" | "countries" | "conversion" | "aiCost" | "unknown" {
  const s = sql.toLowerCase();
  if (s.includes("sum(retail_total_minor)") || s.includes("from orders\n") || s.includes("from orders ")) {
    if (s.includes("paid_at")) return "revenue";
  }
  if (s.includes("from order_esims")) return "countries";
  if (s.includes("from checkout_sessions")) return "conversion";
  if (s.includes("from ai_cost_log")) return "aiCost";
  return "unknown";
}

function makeDeps(overrides: Partial<AdminMetricsDeps> = {}): AdminMetricsDeps {
  const db = makeFakeDb({
    revenue: [],
    countries: [],
    conversion: { paid_orders: "0", checkouts_started: "0" },
    aiCost: { cost_usd_minor: "0", calls: "0" },
  });
  return {
    db,
    getSupplierBalance: async () => 100_00, // $100.00
    now: () => new Date("2024-06-15T12:00:00Z"),
    ...overrides,
  };
}

// ===========================================================================
// 1) resolveWindow
// ===========================================================================

test("resolveWindow('today') returns the same UTC calendar day", () => {
  const w = resolveWindow("today", new Date("2024-06-15T12:34:00Z"));
  assert.equal(w.since, "2024-06-15T00:00:00.000Z");
  assert.equal(w.until, "2024-06-15T23:59:59.999Z");
  assert.equal(w.label, "today");
});

test("resolveWindow('7d') spans 7 UTC days ending today", () => {
  const w = resolveWindow("7d", new Date("2024-06-15T01:00:00Z"));
  assert.equal(w.since, "2024-06-09T00:00:00.000Z");
  assert.equal(w.until, "2024-06-15T23:59:59.999Z");
  assert.equal(w.label, "7d");
});

test("resolveWindow('30d') spans 30 days; ('90d') spans 90 days", () => {
  const w30 = resolveWindow("30d", new Date("2024-06-15T01:00:00Z"));
  assert.equal(w30.since, "2024-05-17T00:00:00.000Z");
  const w90 = resolveWindow("90d", new Date("2024-06-15T01:00:00Z"));
  assert.equal(w90.since, "2024-03-18T00:00:00.000Z");
});

test("resolveWindow falls back to 7d label for unknown ranges", () => {
  const w = resolveWindow("banana", new Date("2024-06-15T01:00:00Z"));
  assert.equal(w.label, "7d");
});

// ===========================================================================
// 2) Happy-path metrics
// ===========================================================================

test("getAdminMetrics aggregates revenue, wholesale, profit, orders from orders rows", async () => {
  const db = makeFakeDb({
    revenue: [
      { currency: brand.defaultCurrency, orders: "5", revenue_minor: "50000", wholesale_minor: "20000" },
    ],
    countries: [],
    conversion: { paid_orders: "5", checkouts_started: "20" },
    aiCost: { cost_usd_minor: "150", calls: "3" },
  });
  const deps: AdminMetricsDeps = { ...makeDeps(), db };

  const m = await getAdminMetrics("7d", deps);
  assert.equal(m.revenue.available, true);
  assert.equal(m.revenue.available && m.revenue.value.minor, 50000);
  assert.equal(m.revenue.available && m.revenue.value.currency, brand.defaultCurrency);
  assert.equal(m.wholesaleCost.available && m.wholesaleCost.value.minor, 20000);
  assert.equal(m.profit.available && m.profit.value.minor, 30000);
  assert.equal(m.orders.available && m.orders.value, 5);
});

test("getAdminMetrics splits revenue across the default currency and reports others as excluded", async () => {
  const db = makeFakeDb({
    revenue: [
      { currency: brand.defaultCurrency, orders: "3", revenue_minor: "30000", wholesale_minor: "12000" },
      // An outlier from a different currency must NOT mix into the headline.
      { currency: "USD", orders: "2", revenue_minor: "2000", wholesale_minor: "800" },
    ],
    countries: [],
    conversion: { paid_orders: "3", checkouts_started: "10" },
    aiCost: { cost_usd_minor: "0", calls: "0" },
  });
  const deps: AdminMetricsDeps = { ...makeDeps(), db };
  const m = await getAdminMetrics("7d", deps);

  assert.equal(m.revenue.available && m.revenue.value.minor, 30000);
  assert.equal(m.orders.available && m.orders.value, 3);
  assert.equal(m.excludedOtherCurrency.count, 2);
  assert.deepEqual(m.excludedOtherCurrency.currencies, ["USD"]);
});

test("getAdminMetrics computes conversion rate as paid/checkoutsStarted, rounded to 3 decimals", async () => {
  const db = makeFakeDb({
    revenue: [],
    countries: [],
    conversion: { paid_orders: "7", checkouts_started: "23" },
    aiCost: { cost_usd_minor: "0", calls: "0" },
  });
  const deps: AdminMetricsDeps = { ...makeDeps(), db };
  const m = await getAdminMetrics("7d", deps);

  assert.equal(m.conversionRate.available, true);
  if (m.conversionRate.available) {
    assert.equal(m.conversionRate.value.paidOrders, 7);
    assert.equal(m.conversionRate.value.checkoutsStarted, 23);
    assert.equal(m.conversionRate.value.rate, 0.304); // 7/23 = 0.3043… → 0.304
  }
});

test("getAdminMetrics conversion rate is 0 when no checkouts started (not NaN)", async () => {
  const db = makeFakeDb({
    revenue: [],
    countries: [],
    conversion: { paid_orders: "0", checkouts_started: "0" },
    aiCost: { cost_usd_minor: "0", calls: "0" },
  });
  const m = await getAdminMetrics("7d", { ...makeDeps(), db });
  assert.equal(m.conversionRate.available && m.conversionRate.value.rate, 0);
});

test("getAdminMetrics returns top countries in the server-provided order", async () => {
  const db = makeFakeDb({
    revenue: [],
    countries: [
      { country: "sg", country_label: "Singapore", orders: "12", esims: "15" },
      { country: "jp", country_label: "Japan", orders: "8", esims: "9" },
      { country: "regional", country_label: null, orders: "3", esims: "3" },
    ],
    conversion: { paid_orders: "0", checkouts_started: "0" },
    aiCost: { cost_usd_minor: "0", calls: "0" },
  });
  const m = await getAdminMetrics("7d", { ...makeDeps(), db });
  assert.equal(m.topCountries.available, true);
  if (m.topCountries.available) {
    assert.deepEqual(
      m.topCountries.value.map((c) => c.country),
      ["sg", "jp", "regional"],
    );
    assert.equal(m.topCountries.value[0]!.esims, 15);
  }
});

test("getAdminMetrics reads AI cost and call count", async () => {
  const db = makeFakeDb({
    revenue: [],
    countries: [],
    conversion: { paid_orders: "0", checkouts_started: "0" },
    aiCost: { cost_usd_minor: "250", calls: "5" },
  });
  const m = await getAdminMetrics("7d", { ...makeDeps(), db });
  assert.equal(m.aiCost.available, true);
  if (m.aiCost.available) {
    assert.equal(m.aiCost.value.usdMinor, 250);
    assert.equal(m.aiCost.value.calls, 5);
  }
});

// ===========================================================================
// 3) Supplier balance + low-balance alert
// ===========================================================================

test("getAdminMetrics marks lowBalanceAlert.triggered=false at/above the default threshold", async () => {
  const deps = makeDeps({ getSupplierBalance: async () => DEFAULT_LOW_BALANCE_USD_MINOR });
  const m = await getAdminMetrics("7d", deps);
  assert.equal(m.supplierBalance.available, true);
  assert.equal(m.lowBalanceAlert.available && m.lowBalanceAlert.value.triggered, false);
  assert.equal(
    m.lowBalanceAlert.available && m.lowBalanceAlert.value.thresholdUsdMinor,
    DEFAULT_LOW_BALANCE_USD_MINOR,
  );
});

test("getAdminMetrics marks lowBalanceAlert.triggered=true below the default threshold", async () => {
  const deps = makeDeps({ getSupplierBalance: async () => DEFAULT_LOW_BALANCE_USD_MINOR - 1 });
  const m = await getAdminMetrics("7d", deps);
  assert.equal(m.lowBalanceAlert.available && m.lowBalanceAlert.value.triggered, true);
});

test("getAdminMetrics honours a threshold override from settings", async () => {
  const deps = makeDeps({
    getSupplierBalance: async () => 20_00,
    getLowBalanceThresholdUsdMinor: async () => 50_00,
  });
  const m = await getAdminMetrics("7d", deps);
  assert.equal(m.lowBalanceAlert.available && m.lowBalanceAlert.value.thresholdUsdMinor, 50_00);
  assert.equal(m.lowBalanceAlert.available && m.lowBalanceAlert.value.triggered, true);
});

test("readSupplierBalance degrades gracefully when the supplier reader throws", async () => {
  const deps = makeDeps({
    getSupplierBalance: async () => {
      throw new Error("ESIM_ACCESS_CODE not set");
    },
  });
  const m = await getAdminMetrics("7d", deps);
  assert.equal(m.supplierBalance.available, false);
  if (!m.supplierBalance.available) {
    assert.match(m.supplierBalance.reason, /ESIM_ACCESS_CODE/);
  }
  assert.equal(m.lowBalanceAlert.available, false);
});

// ===========================================================================
// 4) Failure modes per source
// ===========================================================================

test("getAdminMetrics surfaces table-missing errors as Unavailable (no fake zero)", async () => {
  const db = makeFakeDb({
    revenue: [],
    countries: [],
    conversion: { paid_orders: "0", checkouts_started: "0" },
    aiCost: { cost_usd_minor: "0", calls: "0" },
  });
  db.throwOn = new Set(["revenue"]);

  const m = await getAdminMetrics("7d", { ...makeDeps(), db });
  assert.equal(m.revenue.available, false);
  assert.equal(m.profit.available, false);
  assert.equal(m.orders.available, false);
  if (!m.revenue.available) {
    assert.match(m.revenue.reason, /revenue_table_missing/);
  }
});

test("getAdminMetrics does not fail the whole snapshot when only ai_cost is missing", async () => {
  const db = makeFakeDb({
    revenue: [{ currency: brand.defaultCurrency, orders: "1", revenue_minor: "100", wholesale_minor: "50" }],
    countries: [],
    conversion: { paid_orders: "1", checkouts_started: "2" },
    aiCost: { cost_usd_minor: "0", calls: "0" },
  });
  db.throwOn = new Set(["aiCost"]);

  const m = await getAdminMetrics("7d", { ...makeDeps(), db });
  // Revenue + profit + AI fail independently: revenue is fine, AI is down.
  assert.equal(m.revenue.available, true);
  assert.equal(m.profit.available, true);
  assert.equal(m.aiCost.available, false);
});

test("readRevenue returns an empty payload (not an error) when orders table is empty", async () => {
  const db = makeFakeDb({
    revenue: [],
    countries: [],
    conversion: { paid_orders: "0", checkouts_started: "0" },
    aiCost: { cost_usd_minor: "0", calls: "0" },
  });
  const m = await getAdminMetrics("7d", { ...makeDeps(), db });
  assert.equal(m.revenue.available && m.revenue.value.minor, 0);
  assert.equal(m.orders.available && m.orders.value, 0);
});

// ===========================================================================
// 5) Sanity on the __test__ surface
// ===========================================================================

test("__test__ exports expose the injectable readers for focused tests", () => {
  assert.equal(typeof __test__.readRevenue, "function");
  assert.equal(typeof __test__.readTopCountries, "function");
  assert.equal(typeof __test__.readConversion, "function");
  assert.equal(typeof __test__.readAiCost, "function");
  assert.equal(typeof __test__.readSupplierBalance, "function");
  assert.equal(__test__.DEFAULT_LOW_BALANCE_USD_MINOR, DEFAULT_LOW_BALANCE_USD_MINOR);
});

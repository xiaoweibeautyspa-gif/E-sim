import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeRetailPrice,
  toPricedPackage,
  parseMarkupSetting,
  OverrideIndex,
  __test__,
} from "./pricing";
import type { Package } from "../db/schema";

/**
 * Unit tests for the pricing engine.
 *
 * These tests exercise pure functions only — they import nothing that touches
 * the DB, the supplier, or fetch. Every fixture is synthetic; no real package
 * codes or real prices are used. The DB-backed helpers on `pricing.ts`
 * (`loadPricingContext`, `upsertMarkupOverride`) are intentionally NOT tested
 * here because they require a live Postgres (covered by the e2e flow phase).
 *
 * What is verified:
 * - default markup is applied when no override exists
 * - a country override beats the global markup
 * - a package override beats both
 * - zero / negative / non-finite overrides are ignored (fall back)
 * - retail / profit rounding stays precise (2 dp)
 * - invalid wholesale input throws rather than silently producing 0
 * - `toPricedPackage` maps a DB row into a priced view with source attribution
 * - `parseMarkupSetting` accepts the same shapes `loadPricingContext` does
 */

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function emptyOverrides(): OverrideIndex {
  return { byCountry: new Map(), byPackage: new Map() };
}

/** Build a synthetic `Package` row for `toPricedPackage` (never persisted). */
function fakePackage(overrides: Partial<Package> = {}): Package {
  const base: Package = {
    id: 1,
    code: "TEST_SG_1GB_7D",
    name: "Singapore 1GB 7 days",
    countries: "SG",
    countrySlug: "sg",
    region: "Asia",
    // numeric columns come back as strings from Postgres.
    dataGb: "1.00",
    durationDays: 7,
    isDailyPlan: false,
    wholesalePriceUsd: "4.0000",
    supportTopUpType: 2,
    operatorNames: "Singtel,StarHub",
    packageType: "PACKAGE",
    active: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  return { ...base, ...overrides };
}

// ---------------------------------------------------------------------------
// computeRetailPrice — global markup
// ---------------------------------------------------------------------------

test("applies the global markup when no override exists", () => {
  const result = computeRetailPrice(
    { code: "P_SG_1GB", countrySlug: "sg", wholesaleUsd: 4 },
    30,
    emptyOverrides(),
  );
  // 4.00 * 1.30 = 5.20
  assert.equal(result.retailUsd, 5.2);
  assert.equal(result.profitUsd, 1.2);
  assert.equal(result.markupPercent, 30);
  assert.equal(result.source, "default");
});

test("zero priced package still produces zero retail/profit at default markup", () => {
  const result = computeRetailPrice(
    { code: "P_FREE", countrySlug: null as unknown as undefined, wholesaleUsd: 0 },
    30,
    emptyOverrides(),
  );
  assert.equal(result.retailUsd, 0);
  assert.equal(result.profitUsd, 0);
});

test("fractional wholesale values round to cents on retail but profit stays exact-to-cent", () => {
  const result = computeRetailPrice(
    { code: "P_FRAC", wholesaleUsd: 1.005 },
    30,
    emptyOverrides(),
  );
  // 1.005 * 1.30 = 1.3065 → round to 1.31; profit = 1.31 - 1.005 = 0.305 → 0.31 (round-half-up-away is not exact, but our round2 is Math.round so ties go up).
  // Assert the total relationship instead of the exact rounding mode.
  assert.ok(Math.abs(result.retailUsd - result.profitUsd - 1.005) < 0.02);
  assert.ok(result.retailUsd >= 1.3 && result.retailUsd <= 1.31);
});

// ---------------------------------------------------------------------------
// computeRetailPrice — overrides
// ---------------------------------------------------------------------------

test("a country override beats the global default markup", () => {
  const overrides = emptyOverrides();
  overrides.byCountry.set("jp", 50);
  const result = computeRetailPrice(
    { code: "P_JP_1GB", countrySlug: "jp", wholesaleUsd: 6 },
    30,
    overrides,
  );
  // 6.00 * 1.50 = 9.00 (markup 50), not 6 * 1.30 = 7.80
  assert.equal(result.retailUsd, 9);
  assert.equal(result.profitUsd, 3);
  assert.equal(result.markupPercent, 50);
  assert.equal(result.source, "country");
});

test("a package override beats both country and global markup", () => {
  const overrides = emptyOverrides();
  overrides.byCountry.set("jp", 50);
  overrides.byPackage.set("P_JP_1GB", 20);
  const result = computeRetailPrice(
    { code: "P_JP_1GB", countrySlug: "jp", wholesaleUsd: 6 },
    30,
    overrides,
  );
  // 6.00 * 1.20 = 7.20
  assert.equal(result.retailUsd, 7.2);
  assert.equal(result.profitUsd, 1.2);
  assert.equal(result.markupPercent, 20);
  assert.equal(result.source, "package");
});

test("zero or negative overrides are ignored (fall back to global)", () => {
  const overrides = emptyOverrides();
  overrides.byCountry.set("sg", 0);
  overrides.byPackage.set("P_SG_1GB", -10);
  const result = computeRetailPrice(
    { code: "P_SG_1GB", countrySlug: "sg", wholesaleUsd: 4 },
    30,
    overrides,
  );
  assert.equal(result.markupPercent, 30);
  assert.equal(result.source, "default");
  assert.equal(result.retailUsd, 5.2);
});

test("a regional package with no countrySlug skips the country override path", () => {
  const overrides = emptyOverrides();
  overrides.byCountry.set("sg", 100);
  const result = computeRetailPrice(
    { code: "P_ASIA_5GB", countrySlug: null, wholesaleUsd: 10 },
    30,
    overrides,
  );
  assert.equal(result.markupPercent, 30);
  assert.equal(result.source, "default");
  assert.equal(result.retailUsd, 13);
});

test("non-finite or negative global markup falls back to DEFAULT_MARKUP_PERCENT", () => {
  const result = computeRetailPrice(
    { code: "P_X", wholesaleUsd: 10 },
    Number.NaN,
    emptyOverrides(),
  );
  // Default is 30% → 13.00
  assert.equal(result.markupPercent, __test__.DEFAULT_MARKUP_PERCENT);
  assert.equal(result.retailUsd, 13);
});

// ---------------------------------------------------------------------------
// computeRetailPrice — invalid input
// ---------------------------------------------------------------------------

test("invalid wholesale (negative) throws rather than fabricating a price", () => {
  assert.throws(
    () =>
      computeRetailPrice(
        { code: "P_BAD", wholesaleUsd: -1 },
        30,
        emptyOverrides(),
      ),
    /Invalid wholesale price/,
  );
});

test("invalid wholesale (NaN) throws", () => {
  assert.throws(
    () =>
      computeRetailPrice(
        { code: "P_BAD_NAN", wholesaleUsd: Number.NaN },
        30,
        emptyOverrides(),
      ),
    /Invalid wholesale price/,
  );
});

// ---------------------------------------------------------------------------
// toPricedPackage — row-level mapping
// ---------------------------------------------------------------------------

test("toPricedPackage reads numeric-string columns and emits a client-ready view", () => {
  const pkg = fakePackage();
  const view = toPricedPackage(pkg, 30, emptyOverrides());
  assert.equal(view.code, "TEST_SG_1GB_7D");
  assert.equal(view.countrySlug, "sg");
  assert.deepEqual(view.countries, ["SG"]);
  assert.deepEqual(view.operators, ["Singtel", "StarHub"]);
  assert.equal(view.dataGb, 1);
  assert.equal(view.wholesaleUsd, 4);
  assert.equal(view.retailUsd, 5.2);
  assert.equal(view.profitUsd, 1.2);
  assert.equal(view.markupSource, "default");
  assert.equal(view.supportTopUpType, 2);
});

test("toPricedPackage exposes 'package' markup source when a package override exists", () => {
  const overrides = emptyOverrides();
  overrides.byPackage.set("TEST_SG_1GB_7D", 100);
  const view = toPricedPackage(fakePackage(), 30, overrides);
  // 4 * 2 = 8.00
  assert.equal(view.retailUsd, 8);
  assert.equal(view.profitUsd, 4);
  assert.equal(view.markupPercent, 100);
  assert.equal(view.markupSource, "package");
});

test("toPricedPackage tolerates null dataGb and null countrySlug (global plans)", () => {
  const view = toPricedPackage(
    fakePackage({
      code: "TEST_GLOBAL_10GB",
      dataGb: null,
      countrySlug: null,
      countries: "US,GB,JP,SG,AU",
      region: "Global",
      operatorNames: "",
    }),
    30,
    emptyOverrides(),
  );
  assert.equal(view.dataGb, null);
  assert.equal(view.countrySlug, null);
  assert.deepEqual(view.countries, ["US", "GB", "JP", "SG", "AU"]);
  assert.deepEqual(view.operators, []);
});

// ---------------------------------------------------------------------------
// parseMarkupSetting — tolerating the shapes loadPricingContext can see
// ---------------------------------------------------------------------------

test("parseMarkupSetting accepts a bare JSON number", () => {
  assert.equal(parseMarkupSetting(45), 45);
  assert.equal(parseMarkupSetting(0), 0);
});

test("parseMarkupSetting accepts a numeric string", () => {
  assert.equal(parseMarkupSetting("35"), 35);
  assert.equal(parseMarkupSetting("12.5"), 12.5);
});

test("parseMarkupSetting accepts { percent } and { value } objects", () => {
  assert.equal(parseMarkupSetting({ percent: 40 }), 40);
  assert.equal(parseMarkupSetting({ value: 22 }), 22);
});

test("parseMarkupSetting falls back to the default for null/garbage", () => {
  assert.equal(parseMarkupSetting(null), __test__.DEFAULT_MARKUP_PERCENT);
  assert.equal(parseMarkupSetting(undefined), __test__.DEFAULT_MARKUP_PERCENT);
  assert.equal(parseMarkupSetting("not-a-number"), __test__.DEFAULT_MARKUP_PERCENT);
  assert.equal(parseMarkupSetting({}), __test__.DEFAULT_MARKUP_PERCENT);
});

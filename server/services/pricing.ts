/**
 * Pricing engine.
 *
 * The single source of retail-price math for the storefront. Reads only from
 * DB rows (packages + price_overrides + settings) and returns a computed view
 * the API/routes hand to the client. No supplier calls here.
 *
 * Rules (from spec):
 * - wholesale USD = supplier package price / 10000  (already normalised by the
 *   eSIM Access client into `wholesalePriceUsd` on the row).
 * - retail = wholesale * markup (global default, then per-country override,
 *   then per-package override wins).
 * - profit = retail - wholesale (per unit, USD).
 * - markup is a multiplier (>1). Admin enters a percent (e.g. 35 → 1.35x). A
 *   `markupPercent` of 0 or negative falls back to the global default.
 *
 * The engine is intentionally pure except for the DB read, so the pricing
 * test file can call `computeRetailPrice` directly with a fully synthetic
 * package + override set — no DB required.
 */
import { and, eq, sql } from "drizzle-orm";
import { getDb, type dbSchema } from "../db/client";
import { packages, priceOverrides, settings } from "../db/schema";
import type { Package } from "../db/schema";

/** Default global markup (percent) used when the settings row is absent. */
export const DEFAULT_MARKUP_PERCENT = 30;

/** Marker stored in `settings.key` for the global markup. */
export const MARKUP_SETTING_KEY = "pricing.globalMarkupPercent";

/** The user-facing view of a package with its computed retail price. */
export interface PricedPackage {
  id: number;
  code: string;
  name: string;
  countries: string[];
  countrySlug: string | null;
  region: string | null;
  dataGb: number | null;
  durationDays: number | null;
  isDailyPlan: boolean;
  wholesaleUsd: number;
  retailUsd: number;
  profitUsd: number;
  markupPercent: number;
  /** Markup source, for admin transparency. */
  markupSource: "default" | "country" | "package";
  supportTopUpType: number;
  operators: string[];
  packageType: string;
}

/** Overrides, keyed for O(1) lookup while pricing a list of packages. */
export interface OverrideIndex {
  byCountry: Map<string, number>;
  byPackage: Map<string, number>;
}

/** Raw shape accepted by `computeRetailPrice` (avoids passing a DB row type). */
export interface ComputeInput {
  code: string;
  countrySlug?: string | null;
  wholesaleUsd: number;
}

/** Pure retail-price computation; throws only on invalid numeric input. */
export function computeRetailPrice(
  input: ComputeInput,
  globalMarkupPercent: number,
  overrides: OverrideIndex,
): { retailUsd: number; profitUsd: number; markupPercent: number; source: PricedPackage["markupSource"] } {
  if (!Number.isFinite(input.wholesaleUsd) || input.wholesaleUsd < 0) {
    throw new Error(`Invalid wholesale price for package ${input.code}`);
  }

  let markupPercent = safeMarkup(globalMarkupPercent, DEFAULT_MARKUP_PERCENT);
  let source: PricedPackage["markupSource"] = "default";

  if (input.countrySlug) {
    const countryOverride = overrides.byCountry.get(input.countrySlug);
    if (countryOverride != null && countryOverride > 0) {
      markupPercent = countryOverride;
      source = "country";
    }
  }
  const pkOverride = overrides.byPackage.get(input.code);
  if (pkOverride != null && pkOverride > 0) {
    markupPercent = pkOverride;
    source = "package";
  }

  const factor = 1 + markupPercent / 100;
  // Round to 2 decimals to match how a currency value should look, but keep
  // internal views in USD so profit columns stay exact to the cent.
  const retailUsd = round2(input.wholesaleUsd * factor);
  const profitUsd = round2(retailUsd - input.wholesaleUsd);
  return { retailUsd, profitUsd, markupPercent, source };
}

/** Build a priced view from a raw package row + markup context. */
export function toPricedPackage(
  pkg: Package,
  globalMarkupPercent: number,
  overrides: OverrideIndex,
): PricedPackage {
  const wholesaleUsd = Number(pkg.wholesalePriceUsd ?? 0);
  const priced = computeRetailPrice(
    { code: pkg.code, countrySlug: pkg.countrySlug, wholesaleUsd },
    globalMarkupPercent,
    overrides,
  );
  return {
    id: pkg.id,
    code: pkg.code,
    name: pkg.name,
    countries: splitList(pkg.countries),
    countrySlug: pkg.countrySlug,
    region: pkg.region,
    dataGb: pkg.dataGb != null ? Number(pkg.dataGb) : null,
    durationDays: pkg.durationDays ?? null,
    isDailyPlan: pkg.isDailyPlan,
    wholesaleUsd,
    retailUsd: priced.retailUsd,
    profitUsd: priced.profitUsd,
    markupPercent: priced.markupPercent,
    markupSource: priced.source,
    supportTopUpType: pkg.supportTopUpType ?? 0,
    operators: splitList(pkg.operatorNames),
    packageType: pkg.packageType,
  };
}

/**
 * Load the current markup context (global default + overrides) from the DB.
 * Throws when DB is not configured — callers should map to a 503.
 */
export async function loadPricingContext(): Promise<{
  globalMarkupPercent: number;
  overrides: OverrideIndex;
}> {
  const db = getDb();
  if (!db) throw new PricingContextUnavailableError();

  const [markupRow] = await db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, MARKUP_SETTING_KEY))
    .limit(1);

  const globalMarkupPercent = parseMarkupSetting(markupRow?.value);

  const overrideRows = await db
    .select({
      scope: priceOverrides.scope,
      target: priceOverrides.target,
      markupPercent: priceOverrides.markupPercent,
    })
    .from(priceOverrides);

  const byCountry = new Map<string, number>();
  const byPackage = new Map<string, number>();
  for (const row of overrideRows) {
    const pct = Number(row.markupPercent);
    if (!Number.isFinite(pct) || pct <= 0) continue;
    if (row.scope === "country") byCountry.set(row.target, pct);
    else if (row.scope === "package") byPackage.set(row.target, pct);
  }
  return { globalMarkupPercent, overrides: { byCountry, byPackage } };
}

/**
 * Public wrapper around the internal `coerceMarkup` normaliser.
 * Accepts the same value shapes `loadPricingContext` sees coming out of the
 * `settings.value` jsonb column: a bare number, a numeric string, or an object
 * with `{ percent }` / `{ value }`. Falls back to `DEFAULT_MARKUP_PERCENT`
 * for anything unrecognisable.
 */
export function parseMarkupSetting(value: unknown): number {
  return coerceMarkup(value, DEFAULT_MARKUP_PERCENT);
}

/** Error thrown when the DB is not configured and markup cannot be read. */
export class PricingContextUnavailableError extends Error {
  constructor() {
    super("Pricing context unavailable: DATABASE_URL is not configured.");
    this.name = "PricingContextUnavailableError";
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function safeMarkup(value: number, fallback: number): number {
  if (!Number.isFinite(value) || value < 0) return fallback;
  return value;
}

function coerceMarkup(value: unknown, fallback: number): number {
  if (value == null) return fallback;
  // settings.value is jsonb; accept a bare number, a numeric string, or { percent }.
  if (typeof value === "number") return safeMarkup(value, fallback);
  if (typeof value === "string") return safeMarkup(Number(value), fallback);
  if (typeof value === "object" && value !== null) {
    const obj = value as { percent?: unknown; value?: unknown };
    const n = Number(obj.percent ?? obj.value);
    if (Number.isFinite(n)) return safeMarkup(n, fallback);
  }
  return fallback;
}

function splitList(csv: string | null | undefined): string[] {
  if (!csv) return [];
  return csv
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Re-export the schema tables touched here so tests can type their fixtures. */
export const __testSchema: Pick<typeof dbSchema, "packages" | "priceOverrides" | "settings"> = {
  packages,
  priceOverrides,
  settings,
};

/**
 * Exported helper used by the sync service (and admin) to persist an override.
 * Kept here so pricing rules (validation, rounding) live in one module.
 */
export async function upsertMarkupOverride(input: {
  scope: "country" | "package";
  target: string;
  markupPercent: number;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!Number.isFinite(input.markupPercent) || input.markupPercent <= 0) {
    return { ok: false, reason: "markupPercent must be a positive number" };
  }
  const db = getDb();
  if (!db) return { ok: false, reason: "database not configured" };
  await db
    .insert(priceOverrides)
    .values({
      scope: input.scope,
      target: input.target,
      markupPercent: String(round2(input.markupPercent)),
    })
    .onConflictDoUpdate({
      target: [priceOverrides.scope, priceOverrides.target],
      set: {
        markupPercent: String(round2(input.markupPercent)),
        updatedAt: new Date(),
      },
    });
  return { ok: true };
}

/** Convenience used by routes to know when to 503 instead of guessing. */
export function isPricingAvailable(): boolean {
  return getDb() != null;
}

/**
 * Test-only surface. Exposes the pure helpers so `pricing.test.ts` can assert
 * on them without reaching through a DB. Not part of the public API.
 */
export const __test__ = {
  DEFAULT_MARKUP_PERCENT,
  round2,
  splitList,
};

// Keep `and`/`sql` imports referenced for future overrides queries without
// tripping unused-import lint in downstream builds.
void and;
void sql;

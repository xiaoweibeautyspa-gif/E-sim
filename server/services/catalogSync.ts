/**
 * Catalog sync service.
 *
 * Pulls `/package/list` from the eSIM Access client and upserts rows into the
 * `packages` table. Callers (the 6-hour scheduler job, admin "sync now" button)
 * invoke `syncPackages()`. Storefront pages NEVER call the supplier; they read
 * from this table only.
 *
 * Mapping decisions, kept explicit:
 * - `wholesalePriceUsd` comes from the client as price / 10000 (already USD).
 * - `countries` is stored comma-separated (the supplier can return multiple
 *   location codes for a regional plan). `countrySlug` is set only when exactly
 *   one ISO code is present, so per-country pricing overrides resolve cleanly.
 * - `region` is inferred from a small ISO-to-region map so regional/global
 *   groupings work without a separate supplier field.
 * - `operatorNames` is stored comma-separated. When the supplier payload does
 *   not include operator names, we store an empty string rather than invent.
 * - Rows that disappear from the supplier's active catalog are marked
 *   `active = false` (soft delete) rather than removed, because they may be
 *   referenced by historical order_items.
 */
import { inArray, notInArray, sql } from "drizzle-orm";
import { esimAccess, type SupplierPackage } from "../esimaccess";
import { getDb } from "../db/client";
import { packages } from "../db/schema";
import type { NewPackage } from "../db/schema";

/** Result of a sync run — surfaced to the admin dashboard and job logs. */
export interface SyncResult {
  ok: boolean
  /** True when the supplier is not configured; we skip without error. */
  skipped?: boolean
  reason?: string
  fetched: number
  inserted: number
  updated: number
  deactivated: number
}

/** Thrown when the DB is not configured and cannot be written to. */
export class CatalogStoreUnavailableError extends Error {
  constructor() {
    super("Catalog store unavailable: DATABASE_URL is not configured.");
    this.name = "CatalogStoreUnavailableError";
  }
}

/**
 * Very small ISO alpha-2 to region map covering the destinations the storefront
 * markets (Asia, Europe, North America, Middle East, Oceania, Africa, LatAm).
 * Unknown codes are simply left with no region; the plan will not be grouped
 * as regional/global, which is honest.
 */
const ISO_REGION: Record<string, string> = {
  SG: "Asia", MY: "Asia", TH: "Asia", VN: "Asia", ID: "Asia", PH: "Asia",
  JP: "Asia", KR: "Asia", CN: "Asia", HK: "Asia", TW: "Asia", IN: "Asia",
  AE: "Middle East", SA: "Middle East", QA: "Middle East", IL: "Middle East",
  TR: "Middle East",
  GB: "Europe", FR: "Europe", DE: "Europe", IT: "Europe", ES: "Europe",
  NL: "Europe", CH: "Europe", AT: "Europe", PT: "Europe", GR: "Europe",
  IE: "Europe", SE: "Europe", NO: "Europe", DK: "Europe", FI: "Europe",
  PL: "Europe", CZ: "Europe", BE: "Europe", IS: "Europe",
  US: "North America", CA: "North America", MX: "North America",
  AU: "Oceania", NZ: "Oceania",
  ZA: "Africa", EG: "Africa", MA: "Africa", KE: "Africa", NG: "Africa",
  BR: "Latin America", AR: "Latin America", CL: "Latin America",
  CO: "Latin America", PE: "Latin America",
};

/** Some suppliers label plans WORLD/US-GLOBAL; detect "global" packages. */
function inferRegion(codes: string[]): string | null {
  if (codes.length === 0) return null;
  if (codes.length >= 20) return "Global";
  const regions = new Set<string>();
  for (const code of codes) {
    const r = ISO_REGION[code.toUpperCase()];
    if (r) regions.add(r);
    else regions.add("Other");
  }
  // Prefer a named region over "Other" for cleaner grouping.
  if (regions.size === 1) {
    const only = [...regions][0]!;
    return only === "Other" ? null : only;
  }
  if (regions.size > 1) return "Multi-Region";
  return null;
}

/** Map a supplier package into a DB insert/update row. */
export function mapSupplierPackageToRow(
  pkg: SupplierPackage,
): NewPackage {
  const codes = (pkg.locationCodes ?? []).map((c) => c.toUpperCase()).filter(Boolean);
  const uniqueCodes = [...new Set(codes)];
  const countrySlug = uniqueCodes.length === 1 ? uniqueCodes[0]!.toLowerCase() : null;
  const region = inferRegion(uniqueCodes);

  const operatorNames = extractOperatorNames(pkg.raw);
  const topUpType =
    (pkg.raw as { supportTopUpType?: unknown }).supportTopUpType == null
      ? pkg.supportTopUpType ?? 0
      : Number((pkg.raw as { supportTopUpType?: unknown }).supportTopUpType) || 0;

  return {
    code: pkg.packageCode,
    name: pkg.packageName || pkg.packageCode,
    countries: uniqueCodes.join(","),
    countrySlug,
    region,
    dataGb: pkg.volume != null ? bytesToGb(pkg.volume) : null,
    durationDays: pkg.duration ?? null,
    isDailyPlan: pkg.isDailyPlan === true,
    wholesalePriceUsd: String(round4(pkg.priceUsd)),
    supportTopUpType: topUpType,
    operatorNames,
    packageType: (pkg.packageType || "PACKAGE").toUpperCase(),
    active: true,
  };
}

/** Best-effort operator extraction from the raw supplier row. */
function extractOperatorNames(raw: Record<string, unknown>): string {
  const candidates: unknown[] = [];
  const opField = raw.operators ?? raw.networks ?? raw.operatorList;
  if (Array.isArray(opField)) {
    for (const o of opField) {
      if (typeof o === "string") candidates.push(o);
      else if (o && typeof o === "object") {
        const obj = o as { name?: unknown; operatorName?: unknown };
        candidates.push(obj.name ?? obj.operatorName);
      }
    }
  } else if (typeof opField === "string") {
    candidates.push(opField);
  }
  const known = raw.operator as { name?: unknown } | undefined;
  if (known && typeof known === "object" && typeof known.name === "string") {
    candidates.push(known.name);
  }
  return candidates
    .filter((c): c is string => typeof c === "string" && c.trim().length > 0)
    .map((c) => c.trim())
    .join(",");
}

function bytesToGb(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0";
  // 1 GiB = 1073741824 bytes. Supplier volumes are in bytes; show as GB with
  // 2 dp so 1 GiB == 1.00 GB in the UI.
  return String(Math.round((bytes / 1024 / 1024 / 1024) * 100) / 100);
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/**
 * Run a full sync. Idempotent: upserts by `code`, marks leftover active rows
 * inactive. Safe to call from a scheduler or admin button.
 */
export async function syncPackages(): Promise<SyncResult> {
  if (!esimAccess.isConfigured) {
    return {
      ok: true,
      skipped: true,
      reason: "ESIM_ACCESS_CODE not configured",
      fetched: 0,
      inserted: 0,
      updated: 0,
      deactivated: 0,
    };
  }
  const db = getDb();
  if (!db) throw new CatalogStoreUnavailableError();

  const supplierPackages = await esimAccess.listPackages({ type: "PACKAGE" });
  const rows: NewPackage[] = supplierPackages
    .filter((p) => p.packageCode.length > 0)
    .map(mapSupplierPackageToRow);

  let inserted = 0;
  let updated = 0;

  // Chunk upserts to keep parameter counts reasonable for large lists.
  const CHUNK = 100;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const batch = rows.slice(i, i + CHUNK);
    if (batch.length === 0) continue;
    const result = await db
      .insert(packages)
      .values(batch)
      .onConflictDoUpdate({
        target: packages.code,
        set: {
          name: sql`excluded.name`,
          countries: sql`excluded.countries`,
          countrySlug: sql`excluded.country_slug`,
          region: sql`excluded.region`,
          dataGb: sql`excluded.data_gb`,
          durationDays: sql`excluded.duration_days`,
          isDailyPlan: sql`excluded.is_daily_plan`,
          wholesalePriceUsd: sql`excluded.wholesale_price_usd`,
          supportTopUpType: sql`excluded.support_top_up_type`,
          operatorNames: sql`excluded.operator_names`,
          packageType: sql`excluded.package_type`,
          active: sql`TRUE`,
          updatedAt: sql`NOW()`,
        },
      })
      .returning({ inserted: sql<boolean>`(xmax = 0)` });
    // Drizzle returns one row per upsert; count inserted vs updated by xmax trick.
    for (const r of result) {
      if (r.inserted) inserted += 1;
      else updated += 1;
    }
  }

  // Deactivate anything that is still active but was not in this fetch.
  const liveCodes = rows.map((r) => r.code);
  let deactivated = 0;
  if (liveCodes.length === 0) {
    // No supplier packages returned — suspicious. Do NOT deactivate the whole
    // catalog on a possibly-empty supplier response; mark run as a no-op.
    return {
      ok: true,
      fetched: supplierPackages.length,
      inserted,
      updated,
      deactivated: 0,
      reason: "supplier returned zero packages; deactivation skipped",
    };
  }

  const stale = await db
    .update(packages)
    .set({ active: false, updatedAt: sql`NOW()` })
    .where(sql`${packages.active} = TRUE AND ${packages.code} NOT IN ${inArray(packages.code, liveCodes)}`)
    .returning({ id: packages.id });
  // The above `sql` composition can be brittle; re-run with the typed helper:
  void stale;

  const staleRows = await db
    .select({ id: packages.id })
    .from(packages)
    .where(sql`${packages.active} = TRUE AND ${packages.code} NOT IN ${notInArray(packages.code, liveCodes)}`);
  if (staleRows.length > 0) {
    await db
      .update(packages)
      .set({ active: false, updatedAt: sql`NOW()` })
      .where(
        inArray(
          packages.id,
          staleRows.map((r) => r.id),
        ),
      );
    deactivated = staleRows.length;
  }

  return {
    ok: true,
    fetched: supplierPackages.length,
    inserted,
    updated,
    deactivated,
  };
}

/** Exported for unit tests without touching the DB. */
export const __test__ = {
  mapSupplierPackageToRow,
  inferRegion,
  bytesToGb,
};

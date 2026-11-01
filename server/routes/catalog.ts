/**
 * Catalog read routes.
 *
 * Contract:
 * - Every route reads ONLY from the `packages` table (plus pricing context).
 *   No route calls the supplier. The 6-hour sync job is the sole writer.
 * - If DATABASE_URL is not configured we return 503 with a clear error code,
 *   never a fabricated catalog.
 * - Response shape: a small, stable envelope so the storefront can render
 *   without re-deriving prices. All prices are in USD (`retailUsd`) — the
 *   storefront converts to display currency (SGD/VND/CNY) on the client from
 *   the same USD figure so profit accounting stays parallel.
 * - Only `active` packages are returned.
 */
import { Router, type Request, type Response, type NextFunction } from "express";
import { and, asc, desc, eq, isNotNull, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "../db/client";
import { packages } from "../db/schema";
import {
  loadPricingContext,
  toPricedPackage,
  PricingContextUnavailableError,
  type PricedPackage,
} from "../services/pricing";

/** JSON envelope shape returned by every catalog route. */
interface CatalogOk<T> {
  ok: true;
  data: T;
}
interface CatalogErr {
  ok: false;
  error: string;
  message: string;
}

/** Wrap an async handler with DB-unavailable + error mapping. */
function handler<T>(fn: (req: Request) => Promise<CatalogOk<T>>) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const payload = await fn(req);
      res.status(200).json(payload);
    } catch (err) {
      if (err instanceof PricingContextUnavailableError) {
        return res.status(503).json({
          ok: false,
          error: "catalog_unavailable",
          message: "Catalog store is not configured.",
        } satisfies CatalogErr);
      }
      const message = err instanceof Error ? err.message : "Unknown catalog error";
      // eslint-disable-next-line no-console
      console.error("[catalog route error]", message);
      return next(err);
    }
  };
}

/** Read all active packages and price them in one pass. */
async function loadAllPriced(): Promise<PricedPackage[]> {
  const db = getDb();
  if (!db) throw new PricingContextUnavailableError();
  const context = await loadPricingContext();
  const rows = await db
    .select()
    .from(packages)
    .where(eq(packages.active, true))
    .orderBy(asc(packages.region), asc(packages.code));
  return rows.map((row) => toPricedPackage(row, context.globalMarkupPercent, context.overrides));
}

/** Country slug validation (lowercase ISO alpha-2). */
const slugSchema = z
  .string()
  .trim()
  .min(2)
  .max(8)
  .regex(/^[a-z]{2}(-[a-z]{2,4})?$/i, "Invalid country slug")
  .transform((s) => s.toLowerCase());

export function createCatalogRouter(): Router {
  const router = Router();

  // -------------------------------------------------------------------------
  // GET /api/catalog/destinations
  // Popular destinations derived from catalog (country plans with most
  // availability). We rank by count of plans, tie-break alphabetically so the
  // list is stable. `limit` caps the list.
  // -------------------------------------------------------------------------
  router.get(
    "/destinations",
    handler(async (req) => {
      const limit = clampInt(req.query.limit, 20, 1, 100);
      const all = await loadAllPriced();
      const byCountry = new Map<string, { slug: string; plans: number; minPriceUsd: number }>();
      for (const p of all) {
        if (!p.countrySlug) continue;
        const entry = byCountry.get(p.countrySlug) ?? {
          slug: p.countrySlug,
          plans: 0,
          minPriceUsd: Number.POSITIVE_INFINITY,
        };
        entry.plans += 1;
        if (p.retailUsd < entry.minPriceUsd) entry.minPriceUsd = p.retailUsd;
        byCountry.set(p.countrySlug, entry);
      }
      const destinations = [...byCountry.values()].sort((a, b) => {
        if (b.plans !== a.plans) return b.plans - a.plans;
        return a.slug.localeCompare(b.slug);
      });
      return {
        ok: true as const,
        data: { destinations: destinations.slice(0, limit) },
      };
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/catalog/regional
  // Regional plans (multi-country, has a region, not global). Global plans
  // (region === "Global") are returned from /global.
  // -------------------------------------------------------------------------
  router.get(
    "/regional",
    handler(async () => {
      const all = await loadAllPriced();
      const regional = all.filter(
        (p) => p.region != null && p.region !== "Global" && p.region !== "Other",
      );
      return { ok: true as const, data: { plans: regional } };
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/catalog/global
  // Global / multi-region plans.
  // -------------------------------------------------------------------------
  router.get(
    "/global",
    handler(async () => {
      const all = await loadAllPriced();
      const global = all.filter(
        (p) => p.region === "Global" || p.region === "Multi-Region",
      );
      return { ok: true as const, data: { plans: global } };
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/catalog/daily
  // Daily unlimited plans.
  // -------------------------------------------------------------------------
  router.get(
    "/daily",
    handler(async () => {
      const all = await loadAllPriced();
      const daily = all.filter((p) => p.isDailyPlan);
      return { ok: true as const, data: { plans: daily } };
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/catalog/country/:slug
  // All country plans for a slug, with filters:
  //   minDataGb, maxDataGb, minDays, maxDays, daily (true/false), sortBy (price|data|days)
  // -------------------------------------------------------------------------
  router.get(
    "/country/:slug",
    handler(async (req) => {
      const parsed = slugSchema.safeParse(req.params.slug);
      if (!parsed.success) {
        throw new CatalogValidationError("invalid_country", "Country slug is invalid.");
      }
      const slug = parsed.data;
      const filter = parseCountryFilter(req.query);
      const db = getDb();
      if (!db) throw new PricingContextUnavailableError();
      const context = await loadPricingContext();
      const rows = await db
        .select()
        .from(packages)
        .where(and(eq(packages.active, true), eq(packages.countrySlug, slug)))
        .orderBy(asc(packages.code));
      let plans = rows.map((r) =>
        toPricedPackage(r, context.globalMarkupPercent, context.overrides),
      );
      if (filter.daily != null) plans = plans.filter((p) => p.isDailyPlan === filter.daily);
      if (filter.minDataGb != null) {
        plans = plans.filter((p) => p.dataGb != null && p.dataGb >= filter.minDataGb!);
      }
      if (filter.maxDataGb != null) {
        plans = plans.filter((p) => p.dataGb != null && p.dataGb <= filter.maxDataGb!);
      }
      if (filter.minDays != null) {
        plans = plans.filter((p) => p.durationDays != null && p.durationDays >= filter.minDays!);
      }
      if (filter.maxDays != null) {
        plans = plans.filter((p) => p.durationDays != null && p.durationDays <= filter.maxDays!);
      }
      plans = sortPlans(plans, filter.sortBy);
      // Best value: cheapest per GB among non-daily plans, else cheapest daily.
      const bestValue = pickBestValue(plans);
      return {
        ok: true as const,
        data: {
          country: slug,
          plans,
          bestValueCode: bestValue?.code ?? null,
        },
      };
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/catalog/package/:code
  // One package by code (for plan detail / top-up options in later phases).
  // -------------------------------------------------------------------------
  router.get(
    "/package/:code",
    handler(async (req) => {
      const code = String(req.params.code ?? "").trim();
      if (!code) throw new CatalogValidationError("invalid_code", "Package code is required.");
      const db = getDb();
      if (!db) throw new PricingContextUnavailableError();
      const context = await loadPricingContext();
      const [row] = await db
        .select()
        .from(packages)
        .where(and(eq(packages.active, true), eq(packages.code, code)))
        .limit(1);
      if (!row) throw new CatalogNotFoundError(code);
      const priced = toPricedPackage(row, context.globalMarkupPercent, context.overrides);
      return { ok: true as const, data: { plan: priced } };
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/catalog/search?q=singapore
  // Simple contains-search across countrySlug/countries/name. Returns up to 15
  // destinations. Cheap because it never calls the supplier.
  // -------------------------------------------------------------------------
  router.get(
    "/search",
    handler(async (req) => {
      const q = String(req.query.q ?? "").trim().toLowerCase();
      if (q.length === 0) {
        return { ok: true as const, data: { destinations: [] } };
      }
      const db = getDb();
      if (!db) throw new PricingContextUnavailableError();
      const rows = await db
        .select({ countrySlug: packages.countrySlug, countries: packages.countries })
        .from(packages)
        .where(eq(packages.active, true));
      const hits = new Set<string>();
      for (const r of rows) {
        if (!r.countrySlug) continue;
        const hay = `${r.countrySlug} ${r.countries}`.toLowerCase();
        if (hay.includes(q)) hits.add(r.countrySlug);
      }
      return {
        ok: true as const,
        data: { destinations: [...hits].slice(0, 15) },
      };
    }),
  );

  // Error mapping for the known "not found" / validation errors thrown inside handlers.
  router.use(
    (err: unknown, _req: Request, res: Response, next: NextFunction) => {
      if (err instanceof CatalogValidationError) {
        return res.status(400).json({
          ok: false,
          error: err.code,
          message: err.message,
        } satisfies CatalogErr);
      }
      if (err instanceof CatalogNotFoundError) {
        return res.status(404).json({
          ok: false,
          error: "not_found",
          message: err.message,
        } satisfies CatalogErr);
      }
      return next(err);
    },
  );

  return router;
}

// ---------------------------------------------------------------------------
// Filters + helpers
// ---------------------------------------------------------------------------

interface CountryFilter {
  minDataGb?: number;
  maxDataGb?: number;
  minDays?: number;
  maxDays?: number;
  daily?: boolean;
  sortBy: "price" | "data" | "days" | "none";
}

const numberLike = z
  .string()
  .trim()
  .transform((s) => Number(s))
  .refine((n) => Number.isFinite(n) && n >= 0, "must be a non-negative number");

function parseCountryFilter(query: Request["query"]): CountryFilter {
  const minDataGb = parseNumber(query.minDataGb);
  const maxDataGb = parseNumber(query.maxDataGb);
  const minDays = parseNumber(query.minDays);
  const maxDays = parseNumber(query.maxDays);
  const daily =
    query.daily === "true" ? true : query.daily === "false" ? false : undefined;
  const sortBy =
    query.sortBy === "price" || query.sortBy === "data" || query.sortBy === "days"
      ? query.sortBy
      : "none";
  return {
    minDataGb: clampOptional(minDataGb),
    maxDataGb: clampOptional(maxDataGb),
    minDays: clampOptional(minDays),
    maxDays: clampOptional(maxDays),
    daily,
    sortBy,
  };
}

function parseNumber(value: unknown): number | undefined {
  if (Array.isArray(value)) value = value[0];
  if (typeof value !== "string") return undefined;
  const parsed = numberLike.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function clampOptional(n: number | undefined): number | undefined {
  if (n == null) return undefined;
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const raw = Array.isArray(value) ? value[0] : value;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function sortPlans(plans: PricedPackage[], sortBy: CountryFilter["sortBy"]): PricedPackage[] {
  if (sortBy === "none") return plans;
  const copy = [...plans];
  copy.sort((a, b) => {
    if (sortBy === "price") return a.retailUsd - b.retailUsd;
    if (sortBy === "data") {
      const ad = a.dataGb ?? Number.POSITIVE_INFINITY;
      const bd = b.dataGb ?? Number.POSITIVE_INFINITY;
      return ad - bd;
    }
    // days
    const ad = a.durationDays ?? Number.POSITIVE_INFINITY;
    const bd = b.durationDays ?? Number.POSITIVE_INFINITY;
    return ad - bd;
  });
  return copy;
}

/**
 * Pick a "Best value" plan:
 * - Prefer non-daily plans; compute USD per GB.
 * - If no non-daily plan has a numeric GB, fall back to the cheapest plan.
 */
function pickBestValue(plans: PricedPackage[]): PricedPackage | null {
  if (plans.length === 0) return null;
  const withGb = plans.filter((p) => !p.isDailyPlan && p.dataGb != null && p.dataGb > 0);
  if (withGb.length > 0) {
    return withGb.reduce((best, cur) => {
      const bestPer = best.retailUsd / (best.dataGb as number);
      const curPer = cur.retailUsd / (cur.dataGb as number);
      return curPer < bestPer ? cur : best;
    });
  }
  return [...plans].sort((a, b) => a.retailUsd - b.retailUsd)[0] ?? null;
}

// ---------------------------------------------------------------------------
// Route-local error classes
// ---------------------------------------------------------------------------

export class CatalogValidationError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "CatalogValidationError";
    this.code = code;
  }
}

export class CatalogNotFoundError extends Error {
  constructor(code: string) {
    super(`Package not found: ${code}`);
    this.name = "CatalogNotFoundError";
  }
}

// Keep unused import guard for downstream bundlers referencing `desc`, `isNotNull`.
void desc;
void isNotNull;

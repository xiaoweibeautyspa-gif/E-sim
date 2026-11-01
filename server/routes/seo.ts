/**
 * SEO surfaces: robots.txt, sitemap.xml, free-tool JSON endpoints, and (when
 * renderers are supplied) SSR for the free-tool pages and country pages.
 *
 * Design
 * ------
 *  - Everything that reads our own data reads from our DB (or from
 *    `server/ssr/tools.ts` loaders). Nothing here invents catalogue rows,
 *    prices, or app-block lists. Missing tables return an explicit
 *    `<feature>_unavailable` error so the client renders its "being set up"
 *    state instead of fake data.
 *  - `robots.txt` + `sitemap.xml` are generated from real data: the country
 *    slugs present in `packages`, plus the six tools from the `TOOLS` registry.
 *    If the DB is unavailable the sitemap still returns a valid document with
 *    the static routes (tools + home) so crawlers never see a 500.
 *  - SSR for tool + country pages is OPTIONAL: the caller passes render
 *    functions. When absent, the routes fall through to a 404 JSON envelope
 *    (or, for tools, are simply not mounted) — never a half-rendered HTML
 *    shell pretending to be a full page. See the header of
 *    `server/ssr/countryPage.ts` for the renderer contract.
 *
 * Mounting (see build report — server/app.ts was not in this batch's file set):
 *
 *   import { createSeoRouter } from "./routes/seo";
 *   import { renderCountryPage } from "./ssr/countryPage";
 *   import { renderers as toolRenderers } from "./ssr/toolsPages"; // when wired
 *
 *   app.use("/", createSeoRouter({
 *     countrySlugLoader,          // optional override, defaults to packages query
 *     renderCountryPage,          // pass the real SSR renderer
 *     toolRenderer: toolRenderers, // optional per-tool SSR renderers
 *   }));
 *
 *   // static robots.txt fallback served from public/ if you prefer
 *   // express.static over the dynamic route; do not do both on the same path.
 */
import { Router, type Request, type Response, type RequestHandler } from "express";
import { sql } from "drizzle-orm";
import { getDb } from "../db/client";
import { brand, type SupportedLocale } from "../brand.config";
import {
  TOOLS,
  escapeHtml,
  loadRoamingCarriers,
  type RoamingCarrier,
  type ToolSlug,
} from "../ssr/tools";

// ---------------------------------------------------------------------------
// Envelope helpers
// ---------------------------------------------------------------------------

function ok<T>(res: Response, data: T): void {
  res.status(200).json({ ok: true, data });
}
function fail(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ ok: false, error: code, message });
}

// ---------------------------------------------------------------------------
// Dependency seams
// ---------------------------------------------------------------------------

/** Renders the HTML for a free-tool page. Injected by the app entrypoint. */
export type ToolRenderer = (
  tool: ToolSlug,
  ctx: { locale: SupportedLocale; publicBaseUrl: string },
) => Promise<string | null>;

/** Renders HTML for a country page. Matches `server/ssr/countryPage.ts`. */
export type CountryPageRenderer = (
  slug: string,
  ctx: { locale: SupportedLocale; publicBaseUrl: string },
) => Promise<string | null>;

export interface SeoRouterDeps {
  getDb?: typeof getDb;
  /** Falls back to a query against `packages.country` when omitted. */
  countrySlugLoader?: () => Promise<string[]>;
  /** SSR renderer for tool pages; omit to disable tool SSR (JSON 404s). */
  toolRenderer?: ToolRenderer;
  /** SSR renderer for /esim/:country; omit to disable country SSR. */
  renderCountryPage?: CountryPageRenderer;
  /** Used in sitemap absolute URLs; "" falls back to relative URLs. */
  publicBaseUrl?: string;
  /** Static route list beyond tools + home, for the sitemap. */
  extraStaticPaths?: string[];
}

const DEFAULT_STATIC_PATHS = [
  "/",
  "/trip-planner",
  "/esim",
  "/blog",
  // Tool pages are added from the TOOLS registry below.
] as const;

const LOCALES: readonly SupportedLocale[] = brand.locales;

// ---------------------------------------------------------------------------
// Country slug loader
// ---------------------------------------------------------------------------

/**
 * Read distinct country slugs from `packages`. Any DB error resolves to `[]`
 * so the caller can still build a sitemap with static routes only. Kept as a
 * separate function so tests can swap the whole loader via `countrySlugLoader`.
 */
async function defaultCountrySlugLoader(db: NonNullable<ReturnType<typeof getDb>>): Promise<string[]> {
  type Row = { country: string | null };
  const result = await db
    .execute<Row>(sql`
      SELECT DISTINCT lower(country) AS country
      FROM packages
      WHERE country IS NOT NULL AND length(country) > 0
      ORDER BY country ASC
    `)
    .catch(() => null);

  const rows: Row[] = Array.isArray(result)
    ? (result as Row[])
    : result && Array.isArray((result as { rows?: Row[] }).rows)
      ? (result as { rows: Row[] }).rows
      : [];
  return rows
    .map((r) => r.country)
    .filter((c): c is string => typeof c === "string" && c.length > 0);
}

// ---------------------------------------------------------------------------
// robots.txt + sitemap.xml
// ---------------------------------------------------------------------------

/**
 * Robots policy:
 *   - Disallow crawlers from areas that would leak private data, waste crawl
 *     budget on non-indexable pages, or hit API/webhook endpoints.
 *   - Explicitly point to the sitemap.
 *   - Allow the public tool + country + trip-page (shareable) routes.
 * Kept as a function (not a static file) so the Sitemap URL is derived from
 * the deployment's publicBaseUrl — a literal "https://example.com/sitemap.xml"
 * in a static file would send crawlers to the wrong host.
 */
export function buildRobotsTxt(publicBaseUrl: string): string {
  const sitemapUrl = publicBaseUrl
    ? `${publicBaseUrl.replace(/\/+$/, "")}/sitemap.xml`
    : "/sitemap.xml";
  return [
    "User-agent: *",
    "Allow: /",
    "Disallow: /api/",
    "Disallow: /admin",
    "Disallow: /my-esims",
    "Disallow: /checkout",
    "Disallow: /order",
    "Disallow: /login",
    "Disallow: /signup",
    "Disallow: /account",
    "Disallow: /auto-topup",
    "Disallow: /webhooks",
    "Disallow: /api/webhooks/",
    "",
    `Sitemap: ${sitemapUrl}`,
    "",
  ].join("\n");
}

interface SitemapEntry {
  loc: string;
  changefreq?: "daily" | "weekly" | "monthly";
  priority?: string;
}

/**
 * Build the list of URLs to include. Path list is DB-derived (country slugs)
 * plus the static registry, expanded per locale with hreflang alternates.
 * When a country cannot be loaded we simply skip it — never emit a bogus slug.
 */
export function buildSitemapEntries(input: {
  countrySlugs: string[];
  publicBaseUrl: string;
  extraStaticPaths?: string[];
}): SitemapEntry[] {
  const base = input.publicBaseUrl.replace(/\/+$/, "");
  const withBase = (path: string): string => (base ? `${base}${path}` : path);
  const entries: SitemapEntry[] = [];
  const seen = new Set<string>();

  const push = (e: SitemapEntry) => {
    const key = e.loc;
    if (seen.has(key)) return;
    seen.add(key);
    entries.push(e);
  };

  // Static routes, once per locale.
  const staticPaths = [...DEFAULT_STATIC_PATHS, ...(input.extraStaticPaths ?? [])];
  for (const locale of LOCALES) {
    for (const path of staticPaths) {
      const localized = path === "/" ? `/${locale}` : `/${locale}${path}`;
      push({ loc: withBase(localized), changefreq: "weekly", priority: path === "/" ? "1.0" : "0.7" });
    }
    for (const tool of TOOLS) {
      push({ loc: withBase(`/${locale}${tool.path}`), changefreq: "monthly", priority: "0.6" });
    }
  }

  // Country pages per locale — the SEO workhorse.
  for (const slug of input.countrySlugs) {
    const clean = slug.trim().toLowerCase();
    if (!/^[a-z]{2}(-[a-z]{2,})?$/.test(clean)) continue; // guard against junk
    for (const locale of LOCALES) {
      push({ loc: withBase(`/${locale}/esim/${clean}`), changefreq: "weekly", priority: "0.8" });
    }
  }

  return entries;
}

function renderSitemapXml(entries: SitemapEntry[]): string {
  // hreflang alternates: group by the "de-locale" path so each entry lists its
  // sibling locales. Cheap to compute (linear in entries) and matches the
  // switcher + <link rel="alternate"> tags on the SSR pages.
  const groups = new Map<string, { locale: SupportedLocale; loc: string }[]>();
  for (const e of entries) {
    const m = /\/(en|zh|vi)(\/|$)/.exec(e.loc);
    if (!m) continue;
    const locale = m[1] as SupportedLocale;
    const key = e.loc.replace(/\/(en|zh|vi)(\/|$)/, "/__LOCALE__$2");
    const arr = groups.get(key) ?? [];
    arr.push({ locale, loc: e.loc });
    groups.set(key, arr);
  }

  const body = entries
    .map((e) => {
      const key = e.loc.replace(/\/(en|zh|vi)(\/|$)/, "/__LOCALE__$2");
      const alternates = groups.get(key) ?? [];
      const links =
        alternates.length > 1
          ? alternates
              .map(
                (a) =>
                  `    <xhtml:link rel="alternate" hreflang="${escapeHtml(a.locale)}" href="${escapeHtml(a.loc)}"/>`,
              )
              .join("\n")
          : "";
      return [
        "  <url>",
        `    <loc>${escapeHtml(e.loc)}</loc>`,
        e.changefreq ? `    <changefreq>${e.changefreq}</changefreq>` : "",
        e.priority ? `    <priority>${e.priority}</priority>` : "",
        links,
        "  </url>",
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n");

  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">`,
    body,
    `</urlset>`,
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Tool JSON endpoints
// ---------------------------------------------------------------------------

/**
 * Roaming calculator endpoint. Reads carriers from the shared loader (already
 * used by `server/ssr/tools.ts`) and derives the cheapest matching plan from
 * the `packages` table. When the plan can't be read (no `packages`, DB down)
 * `planCheapestUsd` is null — the client shows the carrier total but not a
 * fabricated savings figure.
 */
async function roamingCalculatorHandler(
  db: NonNullable<ReturnType<typeof getDb>>,
  req: Request,
  res: Response,
): Promise<void> {
  const country = typeof req.query.country === "string" ? req.query.country.trim().toLowerCase() : "";
  if (!/^[a-z]{2}(-[a-z]{2,})?$/.test(country)) {
    fail(res, 400, "invalid_country", "Provide a two-letter country code.");
    return;
  }
  const carriers: RoamingCarrier[] = await loadRoamingCarriers(country);
  if (carriers.length === 0) {
    // Table missing or no rows for this country. Return the "being set up"
    // shape that the page already handles rather than an empty carriers list.
    fail(
      res,
      404,
      "not_found",
      "Roaming prices for this destination are being set up.",
    );
    return;
  }

  // Cheapest real plan for this country, in USD (retail). Read from the DB,
  // never the supplier. Missing table → null price, no invented value.
  type PlanRow = { name: string | null; code: string | null; retail_usd: string | number | null };
  const planResult = await db
    .execute<PlanRow>(sql`
      SELECT name, code, retail_usd
      FROM packages
      WHERE lower(country) = ${country} AND retail_usd IS NOT NULL
      ORDER BY retail_usd ASC
      LIMIT 1
    `)
    .catch(() => null);
  const planRows: PlanRow[] = Array.isArray(planResult)
    ? (planResult as PlanRow[])
    : planResult && Array.isArray((planResult as { rows?: PlanRow[] }).rows)
      ? (planResult as { rows: PlanRow[] }).rows
      : [];
  const cheapest = planRows[0];
  const retail = cheapest ? toNumberOrNull(cheapest.retail_usd) : null;

  ok(res, {
    carriers,
    planCheapestUsd: retail,
    planName: cheapest?.name ?? null,
    planCode: cheapest?.code ?? null,
  });
}

/** Currency converter endpoint. Rates are admin-managed. Not provisioned yet. */
function currencyConverterHandler(_req: Request, res: Response): void {
  fail(
    res,
    404,
    "not_found",
    "The FX rate table is being set up. Indicative rates will appear here.",
  );
}

/** Plug & voltage endpoint. Admin table pending. */
function plugVoltageHandler(_req: Request, res: Response): void {
  fail(res, 404, "not_found", "The plug & voltage table is being set up.");
}

/** Emergency numbers endpoint. Admin table pending. */
function emergencyNumbersHandler(_req: Request, res: Response): void {
  fail(res, 404, "not_found", "The emergency numbers table is being set up.");
}

/** Blocked apps endpoint. Admin table pending. */
function blockedAppsHandler(_req: Request, res: Response): void {
  fail(res, 404, "not_found", "The blocked-apps table is being set up.");
}

/**
 * Visa info endpoint. Admin table pending. Kept for symmetry with the tool
 * registry so the tool page can be added without a router change.
 */
function visaInfoHandler(_req: Request, res: Response): void {
  fail(res, 404, "not_found", "The visa info table is being set up.");
}

function toNumberOrNull(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export function createSeoRouter(deps: SeoRouterDeps = {}): Router {
  const router = Router();
  const dbAccessor = deps.getDb ?? getDb;
  const publicBaseUrl = deps.publicBaseUrl ?? "";

  const loadCountrySlugs = async (): Promise<string[]> => {
    if (deps.countrySlugLoader) return deps.countrySlugLoader();
    const db = dbAccessor();
    if (!db) return [];
    return defaultCountrySlugLoader(db);
  };

  // ---- robots.txt
  const robotsHandler: RequestHandler = (_req, res) => {
    res.type("text/plain").send(buildRobotsTxt(publicBaseUrl));
  };
  router.get("/robots.txt", robotsHandler);

  // ---- sitemap.xml
  router.get("/sitemap.xml", async (_req, res) => {
    const slugs = await loadCountrySlugs();
    const entries = buildSitemapEntries({
      countrySlugs: slugs,
      publicBaseUrl,
      extraStaticPaths: deps.extraStaticPaths,
    });
    res.type("application/xml").send(renderSitemapXml(entries));
  });

  // ---- Tool JSON endpoints (mounted under /api/tools/*)
  const toolsApi = Router();

  toolsApi.get("/roaming-calculator", async (req, res) => {
    const db = dbAccessor();
    if (!db) {
      fail(res, 404, "not_found", "The roaming prices table is being set up.");
      return;
    }
    try {
      await roamingCalculatorHandler(db, req, res);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.log(
        JSON.stringify({
          at: new Date().toISOString(),
          channel: "seo_route",
          tool: "roaming-calculator",
          error: err instanceof Error ? err.message : String(err),
        }),
      );
      fail(res, 500, "internal_error", "Could not compute the comparison.");
    }
  });

  toolsApi.get("/currency-converter", currencyConverterHandler);
  toolsApi.get("/plug-voltage", plugVoltageHandler);
  toolsApi.get("/emergency-numbers", emergencyNumbersHandler);
  toolsApi.get("/blocked-apps", blockedAppsHandler);
  toolsApi.get("/visa-info", visaInfoHandler);

  router.use("/api/tools", toolsApi);

  // ---- SSR for country pages: /[locale]/esim/:country
  // Only mounted when a renderer is supplied — otherwise the SPA handles the
  // route and this router does not pretend to serve full HTML.
  if (deps.renderCountryPage) {
    router.get("/:locale/esim/:country", async (req: Request, res: Response) => {
      const locale = req.params.locale as SupportedLocale;
      if (!LOCALES.includes(locale)) {
        res.status(404).type("text/plain").send("Not found");
        return;
      }
      const country = String(req.params.country).toLowerCase();
      if (!/^[a-z]{2}(-[a-z]{2,})?$/.test(country)) {
        res.status(404).type("text/plain").send("Not found");
        return;
      }
      try {
        const html = await deps.renderCountryPage!(country, { locale, publicBaseUrl });
        if (!html) {
          res.status(404).type("text/plain").send("Not found");
          return;
        }
        res
          .status(200)
          .type("text/html")
          .set("Cache-Control", "public, max-age=300, s-maxage=3600")
          .send(html);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.log(
          JSON.stringify({
            at: new Date().toISOString(),
            channel: "seo_route",
            route: "country_ssr",
            country,
            error: err instanceof Error ? err.message : String(err),
          }),
        );
        res.status(500).type("text/plain").send("Something went wrong.");
      }
    });
  }

  // ---- SSR for tool pages: /[locale]/tools/:tool
  if (deps.toolRenderer) {
    router.get("/:locale/tools/:tool", async (req: Request, res: Response) => {
      const locale = req.params.locale as SupportedLocale;
      if (!LOCALES.includes(locale)) {
        res.status(404).type("text/plain").send("Not found");
        return;
      }
      const slug = String(req.params.tool);
      const known = TOOLS.find((t) => t.slug === slug);
      if (!known) {
        res.status(404).type("text/plain").send("Not found");
        return;
      }
      try {
        const html = await deps.toolRenderer!(known.slug, { locale, publicBaseUrl });
        if (!html) {
          res.status(404).type("text/plain").send("Not found");
          return;
        }
        res
          .status(200)
          .type("text/html")
          .set("Cache-Control", "public, max-age=300, s-maxage=3600")
          .send(html);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.log(
          JSON.stringify({
            at: new Date().toISOString(),
            channel: "seo_route",
            route: "tool_ssr",
            tool: slug,
            error: err instanceof Error ? err.message : String(err),
          }),
        );
        res.status(500).type("text/plain").send("Something went wrong.");
      }
    });
  }

  return router;
}

// ---------------------------------------------------------------------------
// Test surface
// ---------------------------------------------------------------------------
export const __test__ = {
  buildRobotsTxt,
  buildSitemapEntries,
  renderSitemapXml,
  toNumberOrNull,
  LOCALES,
};

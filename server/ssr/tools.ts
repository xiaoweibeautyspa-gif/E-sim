/**
 * Shared toolkit for all SSR pages (country pages + free-tool pages).
 *
 * Kept as a leaf module so `server/ssr/countryPage.ts` and future
 * `server/routes/seo.ts` can import from here without a circular dep.
 *
 * Responsibilities
 * ----------------
 *  - `escapeHtml`: a strict, dependency-free escaper for every interpolation
 *    of user- or DB-sourced strings into HTML. We deliberately do NOT trust
 *    React when we're building strings server-side.
 *  - `renderPageShell`: minimal HTML document with `<head>` (title, meta,
 *    canonical, OG, Twitter card), inline brand CSS tokens (Tailwind picks
 *    up the same `bg-brand-600` etc. from the client bundle; this SSR shell
 *    ships a small critical-CSS block so the first paint isn't unstyled), and
 *    a `<div id="root">`-less body — every SSR page here is fully rendered,
 *    no hydration, which is the whole point of SSR for SEO/CWV).
 *  - `TOOLS`: the canonical registry of the six free tools. Used by
 *    `server/routes/seo.ts` to generate each route + sitemap entry, and by
 *    each tool page to link to related tools.
 *  - `loadRoamingCarriers()`: the roaming savings calculator needs a
 *    carrier → per-GB (or per-day) roaming price table managed by admin.
 *    Reads from `roaming_prices` when available; returns `[]` on missing
 *    table so the client page renders an honest empty state instead of
 *    invented prices.
 *
 * Not in scope here:
 *  - Routing (that's `server/routes/seo.ts`, queued).
 *  - Dynamic OG images (default brand asset only for now).
 *  - Sitemap / robots.txt generation (queued: `server/routes/seo.ts` +
 *    `public/robots.txt`).
 */
import { sql } from "drizzle-orm";
import { getDb } from "../db/client";
import { brand, type SupportedLocale } from "../brand.config";

// ---------------------------------------------------------------------------
// HTML escaping
// ---------------------------------------------------------------------------

/** Escape a string for safe interpolation into HTML text or a quoted attribute. */
export function escapeHtml(input: unknown): string {
  if (input == null) return "";
  const s = String(input);
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ---------------------------------------------------------------------------
// Page shell
// ---------------------------------------------------------------------------

export interface PageShellOptions {
  lang: SupportedLocale;
  title: string;
  description: string;
  /** Path (leading slash) without domain, e.g. "/en/esim/sg". */
  canonicalPath: string;
  /** "" when unknown; otherwise the site root, e.g. "https://example.com". */
  publicBaseUrl: string;
  /** Path to the OG image, defaults to brand.ogImagePath. */
  ogImagePath: string;
  /** Optional full URL if ogImagePath is absolute. */
  ogImageAbsoluteUrl?: string | null;
  /** Extra <head> content placed BEFORE </head> (hreflang, noindex, etc). */
  extraHead?: string;
  /** Additional JSON-LD or meta inserted after extraHead. */
  extraHeadAfter?: string;
  /** The rendered body markup (already escaped by callers). */
  body: string;
}

/**
 * Minimal critical CSS. Duplicates a subset of the Tailwind theme tokens the
 * SSR pages actually use, so the page is styled before the client bundle
 * even loads (e.g. a crawler reading the HTML). The interactive app served
 * at `/` uses the full Tailwind build.
 */
const CRITICAL_CSS = `
  :root{--brand-50:#eef7ff;--brand-600:#1b6ef5;--brand-700:#1557e1;--brand-900:#1a3e8f;--slate-50:#f8fafc;--slate-200:#e2e8f0;--slate-500:#64748b;--slate-600:#475569;--slate-700:#334155;--slate-800:#1e293b;--slate-900:#0f172a;--emerald-100:#d1fae5;--emerald-200:#a7f3d0;--emerald-800:#065f46;--rose-200:#fecdd3;--rose-800:#9f1239;}
  *,*::before,*::after{box-sizing:border-box}
  body{margin:0;font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;color:var(--slate-900);background:#fff;line-height:1.5;-webkit-font-smoothing:antialiased}
  a{color:inherit;text-decoration:none}
  h1,h2,h3{margin:0;line-height:1.2}
  p{margin:0}
  .mx-auto{margin-left:auto;margin-right:auto}
  .mt-1{margin-top:.25rem}.mt-2{margin-top:.5rem}.mt-3{margin-top:.75rem}.mt-4{margin-top:1rem}.mt-8{margin-top:2rem}
  .mb-4{margin-bottom:1rem}
  .px-2{padding-left:.5rem;padding-right:.5rem}.px-3{padding-left:.75rem;padding-right:.75rem}.px-4{padding-left:1rem;padding-right:1rem}.px-5{padding-left:1.25rem;padding-right:1.25rem}
  .py-2{padding-top:.5rem;padding-bottom:.5rem}.py-3{padding-top:.75rem;padding-bottom:.75rem}.py-7{padding-top:1.75rem;padding-bottom:1.75rem}.py-8{padding-top:2rem;padding-bottom:2rem}.py-9{padding-top:2.25rem;padding-bottom:2.25rem}.py-10{padding-top:2.5rem;padding-bottom:2.5rem}.py-16{padding-top:4rem;padding-bottom:4rem}
  .pb-16{padding-bottom:4rem}.pt-4{padding-top:1rem}.pt-6{padding-top:1.5rem}
  .w-full{width:100%}.max-w-md{max-width:28rem}.max-w-2xl{max-width:42rem}.max-w-3xl{max-width:48rem}.max-w-6xl{max-width:72rem}
  .rounded-2xl{border-radius:1rem}.rounded-3xl{border-radius:1.5rem}.rounded-xl{border-radius:.75rem}
  .bg-white{background:#fff}.bg-slate-50{background:var(--slate-50)}
  .bg-gradient-to-br{background-image:linear-gradient(to bottom right,var(--brand-600),var(--brand-700))}
  .text-white{color:#fff}.text-slate-500{color:var(--slate-500)}.text-slate-600{color:var(--slate-600)}.text-slate-700{color:var(--slate-700)}.text-slate-800{color:var(--slate-800)}.text-slate-900{color:var(--slate-900)}
  .text-brand-50\\/90{color:rgba(238,247,255,.9)}.text-brand-100\\/80{color:rgba(217,236,255,.8)}
  .text-emerald-800{color:var(--emerald-800)}.text-sm{font-size:.875rem}.text-xs{font-size:.75rem}.text-\\[11px\\]{font-size:11px}
  .text-lg{font-size:1.125rem;line-height:1.75rem}.text-xl{font-size:1.25rem;line-height:1.75rem}.text-2xl{font-size:1.5rem;line-height:2rem}.text-3xl{font-size:1.875rem;line-height:2.25rem}
  .font-bold{font-weight:700}.font-extrabold{font-weight:800}.font-medium{font-weight:500}.font-semibold{font-weight:600}
  .ring-1{box-shadow:inset 0 0 0 1px var(--slate-200)}
  .ring-1.bg-slate-50{--slate-200:#e2e8f0}
  .bg-emerald-100{background:var(--emerald-100)}.ring-emerald-200{--slate-200:var(--emerald-200)}
  .bg-brand-600{background:var(--brand-600)}.hover\\:bg-brand-700:hover{background:var(--brand-700)}
  .grid{display:grid}.gap-4{gap:1rem}.grid-cols-2{grid-template-columns:repeat(2,minmax(0,1fr))}
  @media (min-width:640px){.sm\\:grid-cols-2{grid-template-columns:repeat(2,minmax(0,1fr))}}
  @media (min-width:1024px){.lg\\:grid-cols-3{grid-template-columns:repeat(3,minmax(0,1fr))}}
  .flex{display:flex}.items-start{align-items:flex-start}.items-baseline{align-items:baseline}.items-center{align-items:center}.justify-between{justify-content:space-between}
  .gap-1{gap:.25rem}.gap-2{gap:.5rem}.gap-3{gap:.75rem}
  .inline-flex{display:inline-flex}.inline-block{display:inline-block}
  .list-decimal{list-style-type:decimal}.pl-5{padding-left:1.25rem}.space-y-1>*+*{margin-top:.25rem}.space-y-3>*+*{margin-top:.75rem}
  .cursor-pointer{cursor:pointer}
  details>summary{list-style:none}
  .underline-offset-2{text-underline-offset:2px}
`;

export function renderPageShell(o: PageShellOptions): string {
  const canonicalUrl = o.publicBaseUrl
    ? `${o.publicBaseUrl.replace(/\/+$/, "")}${o.canonicalPath}`
    : o.canonicalPath;
  const ogImage = o.ogImageAbsoluteUrl
    ? o.ogImageAbsoluteUrl
    : o.publicBaseUrl
      ? `${o.publicBaseUrl.replace(/\/+$/, "")}${o.ogImagePath}`
      : o.ogImagePath;

  const head = `
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <meta name="theme-color" content="${escapeHtml(brand.themeColor)}" />
    <title>${escapeHtml(o.title)}</title>
    <meta name="description" content="${escapeHtml(o.description)}" />
    <link rel="canonical" href="${escapeHtml(canonicalUrl)}" />
    <meta property="og:type" content="website" />
    <meta property="og:site_name" content="${escapeHtml(brand.name)}" />
    <meta property="og:title" content="${escapeHtml(o.title)}" />
    <meta property="og:description" content="${escapeHtml(o.description)}" />
    <meta property="og:url" content="${escapeHtml(canonicalUrl)}" />
    <meta property="og:image" content="${escapeHtml(ogImage)}" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${escapeHtml(o.title)}" />
    <meta name="twitter:description" content="${escapeHtml(o.description)}" />
    <meta name="twitter:image" content="${escapeHtml(ogImage)}" />
    <link rel="icon" href="/favicon.ico" />
    <style>${CRITICAL_CSS}</style>
    ${o.extraHead ?? ""}
    ${o.extraHeadAfter ?? ""}
  `;

  return `<!doctype html>
<html lang="${escapeHtml(o.lang)}">
  <head>${head}</head>
  <body>
    ${renderSiteHeader(o.lang)}
    ${o.body}
    ${renderSiteFooter(o.lang)}
  </body>
</html>`;
}

function renderSiteHeader(locale: SupportedLocale): string {
  return `
    <header class="mx-auto w-full max-w-6xl px-4 py-3">
      <div class="flex items-center justify-between gap-3">
        <a href="/${escapeHtml(locale)}/" class="text-lg font-extrabold text-slate-900">${escapeHtml(brand.name)}</a>
        <nav aria-label="Primary" class="flex items-center gap-2 text-sm">
          <a href="/${escapeHtml(locale)}/esim" class="font-medium text-slate-700 hover:text-slate-900">Destinations</a>
          <a href="/${escapeHtml(locale)}/trip-planner" class="font-medium text-slate-700 hover:text-slate-900">Trip planner</a>
          <a href="/${escapeHtml(locale)}/esim" class="rounded-xl bg-brand-600 px-3 py-1.5 font-semibold text-white hover:bg-brand-700">Buy eSIM</a>
        </nav>
      </div>
    </header>`;
}

function renderSiteFooter(locale: SupportedLocale): string {
  return `
    <footer class="mx-auto w-full max-w-6xl px-4 pb-8 pt-8 text-xs text-slate-500">
      <p>© ${escapeHtml(brand.name)}. ${escapeHtml(brand.tagline)}</p>
      <p class="mt-1">
        <a href="/${escapeHtml(locale)}/esim" class="hover:text-slate-700">Destinations</a>
        ·
        <a href="/${escapeHtml(locale)}/trip-planner" class="hover:text-slate-700">Trip planner</a>
        ·
        <a href="mailto:${escapeHtml(brand.supportEmail)}" class="hover:text-slate-700">Support</a>
      </p>
    </footer>`;
}

// ---------------------------------------------------------------------------
// Free-tool registry
// ---------------------------------------------------------------------------

export type ToolSlug =
  | "roaming-calculator"
  | "visa-info"
  | "currency-converter"
  | "plug-voltage"
  | "emergency-numbers"
  | "blocked-apps";

export interface ToolMeta {
  slug: ToolSlug;
  /** Path under /[locale]/tools/<slug>. */
  path: string;
  /** i18n key resolved by tool pages; English label here for sitemap. */
  label: string;
  /** "Try it" CTA destination on tool pages — typically the country page. */
  ctaEsimPath: string;
  title: string;
  description: string;
}

/**
 * The canonical list of free-tool pages. Consumed by:
 *   - `server/routes/seo.ts` (queued) for sitemap.xml + each tool route.
 *   - tool pages to cross-link each other ("more free tools").
 *   - admin dashboard (later) to show which tools are live.
 *
 * Order is presentation order in the footer + sitemap. Adding a tool means
 * adding a page under `src/pages/tools/` and a client route — this list is
 * the source of truth for sitemaps, not a discovery scan.
 */
export const TOOLS: readonly ToolMeta[] = [
  {
    slug: "roaming-calculator",
    path: "/tools/roaming-calculator",
    label: "Roaming savings calculator",
    ctaEsimPath: "/esim",
    title: `Roaming savings calculator — how much you save with ${brand.name}`,
    description:
      "Compare your carrier's roaming fees against a travel eSIM for any trip length. See your saving instantly.",
  },
  {
    slug: "visa-info",
    path: "/tools/visa-info",
    label: "Visa info",
    ctaEsimPath: "/esim",
    title: "Visa requirements for your next trip",
    description:
      "Quick reference to entry visas and travel authorisations for popular destinations.",
  },
  {
    slug: "currency-converter",
    path: "/tools/currency-converter",
    label: "Currency converter",
    ctaEsimPath: "/esim",
    title: "Travel currency converter",
    description: "Convert prices on the go with an offline-friendly currency converter.",
  },
  {
    slug: "plug-voltage",
    path: "/tools/plug-voltage",
    label: "Plug & voltage guide",
    ctaEsimPath: "/esim",
    title: "Plug types and voltage by country",
    description: "Check which wall adapter and voltage you'll need before you pack.",
  },
  {
    slug: "emergency-numbers",
    path: "/tools/emergency-numbers",
    label: "Emergency numbers",
    ctaEsimPath: "/esim",
    title: "Emergency numbers around the world",
    description: "Police, ambulance, and fire numbers for the countries you're visiting.",
  },
  {
    slug: "blocked-apps",
    path: "/tools/blocked-apps",
    label: "Blocked apps guide",
    ctaEsimPath: "/esim",
    title: "Which apps are blocked where",
    description:
      "Know which apps and services may be restricted at your destination — and how to prepare.",
  },
] as const;

export function toolBySlug(slug: ToolSlug): ToolMeta | null {
  return TOOLS.find((t) => t.slug === slug) ?? null;
}

// ---------------------------------------------------------------------------
// Roaming carrier table
// ---------------------------------------------------------------------------

/**
 * A carrier roaming price row. The calculator multiplies `perDayUsd` by trip
 * length and compares to the plan price. `perGbUsd` is the alternative
 * pricing model some carriers use ("$X per GB"); the calculator picks the
 * cheaper of the two so the comparison is honest about the carrier's
 * actually-lower option.
 */
export interface RoamingCarrier {
  code: string; // e.g. "singtel-sg"
  /** Home market — check for a country-match before showing in the picker. */
  homeCountry: string; // ISO-3166 alpha-2 slug
  name: string;
  perDayUsd: number | null;
  perGbUsd: number | null;
  /** For UI: short note, e.g. "unlimited day passes". */
  note: string | null;
}

/**
 * Read the roaming carrier table. Returns `[]` when the table is absent or
 * the DB is unavailable — never invents a price. Optional `countrySlug`
 * filters the result to carriers which belong to that market.
 */
export async function loadRoamingCarriers(countrySlug?: string): Promise<RoamingCarrier[]> {
  const db = getDb();
  if (!db) return [];
  type Row = {
    code: string;
    home_country: string;
    name: string;
    per_day_usd: string | number | null;
    per_gb_usd: string | number | null;
    note: string | null;
  };
  const rows = await (countrySlug
    ? db.execute<Row>(sql`
        SELECT code, home_country, name, per_day_usd, per_gb_usd, note
        FROM roaming_prices
        WHERE lower(home_country) = ${countrySlug.toLowerCase()}
        ORDER BY name ASC
      `)
    : db.execute<Row>(sql`
        SELECT code, home_country, name, per_day_usd, per_gb_usd, note
        FROM roaming_prices
        ORDER BY name ASC
      `)
  ).catch(() => null);

  const list = Array.isArray(rows)
    ? (rows as Row[])
    : rows && Array.isArray((rows as { rows?: Row[] }).rows)
      ? (rows as { rows: Row[] }).rows
      : [];

  return list.map((r) => ({
    code: r.code,
    homeCountry: r.home_country,
    name: r.name,
    perDayUsd: numberOrNull(r.per_day_usd),
    perGbUsd: numberOrNull(r.per_gb_usd),
    note: r.note,
  }));
}

function numberOrNull(v: string | number | null): number | null {
  if (v == null) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

// ---------------------------------------------------------------------------
// Test surface
// ---------------------------------------------------------------------------
export const __test__ = {
  escapeHtml,
  renderPageShell,
  TOOLS,
  toolBySlug,
  CRITICAL_CSS,
};

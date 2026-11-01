/**
 * Locale contract shared by the switcher, landing pages and (later) the blog
 * bundle and i18n tests.
 *
 * This is intentionally small: it is the ONE place that decides what the
 * supported locales are, how a locale is represented in a URL path, and how
 * an incoming pathname maps to a locale + "bare" path. Components import this
 * instead of duplicating a regex so the hreflang contract has a single source
 * of truth.
 *
 * URL shape (matches the SSR layer's expectation, see server/ssr/*):
 *   /                    → default locale (en), bare path "/"
 *   /en/...              → en
 *   /zh/...              → zh
 *   /vi/...              → vi
 *
 * A page with no locale prefix is treated as `en`. The switcher produces
 * prefixed paths for all locales so the SSR hreflang tags are unambiguous;
 * the bare `/` is still aliased to `/en` when constructing hreflang links so
 * the canonical URL set is stable.
 */
import { brand, type SupportedLocale } from "../../server/brand.config";

export type Locale = SupportedLocale;

/** Display label used by the switcher. Reordering is a one-line change. */
export interface LocaleMeta {
  code: Locale;
  /** Short label shown on the toggle (native name). */
  label: string;
  /** BCP-47 tag used for `<html lang>` and `hreflang`. */
  bcp47: string;
  /** Full native name, for `aria-label` / long form. */
  name: string;
}

export const LOCALES: readonly LocaleMeta[] = [
  { code: "en", label: "EN", bcp47: "en", name: "English" },
  { code: "zh", label: "中文", bcp47: "zh-Hans", name: "简体中文" },
  { code: "vi", label: "VI", bcp47: "vi", name: "Tiếng Việt" },
];

/** Default locale rendered when the pathname has no prefix. */
export const DEFAULT_LOCALE: Locale = "en";

const LOCALE_SET: ReadonlySet<string> = new Set(brand.locales);

function isLocale(v: string): v is Locale {
  return LOCALE_SET.has(v);
}

/**
 * Split an incoming pathname into locale + bare path.
 *
 *   "/"            → { locale: "en", barePath: "/" }
 *   "/zh"          → { locale: "zh", barePath: "/" }
 *   "/vi/esim/jp"  → { locale: "vi", barePath: "/esim/jp" }
 *   "/esim/jp"     → { locale: "en", barePath: "/esim/jp" }
 *
 * If the first segment looks like a locale but isn't one we support, we treat
 * it as part of the bare path so unknown prefixes never mask real content.
 */
export function splitLocale(pathname: string): { locale: Locale; barePath: string } {
  const clean = pathname.startsWith("/") ? pathname : `/${pathname}`;
  const parts = clean.split("/").filter(Boolean);
  const first = parts[0];
  if (first && isLocale(first)) {
    const rest = parts.slice(1).join("/");
    return { locale: first, barePath: rest ? `/${rest}` : "/" };
  }
  return { locale: DEFAULT_LOCALE, barePath: clean || "/" };
}

/**
 * Build the path for a locale + bare path.
 *
 * For the default locale we still emit the prefix (`/en/...`) so the switcher
 * produces identical-shape URLs across locales. `prettyDefault` lets a caller
 * emit `/esim/jp` for English with no prefix — used where the SSR layer already
 * canonically routes English without a prefix.
 */
export function buildLocalePath(
  locale: Locale,
  barePath: string,
  opts: { prettyDefault?: boolean } = {},
): string {
  const bare = barePath.startsWith("/") ? barePath : `/${barePath}`;
  if (opts.prettyDefault && locale === DEFAULT_LOCALE) return bare;
  return bare === "/" ? `/${locale}` : `/${locale}${bare}`;
}

/**
 * Ordered by brand.locales with x-default appended. `relativeTo` is the bare
 * path so the caller can pass the current page and get an equivalent URL in
 * every locale. `origin` is intentionally NOT applied here; the SSR layer
 * turns this into absolute URLs.
 */
export function buildHreflang(relativeTo: string): {
  locale: Locale;
  href: string;
}[] {
  return brand.locales.map((code) => ({
    locale: code,
    href: buildLocalePath(code, relativeTo),
  }));
}

/** True when the code is one of our supported locales. */
export function isSupportedLocale(code: string): code is Locale {
  return isLocale(code);
}

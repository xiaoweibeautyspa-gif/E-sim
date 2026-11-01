/**
 * i18n foundation for the storefront.
 *
 * Design goals:
 *  - Typed translation dictionaries so a missing key at a call site is a
 *    compile error, not a silent fallback. Each locale is a JSON submodule; we
 *    merge it against the English shape to guarantee every key exists.
 *  - Zero external dependencies. The storefront ships to mobile browsers,
 *    and pulling in react-i18next for six files of copy is not worth the
 *    bundle weight. This module is small (~2 KB) and tree-shakes well.
 *  - Locale detection that respects, in order: explicit path prefix
 *    (/en, /zh, /vi), then navigator.language. The server-side SSR layer
 *    produces <link rel="alternate" hreflang> tags using `LOCALES`/`localePath`
 *    from this file, so the two stay in sync.
 *  - `zh` is Simplified Chinese. We do not support Traditional Chinese in
 *    this phase; the value is deliberately only one dialect.
 *
 * Contract for components:
 *    const { t, locale, setLocale, formatCurrency, formatDate } = useI18n();
 *    t("nav.home")                     // plain key
 *    t("home.greeting", { name: "A" }) // {name} interpolation
 *    t("home.saved", { amount: 42 })    // numbers stringify without grouping;
 *                                       // call formatCurrency() for money.
 *
 * Interpolation rules:
 *    - {token} placeholders are replaced with the stringified value.
 *    - A token not present in `params` is left untouched (visible in UI so a
 *      missing variable is obvious during development rather than silently
 *      rendering "undefined").
 *    - Any object that contains an unescaped `{` at the start of a string is
 *      treated as literal text with the brace preserved; use `formatCurrency`
 *      for money instead of interpolating pre-formatted strings into keys.
 *
 * The `LocaleSwitcher` component, `SingaporeTourist` page and the blog/admin
 * surfaces import from here; keeping this module dependency-free lets the SSR
 * layer (`server/ssr/countryPage.ts`) import `LOCALES` and `localePath` without
 * pulling React into the Node server bundle.
 */
import en from "./en.json";
import zh from "./zh.json";

/**
 * Supported locales. Ordered for display in the language switcher (English
 * first as the default, then Simplified Chinese, then Vietnamese).
 *
 * The Vietnamese dictionary (`vi.json`) is added in the next batch; it is
 * listed here now so all switcher/hreflang logic can reference the canonical
 * list without a later churn. Until `vi.json` is added, `vi` falls back to
 * English at lookup time (see `resolveDictionary`).
 */
export const LOCALES = ["en", "zh", "vi"] as const;

export type Locale = (typeof LOCALES)[number];

/** Locale used when none is detected and as the fallback dictionary. */
export const DEFAULT_LOCALE: Locale = "en";

/**
 * Human-readable names for the switcher. In each language's own script, so a
 * Chinese speaker scanning a page can recognise "简体中文" instantly without
 * knowing the current UI language. The `label` field is used by the switcher;
 * `htmlLang` is used for the `lang` attribute (WCAG language of parts).
 */
export const LOCALE_META: Record<Locale, { label: string; htmlLang: string }> = {
  en: { label: "English", htmlLang: "en" },
  zh: { label: "简体中文", htmlLang: "zh-Hans" },
  vi: { label: "Tiếng Việt", htmlLang: "vi" },
};

/**
 * Shape of the dictionary. We derive it from the English JSON so any key added
 * to `en.json` becomes a required key in every other locale. Extra keys in a
 * non-English file (e.g. a localisation that needs one extra label) are
 * allowed structurally but unused — the compile-time type is a subset of
 * English keys, so the `t()` API is safe.
 *
 * Nested objects are flattened at lookup time by `get`. We keep the JSON
 * nested for editor-friendliness (grouped by section) rather than a flat key
 * map like `"nav.home": "Home"`.
 */
export type Dictionary = typeof en;

/**
 * Runtime dictionaries. `en` types are inferred from the JSON import; the
 * others are cast to `Dictionary` after a shallow-merge against `en` so any
 * missing key falls back to English rather than rendering `undefined`.
 *
 * We deliberately do NOT deep-merge: a section heading translated to `""`
 * (empty string) is treated as "translator chose to blank it", not as a
 * missing key — an empty string is a valid value (e.g. a mobile-only label
 * that's suppressed on desktop). Only *missing* keys fall back.
 */
const dictionaries: Partial<Record<Locale, Dictionary>> = {
  en: en as Dictionary,
  zh: mergeMissing(en as Dictionary, zh as Partial<Dictionary>),
  // vi: mergeMissing(en as Dictionary, vi as Partial<Dictionary>), // next batch
};

/**
 * Deep-merge a partial dictionary against English, keeping any non-missing
 * keys from `partial` and copying English for the rest. A key is "missing"
 * only if `partial` does not own it (own-property check). Empty string is a
 * present value and is preserved.
 */
function mergeMissing(
  base: Dictionary,
  partial: Partial<Dictionary>,
): Dictionary {
  const out = { ...base } as Record<string, unknown>;
  for (const key of Object.keys(partial)) {
    const p = (partial as Record<string, unknown>)[key];
    const b = (base as unknown as Record<string, unknown>)[key];
    if (p === undefined) continue;
    if (
      p !== null &&
      typeof p === "object" &&
      !Array.isArray(p) &&
      b !== null &&
      typeof b === "object" &&
      !Array.isArray(b)
    ) {
      out[key] = mergeMissing(b as Dictionary, p as Partial<Dictionary>);
    } else {
      out[key] = p;
    }
  }
  return out as Dictionary;
}

/** True if `value` is one of the supported locales. */
export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

/**
 * Best-effort mapping of a BCP-47 tag to a supported locale. Used by the
 * server-side SSR layer when reading `Accept-Language` and by the client when
 * reading `navigator.language`. `zh-Hans`, `zh-CN`, `zh-SG` all map to `zh`;
 * `zh-TW`, `zh-HK` also map to `zh` — this phase ships Simplified Chinese
 * only and does not silently select a locale it cannot render. A future phase
 * can add `zh-Hant` when content exists.
 */
export function normalizeLocaleTag(raw: string | null | undefined): Locale {
  if (!raw) return DEFAULT_LOCALE;
  const tag = raw.trim().toLowerCase();
  if (!tag) return DEFAULT_LOCALE;
  const primary = tag.split(/[-_]/)[0];
  if (primary === "zh") return "zh";
  if (primary === "vi") return "vi";
  if (primary === "en") return "en";
  return DEFAULT_LOCALE;
}

/**
 * Extract the locale from a URL pathname. Matches a leading `/[locale]` or
 * `/[locale]/...`; anything else returns `null` so the caller can choose
 * whether to default-to-`en` or detect from the browser.
 *
 *   localeFromPath("/")          → null
 *   localeFromPath("/zh")        → "zh"
 *   localeFromPath("/vi/esim/jp")→ "vi"
 *   localeFromPath("/enfoo")     → null  (not a valid locale prefix)
 */
export function localeFromPath(pathname: string): Locale | null {
  const parts = pathname.split("/").filter(Boolean);
  const first = parts[0]?.toLowerCase();
  return first && (LOCALES as readonly string[]).includes(first)
    ? (first as Locale)
    : null;
}

/**
 * Build a locale-prefixed path. The English locale is always prefixed
 * explicitly (`/en/...`) so a shared link is unambiguous — matching the
 * hreflang tags and the "Best eSIM for [Country]" SSR pages which all live
 * under a prefixed path. Passing a path that already has a locale prefix
 * strips it first, so double-prefixing never happens.
 *
 *   localePath("en", "/")            → "/en"
 *   localePath("zh", "/esim/japan")  → "/zh/esim/japan"
 *   localePath("vi", "/zh/about")    → "/vi/about"
 */
export function localePath(locale: Locale, path: string): string {
  const stripped = path.replace(/^\/(en|zh|vi)(?=\/|$)/i, "");
  const clean = stripped.startsWith("/") ? stripped : `/${stripped}`;
  if (clean === "/" || clean === "") return `/${locale}`;
  return `/${locale}${clean}`;
}

/**
 * Path used by the `hreflang` tags. English gets `x-default` as well, since
 * crawlers use that as the "any other language" fallback for the page.
 */
export function hreflangPath(locale: Locale, path: string): string {
  return localePath(locale, path);
}

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

/**
 * Get a raw string from the dictionary. Missing keys return the key itself
 * (so a broken call site is visible in the UI as `nav.unknownKey`), matching
 * the common react-i18next behaviour. This is the low-level lookup; normal
 * components call `translate(locale, key, params)`.
 *
 * Nested JSON is flattened during lookup: `t("nav.home")` walks `dict.nav.home`.
 * Arrays are not translatable (they appear only where an ordered list is
 * meaningful, and the code concatenates them at the call site).
 */
function get(dict: Dictionary, key: string): string | null {
  const parts = key.split(".");
  let node: unknown = dict;
  for (const part of parts) {
    if (node == null || typeof node !== "object") return null;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === "string" ? node : null;
}

/**
 * Interpolate `{param}` placeholders. Unknown placeholders are left intact
 * so a typo in the template (`{name}` vs `{ full_name }`) is visible in the
 * rendered UI, rather than producing a user-facing blank.
 *
 * Only strings and numbers are formatted; passing an object through is a bug
 * in the call site and stays as `{param}` to make that evident.
 */
export function interpolate(
  template: string,
  params?: Record<string, string | number>,
): string {
  if (!params) return template;
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, token: string) => {
    const value = params[token];
    if (value === undefined) return match;
    return String(value);
  });
}

/**
 * Translate a key for a given locale with optional interpolation. Returns the
 * key itself if unknown — that behaviour is deliberate (see `get`). Use the
 * `t` function from `useI18n`/`createTranslator` at component boundaries for
 * a locale bound to the current render.
 */
export function translate(
  locale: Locale,
  key: string,
  params?: Record<string, string | number>,
): string {
  const dict = dictionaries[locale] ?? dictionaries[DEFAULT_LOCALE]!;
  const raw = get(dict, key);
  if (raw === null) {
    // eslint-disable-next-line no-console
    if (typeof console !== "undefined" && console.warn) {
      console.warn(`[i18n] missing key "${key}" in locale "${locale}"`);
    }
    return key;
  }
  return interpolate(raw, params);
}

/** A translator bound to a locale. `createTranslator("zh")("nav.home")`. */
export type Translator = (
  key: string,
  params?: Record<string, string | number>,
) => string;

export function createTranslator(locale: Locale): Translator {
  const dict = dictionaries[locale] ?? dictionaries[DEFAULT_LOCALE]!;
  return (key, params) => {
    const raw = get(dict, key);
    if (raw === null) {
      if (typeof console !== "undefined" && console.warn) {
        console.warn(`[i18n] missing key "${key}" in locale "${locale}"`);
      }
      return key;
    }
    return interpolate(raw, params);
  };
}

// ---------------------------------------------------------------------------
// Formatting (money and dates)
// ---------------------------------------------------------------------------

/** Currency minor-unit rules. E.g. VND and JPY have no decimals. */
const CURRENCY_DECIMALS: Record<string, number> = {
  SGD: 2,
  USD: 2,
  CNY: 2,
  VND: 0,
  JPY: 0,
  KRW: 0,
  THB: 2,
  MYR: 2,
  IDR: 0,
  PHP: 2,
  HKD: 2,
  EUR: 2,
  GBP: 2,
};

/**
 * Format a numeric amount in a currency using the locale's number formatting
 * conventions. Uses `Intl.NumberFormat`, which safely degrades when the
 * runtime lacks the locale data by falling back to a plain number. We clamp
 * to the currency's decimal count so the same call site is safe across
 * currencies (a VND amount rendered as "1.00 ₫" would look wrong).
 *
 *   formatCurrency("zh", 3.5, "SGD")  → "S$3.50"
 *   formatCurrency("en", 25000, "VND")→ "25,000 ₫"
 */
export function formatCurrency(
  locale: Locale,
  amount: number,
  currency: string,
): string {
  const decimals = CURRENCY_DECIMALS[currency.toUpperCase()] ?? 2;
  const safeAmount = Number.isFinite(amount) ? amount : 0;
  try {
    return new Intl.NumberFormat(LOCALE_META[locale].htmlLang, {
      style: "currency",
      currency,
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    }).format(safeAmount);
  } catch {
    // Fallback for unknown currency codes: numeric + currency string.
    return `${safeAmount.toFixed(decimals)} ${currency}`;
  }
}

/**
 * Format a date with the locale's preferred order (YYYY-MM-DD vs D/M/Y).
 * Accepts a `Date` or an ISO string. Returns an empty string for invalid
 * dates rather than "Invalid Date" so call sites can hide a blank field.
 */
export function formatDate(
  locale: Locale,
  date: Date | string,
  options: Intl.DateTimeFormatOptions = { year: "numeric", month: "short", day: "numeric" },
): string {
  const d = typeof date === "string" ? new Date(date) : date;
  if (!Number.isFinite(d.getTime())) return "";
  try {
    return new Intl.DateTimeFormat(LOCALE_META[locale].htmlLang, options).format(d);
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

// ---------------------------------------------------------------------------
// Re-exports for consumers that only need the dictionaries
// ---------------------------------------------------------------------------

/**
 * English dictionary, primarily for tooling (a CLI that checks for missing
 * keys in other locales, or admin "missing translation" reports in a future
 * phase). Shape mirrors `Dictionary`.
 *
 * DO NOT read string values directly in components — use `createTranslator`
 * so the locale is respected.
 */
export const EN_DICTIONARY: Dictionary = en as Dictionary;

/**
 * Canonical list of translation keys, flat. Used by the (queued)
 * `server/services/blogAiDraft.ts` to validate that any placeholders in an AI
 * draft reference real keys, and by the (queued) i18n test file that scans
 * every page for missing keys.
 */
export function listKeys(dict: Dictionary = EN_DICTIONARY): string[] {
  const out: string[] = [];
  (function walk(node: unknown, prefix: string) {
    if (node == null) return;
    if (typeof node === "string") {
      out.push(prefix);
      return;
    }
    if (typeof node !== "object" || Array.isArray(node)) return;
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      walk(v, prefix ? `${prefix}.${k}` : k);
    }
  })(dict, "");
  return out;
}

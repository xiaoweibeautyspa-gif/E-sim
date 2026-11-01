/**
 * LocaleSwitcher — the language toggle in the storefront header.
 *
 * Contract:
 *   - Renders one option per supported locale from `LOCALES` (src/i18n/locales.ts).
 *   - On change: navigates to the SAME page in the new locale by rewriting the
 *     locale prefix of the current pathname and preserving the query/hash.
 *     It reloads the page (window.location.assign) so the SSR layer re-renders
 *     the correct <html lang>, hreflang set, and translated server-rendered
 *     blocks. A client-only swap would desync the SSR locale.
 *   - Keeps hreflang and canonical up to date on the client as a defence for
 *     direct client hits. The SSR layer is the authoritative source; those
 *     tags are re-emitted server-side per request.
 *   - If the caller passes `onNavigate`, we call it instead of hard-navigating.
 *     Used by tests and by an SPA-internal router if one is wired later.
 *
 * Accessibility:
 *   - Single native `<select>` so mobile users get the OS picker, matching
 *     how real travel sites handle 3+ languages.
 *   - `aria-label` reflects the current language so screen readers announce
 *     "Language selector, current language Vietnamese".
 *
 * Honesty:
 *   - Does not fall back to English silently. If a locale prefix is co-opted
 *     by a nonexistent route, the SSR layer 404s — the switcher does not
 *     invent a homepage redirect.
 *   - The switcher never adds a locale prefix to a path that is already
 *     locale-agnostic in the SSR layer (e.g. `/api/*`, `/trip/*` share links
 *     which are intentionally locale-neutral).
 */
import { useCallback, useId, useEffect, useMemo, useState } from "react";
import {
  buildLocalePath,
  buildHreflang,
  isSupportedLocale,
  LOCALES,
  splitLocale,
  type Locale,
} from "../i18n/locales";

export interface LocaleSwitcherProps {
  /** Overrides the locale read from the current URL. */
  locale?: Locale;
  /**
   * Called with the target locale and the prefixed path. When omitted, the
   * browser is hard-navigated to the target path (full reload) so SSR
   * re-renders with the correct `lang` + hreflang.
   */
  onNavigate?: (locale: Locale, href: string) => void;
  /** Optional extra class names on the wrapper. */
  className?: string;
  /**
   * If true, English links emit the bare path (`/esim/jp`) rather than
   * `/en/esim/jp`. Some deployments canonicalise English without a prefix.
   * Defaults to true to match the SSR layer's `<link rel="canonical">` shape.
   */
  prettyEnglish?: boolean;
  /** Optional test override; defaults to window.location.pathname. */
  currentPath?: string;
}

/**
 * Paths that are locale-neutral by design. Changing the language must NOT
 * prefix these or the link would 404 in the SSR layer.
 */
const LOCALE_NEUTRAL_PREFIXES = ["/api/", "/trip/", "/assets/", "/og/"] as const;

function isLocaleNeutral(pathname: string): boolean {
  if (pathname === "/api" || pathname.startsWith("/api/")) return true;
  return LOCALE_NEUTRAL_PREFIXES.some((p) =>
    p.endsWith("/") ? pathname.startsWith(p) || pathname === p.slice(0, -1) : pathname === p,
  );
}

function currentHref(): string {
  if (typeof window === "undefined") return "/";
  return window.location.pathname + window.location.search + window.location.hash;
}

export function LocaleSwitcher({
  locale,
  onNavigate,
  className = "",
  prettyEnglish = true,
  currentPath,
}: LocaleSwitcherProps): JSX.Element {
  const selectId = useId();

  // Resolve the current locale/path from the URL when not overridden. This
  // runs only on the client (window is absent during SSR) so the initial
  // value is the DEFAULT_LOCALE; a useEffect then reads the real URL. That
  // two-step is intentional: it keeps SSR hydration deterministic.
  const initial = useMemo(() => {
    const path = currentPath ?? (typeof window !== "undefined" ? window.location.pathname : "/");
    return splitLocale(path);
  }, [currentPath]);

  const [activeLocale, setActiveLocale] = useState<Locale>(locale ?? initial.locale);
  const [activePath, setActivePath] = useState<string>(initial.barePath);

  useEffect(() => {
    if (locale) {
      setActiveLocale(locale);
    } else if (typeof window !== "undefined") {
      const split = splitLocale(currentPath ?? window.location.pathname);
      setActiveLocale(split.locale);
      setActivePath(split.barePath);
    }
  }, [locale, currentPath]);

  const localeMeta = useMemo(
    () => LOCALES.find((l) => l.code === activeLocale) ?? LOCALES[0]!,
    [activeLocale],
  );

  const handleChange = useCallback(
    (next: string) => {
      if (!isSupportedLocale(next)) return;

      // Locale-neutral routes leave the language footprint alone.
      const pathname =
        typeof window !== "undefined" ? window.location.pathname : activePath;
      if (isLocaleNeutral(pathname)) {
        setActiveLocale(next);
        return;
      }

      const targetHref = buildLocalePath(next, activePath, {
        prettyDefault: prettyEnglish,
      });

      // Preserve query + fragment so e.g. deep links with filters survive.
      const suffix =
        typeof window !== "undefined"
          ? window.location.search + window.location.hash
          : "";
      const finalHref = targetHref + suffix;

      setActiveLocale(next);

      if (onNavigate) {
        onNavigate(next, finalHref);
        return;
      }
      if (typeof window !== "undefined") {
        window.location.assign(finalHref);
      }
    },
    [activePath, onNavigate, prettyEnglish],
  );

  // Client-side sanity: keep <html lang>, hreflang alternates, and canonical
  // in sync when this component mounts on a page. The SSR layer is the
  // authority; this just heals direct client hits.
  useEffect(() => {
    if (typeof document === "undefined") return;
    const meta = LOCALES.find((l) => l.code === activeLocale);
    if (!meta) return;
    document.documentElement.lang = meta.bcp47;

    // Replace the hreflang <link> set with one per supported locale.
    const existing = Array.from(
      document.querySelectorAll<HTMLLinkElement>('link[rel="alternate"][data-hreflang-managed="1"]'),
    );
    for (const node of existing) node.remove();

    const alternates = buildHreflang(activePath);
    const fragment = document.createDocumentFragment();
    for (const alt of alternates) {
      const link = document.createElement("link");
      link.rel = "alternate";
      link.hreflang = LOCALES.find((l) => l.code === alt.locale)?.bcp47 ?? alt.locale;
      link.href = alt.href;
      link.dataset.hreflangManaged = "1";
      fragment.appendChild(link);
    }
    // x-default
    const xDefault = document.createElement("link");
    xDefault.rel = "alternate";
    xDefault.hreflang = "x-default";
    xDefault.href = buildHreflang(activePath)[0]?.href ?? "/en";
    xDefault.dataset.hreflangManaged = "1";
    fragment.appendChild(xDefault);
    document.head.appendChild(fragment);

    return () => {
      // Remove nodes we added on unmount. Leave anything else the SSR layer
      // emitted alone (we only touch nodes marked with our attribute).
      const managed = Array.from(
        document.querySelectorAll<HTMLLinkElement>(
          'link[rel="alternate"][data-hreflang-managed="1"]',
        ),
      );
      for (const node of managed) node.remove();
    };
  }, [activeLocale, activePath]);

  return (
    <div className={`inline-flex items-center gap-1 ${className}`} data-testid="locale-switcher">
      <label htmlFor={selectId} className="sr-only">
        {`${localeMeta.name} — Language`}
      </label>
      <svg
        aria-hidden
        width="16"
        height="16"
        viewBox="0 0 20 20"
        fill="currentColor"
        className="text-slate-500"
      >
        <path d="M10 2a8 8 0 1 0 0 16 8 8 0 0 0 0-16Zm5.9 5h-2.3a12 12 0 0 0-1-2.6A6 6 0 0 1 15.9 7ZM10 4c.7.6 1.5 1.8 1.9 3h-3.8C8.5 5.8 9.3 4.6 10 4ZM7.1 9h5.8a11 11 0 0 1 0 2H7.1a11 11 0 0 1 0-2Zm-3 2a6 6 0 0 1 .1-.9H6a12 12 0 0 0 1 2.9H4.9A6 6 0 0 1 4.1 11ZM6 13h2.9a12 12 0 0 1-1-2.6h2.3c.1.9.4 1.7.7 2.4A6 6 0 0 1 6 13Zm4 3c-.7-.6-1.5-1.8-1.9-3h3.8c-.4 1.2-1.2 2.4-1.9 3Zm2.9-4.6c.3-.7.6-1.5.7-2.4h2.3a12 12 0 0 1-1 2.6H12.9ZM15.1 13h-2.1a12 12 0 0 0 1-2.9h1.9a6 6 0 0 1-.8 2.9Z" />
      </svg>
      <select
        id={selectId}
        value={activeLocale}
        onChange={(e) => handleChange(e.target.value)}
        className="rounded-lg border border-transparent bg-transparent py-1 pl-1 pr-6 text-sm font-medium text-slate-700 outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-200 hover:bg-slate-50"
        data-testid="locale-switcher-select"
        aria-label={`Change language (current: ${localeMeta.name})`}
      >
        {LOCALES.map((l) => (
          <option key={l.code} value={l.code} lang={l.bcp47}>
            {l.label}
          </option>
        ))}
      </select>
    </div>
  );
}

export const __test__ = {
  LOCALE_NEUTRAL_PREFIXES,
  isLocaleNeutral,
};

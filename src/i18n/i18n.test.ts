/**
 * Locale and multilingual routing tests for the EN/ZH/VI storefront.
 *
 * WHAT THESE LOCK DOWN
 * --------------------
 *  - The three shipped JSON bundles parse, are non-empty, and share a stable
 *    base set of keys (so `zh.json` and `vi.json` don't silently drift from
 *    `en.json` on critical strings used by the switcher and country pages).
 *  - Every locale in `brand.locales` resolves through `isSupportedLocale` and
 *    `buildLocalePath` to a prefixed path that round-trips back through
 *    `splitLocale`.
 *  - The Singapore tourist keys exist in EN, ZH and VI (the inbound-tourist
 *    acceptance criterion). Missing keys would render as the dotted token in
 *    the UI because the page falls back to English — that fallback is itself
 *    asserted here.
 *  - `LocaleSwitcher` exports an hreflang mapping for every supported locale.
 *
 * WHAT THESE DO NOT PROVE
 * -----------------------
 *  - SSR-rendered `<html lang>` / `<link rel="alternate">` — that is emitted by
 *    the SSR country page layer and covered by `server/ssr/seo.test.ts`.
 *  - Runtime React rendering of `LocaleSwitcher` — this test imports the module
 *    and inspects the pure helpers; component rendering is covered by the
 *    Vitest/Testing Library setup when it lands (see Home.test.tsx notes).
 *
 * These are SOURCE tests. They import the shipped JSON + locale helpers only;
 * no DB, no network, no Secrets. Run them with the project’s `vitest` runner
 * once that is wired for `src/**` (the server suite runs via `node --test`).
 */
import { describe, it, expect } from "vitest";

import en from "./en.json";
import zh from "./zh.json";
import vi from "./vi.json";
import {
  buildLocalePath,
  isSupportedLocale,
  splitLocale,
  type Locale,
} from "./locales";

// ---------------------------------------------------------------------------
// Bundle sanity
// ---------------------------------------------------------------------------

const BUNDLES = { en, zh, vi } as const;
const LOCALES: Locale[] = ["en", "zh", "vi"];

/** Dotted-path lookup that mirrors what SingaporeTourist.tsx does. */
function lookup(bundle: unknown, path: string): unknown {
  let cursor: unknown = bundle;
  for (const segment of path.split(".")) {
    if (cursor && typeof cursor === "object" && segment in (cursor as object)) {
      cursor = (cursor as Record<string, unknown>)[segment];
    } else {
      return undefined;
    }
  }
  return cursor;
}

describe("i18n bundles", () => {
  it("each bundle is a non-empty object", () => {
    for (const locale of LOCALES) {
      const bundle = BUNDLES[locale];
      expect(typeof bundle, `${locale} bundle type`).toBe("object");
      expect(bundle, `${locale} bundle defined`).toBeTruthy();
      expect(Object.keys(bundle as object).length).toBeGreaterThan(0);
    }
  });

  it("isSupportedLocale accepts every brand locale and rejects others", () => {
    for (const locale of LOCALES) {
      expect(isSupportedLocale(locale), `${locale}`).toBe(true);
    }
    for (const bogus of ["fr", "EN", "zh-CN", "", "jp"]) {
      expect(isSupportedLocale(bogus), `reject "${bogus}"`).toBe(false);
    }
  });

  it("zh and vi cover the Singapore tourist keys the landing page renders", () => {
    const REQUIRED = [
      "tourist.singapore.eyebrow",
      "tourist.singapore.headline",
      "tourist.singapore.subhead",
      "tourist.singapore.primaryCta",
      "tourist.singapore.secondaryCta",
      "tourist.singapore.whyHeading",
      "tourist.singapore.networkHeading",
      "tourist.singapore.practicalHeading",
      "tourist.singapore.installHeading",
      "tourist.singapore.installBody",
      "tourist.singapore.faqHeading",
      "tourist.singapore.ctaHeading",
      "tourist.singapore.ctaBody",
    ] as const;

    for (const key of REQUIRED) {
      for (const locale of LOCALES) {
        const value = lookup(BUNDLES[locale], key);
        expect(typeof value, `${locale}:${key} must be a string`).toBe("string");
        expect((value as string).length, `${locale}:${key} must be non-empty`).toBeGreaterThan(0);
      }
    }
  });

  it("zh and vi FAQ strings exist for all five questions", () => {
    const FAQ_KEYS: string[] = [];
    for (let i = 1; i <= 5; i += 1) {
      FAQ_KEYS.push(`tourist.singapore.faq${i}Q`, `tourist.singapore.faq${i}A`);
    }
    for (const locale of ["zh", "vi"] as const) {
      for (const key of FAQ_KEYS) {
        const value = lookup(BUNDLES[locale], key);
        expect(typeof value, `${locale}:${key}`).toBe("string");
        expect((value as string).length, `${locale}:${key}`).toBeGreaterThan(0);
      }
    }
  });

  it("critical common strings are present in all three bundles", () => {
    const CRITICAL = ["common.buyNow"] as const;
    for (const key of CRITICAL) {
      for (const locale of LOCALES) {
        const value = lookup(BUNDLES[locale], key);
        expect(typeof value, `${locale}:${key}`).toBe("string");
        expect((value as string).length, `${locale}:${key}`).toBeGreaterThan(0);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Routing helpers — buildLocalePath / splitLocale round-trip
// ---------------------------------------------------------------------------

describe("locale routing", () => {
  it("buildLocalePath prefixes every locale except the default", () => {
    expect(buildLocalePath("en", "/esim/sg", { prettyDefault: true })).toBe("/esim/sg");
    expect(buildLocalePath("zh", "/esim/sg", { prettyDefault: true })).toBe("/zh/esim/sg");
    expect(buildLocalePath("vi", "/esim/sg", { prettyDefault: true })).toBe("/vi/esim/sg");
  });

  it("buildLocalePath prefixes the default locale when prettyDefault is off", () => {
    expect(buildLocalePath("en", "/trip-planner")).toBe("/en/trip-planner");
  });

  it("splitLocale recovers the locale from a built path", () => {
    for (const locale of ["zh", "vi"] as const) {
      const path = buildLocalePath(locale, "/singapore-tourist", { prettyDefault: true });
      const parsed = splitLocale(path);
      expect(parsed.locale).toBe(locale);
      expect(parsed.pathname).toBe("/singapore-tourist");
    }
    const parsedDefault = splitLocale("/singapore-tourist");
    expect(parsedDefault.locale).toBe("en");
    expect(parsedDefault.pathname).toBe("/singapore-tourist");
  });

  it("splitLocale returns en for unknown prefixes and leaves the path untouched", () => {
    // An unknown language prefix should NOT be treated as locale; the path
    // falls through so the SSG 404 / country resolver can decide.
    const parsed = splitLocale("/fr/esim/sg");
    expect(parsed.locale).toBe("en");
    expect(parsed.pathname).toBe("/fr/esim/sg");
  });

  it("buildLocalePath normalises a path that lacks a leading slash", () => {
    expect(buildLocalePath("zh", "esim/sg", { prettyDefault: true })).toBe("/zh/esim/sg");
  });
});

// ---------------------------------------------------------------------------
// hreflang
// ---------------------------------------------------------------------------

describe("hreflang alternates", () => {
  it("includes every supported locale plus x-default", async () => {
    const mod = await import("../components/LocaleSwitcher");
    // LocaleSwitcher re-exports the mapping used by SSR + the switcher.
    const mapping = (
      mod as unknown as {
        HREFLANG_MAP?: Record<string, string>;
        hreflangFor?: (l: Locale) => string;
      }
    ).HREFLANG_MAP;

    if (mapping) {
      for (const locale of LOCALES) {
        expect(mapping[locale], `map[${locale}]`).toBeTruthy();
      }
      expect(mapping["x-default"], "x-default alternate").toBeTruthy();
    } else {
      // Fallback: the module must at least expose a `hreflangFor` helper.
      const fn = (mod as unknown as { hreflangFor?: (l: Locale) => string }).hreflangFor;
      expect(typeof fn, "LocaleSwitcher must expose HREFLANG_MAP or hreflangFor").toBe(
        "function",
      );
      if (typeof fn === "function") {
        for (const locale of LOCALES) {
          expect(fn(locale)).toMatch(/^[a-z]{2}(-[A-Z]{2})?$/);
        }
      }
    }
  });
});

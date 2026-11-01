/**
 * /zh/singapore-tourist and /vi/singapore-tourist — inbound tourist landing
 * pages for visitors to Singapore.
 *
 * The page is translated from `src/i18n/zh.json` / `src/i18n/vi.json` under
 * the `tourist.singapore.*` keys. The English version at
 * `/en/singapore-tourist` renders the same layout using en.json strings — the
 * component does not assume a locale.
 *
 * Real data this page is careful about:
 *   - Plan prices come from the public catalog endpoint (`/api/catalog/...`,
 *     served by server/routes/catalog.ts from the DB, NOT the supplier API per
 *     view). If the catalog is not reachable we show an honest
 *     "plans are loading" state with a link to the generic country page; we
 *     NEVER fabricate a price or a "from" figure.
 *   - Supported networks and speeds come from the same admin-managed speed
 *     rating table used by country pages. If it's absent we don't claim 5G.
 *   - Practical info (currency, plug, emergency numbers, transport apps) is
 *     general knowledge and safe to render inline — but only as commentary,
 *     never as a substitution for the emergency-numbers tool page.
 *
 * The page uses a small client-side lookup against the locale JSON bundles.
 * The full i18n index (src/i18n/index.ts, added in a previous batch) owns
 * richer context; here we import both JSON bundles directly so this file has
 * no dependency on that module's exact export shape and can be unit-tested
 * independently.
 *
 * SSR:
 *   The SSR layer (server/ssr/countryPage.ts pattern) renders this page at
 *   /zh/singapore-tourist and /vi/singapore-tourist with correct <html lang>,
 *   hreflang alternates and OG tags via the LocaleSwitcher's effect once the
 *   page hydrates. The client-rendered shell includes the same headings so
 *   the page is usable even before the SSR batch lands.
 *
 * Test hooks:
 *   data-testid="singapore-tourist"
 *   data-testid="singapore-tourist-locale"
 *   data-testid="singapore-tourist-hero-heading"
 *   data-testid="singapore-tourist-primary-cta"
 *   data-testid="singapore-tourist-planner-cta"
 *   data-testid="singapore-tourist-why-card-<n>"
 *   data-testid="singapore-tourist-plan-<code>"
 *   data-testid="singapore-tourist-plans-loading"
 *   data-testid="singapore-tourist-plans-error"
 *   data-testid="singapore-tourist-plans-empty"
 *   data-testid="singapore-tourist-network-body"
 *   data-testid="singapore-tourist-faq-<n>"
 *   data-testid="singapore-tourist-install"
 *   data-testid="singapore-tourist-practical"
 */
import { useEffect, useMemo, useState } from "react";

import en from "../i18n/en.json";
import zh from "../i18n/zh.json";
import vi from "../i18n/vi.json";
import {
  buildLocalePath,
  isSupportedLocale,
  splitLocale,
  type Locale,
} from "../i18n/locales";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Plan {
  /** Stable package code from the DB. */
  code: string;
  /** Display label, e.g. "10 GB · 30 days". */
  displayName: string;
  /** Data label, e.g. "10 GB". */
  dataLabel: string;
  /** Validity label, e.g. "30 days". */
  validityLabel: string;
  /** Retail price in USD (server-priced). */
  retailUsd: number;
  /** True when the plan is a regional/global wrapper. Filtered out here. */
  isRegional: boolean;
  /** True when the plan is a daily unlimited plan. */
  isDaily: boolean;
  /** Human network label like "Singtel 5G" when available. */
  networkLabel: string | null;
  /** Isolated plan page (country-scoped) — used as the CTA target. */
  buyHref: string;
  /** Badge hint from the server ("best-value" | null). */
  badge: string | null;
}

interface ApiOk<T> {
  ok: true;
  data: T;
}
interface ApiErr {
  ok: false;
  error: string;
  message: string;
}

// ---------------------------------------------------------------------------
// Locale bundle lookup
// ---------------------------------------------------------------------------

/**
 * The JSON bundles share a shape so the lookup below can index them with a
 * dotted path. We don't use a library because the surface is tiny and the
 * behaviour — missing key → fall back to `en` — is part of the contract.
 */
const BUNDLES: Record<Locale, unknown> = { en, zh, vi };

function stringAt(bundle: unknown, path: string): string | undefined {
  let cursor: unknown = bundle;
  for (const segment of path.split(".")) {
    if (cursor && typeof cursor === "object" && segment in (cursor as object)) {
      cursor = (cursor as Record<string, unknown>)[segment];
    } else {
      return undefined;
    }
  }
  return typeof cursor === "string" ? cursor : undefined;
}

/**
 * Translate a dotted key. Falls back to English, then to the key itself so a
 * missing string shows up as an obvious token instead of blank UI. `vars`
 * performs simple `{name}` interpolation.
 */
function t(locale: Locale, key: string, vars: Record<string, string | number> = {}): string {
  const primary = stringAt(BUNDLES[locale], key) ?? stringAt(BUNDLES.en, key) ?? key;
  return primary.replace(/\{(\w+)\}/g, (_match, name: string) => {
    const v = vars[name];
    return v == null ? `{${name}}` : String(v);
  });
}

// ---------------------------------------------------------------------------
// Currency formatting
// ---------------------------------------------------------------------------

type Currency = "SGD" | "USD" | "VND" | "CNY";

/**
 * Presentation-only currency display. The base is USD (the price the server
 * returns). These rates are illustrative and only used for the badge; the
 * authoritative price and currency are chosen at checkout by Stripe using
 * the user-selected currency. For CNY and VND we deliberately use a range
 * label ("~") so a stale rate can't mislead about the actual price.
 */
function formatApprox(usd: number, currency: Currency): string {
  if (!Number.isFinite(usd)) return "—";
  switch (currency) {
    case "USD":
      return `$${usd.toFixed(2)} USD`;
    case "SGD": {
      const v = usd * 1.34;
      return `~ S$${v.toFixed(2)}`;
    }
    case "CNY": {
      const v = usd * 7.2;
      return `~ ¥${v.toFixed(2)}`;
    }
    case "VND": {
      const v = Math.round(usd * 25_000);
      return `~ ${v.toLocaleString("vi-VN")}₫`;
    }
  }
}

// ---------------------------------------------------------------------------
// Catalog fetch
// ---------------------------------------------------------------------------

/**
 * The Singapore country page already exposes plans via the catalog router.
 * We reuse `/api/catalog/country/sg` (mounted in server/routes/catalog.ts) so
 * the tourist page is a first-class consumer of the same DB-backed plan
 * source country pages use — no duplicate endpoint, no per-view API call to
 * the supplier.
 */
interface CatalogCountryResponse {
  /** Country display info. */
  country: { slug: string; name: string };
  /** Plan list; server filters non-matching countries already. */
  plans: Plan[];
  /** Admin-managed network summary. */
  networks?: { label: string; speedRating?: string | null }[];
}

async function fetchSingaporePlans(signal: AbortSignal): Promise<CatalogCountryResponse> {
  const res = await fetch("/api/catalog/country/sg", {
    method: "GET",
    credentials: "include",
    headers: { Accept: "application/json" },
    signal,
  });
  const body = (await res.json().catch(() => ({}))) as
    | ApiOk<CatalogCountryResponse>
    | ApiErr
    | Record<string, unknown>;
  if (!res.ok || !("ok" in body) || (body as ApiErr).ok === false) {
    const err = body as ApiErr;
    throw new Error(
      err?.message ?? `The plans endpoint returned HTTP ${res.status}.`,
    );
  }
  return (body as ApiOk<CatalogCountryResponse>).data;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface SingaporeTouristProps {
  /** Override the locale (defaults to URL prefix, falling back to en). */
  locale?: Locale;
  /** Injectable fetcher for tests; defaults to the global fetch. */
  fetcher?: typeof fetch;
}

export function SingaporeTourist({
  locale: localeProp,
  fetcher,
}: SingaporeTouristProps = {}): JSX.Element {
  const locale: Locale = useMemo(() => {
    if (localeProp && isSupportedLocale(localeProp)) return localeProp;
    if (typeof window !== "undefined") {
      return splitLocale(window.location.pathname).locale;
    }
    return "en";
  }, [localeProp]);

  const [state, setState] = useState<
    | { status: "loading" }
    | { status: "ready"; data: CatalogCountryResponse }
    | { status: "error"; message: string }
  >({ status: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    setState({ status: "loading" });
    const fn = fetcher ?? fetch;
    // We call through the injected fetcher only when it's provided; the
    // real one is a thin wrapper around global fetch so the fetchSingaporePlans
    // helper keeps working.
    const promise = fetcher
      ? fn("/api/catalog/country/sg", {
          method: "GET",
          credentials: "include",
          headers: { Accept: "application/json" },
          signal: controller.signal,
        }).then(async (res) => {
          const body = (await res.json().catch(() => ({}))) as
            | ApiOk<CatalogCountryResponse>
            | ApiErr;
          if (!res.ok || !("ok" in body) || (body as ApiErr).ok === false) {
            const err = body as ApiErr;
            throw new Error(err?.message ?? `HTTP ${res.status}`);
          }
          return (body as ApiOk<CatalogCountryResponse>).data;
        })
      : fetchSingaporePlans(controller.signal);

    promise
      .then((data) => {
        if (!controller.signal.aborted) setState({ status: "ready", data });
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        if (controller.signal.aborted) return;
        setState({
          status: "error",
          message:
            err instanceof Error ? err.message : "Could not load Singapore plans.",
        });
      });

    return () => controller.abort();
  }, [fetcher]);

  // Currency label derived from the active locale; purely presentational.
  const currency: Currency = locale === "zh" ? "CNY" : locale === "vi" ? "VND" : "SGD";

  // CTA targets include the locale prefix so the language persists through
  // navigation. English uses the bare path to match the SSR canonical.
  const plansHref = buildLocalePath(locale, "/esim/sg", { prettyDefault: true });
  const plannerHref = buildLocalePath(locale, "/trip-planner", { prettyDefault: true });

  return (
    <main
      className="mx-auto w-full max-w-4xl px-4 pb-16 pt-6"
      data-testid="singapore-tourist"
      data-locale={locale}
    >
      {/* Hero */}
      <section className="rounded-3xl bg-gradient-to-br from-brand-600 to-brand-700 px-5 py-8 text-white sm:px-8 sm:py-10">
        <p
          className="text-xs font-semibold uppercase tracking-wider text-brand-100/80"
          data-testid="singapore-tourist-locale"
        >
          {t(locale, "tourist.singapore.eyebrow")}
        </p>
        <h1
          className="mt-2 text-2xl font-extrabold sm:text-4xl"
          data-testid="singapore-tourist-hero-heading"
        >
          {t(locale, "tourist.singapore.headline")}
        </h1>
        <p className="mt-3 max-w-2xl text-sm text-brand-50/90 sm:text-base">
          {t(locale, "tourist.singapore.subhead")}
        </p>
        <div className="mt-5 flex flex-wrap gap-2">
          <a
            href={plansHref}
            className="rounded-xl bg-white px-4 py-2 text-sm font-semibold text-brand-700 hover:bg-brand-50"
            data-testid="singapore-tourist-primary-cta"
          >
            {t(locale, "tourist.singapore.primaryCta")}
          </a>
          <a
            href={plannerHref}
            className="rounded-xl border border-white/40 px-4 py-2 text-sm font-semibold text-white hover:bg-white/10"
            data-testid="singapore-tourist-planner-cta"
          >
            {t(locale, "tourist.singapore.secondaryCta")}
          </a>
        </div>
      </section>

      {/* Why */}
      <section className="mt-8" aria-labelledby="sg-why-heading">
        <h2 id="sg-why-heading" className="text-lg font-bold text-slate-900 sm:text-xl">
          {t(locale, "tourist.singapore.whyHeading")}
        </h2>
        <ul className="mt-3 grid gap-3 sm:grid-cols-2">
          {(["1", "2", "3", "4"] as const).map((n) => (
            <li
              key={n}
              className="rounded-2xl bg-white p-4 ring-1 ring-slate-200"
              data-testid={`singapore-tourist-why-card-${n}`}
            >
              <h3 className="text-sm font-bold text-slate-900">
                {t(locale, `tourist.singapore.why${n}Title`)}
              </h3>
              <p className="mt-1 text-sm text-slate-600">
                {t(locale, `tourist.singapore.why${n}Body`)}
              </p>
            </li>
          ))}
        </ul>
      </section>

      {/* Plans from DB */}
      <section className="mt-8" aria-labelledby="sg-plans-heading">
        <h2 id="sg-plans-heading" className="text-lg font-bold text-slate-900 sm:text-xl">
          {t(locale, "country.plansHeading", { country: t(locale, "country.pageTitle", { country: "Singapore" }).split(" ").pop() ?? "Singapore" })}
        </h2>
        <div className="mt-3">
          {state.status === "loading" && (
            <div
              className="grid gap-3 sm:grid-cols-2"
              aria-busy
              data-testid="singapore-tourist-plans-loading"
            >
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="h-24 animate-pulse rounded-2xl bg-slate-100" />
              ))}
            </div>
          )}

          {state.status === "error" && (
            <div
              role="alert"
              className="rounded-2xl bg-rose-50 px-4 py-3 text-sm text-rose-800 ring-1 ring-rose-200"
              data-testid="singapore-tourist-plans-error"
            >
              <p className="font-semibold">
                {t(locale, "common.learningMore") /* fallback text plan list not loaded */}
              </p>
              <p className="mt-1 text-xs">
                {t(locale, "tourist.singapore.primaryCta")} →{" "}
                <a className="underline" href={plansHref}>
                  {plansHref}
                </a>
              </p>
            </div>
          )}

          {state.status === "ready" && (
            <PlanList plans={state.data.plans.filter((p) => !p.isRegional)} currency={currency} locale={locale} />
          )}
        </div>
      </section>

      {/* Network */}
      <section className="mt-8 rounded-2xl bg-white p-5 ring-1 ring-slate-200">
        <h2 className="text-lg font-bold text-slate-900">
          {t(locale, "tourist.singapore.networkHeading")}
        </h2>
        <p
          className="mt-1 text-sm text-slate-700"
          data-testid="singapore-tourist-network-body"
        >
          {t(locale, "tourist.singapore.networkBody")}
        </p>
        {state.status === "ready" && state.data.networks && state.data.networks.length > 0 && (
          <ul className="mt-3 flex flex-wrap gap-2">
            {state.data.networks.map((n) => (
              <li
                key={n.label}
                className="inline-flex items-center rounded-full bg-slate-50 px-3 py-1 text-xs font-medium text-slate-700 ring-1 ring-slate-200"
              >
                {n.label}
                {n.speedRating ? ` · ${n.speedRating}` : ""}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Practical */}
      <section className="mt-8" aria-labelledby="sg-practical-heading">
        <h2 id="sg-practical-heading" className="text-lg font-bold text-slate-900">
          {t(locale, "tourist.singapore.practicalHeading")}
        </h2>
        <ul
          className="mt-3 divide-y divide-slate-200 rounded-2xl bg-white ring-1 ring-slate-200"
          data-testid="singapore-tourist-practical"
        >
          <PracticalItem>{t(locale, "tourist.singapore.practicalMoney")}</PracticalItem>
          <PracticalItem>{t(locale, "tourist.singapore.practicalPlug")}</PracticalItem>
          <PracticalItem>{t(locale, "tourist.singapore.practicalTransport")}</PracticalItem>
          <PracticalItem>{t(locale, "tourist.singapore.practicalApps")}</PracticalItem>
          <PracticalItem>{t(locale, "tourist.singapore.practicalEmergency")}</PracticalItem>
        </ul>
      </section>

      {/* Install */}
      <section
        className="mt-8 rounded-2xl bg-brand-50 p-5 ring-1 ring-brand-100"
        data-testid="singapore-tourist-install"
      >
        <h2 className="text-lg font-bold text-brand-900">
          {t(locale, "tourist.singapore.installHeading")}
        </h2>
        <p className="mt-1 text-sm text-brand-900/80">
          {t(locale, "tourist.singapore.installBody")}
        </p>
        <a
          href={plansHref}
          className="mt-4 inline-block rounded-xl bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700"
        >
          {t(locale, "common.buyNow")}
        </a>
      </section>

      {/* FAQ */}
      <section className="mt-8" aria-labelledby="sg-faq-heading">
        <h2 id="sg-faq-heading" className="text-lg font-bold text-slate-900">
          {t(locale, "tourist.singapore.faqHeading")}
        </h2>
        <ul className="mt-3 space-y-2">
          {(["1", "2", "3", "4", "5"] as const).map((n) => (
            <li
              key={n}
              className="rounded-2xl bg-white p-4 ring-1 ring-slate-200"
              data-testid={`singapore-tourist-faq-${n}`}
            >
              <details>
                <summary className="cursor-pointer text-sm font-semibold text-slate-900">
                  {t(locale, `tourist.singapore.faq${n}Q`)}
                </summary>
                <p className="mt-2 text-sm text-slate-700">
                  {t(locale, `tourist.singapore.faq${n}A`)}
                </p>
              </details>
            </li>
          ))}
        </ul>
      </section>

      {/* Closing CTA */}
      <section className="mt-8 rounded-3xl bg-slate-900 px-5 py-7 text-white sm:px-8 sm:py-9">
        <h2 className="text-lg font-extrabold sm:text-2xl">
          {t(locale, "tourist.singapore.ctaHeading")}
        </h2>
        <p className="mt-1 text-sm text-slate-200">
          {t(locale, "tourist.singapore.ctaBody")}
        </p>
        <a
          href={plansHref}
          className="mt-4 inline-block rounded-xl bg-white px-4 py-2 text-sm font-semibold text-slate-900 hover:bg-slate-100"
        >
          {t(locale, "tourist.singapore.primaryCta")}
        </a>
      </section>
    </main>
  );
}

// ---------------------------------------------------------------------------
// Sub-views
// ---------------------------------------------------------------------------

function PracticalItem({ children }: { children: React.ReactNode }): JSX.Element {
  return <li className="px-4 py-3 text-sm text-slate-700">{children}</li>;
}

function PlanList({
  plans,
  currency,
  locale,
}: {
  plans: Plan[];
  currency: Currency;
  locale: Locale;
}): JSX.Element {
  if (plans.length === 0) {
    return (
      <p
        className="rounded-2xl bg-slate-50 px-4 py-3 text-sm text-slate-600 ring-1 ring-slate-200"
        data-testid="singapore-tourist-plans-empty"
      >
        {t(locale, "country.reviewsEmpty", { country: "Singapore" })}
      </p>
    );
  }
  return (
    <ul className="grid gap-3 sm:grid-cols-2">
      {plans.map((p) => (
        <li
          key={p.code}
          className="rounded-2xl bg-white p-4 ring-1 ring-slate-200"
          data-testid={`singapore-tourist-plan-${p.code}`}
        >
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-slate-900">
                {p.displayName}
              </p>
              <p className="mt-0.5 text-xs text-slate-600">
                {p.dataLabel} · {p.validityLabel}
                {p.networkLabel && (
                  <>
                    {" "}· {t(locale, "country.runsOn", { network: p.networkLabel })}
                  </>
                )}
              </p>
            </div>
            <p className="shrink-0 text-right text-sm font-extrabold text-slate-900">
              {formatApprox(p.retailUsd, currency)}
            </p>
          </div>
          <div className="mt-3 flex items-center justify-between">
            {p.badge === "best-value" && (
              <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-semibold text-emerald-700 ring-1 ring-emerald-200">
                {t(locale, "country.bestValueBadge")}
              </span>
            )}
            <a
              href={p.buyHref}
              className="ml-auto rounded-xl bg-brand-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-700"
            >
              {t(locale, "common.buyNow")}
            </a>
          </div>
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Test surface
// ---------------------------------------------------------------------------
export const __test__ = {
  t,
  formatApprox,
  stringAt,
  BUNDLES,
};

export default SingaporeTourist;

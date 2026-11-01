/**
 * SocialProof — the honest, real-data social-proof strip used on country pages
 * and on the homepage.
 *
 * Two pieces of data drive this component, both of which MUST come from real
 * DB rows (never client-computed, never a fake number):
 *
 *   1) Weekly purchase counter — `X people bought [Country] eSIMs this week`.
 *      Sourced from `orders` (paid, non-refunded, within the last 7 days).
 *      The server aggregates and returns the count; this component will NOT
 *      render a number when the count is below a small floor (see
 *      `MIN_SHOW_COUNT`) because "1 person bought this" is anti-social proof.
 *
 *   2) Verified review summary — average + count of verified reviews for the
 *      country. "Verified" means the review was tied to an order id (see
 *      server/services/socialProof.ts). We do not render stars when the server
 *      returns 0 verified reviews.
 *
 * Contract with the backend (server/routes/reviews.ts — this component
 * assumes the following JSON shape; adjust the two fetchers below if the
 * route differs):
 *
 *   GET /api/reviews/social-proof?country=<slug>
 *     → 200 { ok: true, data: {
 *             country: { slug: string; name: string } | null;
 *             weeklyPurchases: { count: number; windowStart: string } | null;
 *             reviewSummary: { average: number; count: number } | null;
 *             guaranteeCopy?: string;
 *           } }
 *     → 4xx/5xx { ok: false, error: string; message: string }
 *
 * Honesty:
 *  - When weeklyPurchases is null or below MIN_SHOW_COUNT we render nothing for
 *    that row (no "0 people bought this week" placeholder).
 *  - When reviewSummary.count is 0 we hide the star block entirely.
 *  - If both are hidden we render `null` so parents don't need to guard.
 *  - While loading we render a skeleton (screen readers get "Loading").
 *  - On error we render a quiet placeholder (or nothing when `silentOnError`).
 *    We never substitute fake numbers.
 */
import { useEffect, useId, useMemo, useRef, useState } from "react";

// ---------------------------------------------------------------------------
// Types (mirrored from server/routes/reviews.ts — keep in sync)
// ---------------------------------------------------------------------------

export interface CountryRef {
  slug: string;
  name: string;
}

export interface WeeklyPurchases {
  count: number;
  /** ISO timestamp of the start of the 7-day window. */
  windowStart: string;
}

export interface ReviewSummary {
  average: number;
  count: number;
}

export interface SocialProofPayload {
  country: CountryRef | null;
  weeklyPurchases: WeeklyPurchases | null;
  reviewSummary: ReviewSummary | null;
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

class SocialProofError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "SocialProofError";
    this.code = code;
  }
}

async function fetchSocialProof(
  country: string,
  signal: AbortSignal,
): Promise<SocialProofPayload> {
  const url = `/api/reviews/social-proof?country=${encodeURIComponent(country)}`;
  const res = await fetch(url, {
    credentials: "include",
    headers: { Accept: "application/json" },
    signal,
  });
  const body = (await res.json().catch(() => ({}))) as ApiOk<SocialProofPayload> | ApiErr | {};
  if (!res.ok || !("ok" in body) || body.ok === false) {
    const err = body as ApiErr;
    throw new SocialProofError(
      err?.error ?? "request_failed",
      err?.message ?? `Request failed (HTTP ${res.status}).`,
    );
  }
  return (body as ApiOk<SocialProofPayload>).data;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Minimum number of purchases required before showing the weekly counter.
 * Below this, "X people bought" reads as negative social proof. 5 is a
 * conservative floor that travels well across every country page.
 */
const MIN_SHOW_COUNT = 5;

/** Below this many reviews, the summary looks statistically noisy. */
const MIN_REVIEW_COUNT = 3;

// ---------------------------------------------------------------------------
// Stars (kept local; not shared with PlanCard because that one has gradient
// half-fills and we want a text-sized variant here.)
// ---------------------------------------------------------------------------

function Stars({ value }: { value: number }): JSX.Element {
  const rounded = Math.round(value * 2) / 2;
  return (
    <span aria-hidden className="inline-flex items-center gap-0.5 text-amber-500">
      {[1, 2, 3, 4, 5].map((i) => {
        const fill = rounded >= i ? 1 : rounded >= i - 0.5 ? 0.5 : 0;
        return (
          <span key={i} className="relative inline-block h-[14px] w-[14px]">
            <svg
              viewBox="0 0 20 20"
              width="14"
              height="14"
              className="absolute inset-0 text-amber-200"
              aria-hidden
            >
              <path
                d="M10 1.5l2.6 5.3 5.9.9-4.3 4.2 1 5.8L10 15l-5.2 2.7 1-5.8L1.5 7.7l5.9-.9z"
                fill="currentColor"
              />
            </svg>
            {fill > 0 && (
              <span
                className="absolute inset-0 overflow-hidden"
                style={{ width: `${fill * 100}%` }}
                aria-hidden
              >
                <svg viewBox="0 0 20 20" width="14" height="14" className="text-amber-500">
                  <path
                    d="M10 1.5l2.6 5.3 5.9.9-4.3 4.2 1 5.8L10 15l-5.2 2.7 1-5.8L1.5 7.7l5.9-.9z"
                    fill="currentColor"
                  />
                </svg>
              </span>
            )}
          </span>
        );
      })}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface SocialProofProps {
  /** Country slug (e.g. "sg") whose proof to fetch. */
  country: string;
  /**
   * When true, a fetch error renders NOTHING instead of the fallback strip.
   * Use `true` on a page that already has plenty to read; `false` in a promo
   * row where the absence of the strip would look like a missing asset.
   */
  silentOnError?: boolean;
  /** Optional heading level for the loaded `<section>`. Defaults to none. */
  className?: string;
  /**
   * Override fetcher (for tests / SSR). Defaults to the global `fetch`.
   */
  fetchImpl?: typeof fetch;
}

type State =
  | { status: "loading" }
  | { status: "ready"; payload: SocialProofPayload }
  | { status: "error"; code: string; message: string };

/**
 * The strip rendered when data is loaded. Exported via `__test__` so a route
 * test can assert the visible text variants without a DOM harness.
 */
export function buildStrip(payload: SocialProofPayload): {
  showCount: boolean;
  count: number;
  countryName: string | null;
  showReviews: boolean;
  average: number | null;
  reviewCount: number | null;
} {
  const purchased = payload.weeklyPurchases;
  const reviews = payload.reviewSummary;
  const showCount =
    purchased != null && Number.isFinite(purchased.count) && purchased.count >= MIN_SHOW_COUNT;
  const showReviews =
    reviews != null &&
    Number.isFinite(reviews.average) &&
    reviews.average > 0 &&
    reviews.average <= 5 &&
    Number.isFinite(reviews.count) &&
    reviews.count >= MIN_REVIEW_COUNT;
  return {
    showCount,
    count: purchased?.count ?? 0,
    countryName: payload.country?.name ?? null,
    showReviews,
    average: showReviews ? reviews!.average : null,
    reviewCount: showReviews ? reviews!.count : null,
  };
}

export function SocialProof({
  country,
  silentOnError = false,
  className = "",
  fetchImpl,
}: SocialProofProps): JSX.Element | null {
  const fetchFn = fetchImpl ?? fetch;
  const [state, setState] = useState<State>({ status: "loading" });
  const abortRef = useRef<AbortController | null>(null);
  const idBase = useId();

  useEffect(() => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setState({ status: "loading" });

    // Inline fetch (not the shared helper) because the shared helper has a
    // different `{ data }` envelope used elsewhere and we want this file to
    // stay self-contained with the contract at the top.
    (async () => {
      try {
        const url = `/api/reviews/social-proof?country=${encodeURIComponent(country)}`;
        const res = await fetchFn(url, {
          credentials: "include",
          headers: { Accept: "application/json" },
          signal: controller.signal,
        });
        const body = (await res.json().catch(() => ({}))) as
          | ApiOk<SocialProofPayload>
          | ApiErr
          | {};
        if (controller.signal.aborted) return;
        if (!res.ok || !("ok" in body) || body.ok === false) {
          const err = body as ApiErr;
          setState({
            status: "error",
            code: err?.error ?? "request_failed",
            message: err?.message ?? `Request failed (HTTP ${res.status}).`,
          });
          return;
        }
        setState({ status: "ready", payload: (body as ApiOk<SocialProofPayload>).data });
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        if (controller.signal.aborted) return;
        setState({
          status: "error",
          code: "request_failed",
          message: err instanceof Error ? err.message : "Could not load social proof.",
        });
      }
    })();

    return () => controller.abort();
  }, [country, fetchFn]);

  const strip = useMemo(
    () => (state.status === "ready" ? buildStrip(state.payload) : null),
    [state],
  );

  if (state.status === "loading") {
    return (
      <div
        aria-busy
        aria-label="Loading social proof"
        data-testid="social-proof-loading"
        className={`flex gap-2 ${className}`}
      >
        <span
          className="h-7 w-40 animate-pulse rounded-full bg-slate-100"
          id={`${idBase}-c`}
        />
        <span className="h-7 w-28 animate-pulse rounded-full bg-slate-100" />
      </div>
    );
  }

  if (state.status === "error") {
    if (silentOnError) return null;
    return (
      <p
        role="status"
        data-testid="social-proof-error"
        data-error-code={state.code}
        className={`text-xs text-slate-500 ${className}`}
      >
        Reviews and purchase counts are loading slowly — refresh to try again.
      </p>
    );
  }

  // state === ready
  if (!strip || (!strip.showCount && !strip.showReviews)) {
    // Nothing truthful to show → render nothing at all. Callers don't need to
    // guard.
    return null;
  }

  const countryLabel = strip.countryName ?? country.toUpperCase();

  return (
    <div
      data-testid="social-proof"
      className={`flex flex-wrap items-center gap-2 ${className}`}
    >
      {strip.showCount && (
        <span
          data-testid="social-proof-purchases"
          data-count={strip.count}
          className="inline-flex items-center gap-1.5 rounded-full bg-brand-50 px-2.5 py-1 text-xs font-semibold text-brand-800 ring-1 ring-brand-100"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            aria-hidden
          >
            <path
              d="M17 20v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 10a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM22 20v-2a4 4 0 0 0-3-3.87M16 2.13A4 4 0 0 1 16 9.87"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          {strip.count} {strip.count === 1 ? "person bought" : "people bought"} {countryLabel}{" "}
          {countryLabel.endsWith("s") ? "eSIMs" : "eSIMs"} this week
        </span>
      )}

      {strip.showReviews && strip.average != null && strip.reviewCount != null && (
        <span
          data-testid="social-proof-reviews"
          data-average={strip.average}
          data-count={strip.reviewCount}
          className="inline-flex items-center gap-1.5 rounded-full bg-white px-2.5 py-1 text-xs font-medium text-slate-700 ring-1 ring-slate-200"
        >
          <Stars value={strip.average} />
          <span className="font-semibold text-slate-900">
            {strip.average.toFixed(1)}
          </span>
          <span className="text-slate-500">
            · {strip.reviewCount} verified{" "}
            {strip.reviewCount === 1 ? "review" : "reviews"}
          </span>
        </span>
      )}
    </div>
  );
}

export const __test__ = {
  buildStrip,
  MIN_SHOW_COUNT,
  MIN_REVIEW_COUNT,
  fetchSocialProof,
};

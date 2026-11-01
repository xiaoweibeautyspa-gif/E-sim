/**
 * Destination / country page: /esim/[country].
 *
 * Responsibilities (Phase 1 scope):
 * - Read plans for the country from the catalog API (DB-backed, never the
 *   supplier). Re-fetch when filters change so "best value" stays
 *   server-authoritative, while the current list stays visible during the
 *   refetch.
 * - Filters via <PlanFilters> mapped to the `/catalog/country/:slug` query
 *   params (minDataGb, maxDays, daily, sortBy). The filter component owns
 *   rendering; the page owns filter state and the network call.
 * - Plan cards via <PlanCard> with the Best value badge from the server.
 * - Reviews via <ReviewList>. The host supplies `reviews` when the (later)
 *   review API is wired; until then the component renders its honest empty
 *   state. Speed ratings are passed through to PlanCard when available.
 *
 * State model is explicit: distinct loading, empty, error and ready branches.
 * No fabricated plan or review data anywhere.
 */
import { useEffect, useMemo, useState } from "react";
import { PlanCard } from "../components/PlanCard";
import { PlanFilters, type PlanFiltersValue } from "../components/PlanFilters";
import { ReviewList, type Review } from "../components/ReviewList";
import {
  apiClient,
  countryName,
  type CatalogPlan,
  type CountryPlansResponse,
  type DisplayCurrency,
} from "../lib/apiClient";

export interface CountryPageProps {
  /** Lowercase ISO-3166 alpha-2 slug from the route. */
  country: string;
  /** Optional preloaded reviews for this country. Populated by the conversion phase. */
  reviews?: Review[];
  /** Optional speed ratings keyed by plan code (admin-managed table later). */
  speedByPlan?: Record<string, { label: string; outOf5: number }>;
  /** Called when the user chooses a plan. Checkout wiring lands in a later phase. */
  onChoose?: (plan: CatalogPlan) => void;
}

const DEFAULT_FILTERS: PlanFiltersValue = {
  minDataGb: undefined,
  maxDays: undefined,
  daily: undefined,
  sortBy: "none",
};

/**
 * Build the query string for `/catalog/country/:slug` from filters.
 * Only includes params the server understands; keeps the URL minimal.
 */
export function buildCountryQuery(filters: PlanFiltersValue): string {
  const params = new URLSearchParams();
  if (filters.minDataGb != null) params.set("minDataGb", String(filters.minDataGb));
  if (filters.maxDataGb != null) params.set("maxDataGb", String(filters.maxDataGb));
  if (filters.minDays != null) params.set("minDays", String(filters.minDays));
  if (filters.maxDays != null) params.set("maxDays", String(filters.maxDays));
  if (filters.daily === true) params.set("daily", "true");
  else if (filters.daily === false) params.set("daily", "false");
  if (filters.sortBy !== "none") params.set("sortBy", filters.sortBy);
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

function SectionError({ message, onRetry }: { message: string; onRetry: () => void }): JSX.Element {
  return (
    <div className="rounded-2xl bg-rose-50 p-4 text-sm text-rose-800 ring-1 ring-rose-200" role="alert">
      <p>{message}</p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-2 rounded-lg bg-rose-600 px-3 py-1.5 font-medium text-white hover:bg-rose-700"
      >
        Try again
      </button>
    </div>
  );
}

function PlanGridSkeleton({ count = 4 }: { count?: number }): JSX.Element {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" aria-hidden data-testid="plans-loading">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="h-56 animate-pulse rounded-2xl bg-slate-100 ring-1 ring-slate-200" />
      ))}
    </div>
  );
}

export function CountryPage({
  country,
  reviews,
  speedByPlan,
  onChoose,
}: CountryPageProps): JSX.Element {
  const slug = country.toLowerCase();
  const [filters, setFilters] = useState<PlanFiltersValue>(DEFAULT_FILTERS);
  const [currency, setCurrency] = useState<DisplayCurrency>("USD");
  const [state, setState] = useState<
    | { status: "loading" }
    | { status: "ready"; data: CountryPlansResponse }
    | { status: "error"; message: string }
  >({ status: "loading" });
  const [reloadNonce, setReloadNonce] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    // Keep previous data visible during a refetch to avoid a flashing skeleton.
    setState((prev) => (prev.status === "ready" ? prev : { status: "loading" }));
    const query = buildCountryQuery(filters);
    apiClient
      .getCountryPlans(`${slug}${query}`, { signal: controller.signal })
      .then((data) => {
        if (!controller.signal.aborted) setState({ status: "ready", data });
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setState({
          status: "error",
          message: err instanceof Error ? err.message : "Could not load plans.",
        });
      });
    return () => controller.abort();
  }, [slug, filters, reloadNonce]);

  const displayName = useMemo(() => countryName(slug), [slug]);

  function handleChoose(planCode: string) {
    if (state.status !== "ready") return;
    const plan = state.data.plans.find((p) => p.code === planCode);
    if (plan && onChoose) onChoose(plan);
  }

  // Reviews summary per plan derived from the props (only when the host supplied them).
  const reviewSummaryByPlan = useMemo<Record<string, { count: number; average: number }>>(() => {
    if (!reviews || reviews.length === 0) return {};
    const grouped = new Map<string, { count: number; total: number }>();
    for (const r of reviews) {
      if (!r.planLabel) continue;
      const key = r.planLabel;
      const cur = grouped.get(key) ?? { count: 0, total: 0 };
      cur.count += 1;
      cur.total += Number.isFinite(r.rating) ? r.rating : 0;
      grouped.set(key, cur);
    }
    const out: Record<string, { count: number; average: number }> = {};
    for (const [key, v] of grouped) {
      out[key] = { count: v.count, average: v.total / v.count };
    }
    return out;
  }, [reviews]);

  return (
    <div className="mx-auto w-full max-w-6xl px-4 pb-16" data-testid="country-page">
      {/* Hero */}
      <nav aria-label="Breadcrumb" className="mt-4 text-sm text-slate-500">
        <a href="/" className="hover:text-slate-800">Home</a>
        <span aria-hidden className="px-2">/</span>
        <span className="text-slate-800">{displayName}</span>
      </nav>

      <section className="mt-3 overflow-hidden rounded-3xl bg-gradient-to-br from-brand-600 to-brand-700 px-5 py-8 text-white sm:px-8 sm:py-10">
        <h1 className="text-2xl font-extrabold sm:text-3xl" data-testid="country-heading">
          eSIM for {displayName}
        </h1>
        <p className="mt-2 max-w-2xl text-sm text-brand-50/90">
          Instant data on arrival. Scan a QR, switch on the plan, and skip the roaming bill.
          All plans are prepaid and come with a friendly install guide.
        </p>
        <div className="mt-4 flex items-center gap-3 text-sm">
          <label htmlFor="country-currency" className="text-brand-50/80">Show prices in</label>
          <select
            id="country-currency"
            value={currency}
            onChange={(e) => setCurrency(e.target.value as DisplayCurrency)}
            className="rounded-lg border-0 bg-white/15 px-2 py-1 text-white outline-none ring-1 ring-white/20 focus:ring-2 focus:ring-white"
            data-testid="country-currency"
          >
            <option className="text-slate-900" value="USD">USD</option>
            <option className="text-slate-900" value="SGD">SGD</option>
            <option className="text-slate-900" value="VND">VND</option>
            <option className="text-slate-900" value="CNY">CNY</option>
          </select>
          <span className="text-xs text-brand-50/60">Indicative — settled at checkout</span>
        </div>
      </section>

      {/* Filters */}
      <div className="mt-6">
        <PlanFilters
          value={filters}
          onChange={setFilters}
          busy={state.status === "loading"}
          ariaLabel={`Filters for ${displayName} plans`}
        />
      </div>

      {/* Plans */}
      <section className="mt-6" aria-labelledby="plans-heading">
        <h2 id="plans-heading" className="mb-4 text-lg font-bold text-slate-900">
          Available plans
        </h2>

        {state.status === "loading" && <PlanGridSkeleton />}

        {state.status === "error" && (
          <SectionError message={state.message} onRetry={() => setReloadNonce((n) => n + 1)} />
        )}

        {state.status === "ready" && state.data.plans.length === 0 && (
          <div
            className="rounded-2xl bg-slate-50 p-6 text-center text-sm text-slate-600 ring-1 ring-slate-200"
            data-testid="plans-empty"
          >
            <p className="font-medium text-slate-800">No plans match those filters.</p>
            <p className="mt-1">Try widening the data or duration range.</p>
            <button
              type="button"
              onClick={() => setFilters({ ...DEFAULT_FILTERS })}
              className="mt-3 rounded-lg bg-brand-600 px-3 py-1.5 font-medium text-white hover:bg-brand-700"
            >
              Reset filters
            </button>
          </div>
        )}

        {state.status === "ready" && state.data.plans.length > 0 && (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {state.data.plans.map((plan) => {
              const summary =
                reviewSummaryByPlan[plan.name] ??
                (reviews
                  ? deriveSummaryByName(reviews, plan.name)
                  : undefined);
              const speed = speedByPlan?.[plan.code];
              return (
                <PlanCard
                  key={plan.code}
                  plan={plan}
                  currency={currency}
                  isBestValue={state.data.bestValueCode === plan.code}
                  reviewSummary={summary ?? null}
                  speedRating={speed ?? null}
                  onChoose={onChoose ? handleChoose : undefined}
                />
              );
            })}
          </div>
        )}
      </section>

      {/* Reviews */}
      <div className="mt-10">
        <ReviewList
          reviews={reviews}
          countryLabel={displayName}
          reviewsHref={`/esim/${slug}/reviews`}
        />
      </div>
    </div>
  );
}

/**
 * Derive a review summary for a plan name from the full review list. The
 * server-authoritative reviews API will supply per-plan counts directly in the
 * conversion phase; until then we approximate by matching the review's
 * `planLabel` to the plan's display name. If nothing matches, `undefined` is
 * returned so PlanCard renders without a review line rather than a fake star.
 */
function deriveSummaryByName(
  reviews: Review[],
  planName: string,
): { count: number; average: number } | undefined {
  const matching = reviews.filter((r) => r.planLabel === planName);
  if (matching.length === 0) return undefined;
  const total = matching.reduce((s, r) => s + (Number.isFinite(r.rating) ? r.rating : 0), 0);
  return { count: matching.length, average: total / matching.length };
}

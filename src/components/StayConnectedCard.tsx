/**
 * StayConnectedCard — the "Stay connected" recommendation shown beside a
 * streamed trip plan (and, in a later batch, inside saved trips / offline
 * packs).
 *
 * Contract:
 *   - Props carry a REAL plan (the shape the route emits in its `connected`
 *     SSE event) or `null`. The card NEVER fabricates a plan, price, or
 *     network. When `plan` is null the component renders nothing at all
 *     (`return null`), so callers can drop it in without a null check.
 *   - "Buy now" href comes from the server (`plan.buyHref`). We do not build
 *     it client-side, because only the server knows today's country slug and
 *     pre-chosen-plan routing. If `buyHref` is empty we omit the button — a
 *     dead "Buy now" is worse than none.
 *   - Price formatting is via a caller-supplied `formatPrice` callback so the
 *     currency (SGD/USD/VND/CNY) is the caller's truth (the page passes the
 *     currency the user picked for their budget, or the storefront default).
 *     We also expose a sensible default formatter for embedding elsewhere.
 *   - The `isRegional` flag drives a small explainer line. When true we say
 *     "one regional plan for every country on your trip"; when false we say
 *     "one plan for your main destination". Anything more elaborate is the
 *     page's job.
 *
 * Design notes:
 *   - Purely presentational: no fetch, no state, no effects. It's safe in
 *     every render (including inside a streamed output where the parent
 *     re-renders on every token) because the output is stable for a given
 *     plan.
 *   - Mobile-first, matches the visual language of PlanCard / EsimCard
 *     (rounded-2xl, brand tint, ring, single primary button).
 *   - Accessible: single heading level (h2 by default, configurable), real
 *     `<a>` for Buy now so middle-click / cmd-click / right-click work.
 *     `data-testid` set on the whole card and the buy button so end-to-end
 *     tests can assert the exact plan rendered.
 */

// ---------------------------------------------------------------------------
// Types — mirror the route's `StayConnectedPlan` shape in
// `server/routes/tripPlanner.ts` so this file can be used directly from a
// saved trip payload later without a translation layer.
// ---------------------------------------------------------------------------

export interface StayConnectedPlan {
  /** Stable plan code (e.g. "sg-10gb-30d"). */
  planCode: string;
  /** Human name as stored on the package (may be duplicated by displayName). */
  name: string;
  /** Fully-qualified label like "Singapore 10 GB · 30 days". */
  displayName: string;
  /** "10 GB" or "Unlimited / day". */
  dataLabel: string;
  /** "30 days" or "7 days". */
  validityLabel: string;
  /** "Singtel 5G, StarHub 4G" — already human-readable from the server. */
  networkLabel: string | null;
  /** Country slug for linking back to a country page, when single-country. */
  countrySlug: string | null;
  /** Retail price in USD (before tax). Formatting is the caller's job. */
  retailUsd: number;
  /** True for regional (multi-country) products. */
  isRegional: boolean;
  /** Server-built "Buy now" URL. Empty string = no button. */
  buyHref: string;
}

export interface StayConnectedCardProps {
  /** Real plan from the server, or null → renders nothing. */
  plan: StayConnectedPlan | null;
  /**
   * Formats a USD number into the display currency. Pass the page's own
   * currency-aware formatter so the card stays consistent with the rest of
   * the page. Defaults to a plain USD formatter.
   */
  formatPrice?: (usd: number) => string;
  /** Heading level. Defaults to h2. */
  headingLevel?: 2 | 3;
  /** Optional aria-label override for the section. */
  ariaLabel?: string;
  /** Optional class appended to the outer article. */
  className?: string;
}

// ---------------------------------------------------------------------------
// Default formatter
// ---------------------------------------------------------------------------

/**
 * Plain USD formatter. Deliberately minimal — pages that care about currency
 * pass their own `formatPrice` (the trip planner page passes one that applies
 * the user's budget currency).
 */
export function defaultFormatPrice(usd: number): string {
  if (!Number.isFinite(usd) || usd < 0) return "—";
  return `$${usd.toFixed(2)} USD`;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function StayConnectedCard({
  plan,
  formatPrice = defaultFormatPrice,
  headingLevel = 2,
  ariaLabel = "Stay connected on your trip",
  className = "",
}: StayConnectedCardProps): JSX.Element | null {
  if (!plan) return null;

  const Heading = headingLevel === 3 ? "h3" : "h2";
  const pricing = formatPrice(plan.retailUsd);
  const hasBuy = plan.buyHref.trim().length > 0;
  const explainer = plan.isRegional
    ? "One regional plan covers every country on your trip."
    : "One plan for your main destination.";

  return (
    <article
      className={`rounded-2xl bg-brand-50 p-5 ring-1 ring-brand-100 ${className}`}
      aria-label={ariaLabel}
      data-testid="stay-connected-card"
      data-plan-code={plan.planCode}
      data-is-regional={plan.isRegional ? "true" : "false"}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <Heading className="text-base font-bold text-brand-900">Stay connected</Heading>
          <p className="mt-1 text-sm text-brand-900/80">{explainer}</p>
        </div>
        {plan.isRegional && (
          <span
            className="shrink-0 rounded-full bg-white px-2 py-0.5 text-[11px] font-semibold text-brand-700 ring-1 ring-brand-200"
            data-testid="stay-connected-regional-badge"
          >
            Regional
          </span>
        )}
      </div>

      <div className="mt-4 flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-slate-900" data-testid="stay-connected-name">
            {plan.displayName || plan.name}
          </p>
          <p className="mt-0.5 text-xs text-slate-600" data-testid="stay-connected-meta">
            {plan.dataLabel} · {plan.validityLabel}
            {plan.networkLabel && (
              <>
                {" "}· Runs on{" "}
                <span className="font-medium text-slate-700">{plan.networkLabel}</span>
              </>
            )}
          </p>
        </div>
        <div className="text-right">
          <p
            className="text-lg font-extrabold leading-none text-slate-900"
            data-testid="stay-connected-price"
          >
            {pricing}
          </p>
          {hasBuy ? (
            <a
              href={plan.buyHref}
              className="mt-2 inline-block rounded-xl bg-brand-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-brand-700"
              data-testid="stay-connected-buy"
            >
              Buy now
            </a>
          ) : (
            <p
              className="mt-2 text-[11px] text-slate-500"
              data-testid="stay-connected-no-buy"
            >
              Buy now is temporarily unavailable.
            </p>
          )}
        </div>
      </div>

      {plan.countrySlug && (
        <p className="mt-3 text-[11px] text-slate-500">
          <a
            href={`/esim/${plan.countrySlug}`}
            className="font-medium text-brand-700 hover:text-brand-800"
            data-testid="stay-connected-country-link"
          >
            See all {plan.displayName.split(" ")[0] ?? "destination"} plans →
          </a>
        </p>
      )}
    </article>
  );
}

// ---------------------------------------------------------------------------
// Test surface
// ---------------------------------------------------------------------------

export const __test__ = {
  defaultFormatPrice,
};

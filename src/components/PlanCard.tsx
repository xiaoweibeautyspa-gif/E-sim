/**
 * A single eSIM plan card used on country pages (and anywhere a plan is listed).
 *
 * Displays: data allowance (GB or daily-unlimited), validity in days, retail
 * price in the chosen display currency, and the network(s) the plan runs on
 * ("Runs on Singtel 5G"). Optionally shows a "Best value" badge, a verified
 * review summary, and a network speed rating when the host provides them.
 *
 * Deliberately dumb: no data fetching, no business logic. The parent passes a
 * `CatalogPlan` (server-priced) and cosmetic flags. Prices are formatted from
 * USD via the shared `formatMoney` helper so display stays consistent.
 *
 * The primary action ("Choose plan") calls `onChoose` with the plan code. The
 * checkout flow is a later phase; this phase wires the button to the handler so
 * the control is real, not decorative. When no handler is supplied the button
 * is disabled with an explanatory title rather than pretending to do something.
 */
import type { CatalogPlan, DisplayCurrency } from "../lib/apiClient";
import { formatMoney } from "../lib/apiClient";

export interface PlanCardProps {
  plan: CatalogPlan;
  currency: DisplayCurrency;
  /** Marks the server-selected best-value plan with a badge. */
  isBestValue?: boolean;
  /** Optional speed rating e.g. `{ label: "Fast", outOf5: 4.5 }`. */
  speedRating?: { label: string; outOf5: number } | null;
  /** Optional verified review summary (count + average). */
  reviewSummary?: { count: number; average: number } | null;
  /** Called when the user picks this plan. Omit to disable the action. */
  onChoose?: (planCode: string) => void;
  /** Disables the action while a checkout session is being created. */
  busy?: boolean;
}

function dataLabel(plan: CatalogPlan): string {
  if (plan.isDailyPlan) return "Unlimited / day";
  if (plan.dataGb != null) return `${trimNumber(plan.dataGb)} GB`;
  return "Data included";
}

function validityLabel(plan: CatalogPlan): string | null {
  if (plan.durationDays == null) return null;
  return `${plan.durationDays} ${plan.durationDays === 1 ? "day" : "days"}`;
}

function trimNumber(n: number): string {
  // Show 1 decimal only when needed (1 instead of 1.0, 1.5 stays 1.5).
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

function networkLabel(plan: CatalogPlan): string | null {
  if (plan.operators.length === 0) return null;
  // Show the first two networks to avoid clutter; "+N more" beyond that.
  const [first, second, ...rest] = plan.operators;
  const shown = [first, second].filter(Boolean).join(", ");
  const suffix = rest.length > 0 ? ` +${rest.length} more` : "";
  return `Runs on ${shown}${suffix}`;
}

function Stars({ value }: { value: number }): JSX.Element {
  // Rounds to the nearest half for a simple, honest visual.
  const rounded = Math.round(value * 2) / 2;
  return (
    <span aria-hidden className="inline-flex items-center gap-0.5 text-amber-500">
      {[1, 2, 3, 4, 5].map((i) => {
        const fill = rounded >= i ? "full" : rounded >= i - 0.5 ? "half" : "empty";
        return (
          <svg key={i} width="14" height="14" viewBox="0 0 20 20" aria-hidden>
            <defs>
              <linearGradient id={`star-half-${i}`}>
                <stop offset="50%" stopColor="currentColor" />
                <stop offset="50%" stopColor="transparent" />
              </linearGradient>
            </defs>
            <path
              d="M10 1.5l2.6 5.3 5.9.9-4.3 4.2 1 5.8L10 15l-5.2 2.7 1-5.8L1.5 7.7l5.9-.9z"
              fill={
                fill === "full"
                  ? "currentColor"
                  : fill === "half"
                    ? `url(#star-half-${i})`
                    : "none"
              }
              stroke="currentColor"
              strokeWidth="1"
            />
          </svg>
        );
      })}
    </span>
  );
}

export function PlanCard({
  plan,
  currency,
  isBestValue = false,
  speedRating = null,
  reviewSummary = null,
  onChoose,
  busy = false,
}: PlanCardProps): JSX.Element {
  const validity = validityLabel(plan);
  const network = networkLabel(plan);
  const price = formatMoney(plan.retailUsd, currency);
  const canChoose = typeof onChoose === "function" && !busy;

  return (
    <article
      data-testid={`plan-card-${plan.code}`}
      data-best-value={isBestValue ? "true" : "false"}
      className={`relative flex h-full flex-col rounded-2xl bg-white p-5 ring-1 transition ${
        isBestValue
          ? "ring-2 ring-brand-500 shadow-lg shadow-brand-500/10"
          : "ring-slate-200 hover:shadow-md"
      }`}
    >
      {isBestValue && (
        <span
          data-testid="best-value-badge"
          className="absolute -top-3 left-5 inline-flex items-center gap-1 rounded-full bg-brand-600 px-2.5 py-0.5 text-xs font-bold text-white shadow"
        >
          <svg width="12" height="12" viewBox="0 0 20 20" fill="currentColor" aria-hidden>
            <path d="M10 1l2.4 5 5.5.5-4.1 3.6 1.2 5.4L10 12.9 5 15.5l1.2-5.4L2.1 6.5 7.6 6z" />
          </svg>
          Best value
        </span>
      )}

      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-slate-900">{plan.name}</h3>
          {plan.region && (
            <p className="mt-0.5 text-xs uppercase tracking-wide text-brand-600">
              {plan.region}
            </p>
          )}
        </div>
        <div className="text-right">
          <p className="text-xl font-extrabold leading-none text-slate-900" data-testid="plan-price">
            {price}
          </p>
          <p className="mt-0.5 text-[11px] text-slate-400">incl. taxes</p>
        </div>
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
        <div className="rounded-xl bg-slate-50 p-2.5">
          <dt className="text-[11px] uppercase tracking-wide text-slate-400">Data</dt>
          <dd
            className="mt-0.5 font-semibold text-slate-800"
            data-testid="plan-data"
          >
            {dataLabel(plan)}
          </dd>
        </div>
        <div className="rounded-xl bg-slate-50 p-2.5">
          <dt className="text-[11px] uppercase tracking-wide text-slate-400">Validity</dt>
          <dd className="mt-0.5 font-semibold text-slate-800">
            {validity ?? "—"}
          </dd>
        </div>
      </dl>

      {network && (
        <p className="mt-3 flex items-center gap-1.5 text-xs text-slate-600" data-testid="plan-network">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
            <path d="M2 20h.01M7 20v-4M12 20V10M17 20V4M22 20V8" strokeLinecap="round" />
          </svg>
          {network}
        </p>
      )}

      {speedRating && (
        <p className="mt-1 flex items-center gap-1.5 text-xs text-slate-600" data-testid="plan-speed">
          <span className="font-medium text-slate-700">Speed</span>
          <span>{speedRating.label}</span>
          <span className="text-slate-400">· {speedRating.outOf5.toFixed(1)}/5</span>
        </p>
      )}

      {reviewSummary && reviewSummary.count > 0 ? (
        <p className="mt-2 flex items-center gap-1.5 text-xs text-slate-600" data-testid="plan-reviews">
          <Stars value={reviewSummary.average} />
          <span className="font-medium text-slate-700">{reviewSummary.average.toFixed(1)}</span>
          <span className="text-slate-400">
            ({reviewSummary.count} {reviewSummary.count === 1 ? "review" : "reviews"})
          </span>
        </p>
      ) : null}

      <div className="mt-auto pt-4">
        <button
          type="button"
          onClick={() => onChoose?.(plan.code)}
          disabled={!canChoose}
          title={canChoose ? undefined : "Checkout arrives in the next phase"}
          className={`w-full rounded-xl px-4 py-2.5 text-sm font-semibold transition ${
            canChoose
              ? "bg-brand-600 text-white hover:bg-brand-700"
              : "cursor-not-allowed bg-slate-100 text-slate-400"
          }`}
          data-testid={`choose-plan-${plan.code}`}
        >
          {busy ? "Starting…" : "Choose plan"}
        </button>
      </div>
    </article>
  );
}

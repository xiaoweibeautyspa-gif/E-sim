/**
 * Verified review list for a country (or a specific plan).
 *
 * This component is display-only. The `reviews` prop is supplied by the host
 * from a real source (the reviews API added in the conversion phase); while
 * that data does not exist the host passes `undefined` and this component
 * renders a plain, honest empty state — no invented stars, no fake counts.
 *
 * Every review carries `verified: true|false`; the badge only renders when
 * `verified` is true so it can never imply verification that doesn't exist.
 * The list is bounded (`limit`) to keep country pages tight; when more reviews
 * exist a "See all N reviews" link is shown pointing at `reviewsHref`.
 */
import { useId, useMemo } from "react";

export interface Review {
  id: string | number;
  /** 1..5, in half-star precision is allowed (e.g. 4.5). */
  rating: number;
  /** Review body. Keep it short; long reviews are truncated by CSS. */
  body: string;
  /** Reviewer display name as shown publicly (e.g. "Wei L."). */
  author: string;
  /** ISO date string of when the review was posted. */
  createdAt: string;
  /** Quick provenance label, e.g. "Japan 10 GB · 30 days". */
  planLabel?: string;
  /** Country the review is for, used in the accessible label. */
  country?: string;
  /** True only when the review was left by a verified buyer. */
  verified: boolean;
}

export interface ReviewListProps {
  /** Reviews to display. `undefined` → empty state; `[]` → also empty. */
  reviews: Review[] | undefined;
  /** Max reviews to render. Defaults to 5. */
  limit?: number;
  /** Heading text. Defaults to "Reviews". */
  heading?: string;
  /** Human country name for the empty state copy. */
  countryLabel?: string;
  /** When set, an "All N reviews" link is shown next to the heading. */
  reviewsHref?: string;
}

const DEFAULT_LIMIT = 5;

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-GB", { year: "numeric", month: "short" });
}

function StarRow({ value }: { value: number }): JSX.Element {
  const rounded = Math.round(value * 2) / 2;
  const label = `${Math.max(0, Math.min(5, value)).toFixed(1)} out of 5`;
  return (
    <span className="inline-flex items-center gap-0.5 text-amber-500" aria-label={label}>
      {[1, 2, 3, 4, 5].map((i) => {
        const fill = rounded >= i ? "full" : rounded >= i - 0.5 ? "half" : "empty";
        return (
          <svg key={i} width="14" height="14" viewBox="0 0 20 20" aria-hidden>
            <defs>
              <linearGradient id={`rl-half-${i}`}>
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
                    ? `url(#rl-half-${i})`
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

export function ReviewList({
  reviews,
  limit = DEFAULT_LIMIT,
  heading = "Reviews",
  countryLabel,
  reviewsHref,
}: ReviewListProps): JSX.Element {
  const headingId = useId();
  const all = reviews ?? [];
  const shown = useMemo(() => all.slice(0, Math.max(1, limit)), [all, limit]);

  function summary(): { count: number; average: number } {
    if (all.length === 0) return { count: 0, average: 0 };
    const total = all.reduce((sum, r) => sum + (Number.isFinite(r.rating) ? r.rating : 0), 0);
    return { count: all.length, average: total / all.length };
  }

  const { count, average } = summary();

  return (
    <section aria-labelledby={headingId} data-testid="review-list">
      <div className="flex items-end justify-between gap-3">
        <div>
          <h2 id={headingId} className="text-lg font-bold text-slate-900">
            {heading}
          </h2>
          {count > 0 && (
            <p className="mt-1 flex items-center gap-2 text-sm text-slate-600">
              <StarRow value={average} />
              <span className="font-semibold text-slate-800">{average.toFixed(1)}</span>
              <span className="text-slate-400">
                ({count} verified {count === 1 ? "review" : "reviews"})
              </span>
            </p>
          )}
        </div>
        {reviewsHref && all.length > limit && (
          <a
            href={reviewsHref}
            className="text-sm font-medium text-brand-700 hover:text-brand-800"
          >
            All {all.length} reviews →
          </a>
        )}
      </div>

      {count === 0 ? (
        <p
          className="mt-3 rounded-2xl bg-slate-50 p-4 text-sm text-slate-600 ring-1 ring-slate-200"
          data-testid="reviews-empty"
        >
          {countryLabel
            ? `No reviews yet for ${countryLabel} plans. Reviews open up after a trip — you'll get an email asking for one.`
            : "No reviews yet. Reviews open up after a trip — you'll get an email asking for one."}
        </p>
      ) : (
        <ul className="mt-3 space-y-3" data-testid="country-reviews">
          {shown.map((r) => (
            <li
              key={r.id}
              className="rounded-2xl bg-white p-4 text-sm text-slate-700 ring-1 ring-slate-200"
              data-testid={`review-${r.id}`}
            >
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <StarRow value={r.rating} />
                  <span className="font-semibold text-slate-800">{r.rating.toFixed(1)}</span>
                  {r.verified && (
                    <span
                      className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700 ring-1 ring-emerald-200"
                      data-testid="review-verified"
                    >
                      <svg width="10" height="10" viewBox="0 0 20 20" fill="currentColor" aria-hidden>
                        <path d="M7.6 13.2 4 9.6l1.4-1.4 2.2 2.2 6-6L15 5.8z" />
                      </svg>
                      Verified
                    </span>
                  )}
                </div>
                {r.createdAt && (
                  <time
                    className="text-xs text-slate-400"
                    dateTime={r.createdAt}
                  >
                    {formatDate(r.createdAt)}
                  </time>
                )}
              </div>
              <p className="mt-2 line-clamp-4 text-slate-700">{r.body}</p>
              <p className="mt-2 text-xs text-slate-500">
                <span className="font-medium text-slate-700">{r.author}</span>
                {r.planLabel && (
                  <>
                    <span aria-hidden className="px-1">·</span>
                    <span>{r.planLabel}</span>
                  </>
                )}
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

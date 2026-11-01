/**
 * GuaranteeBadge — the money-back guarantee badge.
 *
 * Shown at checkout (and optionally on plan cards / country pages) to reduce
 * purchase anxiety. Copy is sourced from `brand.guaranteeCopy` so the promise
 * is stated identically everywhere (emails, checkout, here). We do not
 * paraphrase it per-surface: a guarantee that reads three ways looks like
 * marketing spin.
 *
 * Design:
 *  - Purely presentational. No fetch, no state. Safe to render in SSR.
 *  - Two variants: `inline` (a pill for tight spots like the checkout summary
 *    line) and `card` (a bordered panel for a dedicated reassurance row).
 *  - It does NOT show a "trustpilot" style score or a review count — those are
 *    SocialProof's job, sourced from real data. Keeping the two separate means
 *    a fake-looking 4.9 near "money-back guarantee" never happens.
 *
 * Honesty:
 *  - The guarantee copy is a promise we can keep (the refund service refunds
 *    unused eSIMs). We surface it as-is and add one short clarifier: "once
 *    installed, eSIMs can't be refunded by the carrier" — this matches the
 *    policy in server/services/refund.ts (installed → manual review) without
 *    over-promising an automatic refund the code can't do.
 */
import { brand } from "../../server/brand.config";

export type GuaranteeBadgeVariant = "inline" | "card";

export interface GuaranteeBadgeProps {
  variant?: GuaranteeBadgeVariant;
  /** Optional override; defaults to `brand.guaranteeCopy`. */
  copy?: string;
  /**
   * Shows the "installed eSIMs reviewed by support" clarifier. Defaults true.
   * Turn off in very tight placements (e.g. a sticky checkout footer).
   */
  showClarifier?: boolean;
  /** Optional class appended to the outer element. */
  className?: string;
}

const CLARIFIER =
  "Once the eSIM is installed it can't be refunded automatically — contact support and we'll review it.";

function CheckIcon(): JSX.Element {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      aria-hidden
    >
      <path d="M4.5 12.5l4.5 4.5L19.5 6.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function GuaranteeBadge({
  variant = "inline",
  copy = brand.guaranteeCopy,
  showClarifier = true,
  className = "",
}: GuaranteeBadgeProps): JSX.Element {
  if (variant === "card") {
    return (
      <section
        aria-label="Money-back guarantee"
        data-testid="guarantee-badge"
        data-variant="card"
        className={`rounded-2xl bg-emerald-50 p-4 ring-1 ring-emerald-200 ${className}`}
      >
        <p className="flex items-center gap-2 text-sm font-semibold text-emerald-900">
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-emerald-600 text-white">
            <CheckIcon />
          </span>
          {copy}
        </p>
        {showClarifier && (
          <p className="mt-1.5 pl-8 text-xs text-emerald-900/80">{CLARIFIER}</p>
        )}
      </section>
    );
  }

  return (
    <p
      data-testid="guarantee-badge"
      data-variant="inline"
      className={`inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-800 ring-1 ring-emerald-200 ${className}`}
    >
      <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-emerald-600 text-white">
        <CheckIcon />
      </span>
      <span>{copy}</span>
    </p>
  );
}

export const __test__ = { CLARIFIER };

// src/components/UsageBar.tsx
/**
 * Data-usage bar for a single eSIM (My eSIMs dashboard).
 *
 * Contract:
 * - `totalBytes` / `usedBytes` come from the server, captured from the
 *   supplier's /esim/usage/query via the 3-hourly refresh job. Both are BYTES
 *   (the supplier's native unit); we format to MB/GB here.
 * - Usage data is DELAYED 1-3 hours upstream, so this component always states
 *   the freshness rule ("Usage updated every few hours") and renders the
 *   server-provided `lastUpdatedAt` timestamp. It never fabricates a number:
 *   when usage is unknown it shows "not yet reported" instead of 0%.
 * - The bar is colour-banded (green / amber / red) based on remaining data,
 *   matching the low-data thresholds the alerts phase uses, but the banding is
 *   purely visual — the messaging stays truthful.
 *
 * No data fetching here: the parent supplies a resolved usage snapshot.
 */
import { useId } from "react";

export interface UsageSnapshot {
  /** Total allowance in bytes for the current plan period. Null when unknown. */
  totalBytes: number | null;
  /** Used amount in bytes. Null when the supplier hasn't reported yet. */
  usedBytes: number | null;
  /**
   * ISO timestamp of when this usage figure was captured from the supplier.
   * Null when we have never successfully refreshed usage for this eSIM.
   */
  lastUpdatedAt: string | null;
}

export interface UsageBarProps {
  usage: UsageSnapshot;
  /** Overrides the default "Usage updated every few hours" caption. */
  freshnessCopy?: string;
  /** Compact mode trims padding; useful where the card is already dense. */
  compact?: boolean;
}

const BYTES_PER_MB = 1024 * 1024;

/** Human byte formatter tuned for travel-data magnitudes. */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes === 0) return "0 MB";
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1) {
    // One decimal below 10 GB, whole numbers above, so cards stay tidy.
    return gb >= 10 ? `${Math.round(gb)} GB` : `${gb.toFixed(1)} GB`;
  }
  const mb = bytes / BYTES_PER_MB;
  return mb >= 10 ? `${Math.round(mb)} MB` : `${mb.toFixed(1)} MB`;
}

/** Format an ISO timestamp to a short local date-time, or null when absent. */
export function formatLastUpdated(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

type Band = "unknown" | "healthy" | "low" | "critical" | "exhausted";

interface Computed {
  band: Band;
  /** Integer 0..100 for the filled portion. */
  percent: number;
  /** Remaining bytes, or null when unknown. */
  remainingBytes: number | null;
  /** True when total and used are both known and used exceeds total. */
  over: boolean;
}

/**
 * Compute the usage band + percent. Kept exported (pure) so the route test in
 * the next batch can assert banding without a DOM.
 */
export function computeUsage(usage: UsageSnapshot): Computed {
  const { totalBytes, usedBytes } = usage;
  if (
    totalBytes == null ||
    usedBytes == null ||
    !Number.isFinite(totalBytes) ||
    !Number.isFinite(usedBytes) ||
    totalBytes <= 0
  ) {
    return { band: "unknown", percent: 0, remainingBytes: null, over: false };
  }
  const clampedUsed = Math.max(0, usedBytes);
  const remainingBytes = totalBytes - clampedUsed;
  const over = remainingBytes < 0;
  const percent = Math.min(100, Math.max(0, Math.round((clampedUsed / totalBytes) * 100)));
  let band: Band;
  if (remainingBytes <= 0) band = "exhausted";
  else if (remainingBytes <= 100 * BYTES_PER_MB) band = "critical"; // ≤100 MB left
  else if (clampedUsed / totalBytes >= 0.8) band = "low"; // ≥80% consumed
  else band = "healthy";
  return { band, percent, remainingBytes, over };
}

const BAND_FILL: Record<Band, string> = {
  unknown: "bg-slate-300",
  healthy: "bg-emerald-500",
  low: "bg-amber-500",
  critical: "bg-rose-500",
  exhausted: "bg-rose-600",
};

const BAND_TEXT: Record<Band, string> = {
  unknown: "text-slate-500",
  healthy: "text-emerald-700",
  low: "text-amber-700",
  critical: "text-rose-700",
  exhausted: "text-rose-700",
};

export function UsageBar({
  usage,
  freshnessCopy = "Usage updated every few hours.",
  compact = false,
}: UsageBarProps): JSX.Element {
  const labelId = useId();
  const summaryId = useId();
  const { band, percent, remainingBytes, over } = computeUsage(usage);
  const lastUpdated = formatLastUpdated(usage.lastUpdatedAt);
  const known = band !== "unknown";

  const usedLabel = formatBytes(usage.usedBytes);
  const totalLabel = formatBytes(usage.totalBytes);

  const summaryText = known
    ? `${usedLabel} of ${totalLabel} used${
        remainingBytes != null && remainingBytes > 0
          ? `, ${formatBytes(remainingBytes)} left`
          : remainingBytes === 0
            ? ", none left"
            : ""
      }`
    : "Data usage not yet reported";

  return (
    <div
      className={compact ? "text-sm" : "text-sm"}
      data-testid="usage-bar"
      data-band={band}
      role="group"
      aria-labelledby={labelId}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span id={labelId} className="text-xs font-medium uppercase tracking-wide text-slate-500">
          Data used
        </span>
        {known ? (
          <span
            className={`text-xs font-semibold ${BAND_TEXT[band]}`}
            id={summaryId}
            data-testid="usage-summary"
          >
            {usedLabel} / {totalLabel}
          </span>
        ) : (
          <span className="text-xs font-medium text-slate-400" data-testid="usage-summary">
            Not yet reported
          </span>
        )}
      </div>

      <div
        className={`mt-1.5 h-2.5 w-full overflow-hidden rounded-full bg-slate-200 ${
          !known ? "opacity-70" : ""
        }`}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={known ? percent : undefined}
        aria-valuetext={summaryText}
        aria-describedby={summaryId}
        data-testid="usage-progress"
      >
        <div
          className={`h-full rounded-full transition-[width] duration-500 ${BAND_FILL[band]}`}
          style={{ width: `${known ? percent : 0}%` }}
        />
      </div>

      <div className="mt-1.5 flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5 text-[11px] text-slate-500">
        <span data-testid="usage-remaining">
          {known
            ? remainingBytes != null && remainingBytes > 0
              ? `${formatBytes(remainingBytes)} left${over ? " (over plan)" : ""}`
              : over
                ? "Over plan allowance"
                : "No data left"
            : "We'll show usage after the first refresh."}
        </span>
        <span data-testid="usage-freshness">
          {lastUpdated ? (
            <>
              Updated {lastUpdated}
              <span className="text-slate-400"> · {freshnessCopy}</span>
            </>
          ) : (
            <>
              Not refreshed yet
              <span className="text-slate-400"> · {freshnessCopy}</span>
            </>
          )}
        </span>
      </div>
    </div>
  );
}

export const __test__ = { computeUsage, formatBytes, formatLastUpdated };

/**
 * Plan filter bar used on country pages (and anywhere a plan grid needs
 * narrowing). Purely presentational: it owns no fetch state and calls
 * `onChange` with the full next filter set so the host stays the source of
 * truth and can re-query the server.
 *
 * Filters match the server contract in server/routes/catalog.ts:
 *   minDataGb, maxDataGb, minDays, maxDays, daily (true|false), sortBy
 *
 * The component renders only the filters the caller asked for via `visible`
 * so it can be reused on other surfaces (e.g. a dashboard plan picker) without
 * showing controls that don't apply there. Every control is a real input wired
 * to onChange. Values are never guessed: clearing a select sets the field back
 * to `undefined`, not to a fake default.
 */
import { useId } from "react";

export type PlanSortBy = "none" | "price" | "data" | "days";

export interface PlanFiltersValue {
  minDataGb?: number;
  maxDataGb?: number;
  minDays?: number;
  maxDays?: number;
  /** undefined = "any plan type"; true/false narrow to daily / non-daily. */
  daily?: boolean;
  sortBy: PlanSortBy;
}

export const DEFAULT_PLAN_FILTERS: PlanFiltersValue = { sortBy: "none" };

export type PlanFilterKey =
  | "minDataGb"
  | "maxDataGb"
  | "minDays"
  | "maxDays"
  | "daily"
  | "sortBy";

export interface PlanFiltersProps {
  value: PlanFiltersValue;
  onChange: (next: PlanFiltersValue) => void;
  /**
   * Which controls to render. Defaults to the country-page set:
   * min data, max days, daily toggle, sort.
   */
  visible?: readonly PlanFilterKey[];
  /** Disables every control while a refetch is in flight. */
  busy?: boolean;
  /** Optional label describing what is being filtered (accessibility). */
  ariaLabel?: string;
}

const DATA_OPTIONS: { label: string; value: number | undefined }[] = [
  { label: "Any data", value: undefined },
  { label: "1 GB+", value: 1 },
  { label: "3 GB+", value: 3 },
  { label: "5 GB+", value: 5 },
  { label: "10 GB+", value: 10 },
  { label: "20 GB+", value: 20 },
];

const DAYS_OPTIONS: { label: string; value: number | undefined }[] = [
  { label: "Any duration", value: undefined },
  { label: "Up to 3 days", value: 3 },
  { label: "Up to 7 days", value: 7 },
  { label: "Up to 15 days", value: 15 },
  { label: "Up to 30 days", value: 30 },
];

const SORT_OPTIONS: { label: string; value: PlanSortBy }[] = [
  { label: "Recommended", value: "none" },
  { label: "Price: low to high", value: "price" },
  { label: "Data: low to high", value: "data" },
  { label: "Duration: short to long", value: "days" },
];

/** Read a `<select>` value into a number or undefined. */
function numberFromSelect(raw: string): number | undefined {
  if (raw === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/** True when the value differs from the default set (used to show "Reset"). */
export function planFiltersAreDefault(value: PlanFiltersValue): boolean {
  return (
    value.minDataGb === undefined &&
    value.maxDataGb === undefined &&
    value.minDays === undefined &&
    value.maxDays === undefined &&
    value.daily === undefined &&
    value.sortBy === "none"
  );
}

const DEFAULT_VISIBLE: readonly PlanFilterKey[] = [
  "minDataGb",
  "maxDays",
  "daily",
  "sortBy",
];

export function PlanFilters({
  value,
  onChange,
  visible = DEFAULT_VISIBLE,
  busy = false,
  ariaLabel = "Plan filters",
}: PlanFiltersProps): JSX.Element {
  const baseId = useId();
  const show = (key: PlanFilterKey) => visible.includes(key);
  const anyActive = !planFiltersAreDefault(value);

  function set<K extends keyof PlanFiltersValue>(key: K, next: PlanFiltersValue[K]) {
    const updated: PlanFiltersValue = { ...value, [key]: next };
    // `daily === undefined` should remove the key entirely so callers can test
    // presence cleanly and the query builder omits it.
    if (key === "daily" && next === undefined) delete updated.daily;
    onChange(updated);
  }

  return (
    <div
      className="flex flex-wrap items-center gap-2 rounded-2xl bg-slate-50 p-3 ring-1 ring-slate-200"
      data-testid="plan-filters"
      role="group"
      aria-label={ariaLabel}
      aria-busy={busy || undefined}
    >
      {show("minDataGb") && (
        <>
          <label className="sr-only" htmlFor={`${baseId}-data`}>
            Minimum data
          </label>
          <select
            id={`${baseId}-data`}
            value={value.minDataGb ?? ""}
            onChange={(e) => set("minDataGb", numberFromSelect(e.target.value))}
            disabled={busy}
            className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-800 disabled:opacity-60"
            data-testid="filter-data"
          >
            {DATA_OPTIONS.map((o) => (
              <option key={o.label} value={o.value ?? ""}>
                {o.label}
              </option>
            ))}
          </select>
        </>
      )}

      {show("maxDataGb") && (
        <>
          <label className="sr-only" htmlFor={`${baseId}-max-data`}>
            Maximum data
          </label>
          <select
            id={`${baseId}-max-data`}
            value={value.maxDataGb ?? ""}
            onChange={(e) => set("maxDataGb", numberFromSelect(e.target.value))}
            disabled={busy}
            className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-800 disabled:opacity-60"
            data-testid="filter-max-data"
          >
            {DATA_OPTIONS.map((o) => (
              <option key={o.label} value={o.value ?? ""}>
                {o.value == null ? "Any data" : `Up to ${o.value} GB`}
              </option>
            ))}
          </select>
        </>
      )}

      {show("maxDays") && (
        <>
          <label className="sr-only" htmlFor={`${baseId}-days`}>
            Maximum duration
          </label>
          <select
            id={`${baseId}-days`}
            value={value.maxDays ?? ""}
            onChange={(e) => set("maxDays", numberFromSelect(e.target.value))}
            disabled={busy}
            className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-800 disabled:opacity-60"
            data-testid="filter-days"
          >
            {DAYS_OPTIONS.map((o) => (
              <option key={o.label} value={o.value ?? ""}>
                {o.label}
              </option>
            ))}
          </select>
        </>
      )}

      {show("minDays") && (
        <>
          <label className="sr-only" htmlFor={`${baseId}-min-days`}>
            Minimum duration
          </label>
          <select
            id={`${baseId}-min-days`}
            value={value.minDays ?? ""}
            onChange={(e) => set("minDays", numberFromSelect(e.target.value))}
            disabled={busy}
            className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-800 disabled:opacity-60"
            data-testid="filter-min-days"
          >
            <option value="">Any duration</option>
            <option value="3">3+ days</option>
            <option value="7">7+ days</option>
            <option value="15">15+ days</option>
            <option value="30">30+ days</option>
          </select>
        </>
      )}

      {show("daily") && (
        <label
          className={`inline-flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-1.5 text-sm ${
            value.daily === true
              ? "border-brand-500 bg-brand-50 text-brand-800"
              : "border-slate-200 bg-white text-slate-700"
          } ${busy ? "opacity-60" : ""}`}
        >
          <input
            type="checkbox"
            className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
            checked={value.daily === true}
            onChange={(e) => set("daily", e.target.checked ? true : undefined)}
            disabled={busy}
            data-testid="filter-daily"
          />
          Daily plans
        </label>
      )}

      {show("sortBy") && (
        <div className="ml-auto flex items-center gap-2">
          <label htmlFor={`${baseId}-sort`} className="text-xs text-slate-500">
            Sort
          </label>
          <select
            id={`${baseId}-sort`}
            value={value.sortBy}
            onChange={(e) => set("sortBy", e.target.value as PlanSortBy)}
            disabled={busy}
            className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-800 disabled:opacity-60"
            data-testid="filter-sort"
          >
            {SORT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
      )}

      {anyActive && (
        <button
          type="button"
          onClick={() => onChange({ ...DEFAULT_PLAN_FILTERS })}
          disabled={busy}
          className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-60"
          data-testid="filter-reset"
        >
          Reset
        </button>
      )}
    </div>
  );
}

/**
 * Admin dashboard — /admin.
 *
 * Reads a single metrics snapshot from GET /api/admin/metrics and renders:
 *   - Revenue / Profit / Orders (headline cards)
 *   - Top countries (table)
 *   - Conversion rate
 *   - Supplier balance + low-balance alert
 *   - AI cost (last window)
 *
 * The page is a snapshot with honest empty states:
 *   - Each metric is a `Maybe<T>` from the server; when `available:false` we
 *     render "Unavailable — {reason}" instead of zero. That way a broken query
 *     on one table doesn't mask as a real number.
 *   - We do NOT poll aggressively. A single fetch per range change plus a
 *     manual refresh button; the underlying data doesn't change faster than
 *     the supplier job.
 *   - No writes here. The queue, refund review, settings and data-table
 *     editors live in sibling admin pages (AdminOrders, AdminSettings,
 *     AdminDataTables — later in this phase).
 *
 * Test selectors
 * --------------
 *   data-testid="admin-dashboard"
 *   data-testid="admin-dashboard-loading"
 *   data-testid="admin-dashboard-error"
 *   data-testid="admin-range-<label>"
 *   data-testid="admin-refresh"
 *   data-testid="admin-metric-revenue"
 *   data-testid="admin-metric-profit"
 *   data-testid="admin-metric-orders"
 *   data-testid="admin-metric-conversion"
 *   data-testid="admin-metric-supplier-balance"
 *   data-testid="admin-metric-ai-cost"
 *   data-testid="admin-low-balance-alert"
 *   data-testid="admin-top-countries"
 *   data-testid="admin-top-country-<country>"
 *   data-testid="admin-excluded-currency"
 *   data-testid="admin-metric-unavailable"
 */
import { useCallback, useEffect, useState } from "react";
import { brand, type SupportedCurrency } from "../../server/brand.config";
import type {
  AdminMetrics,
  CountryCount,
  Maybe,
  MoneyTotal,
  SupplierBalance as SupplierBalanceMetric,
} from "../../server/services/adminMetrics";

// ---------------------------------------------------------------------------
// Fetch helper
// ---------------------------------------------------------------------------

class AdminApiError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  constructor(code: string, httpStatus: number, message: string) {
    super(message);
    this.name = "AdminApiError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

interface ApiOk<T> {
  ok: true;
  data: T;
}
interface ApiErr {
  ok: false;
  error: string;
  message: string;
}

async function fetchMetrics(
  fetchImpl: Fetcher,
  range: RangeKey,
): Promise<AdminMetrics> {
  const res = await fetchImpl(`/api/admin/metrics?range=${range}`, {
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  const body = (await res.json().catch(() => ({}))) as
    | ApiOk<AdminMetrics>
    | ApiErr
    | Record<string, unknown>;
  if (!res.ok || !("ok" in body) || (body as ApiErr).ok === false) {
    const err = body as Partial<ApiErr>;
    throw new AdminApiError(
      err.error ?? "request_failed",
      res.status,
      err.message ?? `Request failed (HTTP ${res.status}).`,
    );
  }
  return (body as ApiOk<AdminMetrics>).data;
}

// ---------------------------------------------------------------------------
// Formatting helpers (mirror the currency semantics used across the app)
// ---------------------------------------------------------------------------

function formatMinor(minor: number, currency: string): string {
  if (!Number.isFinite(minor)) return "—";
  const zeroDecimal = currency === "VND";
  const major = zeroDecimal ? minor : minor / 100;
  const body = zeroDecimal
    ? Math.round(major).toLocaleString("en-US")
    : major.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${body} ${currency}`;
}

function formatUsdMinor(usdMinor: number): string {
  return formatMinor(usdMinor, "USD");
}

function formatPercent(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// ---------------------------------------------------------------------------
// UI primitives
// ---------------------------------------------------------------------------

function MetricCard({
  label,
  testId,
  children,
  emphasised,
}: {
  label: string;
  testId: string;
  children: JSX.Element | string;
  emphasised?: boolean;
}): JSX.Element {
  return (
    <div
      className={`rounded-2xl p-4 ring-1 ${
        emphasised ? "bg-brand-50 ring-brand-200" : "bg-white ring-slate-200"
      }`}
      data-testid={testId}
    >
      <p className="text-[11px] uppercase tracking-wide text-slate-500">{label}</p>
      <div className="mt-1 text-2xl font-extrabold text-slate-900">{children}</div>
    </div>
  );
}

function UnavailableBox({ reason }: { reason: string }): JSX.Element {
  return (
    <p
      className="text-sm font-medium text-rose-700"
      data-testid="admin-metric-unavailable"
      title={reason}
    >
      Unavailable
      <span className="ml-1 text-[11px] font-normal text-rose-600/80">
        ({reason})
      </span>
    </p>
  );
}

function renderMoney(maybe: Maybe<MoneyTotal>): JSX.Element | string {
  if (!maybe.available) return <UnavailableBox reason={maybe.reason} />;
  return formatMinor(maybe.value.minor, maybe.value.currency);
}

function renderSupplierBalance(maybe: Maybe<SupplierBalanceMetric>): JSX.Element | string {
  if (!maybe.available) return <UnavailableBox reason={maybe.reason} />;
  return formatUsdMinor(maybe.value.usdMinor);
}

// ---------------------------------------------------------------------------
// Ranges
// ---------------------------------------------------------------------------

type RangeKey = "today" | "7d" | "30d" | "90d";

const RANGES: { key: RangeKey; label: string }[] = [
  { key: "today", label: "Today" },
  { key: "7d", label: "7 days" },
  { key: "30d", label: "30 days" },
  { key: "90d", label: "90 days" },
];

// ---------------------------------------------------------------------------
// Top countries table
// ---------------------------------------------------------------------------

function TopCountriesTable({
  maybe,
}: {
  maybe: Maybe<CountryCount[]>;
}): JSX.Element {
  if (!maybe.available) {
    return (
      <p className="mt-3 rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-800 ring-1 ring-rose-200">
        Couldn't load country breakdown ({maybe.reason}).
      </p>
    );
  }
  if (maybe.value.length === 0) {
    return (
      <p className="mt-3 rounded-xl bg-slate-50 px-3 py-2 text-sm text-slate-600 ring-1 ring-slate-200">
        No paid orders in this window yet.
      </p>
    );
  }
  const maxEsims = Math.max(...maybe.value.map((c) => c.esims), 1);
  return (
    <div className="mt-3 overflow-x-auto rounded-2xl ring-1 ring-slate-200" data-testid="admin-top-countries">
      <table className="w-full min-w-[480px] text-sm">
        <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
          <tr>
            <th className="px-3 py-2 text-left">Country</th>
            <th className="px-3 py-2 text-right">Orders</th>
            <th className="px-3 py-2 text-right">eSIMs</th>
            <th className="px-3 py-2 text-left">Share</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100 bg-white">
          {maybe.value.map((c) => (
            <tr key={c.country} data-testid={`admin-top-country-${c.country}`}>
              <td className="px-3 py-2 font-medium text-slate-800">
                {c.label ?? c.country.toUpperCase()}
              </td>
              <td className="px-3 py-2 text-right tabular-nums text-slate-800">
                {c.orders.toLocaleString()}
              </td>
              <td className="px-3 py-2 text-right tabular-nums text-slate-800">
                {c.esims.toLocaleString()}
              </td>
              <td className="px-3 py-2">
                <div className="h-2 w-32 overflow-hidden rounded-full bg-slate-100">
                  <div
                    className="h-2 bg-brand-500"
                    style={{ width: `${Math.round((c.esims / maxEsims) * 100)}%` }}
                  />
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page state
// ---------------------------------------------------------------------------

type PageState =
  | { status: "loading" }
  | { status: "ready"; metrics: AdminMetrics }
  | { status: "error"; code: string; message: string; httpStatus: number };

export interface AdminDashboardProps {
  /** Injectable fetcher for tests. */
  fetcher?: Fetcher;
  /** Initial range; useful for deep links. */
  initialRange?: RangeKey;
}

export function AdminDashboard({
  fetcher,
  initialRange = "7d",
}: AdminDashboardProps = {}): JSX.Element {
  const fetchImpl: Fetcher = fetcher ?? ((url, init) => fetch(url, init));
  const [range, setRange] = useState<RangeKey>(initialRange);
  const [state, setState] = useState<PageState>({ status: "loading" });
  const [reloadNonce, setReloadNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    fetchMetrics(fetchImpl, range)
      .then((metrics) => {
        if (!cancelled) setState({ status: "ready", metrics });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const code = err instanceof AdminApiError ? err.code : "request_failed";
        const httpStatus = err instanceof AdminApiError ? err.httpStatus : 0;
        const message =
          err instanceof Error ? err.message : "Could not load the dashboard.";
        setState({ status: "error", code, message, httpStatus });
      });
    return () => {
      cancelled = true;
    };
  }, [fetchImpl, range, reloadNonce]);

  const refresh = useCallback(() => setReloadNonce((n) => n + 1), []);

  // ----- Header + range selector (rendered for every state) -----------------
  const header = (
    <header className="mb-6">
      <p className="text-xs uppercase tracking-wide text-slate-500">
        {brand.name} · Admin
      </p>
      <div className="mt-1 flex flex-wrap items-end justify-between gap-3">
        <h1 className="text-2xl font-extrabold text-slate-900">Dashboard</h1>
        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex rounded-xl bg-slate-100 p-0.5" role="group" aria-label="Time range">
            {RANGES.map((r) => (
              <button
                key={r.key}
                type="button"
                onClick={() => setRange(r.key)}
                className={`rounded-lg px-3 py-1.5 text-xs font-semibold ${
                  range === r.key
                    ? "bg-white text-slate-900 shadow-sm"
                    : "text-slate-600 hover:text-slate-900"
                }`}
                data-testid={`admin-range-${r.key}`}
                aria-pressed={range === r.key}
              >
                {r.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={refresh}
            className="rounded-xl border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
            data-testid="admin-refresh"
          >
            Refresh
          </button>
        </div>
      </div>
    </header>
  );

  // ----- Loading -------------------------------------------------------------
  if (state.status === "loading") {
    return (
      <main
        className="mx-auto w-full max-w-6xl px-4 pb-16 pt-6"
        aria-busy
        data-testid="admin-dashboard-loading"
      >
        {header}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-24 animate-pulse rounded-2xl bg-slate-100" />
          ))}
        </div>
        <div className="mt-6 h-64 animate-pulse rounded-2xl bg-slate-100" />
      </main>
    );
  }

  // ----- Error --------------------------------------------------------------
  if (state.status === "error") {
    return (
      <main className="mx-auto w-full max-w-6xl px-4 pb-16 pt-6">
        {header}
        <div
          role="alert"
          className="rounded-2xl bg-rose-50 px-4 py-3 text-sm text-rose-800 ring-1 ring-rose-200"
          data-testid="admin-dashboard-error"
          data-error-code={state.code}
        >
          <p className="font-semibold">
            {state.httpStatus === 401 || state.httpStatus === 403
              ? "You don't have access to the admin dashboard."
              : "We couldn't load the dashboard."}
          </p>
          <p className="mt-1">{state.message}</p>
          <button
            type="button"
            onClick={refresh}
            className="mt-3 rounded-lg bg-rose-600 px-3 py-1.5 font-medium text-white hover:bg-rose-700"
          >
            Try again
          </button>
        </div>
      </main>
    );
  }

  // ----- Ready --------------------------------------------------------------
  const m = state.metrics;
  const lowBalanceTriggered = m.lowBalanceAlert.available && m.lowBalanceAlert.value.triggered;
  const excluded = m.excludedOtherCurrency;

  return (
    <main
      className="mx-auto w-full max-w-6xl px-4 pb-16 pt-6"
      data-testid="admin-dashboard"
    >
      {header}

      {/* Low balance banner */}
      {lowBalanceTriggered && m.lowBalanceAlert.available && m.supplierBalance.available && (
        <div
          role="alert"
          className="mb-4 rounded-2xl bg-amber-50 px-4 py-3 text-sm text-amber-900 ring-1 ring-amber-200"
          data-testid="admin-low-balance-alert"
        >
          <p className="font-semibold">Supplier balance is low</p>
          <p className="mt-1 text-xs text-amber-800">
            Current: {formatUsdMinor(m.supplierBalance.value.usdMinor)} · Threshold:{" "}
            {formatUsdMinor(m.lowBalanceAlert.value.thresholdUsdMinor)}. Top up the
            eSIM Access account before the next paid order so fulfilment doesn't
            get stuck.
          </p>
        </div>
      )}

      {/* Headline cards */}
      <section
        aria-labelledby="admin-headline"
        className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"
      >
        <h2 id="admin-headline" className="sr-only">
          Headline metrics
        </h2>
        <MetricCard label="Revenue" testId="admin-metric-revenue">
          {renderMoney(m.revenue)}
        </MetricCard>
        <MetricCard label="Profit" testId="admin-metric-profit" emphasised>
          {renderMoney(m.profit)}
        </MetricCard>
        <MetricCard label="Paid orders" testId="admin-metric-orders">
          {m.orders.available ? m.orders.value.toLocaleString() : (
            <UnavailableBox reason={m.orders.reason} />
          )}
        </MetricCard>
        <MetricCard label="Conversion rate" testId="admin-metric-conversion">
          {m.conversionRate.available ? (
            <>
              {formatPercent(m.conversionRate.value.rate)}
              <span className="ml-2 text-[11px] font-normal text-slate-500">
                {m.conversionRate.value.paidOrders}/{m.conversionRate.value.checkoutsStarted}
              </span>
            </>
          ) : (
            <UnavailableBox reason={m.conversionRate.reason} />
          )}
        </MetricCard>
      </section>

      {/* Supplier balance + AI cost */}
      <section
        aria-labelledby="admin-secondary"
        className="mt-3 grid gap-3 sm:grid-cols-2"
      >
        <h2 id="admin-secondary" className="sr-only">
          Supplier and AI
        </h2>
        <MetricCard label="Supplier balance (USD)" testId="admin-metric-supplier-balance">
          {renderSupplierBalance(m.supplierBalance)}
          {m.supplierBalance.available && (
            <p className="mt-1 text-[11px] font-normal text-slate-500">
              fetched {formatTimestamp(m.supplierBalance.value.fetchedAt)}
            </p>
          )}
        </MetricCard>
        <MetricCard label="AI spend (window)" testId="admin-metric-ai-cost">
          {m.aiCost.available ? (
            <>
              {formatUsdMinor(m.aiCost.value.usdMinor)}
              <span className="ml-2 text-[11px] font-normal text-slate-500">
                {m.aiCost.value.calls.toLocaleString()} calls
              </span>
            </>
          ) : (
            <UnavailableBox reason={m.aiCost.reason} />
          )}
        </MetricCard>
      </section>

      {excluded.count > 0 && (
        <p
          className="mt-3 rounded-xl bg-slate-50 px-3 py-2 text-xs text-slate-700 ring-1 ring-slate-200"
          data-testid="admin-excluded-currency"
        >
          Totals exclude {excluded.count} order{excluded.count === 1 ? "" : "s"} in{" "}
          {excluded.currencies.join(", ")} — headline is in {brand.defaultCurrency} only.
        </p>
      )}

      {/* Top countries */}
      <section className="mt-8" aria-labelledby="admin-countries">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <h2 id="admin-countries" className="text-base font-bold text-slate-900">
            Top destinations
          </h2>
          <p className="text-[11px] text-slate-500">
            Window: {formatTimestamp(m.window.since)} → {formatTimestamp(m.window.until)}
          </p>
        </div>
        <TopCountriesTable maybe={m.topCountries} />
      </section>

      <p className="mt-8 text-[11px] text-slate-400">
        Snapshot generated {formatTimestamp(m.generatedAt)}. Supplier balance is
        read live; revenue/profit/AI cost are from the database. Currency: {" "}
        {brand.defaultCurrency satisfies SupportedCurrency}.
      </p>

      <nav className="mt-6 flex flex-wrap gap-3 text-sm">
        <a
          href="/admin/orders"
          className="rounded-xl border border-slate-300 bg-white px-4 py-2 font-medium text-slate-700 hover:bg-slate-50"
        >
          Orders &amp; queues
        </a>
        <a
          href="/admin/settings"
          className="rounded-xl border border-slate-300 bg-white px-4 py-2 font-medium text-slate-700 hover:bg-slate-50"
        >
          Settings
        </a>
        <a
          href="/"
          className="rounded-xl border border-slate-300 bg-white px-4 py-2 font-medium text-slate-700 hover:bg-slate-50"
        >
          Back to storefront
        </a>
      </nav>
    </main>
  );
}

export const __test__ = {
  formatMinor,
  formatUsdMinor,
  formatPercent,
  fetchMetrics,
  AdminApiError,
};

export default AdminDashboard;

/**
 * Admin payouts — /admin/payouts.
 *
 * Bookkeeping + approval surface for affiliate / partner / B2B commission
 * payouts. We track owed balances and payout records; actual money movement is
 * outside this UI (the ops team uses a bank / Stripe Connect flow).
 *
 * Two tabs:
 *   1. "Owed"   — every payee with a positive bookkeeping balance.
 *                 GET  /api/admin/payouts?status=owed
 *                 → { payees: Maybe<PayoutPayee[]> }
 *   2. "History" — recorded payouts (any state).
 *                 GET  /api/admin/payouts?status=history&limit=<n>
 *                 → { payouts: Maybe<PayoutRow[]> }
 *
 * Actions:
 *   - "Record payout"        POST /api/admin/payouts
 *                            body: { payeeType, payeeId, amountMinor, currency, note? }
 *                            → { payout: PayoutRow }
 *   - "Mark paid"            POST /api/admin/payouts/:id/mark-paid
 *   - "Void"                 POST /api/admin/payouts/:id/void
 *
 * HONESTY RULES
 * -------------
 *   - Amounts come from the server. We do not compute commission ourselves.
 *   - A "record payout" is only a bookkeeping entry — the UI says so. It never
 *     claims money was transferred.
 *   - Currency is per-payee (agents may be paid in SGD, partners in USD…).
 *     We never mix currencies in the totals.
 *   - When the response is `Maybe<…>` `available:false` we render the reason
 *     instead of zeros.
 *
 * Test selectors
 * --------------
 *   data-testid="admin-payouts"
 *   data-testid="admin-payouts-tab-owed"
 *   data-testid="admin-payouts-tab-history"
 *   data-testid="admin-payouts-error"
 *   data-testid="admin-payouts-payee-<payeeType>-<payeeId>"
 *   data-testid="admin-payouts-record-<payeeType>-<payeeId>"
 *   data-testid="admin-payouts-history-row-<id>"
 *   data-testid="admin-payouts-mark-paid-<id>"
 *   data-testid="admin-payouts-void-<id>"
 *   data-testid="admin-payouts-modal"
 *   data-testid="admin-payouts-modal-amount"
 *   data-testid="admin-payouts-modal-submit"
 */
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { brand, type SupportedCurrency } from "../brand.config";
import type { Maybe } from "../services/adminMetrics";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PayeeType = "affiliate" | "partner" | "b2b_agent";
export type PayoutStatus = "owed" | "recorded" | "paid" | "void";

export interface PayoutPayee {
  payeeType: PayeeType;
  payeeId: number;
  displayName: string;
  email: string;
  currency: SupportedCurrency;
  /** Commission that has accrued but not yet been included in a payout. */
  owedMinor: number;
  /** Lifetime paid to this payee. */
  paidLifetimeMinor: number;
  lastPayoutAt: string | null;
}

export interface PayoutRow {
  id: number;
  payeeType: PayeeType;
  payeeId: number;
  displayName: string;
  amountMinor: number;
  currency: SupportedCurrency;
  status: Exclude<PayoutStatus, "owed">;
  note: string | null;
  createdAt: string;
  paidAt: string | null;
  reference: string | null;
}

// ---------------------------------------------------------------------------
// Fetch plumbing
// ---------------------------------------------------------------------------

class PayoutApiError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  constructor(code: string, httpStatus: number, message: string) {
    super(message);
    this.name = "PayoutApiError";
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

async function call<T>(
  fetchImpl: Fetcher,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<T> {
  const init: RequestInit = {
    method,
    credentials: "include",
    headers: { Accept: "application/json" },
  };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    (init.headers as Record<string, string>)["Content-Type"] = "application/json";
  }
  const res = await fetchImpl(path, init);
  const json = (await res.json().catch(() => ({}))) as ApiOk<T> | ApiErr | Record<string, unknown>;
  if (!res.ok || !("ok" in json) || (json as ApiErr).ok === false) {
    const err = json as Partial<ApiErr>;
    throw new PayoutApiError(
      err.error ?? "request_failed",
      res.status,
      err.message ?? `Request failed (HTTP ${res.status}).`,
    );
  }
  return (json as ApiOk<T>).data;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatMinor(minor: number, currency: SupportedCurrency): string {
  if (!Number.isFinite(minor)) return "—";
  const zeroDecimal = currency === "VND";
  const major = zeroDecimal ? minor : minor / 100;
  const body = zeroDecimal
    ? Math.round(major).toLocaleString("en-US")
    : major.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${body} ${currency}`;
}

function formatTimestamp(iso: string | null): string {
  if (!iso) return "—";
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

function payeeTypeLabel(t: PayeeType): string {
  switch (t) {
    case "affiliate":
      return "Affiliate";
    case "partner":
      return "Partner";
    case "b2b_agent":
      return "B2B agent";
  }
}

// ---------------------------------------------------------------------------
// Record-payout modal
// ---------------------------------------------------------------------------

interface RecordModalProps {
  fetchImpl: Fetcher;
  payee: PayoutPayee;
  onClose: () => void;
  onRecorded: () => void;
}

function RecordPayoutModal({ fetchImpl, payee, onClose, onRecorded }: RecordModalProps): JSX.Element {
  // Default amount = full owed balance in minor units.
  const [amount, setAmount] = useState<string>(
    payee.currency === "VND"
      ? String(payee.owedMinor)
      : (payee.owedMinor / 100).toFixed(2),
  );
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);

  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    const amountMinor =
      payee.currency === "VND" ? Math.round(Number(amount)) : Math.round(Number(amount) * 100);
    if (!Number.isFinite(amountMinor) || amountMinor <= 0) {
      setError({ code: "invalid_amount", message: "Amount must be greater than zero." });
      return;
    }
    if (amountMinor > payee.owedMinor) {
      setError({
        code: "amount_exceeds_owed",
        message: "Amount exceeds the owed balance. Adjust before continuing.",
      });
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await call<{ payout: PayoutRow }>(fetchImpl, "POST", "/api/admin/payouts", {
        payeeType: payee.payeeType,
        payeeId: payee.payeeId,
        amountMinor,
        currency: payee.currency,
        note: note.trim() || undefined,
      });
      onRecorded();
      onClose();
    } catch (err) {
      setError({
        code: err instanceof PayoutApiError ? err.code : "request_failed",
        message: err instanceof Error ? err.message : "Could not record payout.",
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="record-payout-heading"
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
      data-testid="admin-payouts-modal"
    >
      <div className="w-full max-w-md rounded-2xl bg-white p-5 shadow-xl">
        <h2 id="record-payout-heading" className="text-base font-bold text-slate-900">
          Record payout
        </h2>
        <p className="mt-1 text-xs text-slate-500">
          Bookkeeping entry only — this does not transfer money. Use your bank or
          Stripe after recording.
        </p>
        <p className="mt-2 text-xs text-slate-700">
          {payeeTypeLabel(payee.payeeType)} · <strong>{payee.displayName}</strong> —{" "}
          owed {formatMinor(payee.owedMinor, payee.currency)}
        </p>
        <form onSubmit={(e) => void handleSubmit(e)} className="mt-3 space-y-3" noValidate>
          {error && (
            <p
              role="alert"
              className="rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-800 ring-1 ring-rose-200"
              data-error-code={error.code}
            >
              {error.message}
            </p>
          )}
          <label className="block text-sm">
            <span className="font-medium text-slate-800">Amount ({payee.currency})</span>
            <input
              type="number"
              step={payee.currency === "VND" ? "1" : "0.01"}
              min="0"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              disabled={busy}
              className="mt-1 w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-200 disabled:opacity-60"
              data-testid="admin-payouts-modal-amount"
            />
          </label>
          <label className="block text-sm">
            <span className="font-medium text-slate-800">Note (optional)</span>
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              disabled={busy}
              className="mt-1 w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-200 disabled:opacity-60"
            />
          </label>
          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              className="rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-60"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy}
              className="rounded-xl bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-60"
              data-testid="admin-payouts-modal-submit"
            >
              {busy ? "Recording…" : "Record"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Owed tab
// ---------------------------------------------------------------------------

type OwedState =
  | { status: "loading" }
  | { status: "ready"; value: Maybe<PayoutPayee[]> }
  | { status: "error"; code: string; message: string };

function OwedTab({
  fetchImpl,
  reloadToken,
  onMutated,
}: {
  fetchImpl: Fetcher;
  reloadToken: number;
  onMutated: () => void;
}): JSX.Element {
  const [state, setState] = useState<OwedState>({ status: "loading" });
  const [openFor, setOpenFor] = useState<PayoutPayee | null>(null);

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    call<{ payees: Maybe<PayoutPayee[]> }>(fetchImpl, "GET", "/api/admin/payouts?status=owed")
      .then((d) => {
        if (!cancelled) setState({ status: "ready", value: d.payees });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState({
          status: "error",
          code: err instanceof PayoutApiError ? err.code : "request_failed",
          message: err instanceof Error ? err.message : "Could not load owed balances.",
        });
      });
    return () => {
      cancelled = true;
    };
  }, [fetchImpl, reloadToken]);

  // Group per-currency subtotals so the admin sees clean totals, never mixed.
  const subtotals = useMemo(() => {
    if (state.status !== "ready" || !state.value.available) return null;
    const totals = new Map<SupportedCurrency, number>();
    for (const p of state.value.value) {
      totals.set(p.currency, (totals.get(p.currency) ?? 0) + p.owedMinor);
    }
    return Array.from(totals.entries());
  }, [state]);

  if (state.status === "loading") {
    return (
      <div className="space-y-2" aria-busy>
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-16 animate-pulse rounded-xl bg-slate-100" />
        ))}
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <p
        role="alert"
        className="rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-800 ring-1 ring-rose-200"
        data-testid="admin-payouts-error"
        data-error-code={state.code}
      >
        {state.message}
      </p>
    );
  }

  if (!state.value.available) {
    return (
      <p className="rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-800 ring-1 ring-rose-200">
        Couldn't load owed balances ({state.value.reason}).
      </p>
    );
  }

  if (state.value.value.length === 0) {
    return (
      <p className="rounded-xl bg-slate-50 px-4 py-6 text-sm text-slate-600 ring-1 ring-slate-200">
        Nothing owed to any payee right now.
      </p>
    );
  }

  return (
    <>
      {subtotals && subtotals.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {subtotals.map(([cur, minor]) => (
            <span
              key={cur}
              className="inline-flex items-center rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-800 ring-1 ring-slate-200"
            >
              Owed {cur}: {formatMinor(minor, cur)}
            </span>
          ))}
        </div>
      )}

      <div className="mt-3 overflow-x-auto rounded-2xl ring-1 ring-slate-200 bg-white">
        <table className="w-full min-w-[720px] text-sm">
          <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-3 py-2 text-left">Payee</th>
              <th className="px-3 py-2 text-left">Type</th>
              <th className="px-3 py-2 text-right">Owed</th>
              <th className="px-3 py-2 text-right">Lifetime paid</th>
              <th className="px-3 py-2 text-left">Last payout</th>
              <th className="px-3 py-2 text-right">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {state.value.value.map((p) => (
              <tr
                key={`${p.payeeType}-${p.payeeId}`}
                data-testid={`admin-payouts-payee-${p.payeeType}-${p.payeeId}`}
              >
                <td className="px-3 py-2">
                  <p className="font-medium text-slate-900">{p.displayName}</p>
                  <p className="text-[11px] text-slate-500">{p.email}</p>
                </td>
                <td className="px-3 py-2 text-slate-700">{payeeTypeLabel(p.payeeType)}</td>
                <td className="px-3 py-2 text-right tabular-nums font-semibold text-slate-900">
                  {formatMinor(p.owedMinor, p.currency)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-slate-700">
                  {formatMinor(p.paidLifetimeMinor, p.currency)}
                </td>
                <td className="px-3 py-2 text-[11px] text-slate-500">
                  {formatTimestamp(p.lastPayoutAt)}
                </td>
                <td className="px-3 py-2 text-right">
                  <button
                    type="button"
                    onClick={() => setOpenFor(p)}
                    className="rounded-lg border border-slate-300 bg-white px-3 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
                    data-testid={`admin-payouts-record-${p.payeeType}-${p.payeeId}`}
                  >
                    Record payout
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {openFor && (
        <RecordPayoutModal
          fetchImpl={fetchImpl}
          payee={openFor}
          onClose={() => setOpenFor(null)}
          onRecorded={onMutated}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// History tab
// ---------------------------------------------------------------------------

type HistoryState =
  | { status: "loading" }
  | { status: "ready"; value: Maybe<PayoutRow[]> }
  | { status: "error"; code: string; message: string };

function HistoryTab({
  fetchImpl,
  reloadToken,
  onMutated,
}: {
  fetchImpl: Fetcher;
  reloadToken: number;
  onMutated: () => void;
}): JSX.Element {
  const [limit, setLimit] = useState(50);
  const [state, setState] = useState<HistoryState>({ status: "loading" });
  const [busyId, setBusyId] = useState<number | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(() => {
    setState({ status: "loading" });
    call<{ payouts: Maybe<PayoutRow[]> }>(
      fetchImpl,
      "GET",
      `/api/admin/payouts?status=history&limit=${limit}`,
    )
      .then((d) => setState({ status: "ready", value: d.payouts }))
      .catch((err: unknown) =>
        setState({
          status: "error",
          code: err instanceof PayoutApiError ? err.code : "request_failed",
          message: err instanceof Error ? err.message : "Could not load payout history.",
        }),
      );
  }, [fetchImpl, limit]);

  useEffect(() => {
    load();
  }, [load, reloadToken]);

  async function markPaid(id: number): Promise<void> {
    setBusyId(id);
    setActionError(null);
    try {
      await call(fetchImpl, "POST", `/api/admin/payouts/${id}/mark-paid`);
      onMutated();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Action failed.");
    } finally {
      setBusyId(null);
    }
  }

  async function voidPayout(id: number): Promise<void> {
    setBusyId(id);
    setActionError(null);
    try {
      await call(fetchImpl, "POST", `/api/admin/payouts/${id}/void`);
      onMutated();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Action failed.");
    } finally {
      setBusyId(null);
    }
  }

  if (state.status === "loading") {
    return (
      <div className="space-y-2" aria-busy>
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-16 animate-pulse rounded-xl bg-slate-100" />
        ))}
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <p
        role="alert"
        className="rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-800 ring-1 ring-rose-200"
        data-testid="admin-payouts-error"
        data-error-code={state.code}
      >
        {state.message}
      </p>
    );
  }

  if (!state.value.available) {
    return (
      <p className="rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-800 ring-1 ring-rose-200">
        Couldn't load payout history ({state.value.reason}).
      </p>
    );
  }

  const rows = state.value.value;

  return (
    <>
      {actionError && (
        <p
          role="alert"
          className="rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-800 ring-1 ring-rose-200"
        >
          {actionError}
        </p>
      )}

      <div className="flex items-center justify-end gap-2 text-xs text-slate-600">
        <label className="flex items-center gap-1">
          Show
          <select
            value={limit}
            onChange={(e) => setLimit(Number(e.target.value))}
            className="rounded-lg border border-slate-300 bg-white px-1.5 py-1 text-xs"
          >
            <option value={25}>25</option>
            <option value={50}>50</option>
            <option value={100}>100</option>
          </select>
        </label>
      </div>

      {rows.length === 0 ? (
        <p className="mt-3 rounded-xl bg-slate-50 px-4 py-6 text-sm text-slate-600 ring-1 ring-slate-200">
          No payouts recorded yet.
        </p>
      ) : (
        <div className="mt-2 overflow-x-auto rounded-2xl ring-1 ring-slate-200 bg-white">
          <table className="w-full min-w-[840px] text-sm">
            <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-3 py-2 text-left">Payee</th>
                <th className="px-3 py-2 text-left">Type</th>
                <th className="px-3 py-2 text-right">Amount</th>
                <th className="px-3 py-2 text-left">Status</th>
                <th className="px-3 py-2 text-left">Recorded</th>
                <th className="px-3 py-2 text-left">Reference</th>
                <th className="px-3 py-2 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((r) => (
                <tr key={r.id} data-testid={`admin-payouts-history-row-${r.id}`}>
                  <td className="px-3 py-2 font-medium text-slate-900">{r.displayName}</td>
                  <td className="px-3 py-2 text-slate-700">{payeeTypeLabel(r.payeeType)}</td>
                  <td className="px-3 py-2 text-right tabular-nums font-semibold text-slate-900">
                    {formatMinor(r.amountMinor, r.currency)}
                  </td>
                  <td className="px-3 py-2">
                    <span
                      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ${
                        r.status === "paid"
                          ? "bg-emerald-50 text-emerald-800 ring-emerald-200"
                          : r.status === "recorded"
                            ? "bg-amber-50 text-amber-900 ring-amber-200"
                            : "bg-slate-100 text-slate-500 ring-slate-200"
                      }`}
                      data-payout-status={r.status}
                    >
                      {r.status}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-[11px] text-slate-500">
                    {formatTimestamp(r.createdAt)}
                  </td>
                  <td className="px-3 py-2 font-mono text-[11px] text-slate-600">
                    {r.reference ?? "—"}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <div className="flex justify-end gap-1">
                      {r.status === "recorded" && (
                        <button
                          type="button"
                          onClick={() => void markPaid(r.id)}
                          disabled={busyId === r.id}
                          className="rounded-lg bg-emerald-600 px-2 py-1 text-[11px] font-semibold text-white hover:bg-emerald-700 disabled:opacity-60"
                          data-testid={`admin-payouts-mark-paid-${r.id}`}
                        >
                          Mark paid
                        </button>
                      )}
                      {(r.status === "recorded" || r.status === "paid") && (
                        <button
                          type="button"
                          onClick={() => void voidPayout(r.id)}
                          disabled={busyId === r.id}
                          className="rounded-lg border border-slate-300 bg-white px-2 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-60"
                          data-testid={`admin-payouts-void-${r.id}`}
                        >
                          Void
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

type Tab = "owed" | "history";

export interface AdminPayoutsProps {
  fetcher?: Fetcher;
}

export function AdminPayouts({ fetcher }: AdminPayoutsProps = {}): JSX.Element {
  const fetchImpl: Fetcher = fetcher ?? ((url, init) => fetch(url, init));
  const [tab, setTab] = useState<Tab>("owed");
  const [reloadToken, setReloadToken] = useState(0);
  const triggerReload = useCallback(() => setReloadToken((n) => n + 1), []);

  return (
    <main className="mx-auto w-full max-w-6xl px-4 pb-16 pt-6" data-testid="admin-payouts">
      <header className="mb-6">
        <p className="text-xs uppercase tracking-wide text-slate-500">
          {brand.name} · Admin
        </p>
        <h1 className="mt-1 text-2xl font-extrabold text-slate-900">Payouts</h1>
        <p className="mt-1 max-w-2xl text-sm text-slate-600">
          Affiliate, partner and B2B commission bookkeeping. Recording a payout
          does not move money — pay the payee via your usual bank or Stripe flow
          and mark it paid here.
        </p>
      </header>

      <div className="inline-flex flex-wrap rounded-xl bg-slate-100 p-0.5" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "owed"}
          onClick={() => setTab("owed")}
          className={`rounded-lg px-3 py-1.5 text-xs font-semibold ${
            tab === "owed" ? "bg-white text-slate-900 shadow-sm" : "text-slate-600 hover:text-slate-900"
          }`}
          data-testid="admin-payouts-tab-owed"
        >
          Owed
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "history"}
          onClick={() => setTab("history")}
          className={`rounded-lg px-3 py-1.5 text-xs font-semibold ${
            tab === "history" ? "bg-white text-slate-900 shadow-sm" : "text-slate-600 hover:text-slate-900"
          }`}
          data-testid="admin-payouts-tab-history"
        >
          History
        </button>
      </div>

      <section className="mt-4 space-y-3">
        {tab === "owed" ? (
          <OwedTab fetchImpl={fetchImpl} reloadToken={reloadToken} onMutated={triggerReload} />
        ) : (
          <HistoryTab fetchImpl={fetchImpl} reloadToken={reloadToken} onMutated={triggerReload} />
        )}
      </section>

      <nav className="mt-8 flex flex-wrap gap-3 text-sm">
        <a
          href="/admin"
          className="rounded-xl border border-slate-300 bg-white px-4 py-2 font-medium text-slate-700 hover:bg-slate-50"
        >
          Dashboard
        </a>
        <a
          href="/admin/orders"
          className="rounded-xl border border-slate-300 bg-white px-4 py-2 font-medium text-slate-700 hover:bg-slate-50"
        >
          Orders
        </a>
        <a
          href="/admin/settings"
          className="rounded-xl border border-slate-300 bg-white px-4 py-2 font-medium text-slate-700 hover:bg-slate-50"
        >
          Settings
        </a>
        <a
          href="/admin/data-tables"
          className="rounded-xl border border-slate-300 bg-white px-4 py-2 font-medium text-slate-700 hover:bg-slate-50"
        >
          Data tables
        </a>
        <a
          href="/admin/blog"
          className="rounded-xl border border-slate-300 bg-white px-4 py-2 font-medium text-slate-700 hover:bg-slate-50"
        >
          Blog
        </a>
      </nav>
    </main>
  );
}

export const __test__ = {
  formatMinor,
  formatTimestamp,
  payeeTypeLabel,
  call,
  PayoutApiError,
};

export default AdminPayouts;

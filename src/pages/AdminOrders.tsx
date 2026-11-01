/**
 * Admin orders + queues — /admin/orders.
 *
 * Three operational surfaces on one page, each an independent fetch so one
 * failed panel never blanks the others:
 *
 *   1. Failed / processing orders  → GET /api/admin/orders?status=failed,processing
 *   2. Refund review queue         → GET /api/admin/refunds?status=review
 *   3. Webhook event log           → GET /api/admin/webhook-events?limit=
 *
 * HONESTY RULES
 * -------------
 *   - `unavailable` responses render a reason, never a zero.
 *   - Action buttons (retry fulfilment, approve/decline refund, mark reviewed)
 *     POST to the API and then re-fetch the affected panel. If the action
 *     endpoint isn't wired (404/503) we surface the server's message instead
 *     of pretending the action worked.
 *   - We do not page through webhook events indefinitely: the server owns the
 *     limit; we render exactly what came back and offer a "load older" that
 *     does a fresh request with a larger limit, capped in the UI.
 *
 * Test selectors
 * --------------
 *   data-testid="admin-orders"
 *   data-testid="admin-orders-loading"
 *   data-testid="admin-orders-error"
 *   data-testid="admin-queue-failed"
 *   data-testid="admin-queue-refund"
 *   data-testid="admin-queue-webhooks"
 *   data-testid="admin-order-row-<publicId>"
 *   data-testid="admin-refund-row-<refundId>"
 *   data-testid="admin-webhook-row-<id>"
 *   data-testid="admin-order-retry-<publicId>"
 *   data-testid="admin-refund-approve-<refundId>"
 *   data-testid="admin-refund-decline-<refundId>"
 *   data-testid="admin-panel-unavailable"
 */
import { useCallback, useEffect, useState } from "react";
import { brand } from "../../server/brand.config";
import type { Maybe } from "../../server/services/adminMetrics";

// ---------------------------------------------------------------------------
// Response shapes (see header — reconciled against server/routes/admin.ts)
// ---------------------------------------------------------------------------

export type AdminOrderStatus =
  | "pending_payment"
  | "paid"
  | "processing"
  | "completed"
  | "failed"
  | "refunded"
  | "cancelled";

export interface AdminOrderRow {
  publicId: string;
  status: AdminOrderStatus;
  /** Total the customer paid, in minor units of `currency`. */
  totalMinor: number;
  currency: string;
  planLabel: string;
  quantity: number;
  buyerEmail: string | null;
  country: string | null;
  createdAt: string;
  /** Reason for being in the failed queue, when present. */
  failureReason?: string | null;
  /** ISO timestamp of the last fulfilment attempt, when present. */
  lastAttemptAt?: string | null;
}

export type RefundDecision = "pending_review" | "auto_refunded" | "approved" | "declined";

export interface AdminRefundRow {
  refundId: string;
  orderPublicId: string;
  iccid: string | null;
  esimTranNo: string | null;
  /** Why the refund is in the manual queue (e.g. "installed"). */
  reason: string;
  requestedAt: string;
  amountMinor: number;
  currency: string;
  buyerEmail: string | null;
  decision: RefundDecision;
}

export interface AdminWebhookEventRow {
  id: number;
  notifyId: string | null;
  notifyType: string;
  receivedAt: string;
  processedAt: string | null;
  /** "processed" | "duplicate" | "error" | "received" */
  outcome: string;
  esimTranNo: string | null;
  errorMessage: string | null;
}

// ---------------------------------------------------------------------------
// Fetch plumbing
// ---------------------------------------------------------------------------

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

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
    throw new AdminApiError(
      err.error ?? "request_failed",
      res.status,
      err.message ?? `Request failed (HTTP ${res.status}).`,
    );
  }
  return (json as ApiOk<T>).data;
}

// The list endpoints return `Maybe<T[]>` so a single broken table can be
// reported without failing the whole page.
type MaybeList<T> = Maybe<T[]>;

// ---------------------------------------------------------------------------
// Formatting
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

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

function UnavailablePanel({ label, reason }: { label: string; reason: string }): JSX.Element {
  return (
    <p
      className="mt-3 rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-800 ring-1 ring-rose-200"
      data-testid="admin-panel-unavailable"
      data-panel={label}
    >
      Couldn't load {label} ({reason}).
    </p>
  );
}

function EmptyPanel({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <p className="mt-3 rounded-xl bg-slate-50 px-3 py-2 text-sm text-slate-600 ring-1 ring-slate-200">
      {children}
    </p>
  );
}

function Spinner(): JSX.Element {
  return <div className="mt-3 h-24 animate-pulse rounded-2xl bg-slate-100" aria-busy />;
}

function StatusBadge({ status }: { status: AdminOrderStatus }): JSX.Element {
  const map: Record<AdminOrderStatus, string> = {
    pending_payment: "bg-slate-100 text-slate-700 ring-slate-200",
    paid: "bg-brand-50 text-brand-800 ring-brand-200",
    processing: "bg-amber-50 text-amber-900 ring-amber-200",
    completed: "bg-emerald-50 text-emerald-800 ring-emerald-200",
    failed: "bg-rose-50 text-rose-800 ring-rose-200",
    refunded: "bg-slate-100 text-slate-700 ring-slate-200",
    cancelled: "bg-slate-100 text-slate-500 ring-slate-200",
  };
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ${map[status]}`}
      data-order-status={status}
    >
      {status.replace(/_/g, " ")}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Panel: orders queue
// ---------------------------------------------------------------------------

type PanelState<T> =
  | { status: "loading" }
  | { status: "ready"; value: Maybe<T[]> }
  | { status: "error"; code: string; message: string };

function OrderQueuePanel({
  fetchImpl,
  onRetry,
}: {
  fetchImpl: Fetcher;
  onRetry: () => void;
}): JSX.Element {
  const [state, setState] = useState<PanelState<AdminOrderRow>>({ status: "loading" });
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(() => {
    setState({ status: "loading" });
    call<{ orders: MaybeList<AdminOrderRow> }>(
      fetchImpl,
      "GET",
      "/api/admin/orders?status=failed,processing",
    )
      .then((d) => setState({ status: "ready", value: d.orders }))
      .catch((err: unknown) =>
        setState({
          status: "error",
          code: err instanceof AdminApiError ? err.code : "request_failed",
          message: err instanceof Error ? err.message : "Could not load orders.",
        }),
      );
  }, [fetchImpl]);

  useEffect(() => {
    load();
  }, [load, onRetry]);

  async function retry(publicId: string): Promise<void> {
    setBusyId(publicId);
    setActionError(null);
    try {
      await call(fetchImpl, "POST", `/api/admin/orders/${encodeURIComponent(publicId)}/retry`);
      load();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Retry failed.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section aria-labelledby="orders-queue-heading" data-testid="admin-queue-failed">
      <div className="flex items-center justify-between gap-2">
        <h2 id="orders-queue-heading" className="text-base font-bold text-slate-900">
          Failed &amp; processing orders
        </h2>
        <button
          type="button"
          onClick={load}
          className="rounded-lg border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
        >
          Refresh
        </button>
      </div>

      {actionError && (
        <p role="alert" className="mt-2 rounded-xl bg-rose-50 px-3 py-2 text-xs text-rose-800 ring-1 ring-rose-200">
          {actionError}
        </p>
      )}

      {state.status === "loading" && <Spinner />}

      {state.status === "error" && (
        <UnavailablePanel label="the order queue" reason={state.message} />
      )}

      {state.status === "ready" && !state.value.available && (
        <UnavailablePanel label="the order queue" reason={state.value.reason} />
      )}

      {state.status === "ready" && state.value.available && state.value.value.length === 0 && (
        <EmptyPanel>No failed or processing orders right now.</EmptyPanel>
      )}

      {state.status === "ready" && state.value.available && state.value.value.length > 0 && (
        <div className="mt-3 overflow-x-auto rounded-2xl ring-1 ring-slate-200">
          <table className="w-full min-w-[720px] text-sm">
            <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-3 py-2 text-left">Order</th>
                <th className="px-3 py-2 text-left">Status</th>
                <th className="px-3 py-2 text-left">Plan</th>
                <th className="px-3 py-2 text-right">Total</th>
                <th className="px-3 py-2 text-left">Created</th>
                <th className="px-3 py-2 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 bg-white">
              {state.value.value.map((o) => (
                <tr key={o.publicId} data-testid={`admin-order-row-${o.publicId}`}>
                  <td className="px-3 py-2">
                    <p className="font-mono text-xs text-slate-800">{o.publicId}</p>
                    {o.buyerEmail && (
                      <p className="text-[11px] text-slate-500">{o.buyerEmail}</p>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <StatusBadge status={o.status} />
                    {o.failureReason && (
                      <p className="mt-0.5 text-[10px] text-rose-600">{o.failureReason}</p>
                    )}
                  </td>
                  <td className="px-3 py-2 text-slate-700">
                    <p>{o.planLabel}</p>
                    <p className="text-[11px] text-slate-500">
                      {o.country ? `${o.country} · ` : ""}×{o.quantity}
                    </p>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums font-semibold text-slate-900">
                    {formatMinor(o.totalMinor, o.currency)}
                  </td>
                  <td className="px-3 py-2 text-[11px] text-slate-500">
                    {formatTimestamp(o.createdAt)}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {(o.status === "failed" || o.status === "processing") && (
                      <button
                        type="button"
                        onClick={() => void retry(o.publicId)}
                        disabled={busyId === o.publicId}
                        className="rounded-lg border border-slate-300 bg-white px-2 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-60"
                        data-testid={`admin-order-retry-${o.publicId}`}
                      >
                        {busyId === o.publicId ? "Retrying…" : "Retry"}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Panel: refund review queue
// ---------------------------------------------------------------------------

function RefundQueuePanel({ fetchImpl }: { fetchImpl: Fetcher }): JSX.Element {
  const [state, setState] = useState<PanelState<AdminRefundRow>>({ status: "loading" });
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(() => {
    setState({ status: "loading" });
    call<{ refunds: MaybeList<AdminRefundRow> }>(
      fetchImpl,
      "GET",
      "/api/admin/refunds?status=pending_review",
    )
      .then((d) => setState({ status: "ready", value: d.refunds }))
      .catch((err: unknown) =>
        setState({
          status: "error",
          code: err instanceof AdminApiError ? err.code : "request_failed",
          message: err instanceof Error ? err.message : "Could not load refunds.",
        }),
      );
  }, [fetchImpl]);

  useEffect(() => {
    load();
  }, [load]);

  async function decide(refundId: string, decision: "approve" | "decline"): Promise<void> {
    setBusyId(refundId);
    setActionError(null);
    try {
      await call(
        fetchImpl,
        "POST",
        `/api/admin/refunds/${encodeURIComponent(refundId)}/${decision}`,
        {},
      );
      load();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Action failed.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section aria-labelledby="refund-queue-heading" data-testid="admin-queue-refund">
      <h2 id="refund-queue-heading" className="text-base font-bold text-slate-900">
        Refund review queue
      </h2>

      {actionError && (
        <p role="alert" className="mt-2 rounded-xl bg-rose-50 px-3 py-2 text-xs text-rose-800 ring-1 ring-rose-200">
          {actionError}
        </p>
      )}

      {state.status === "loading" && <Spinner />}
      {state.status === "error" && <UnavailablePanel label="the refund queue" reason={state.message} />}
      {state.status === "ready" && !state.value.available && (
        <UnavailablePanel label="the refund queue" reason={state.value.reason} />
      )}
      {state.status === "ready" && state.value.available && state.value.value.length === 0 && (
        <EmptyPanel>No refunds awaiting manual review.</EmptyPanel>
      )}

      {state.status === "ready" && state.value.available && state.value.value.length > 0 && (
        <div className="mt-3 space-y-3">
          {state.value.value.map((r) => (
            <div
              key={r.refundId}
              className="rounded-2xl bg-white p-4 ring-1 ring-slate-200"
              data-testid={`admin-refund-row-${r.refundId}`}
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <p className="font-mono text-xs text-slate-800">{r.orderPublicId}</p>
                  <p className="text-xs text-slate-600">{r.reason}</p>
                  {r.iccid && (
                    <p className="mt-0.5 text-[11px] text-slate-500">
                      ICCID <span className="font-mono">{r.iccid}</span>
                    </p>
                  )}
                </div>
                <div className="text-right">
                  <p className="font-semibold tabular-nums text-slate-900">
                    {formatMinor(r.amountMinor, r.currency)}
                  </p>
                  <p className="text-[11px] text-slate-500">{formatTimestamp(r.requestedAt)}</p>
                </div>
              </div>
              <div className="mt-3 flex gap-2">
                <button
                  type="button"
                  onClick={() => void decide(r.refundId, "approve")}
                  disabled={busyId === r.refundId}
                  className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-60"
                  data-testid={`admin-refund-approve-${r.refundId}`}
                >
                  Approve refund
                </button>
                <button
                  type="button"
                  onClick={() => void decide(r.refundId, "decline")}
                  disabled={busyId === r.refundId}
                  className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-60"
                  data-testid={`admin-refund-decline-${r.refundId}`}
                >
                  Decline
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Panel: webhook event log
// ---------------------------------------------------------------------------

function WebhookLogPanel({ fetchImpl }: { fetchImpl: Fetcher }): JSX.Element {
  const [limit, setLimit] = useState(50);
  const [state, setState] = useState<PanelState<AdminWebhookEventRow>>({ status: "loading" });

  const load = useCallback(() => {
    setState({ status: "loading" });
    call<{ events: MaybeList<AdminWebhookEventRow> }>(
      fetchImpl,
      "GET",
      `/api/admin/webhook-events?limit=${limit}`,
    )
      .then((d) => setState({ status: "ready", value: d.events }))
      .catch((err: unknown) =>
        setState({
          status: "error",
          code: err instanceof AdminApiError ? err.code : "request_failed",
          message: err instanceof Error ? err.message : "Could not load events.",
        }),
      );
  }, [fetchImpl, limit]);

  useEffect(() => {
    load();
  }, [load]);

  const outcomeClass = (outcome: string): string => {
    switch (outcome) {
      case "processed":
        return "bg-emerald-50 text-emerald-800 ring-emerald-200";
      case "duplicate":
        return "bg-slate-100 text-slate-700 ring-slate-200";
      case "error":
        return "bg-rose-50 text-rose-800 ring-rose-200";
      default:
        return "bg-amber-50 text-amber-900 ring-amber-200";
    }
  };

  return (
    <section aria-labelledby="webhook-log-heading" data-testid="admin-queue-webhooks">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="webhook-log-heading" className="text-base font-bold text-slate-900">
          Webhook event log
        </h2>
        <div className="flex items-center gap-2 text-xs">
          <label className="flex items-center gap-1 text-slate-600">
            Show
            <select
              value={limit}
              onChange={(e) => setLimit(Number(e.target.value))}
              className="rounded-lg border border-slate-300 bg-white px-1.5 py-1 text-xs"
            >
              <option value={50}>50</option>
              <option value={100}>100</option>
              <option value={200}>200</option>
            </select>
          </label>
          <button
            type="button"
            onClick={load}
            className="rounded-lg border border-slate-300 bg-white px-2.5 py-1 font-medium text-slate-700 hover:bg-slate-50"
          >
            Refresh
          </button>
        </div>
      </div>

      {state.status === "loading" && <Spinner />}
      {state.status === "error" && <UnavailablePanel label="the webhook log" reason={state.message} />}
      {state.status === "ready" && !state.value.available && (
        <UnavailablePanel label="the webhook log" reason={state.value.reason} />
      )}
      {state.status === "ready" && state.value.available && state.value.value.length === 0 && (
        <EmptyPanel>No webhook events logged yet.</EmptyPanel>
      )}

      {state.status === "ready" && state.value.available && state.value.value.length > 0 && (
        <div className="mt-3 overflow-x-auto rounded-2xl ring-1 ring-slate-200">
          <table className="w-full min-w-[720px] text-sm">
            <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-3 py-2 text-left">Notify type</th>
                <th className="px-3 py-2 text-left">notifyId</th>
                <th className="px-3 py-2 text-left">Outcome</th>
                <th className="px-3 py-2 text-left">eSIM</th>
                <th className="px-3 py-2 text-left">Received</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 bg-white">
              {state.value.value.map((ev) => (
                <tr key={ev.id} data-testid={`admin-webhook-row-${ev.id}`}>
                  <td className="px-3 py-2 font-medium text-slate-800">{ev.notifyType}</td>
                  <td className="px-3 py-2 font-mono text-[11px] text-slate-600">
                    {ev.notifyId ?? "—"}
                  </td>
                  <td className="px-3 py-2">
                    <span
                      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ${outcomeClass(ev.outcome)}`}
                      data-outcome={ev.outcome}
                    >
                      {ev.outcome}
                    </span>
                    {ev.errorMessage && (
                      <p className="mt-0.5 text-[10px] text-rose-600">{ev.errorMessage}</p>
                    )}
                  </td>
                  <td className="px-3 py-2 font-mono text-[11px] text-slate-600">
                    {ev.esimTranNo ?? "—"}
                  </td>
                  <td className="px-3 py-2 text-[11px] text-slate-500">
                    {formatTimestamp(ev.receivedAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export interface AdminOrdersProps {
  fetcher?: Fetcher;
}

export function AdminOrders({ fetcher }: AdminOrdersProps = {}): JSX.Element {
  const fetchImpl: Fetcher = fetcher ?? ((url, init) => fetch(url, init));
  const [, force] = useState(0);
  const refreshOrders = useCallback(() => force((n) => n + 1), []);

  return (
    <main className="mx-auto w-full max-w-6xl px-4 pb-16 pt-6" data-testid="admin-orders">
      <header className="mb-6">
        <p className="text-xs uppercase tracking-wide text-slate-500">
          {brand.name} · Admin
        </p>
        <h1 className="mt-1 text-2xl font-extrabold text-slate-900">
          Orders &amp; queues
        </h1>
        <p className="mt-1 max-w-2xl text-sm text-slate-600">
          Fulfilment failures, refund reviews and every supplier webhook in one
          place. Actions call the admin API directly — no silent retries.
        </p>
      </header>

      <div className="space-y-10">
        <OrderQueuePanel fetchImpl={fetchImpl} onRetry={refreshOrders} />
        <RefundQueuePanel fetchImpl={fetchImpl} />
        <WebhookLogPanel fetchImpl={fetchImpl} />
      </div>

      <nav className="mt-8 flex flex-wrap gap-3 text-sm">
        <a href="/admin" className="rounded-xl border border-slate-300 bg-white px-4 py-2 font-medium text-slate-700 hover:bg-slate-50">
          Dashboard
        </a>
        <a href="/admin/settings" className="rounded-xl border border-slate-300 bg-white px-4 py-2 font-medium text-slate-700 hover:bg-slate-50">
          Settings
        </a>
        <a href="/admin/data-tables" className="rounded-xl border border-slate-300 bg-white px-4 py-2 font-medium text-slate-700 hover:bg-slate-50">
          Data tables
        </a>
      </nav>
    </main>
  );
}

export const __test__ = { formatMinor, formatTimestamp, UnavailablePanel };

export default AdminOrders;

/**
 * Corporate account admin — /corporate/admin (or /corporate).
 *
 * Contract (mirrors server/routes/corporate.ts, saved in an earlier batch):
 *   POST /api/corporate/login              { email, password }
 *   POST /api/corporate/logout
 *   GET  /api/corporate/me                 { company: CorporateCompany, seats: CorporateSeat[], invoices: CorporateInvoice[] }
 *   GET  /api/corporate/usage              { perSeat: Array<{ seatId, usedBytes, totalBytes, lastUpdatedAt }> }
 *   POST /api/corporate/assignments        { packageCode, seats: [{ email, name }] }
 *   POST /api/corporate/unassign           { seatId }
 *   POST /api/corporate/invoices           (admin-side generation) → { invoice }
 *
 * Honesty rules
 * -------------
 *   - Usage numbers render exactly as returned. When `lastUpdatedAt` is
 *     present we surface "updated X ago" so we never imply real-time data.
 *   - Invoicing is a statement view. When the server provides a `pdfUrl` we
 *     link it; when it does not we show the invoice date + total without a
 *     link rather than faking a PDF.
 *   - Assigning/unassigning an eSIM is wired to real endpoints; no browser-
 *     side mutation of a seat that could bypass payment.
 */
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { brand, type SupportedCurrency } from "../../server/brand.config";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type SeatStatus = "assigned" | "active" | "expired" | "unassigned";

export interface CorporateSeat {
  seatId: number;
  employeeEmail: string;
  employeeName: string | null;
  country: string | null;
  planName: string | null;
  status: SeatStatus;
  iccid: string | null;
  esimTranNo: string | null;
  /** ISO timestamp from the 3-hour refresh; null when never fetched. */
  usageUpdatedAt: string | null;
  usedBytes: number | null;
  totalBytes: number | null;
  expiresAt: string | null;
}

export interface CorporateInvoice {
  publicId: string;
  periodStart: string;
  periodEnd: string;
  totalMinor: number;
  currency: SupportedCurrency;
  status: "draft" | "open" | "paid" | "overdue";
  pdfUrl: string | null;
}

export interface CorporateCompany {
  publicId: string;
  companyName: string;
  billingEmail: string;
  status: "pending" | "approved" | "suspended";
  currency: SupportedCurrency;
}

export interface CorporateCatalogEntry {
  code: string;
  name: string;
  dataLabel: string;
  validityLabel: string;
}

interface MeResponse {
  company: CorporateCompany;
  seats: CorporateSeat[];
  invoices: CorporateInvoice[];
  catalog?: CorporateCatalogEntry[];
}

// ---------------------------------------------------------------------------
// Fetch helper (injectable fetcher for tests)
// ---------------------------------------------------------------------------

class CorporateApiError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  constructor(code: string, httpStatus: number, message: string) {
    super(message);
    this.name = "CorporateApiError";
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
  method: "GET" | "POST" | "DELETE",
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
    throw new CorporateApiError(
      err.error ?? "request_failed",
      res.status,
      err.message ?? `Request failed (HTTP ${res.status}).`,
    );
  }
  return (json as ApiOk<T>).data;
}

// ---------------------------------------------------------------------------
// Formatting helpers
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

function formatBytes(bytes: number | null): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

function relativeTime(iso: string | null): string {
  if (!iso) return "not yet updated";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "not yet updated";
  const diffMs = Date.now() - t;
  if (diffMs < 0) return "just now";
  const mins = Math.round(diffMs / 60_000);
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  const days = Math.round(hours / 24);
  return `${days} ${days === 1 ? "day" : "days"} ago`;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

// ---------------------------------------------------------------------------
// Usage bar (compact version so CorporateAdmin does not depend on the more
// elaborate <UsageBar> used on My eSIMs)
// ---------------------------------------------------------------------------

function CompactUsageBar({
  used,
  total,
}: {
  used: number | null;
  total: number | null;
}): JSX.Element {
  const pct =
    used != null && total != null && total > 0
      ? Math.min(100, Math.max(0, (used / total) * 100))
      : 0;
  const low = pct >= 80;
  return (
    <div className="w-full" data-testid="corporate-usage-bar">
      <div className="h-2 w-full overflow-hidden rounded-full bg-slate-100">
        <div
          className={`h-2 ${low ? "bg-amber-500" : "bg-brand-500"}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <p className="mt-1 text-[11px] text-slate-500">
        {formatBytes(used)} of {formatBytes(total)}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

function LoginForm({
  fetchImpl,
  onSuccess,
}: {
  fetchImpl: Fetcher;
  onSuccess: () => void;
}): JSX.Element {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await call(fetchImpl, "POST", "/api/corporate/login", {
        email: email.trim(),
        password,
      });
      onSuccess();
    } catch (err) {
      setError({
        code: err instanceof CorporateApiError ? err.code : "request_failed",
        message: err instanceof Error ? err.message : "Could not sign in.",
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="mt-4 space-y-3" noValidate>
      {error && (
        <div
          role="alert"
          className="rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-800 ring-1 ring-rose-200"
          data-testid="corporate-login-error"
          data-error-code={error.code}
        >
          {error.message}
        </div>
      )}
      <label className="block text-sm">
        <span className="font-medium text-slate-800">Work email</span>
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="email"
          required
          disabled={busy}
          className="mt-1 w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-200 disabled:opacity-60"
        />
      </label>
      <label className="block text-sm">
        <span className="font-medium text-slate-800">Password</span>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
          required
          disabled={busy}
          className="mt-1 w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-200 disabled:opacity-60"
        />
      </label>
      <button
        type="submit"
        disabled={busy}
        className="w-full rounded-xl bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-60"
        data-testid="corporate-login-submit"
      >
        {busy ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Seat assignment form
// ---------------------------------------------------------------------------

function AssignForm({
  fetchImpl,
  catalog,
  onDone,
}: {
  fetchImpl: Fetcher;
  catalog: CorporateCatalogEntry[];
  onDone: () => void;
}): JSX.Element {
  const [packageCode, setPackageCode] = useState(catalog[0]?.code ?? "");
  const [employeeEmail, setEmployeeEmail] = useState("");
  const [employeeName, setEmployeeName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await call(fetchImpl, "POST", "/api/corporate/assignments", {
        packageCode,
        seats: [
          {
            email: employeeEmail.trim(),
            name: employeeName.trim() || undefined,
          },
        ],
      });
      setEmployeeEmail("");
      setEmployeeName("");
      onDone();
    } catch (err) {
      setError({
        code: err instanceof CorporateApiError ? err.code : "request_failed",
        message: err instanceof Error ? err.message : "Could not assign eSIM.",
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="mt-3 space-y-3" data-testid="corporate-assign-form" noValidate>
      {error && (
        <div
          role="alert"
          className="rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-800 ring-1 ring-rose-200"
          data-testid="corporate-assign-error"
          data-error-code={error.code}
        >
          {error.message}
        </div>
      )}
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="block text-sm">
          <span className="font-medium text-slate-800">Plan</span>
          <select
            value={packageCode}
            onChange={(e) => setPackageCode(e.target.value)}
            disabled={busy || catalog.length === 0}
            className="mt-1 w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-200 disabled:opacity-60"
          >
            {catalog.length === 0 ? (
              <option value="">No plans available</option>
            ) : (
              catalog.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.name} · {c.dataLabel} · {c.validityLabel}
                </option>
              ))
            )}
          </select>
        </label>
        <label className="block text-sm">
          <span className="font-medium text-slate-800">Employee email</span>
          <input
            type="email"
            value={employeeEmail}
            onChange={(e) => setEmployeeEmail(e.target.value)}
            required
            disabled={busy}
            className="mt-1 w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-200 disabled:opacity-60"
          />
        </label>
        <label className="block text-sm">
          <span className="font-medium text-slate-800">Employee name (optional)</span>
          <input
            value={employeeName}
            onChange={(e) => setEmployeeName(e.target.value)}
            disabled={busy}
            className="mt-1 w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-200 disabled:opacity-60"
          />
        </label>
      </div>
      <button
        type="submit"
        disabled={busy || catalog.length === 0}
        className="rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-60"
        data-testid="corporate-assign-submit"
      >
        {busy ? "Assigning…" : "Assign eSIM"}
      </button>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Seat row
// ---------------------------------------------------------------------------

function SeatRow({
  seat,
  onUnassign,
  busy,
}: {
  seat: CorporateSeat;
  onUnassign: (seat: CorporateSeat) => void;
  busy: boolean;
}): JSX.Element {
  const statusClass: Record<SeatStatus, string> = {
    assigned: "bg-slate-100 text-slate-700 ring-slate-200",
    active: "bg-emerald-50 text-emerald-800 ring-emerald-200",
    expired: "bg-slate-100 text-slate-500 ring-slate-200",
    unassigned: "bg-slate-50 text-slate-500 ring-slate-200",
  };
  return (
    <tr data-testid={`corporate-seat-${seat.seatId}`}>
      <td className="px-3 py-3">
        <p className="text-sm font-medium text-slate-900">
          {seat.employeeName ?? "—"}
        </p>
        <p className="text-[11px] text-slate-500">{seat.employeeEmail}</p>
      </td>
      <td className="px-3 py-3 text-sm text-slate-700">
        <p>{seat.planName ?? "—"}</p>
        <p className="text-[11px] text-slate-500">{seat.country ?? ""}</p>
      </td>
      <td className="px-3 py-3">
        <span
          className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ${statusClass[seat.status]}`}
          data-seat-status={seat.status}
        >
          {seat.status}
        </span>
      </td>
      <td className="px-3 py-3">
        <CompactUsageBar used={seat.usedBytes} total={seat.totalBytes} />
        <p className="mt-1 text-[10px] text-slate-400">
          updated {relativeTime(seat.usageUpdatedAt)}
        </p>
      </td>
      <td className="px-3 py-3 text-right">
        {seat.status !== "unassigned" && seat.status !== "expired" ? (
          <button
            type="button"
            onClick={() => onUnassign(seat)}
            disabled={busy}
            className="rounded-lg border border-slate-300 bg-white px-2 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-60"
            data-testid={`corporate-unassign-${seat.seatId}`}
          >
            Unassign
          </button>
        ) : (
          <span className="text-[11px] text-slate-400">—</span>
        )}
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

type MeState =
  | { status: "loading" }
  | { status: "signed_out" }
  | { status: "ready"; me: MeResponse }
  | { status: "error"; code: string; message: string };

export interface CorporateAdminProps {
  fetcher?: Fetcher;
}

export function CorporateAdmin({ fetcher }: CorporateAdminProps = {}): JSX.Element {
  const fetchImpl: Fetcher = fetcher ?? ((url, init) => fetch(url, init));
  const [me, setMe] = useState<MeState>({ status: "loading" });
  const [reloadNonce, setReloadNonce] = useState(0);
  const [busySeatId, setBusySeatId] = useState<number | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setMe({ status: "loading" });
    call<MeResponse>(fetchImpl, "GET", "/api/corporate/me")
      .then((data) => {
        if (!cancelled) setMe({ status: "ready", me: data });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof CorporateApiError && err.httpStatus === 401) {
          setMe({ status: "signed_out" });
          return;
        }
        setMe({
          status: "error",
          code: err instanceof CorporateApiError ? err.code : "request_failed",
          message: err instanceof Error ? err.message : "Could not load corporate portal.",
        });
      });
    return () => {
      cancelled = true;
    };
  }, [fetchImpl, reloadNonce]);

  async function handleLogout(): Promise<void> {
    try {
      await call(fetchImpl, "POST", "/api/corporate/logout");
    } catch {
      /* best effort */
    }
    setReloadNonce((n) => n + 1);
  }

  async function handleUnassign(seat: CorporateSeat): Promise<void> {
    setBusySeatId(seat.seatId);
    setActionError(null);
    try {
      await call(fetchImpl, "POST", "/api/corporate/unassign", { seatId: seat.seatId });
      setReloadNonce((n) => n + 1);
    } catch (err) {
      setActionError(
        err instanceof Error ? err.message : "Could not unassign this seat.",
      );
    } finally {
      setBusySeatId(null);
    }
  }

  const header = useMemo(
    () => (
      <header className="mb-6">
        <p className="text-xs uppercase tracking-wide text-slate-500">
          {brand.name} · Corporate
        </p>
        <h1 className="mt-1 text-2xl font-extrabold text-slate-900">
          Corporate eSIMs
        </h1>
        <p className="mt-1 max-w-xl text-sm text-slate-600">
          Assign travel eSIMs to your staff, watch their data usage, and pay one
          monthly invoice.
        </p>
      </header>
    ),
    [],
  );

  if (me.status === "loading") {
    return (
      <main
        className="mx-auto w-full max-w-4xl px-4 py-10"
        aria-busy
        data-testid="corporate-loading"
      >
        <div className="h-8 w-64 animate-pulse rounded bg-slate-100" />
        <div className="mt-4 h-40 animate-pulse rounded-2xl bg-slate-100" />
      </main>
    );
  }

  if (me.status === "error") {
    return (
      <main className="mx-auto w-full max-w-4xl px-4 py-10">
        <div
          role="alert"
          className="rounded-2xl bg-rose-50 px-4 py-3 text-sm text-rose-800 ring-1 ring-rose-200"
          data-testid="corporate-error"
          data-error-code={me.code}
        >
          <p className="font-semibold">We couldn't load your account.</p>
          <p className="mt-1">{me.message}</p>
          <button
            type="button"
            onClick={() => setReloadNonce((n) => n + 1)}
            className="mt-3 rounded-lg bg-rose-600 px-3 py-1.5 font-medium text-white hover:bg-rose-700"
          >
            Try again
          </button>
        </div>
      </main>
    );
  }

  if (me.status === "signed_out") {
    return (
      <main
        className="mx-auto w-full max-w-md px-4 pb-16 pt-6"
        data-testid="corporate-signed-out"
      >
        {header}
        <section className="rounded-2xl bg-white p-5 ring-1 ring-slate-200">
          <h2 className="text-base font-bold text-slate-900">Sign in</h2>
          <LoginForm
            fetchImpl={fetchImpl}
            onSuccess={() => setReloadNonce((n) => n + 1)}
          />
          <p className="mt-4 text-center text-xs text-slate-500">
            Need a corporate account? Email{" "}
            <a href={`mailto:${brand.supportEmail}`} className="underline">
              {brand.supportEmail}
            </a>
            .
          </p>
        </section>
      </main>
    );
  }

  const company = me.me.company;

  if (company.status === "pending") {
    return (
      <main
        className="mx-auto w-full max-w-2xl px-4 pb-16 pt-6"
        data-testid="corporate-pending"
      >
        {header}
        <section className="rounded-2xl bg-amber-50 px-4 py-4 text-sm text-amber-900 ring-1 ring-amber-200">
          <h2 className="font-semibold">Account under review</h2>
          <p className="mt-1">
            Your account ({company.companyName}) is being set up. We'll email{" "}
            {company.billingEmail} once it's ready to use.
          </p>
          <button
            type="button"
            onClick={handleLogout}
            className="mt-3 rounded-lg bg-white px-3 py-1.5 text-xs font-medium text-amber-900 ring-1 ring-amber-300 hover:bg-amber-100"
          >
            Sign out
          </button>
        </section>
      </main>
    );
  }

  if (company.status === "suspended") {
    return (
      <main
        className="mx-auto w-full max-w-2xl px-4 pb-16 pt-6"
        data-testid="corporate-suspended"
      >
        {header}
        <section className="rounded-2xl bg-slate-100 px-4 py-4 text-sm text-slate-800 ring-1 ring-slate-200">
          <h2 className="font-semibold">Account suspended</h2>
          <p className="mt-1">
            Email{" "}
            <a href={`mailto:${brand.supportEmail}`} className="underline">
              {brand.supportEmail}
            </a>{" "}
            to restore access.
          </p>
          <button
            type="button"
            onClick={handleLogout}
            className="mt-3 rounded-lg bg-white px-3 py-1.5 text-xs font-medium text-slate-800 ring-1 ring-slate-300 hover:bg-slate-50"
          >
            Sign out
          </button>
        </section>
      </main>
    );
  }

  // ---------- approved ----------
  const seats = me.me.seats;
  const invoices = me.me.invoices;
  const catalog = me.me.catalog ?? [];
  const openInvoice = invoices.find((inv) => inv.status === "open" || inv.status === "overdue");

  return (
    <main
      className="mx-auto w-full max-w-4xl px-4 pb-16 pt-6"
      data-testid="corporate-approved"
    >
      {header}

      <section className="rounded-2xl bg-white p-5 ring-1 ring-slate-200">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <p className="text-sm font-semibold text-slate-900">{company.companyName}</p>
            <p className="text-xs text-slate-500">Billing: {company.billingEmail}</p>
          </div>
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center rounded-full bg-brand-50 px-2.5 py-0.5 text-xs font-semibold text-brand-800 ring-1 ring-brand-100">
              {seats.length} seat{seats.length === 1 ? "" : "s"}
            </span>
            <button
              type="button"
              onClick={handleLogout}
              className="rounded-lg border border-slate-300 bg-white px-3 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
            >
              Sign out
            </button>
          </div>
        </div>
        {openInvoice && (
          <p
            className="mt-3 rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-900 ring-1 ring-amber-200"
            data-testid="corporate-open-invoice"
          >
            Open invoice {openInvoice.publicId} (
            {formatMinor(openInvoice.totalMinor, openInvoice.currency)}) for{" "}
            {formatDate(openInvoice.periodStart)} – {formatDate(openInvoice.periodEnd)}.
          </p>
        )}
      </section>

      <section className="mt-8" aria-labelledby="corporate-assign-heading">
        <h2
          id="corporate-assign-heading"
          className="text-base font-bold text-slate-900"
        >
          Assign an eSIM
        </h2>
        <div className="mt-3 rounded-2xl bg-white p-4 ring-1 ring-slate-200">
          <AssignForm
            fetchImpl={fetchImpl}
            catalog={catalog}
            onDone={() => setReloadNonce((n) => n + 1)}
          />
        </div>
      </section>

      {actionError && (
        <div
          role="alert"
          className="mt-4 rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-800 ring-1 ring-rose-200"
          data-testid="corporate-action-error"
        >
          {actionError}
        </div>
      )}

      <section className="mt-8" aria-labelledby="corporate-seats-heading">
        <h2 id="corporate-seats-heading" className="text-base font-bold text-slate-900">
          Assigned seats
        </h2>
        {seats.length === 0 ? (
          <p className="mt-3 rounded-xl bg-slate-50 px-4 py-3 text-sm text-slate-600 ring-1 ring-slate-200">
            No eSIMs assigned yet. Add an employee above to get started.
          </p>
        ) : (
          <div className="mt-3 overflow-x-auto rounded-2xl ring-1 ring-slate-200">
            <table className="w-full min-w-[640px] text-sm">
              <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-3 py-2 text-left">Employee</th>
                  <th className="px-3 py-2 text-left">Plan</th>
                  <th className="px-3 py-2 text-left">Status</th>
                  <th className="px-3 py-2 text-left">Data usage</th>
                  <th className="px-3 py-2 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 bg-white">
                {seats.map((seat) => (
                  <SeatRow
                    key={seat.seatId}
                    seat={seat}
                    busy={busySeatId === seat.seatId}
                    onUnassign={(s) => void handleUnassign(s)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-2 text-[11px] text-slate-500">
          Usage is refreshed every few hours (typically a 1–3 hour delay from the
          operator).
        </p>
      </section>

      <section className="mt-8" aria-labelledby="corporate-invoices-heading">
        <h2 id="corporate-invoices-heading" className="text-base font-bold text-slate-900">
          Invoices
        </h2>
        {invoices.length === 0 ? (
          <p className="mt-3 rounded-xl bg-slate-50 px-4 py-3 text-sm text-slate-600 ring-1 ring-slate-200">
            No invoices yet. They're generated at the end of each billing period.
          </p>
        ) : (
          <div className="mt-3 overflow-x-auto rounded-2xl ring-1 ring-slate-200">
            <table className="w-full min-w-[560px] text-sm">
              <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-3 py-2 text-left">Invoice</th>
                  <th className="px-3 py-2 text-left">Period</th>
                  <th className="px-3 py-2 text-right">Total</th>
                  <th className="px-3 py-2 text-left">Status</th>
                  <th className="px-3 py-2 text-right">PDF</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 bg-white">
                {invoices.map((inv) => (
                  <tr key={inv.publicId} data-testid={`corporate-invoice-${inv.publicId}`}>
                    <td className="px-3 py-2 font-mono text-xs text-slate-800">
                      {inv.publicId}
                    </td>
                    <td className="px-3 py-2 text-slate-700">
                      {formatDate(inv.periodStart)} – {formatDate(inv.periodEnd)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums font-semibold text-slate-900">
                      {formatMinor(inv.totalMinor, inv.currency)}
                    </td>
                    <td className="px-3 py-2">
                      <span
                        className="inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-700 ring-1 ring-slate-200"
                        data-invoice-status={inv.status}
                      >
                        {inv.status}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right">
                      {inv.pdfUrl ? (
                        <a
                          href={inv.pdfUrl}
                          className="text-xs font-medium text-brand-700 hover:text-brand-800"
                          target="_blank"
                          rel="noreferrer"
                        >
                          Download
                        </a>
                      ) : (
                        <span className="text-[11px] text-slate-400">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <nav className="mt-8 flex flex-wrap gap-3 text-sm">
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

export const __test__ = { formatMinor, formatBytes, relativeTime };
export default CorporateAdmin;

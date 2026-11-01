/**
 * Affiliate dashboard — /affiliates (public info + login) and
 * /affiliates/dashboard (signed-in surface).
 *
 * Contract (server/routes/affiliates.ts, previous batch):
 *   POST /api/affiliates/apply           { displayName, email, password, website?, socialUrl?, promoMethod? }
 *   POST /api/affiliates/login           { email, password }
 *   POST /api/affiliates/logout
 *   GET  /api/affiliates/me              { affiliate, link, cookieDays }
 *   GET  /api/affiliates/stats           { clicks, sales, grossMinor, commissionOwedMinor, currency }
 *
 * The page distinguishes:
 *   - signed out  → login form + "apply" link
 *   - signed in but pending → an honest "under review" panel with logout
 *   - signed in approved    → profile + link (with copy button) + stats
 *
 * Honesty rules:
 *   - We never invent stats. If /stats fails we render our own error.
 *   - Payouts owed come straight from the server; the copy says
 *     "Bookkeeping total — payouts are settled by our team each month", so
 *     this page never implies a payout has been *sent*.
 *   - The link is truncated visibly to 60 characters but the COPY button
 *     copies the full URL from state.
 */
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { brand, type SupportedCurrency, absoluteUrl } from "../../server/brand.config";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface AffiliateProfile {
  publicId: string;
  displayName: string;
  email: string;
  website: string | null;
  socialUrl: string | null;
  status: "pending" | "approved" | "rejected" | "suspended";
  commissionPercent: number;
  cookieDays: number;
  code: string | null;
}

export interface AffiliateStats {
  clicks: number;
  sales: number;
  grossMinor: number;
  commissionOwedMinor: number;
  currency: SupportedCurrency;
}

interface MeResponse {
  affiliate: AffiliateProfile;
  link: string | null;
  cookieDays: number;
}

// ---------------------------------------------------------------------------
// Fetch helpers (injectable for tests)
// ---------------------------------------------------------------------------

class AffiliateApiError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  constructor(code: string, httpStatus: number, message: string) {
    super(message);
    this.name = "AffiliateApiError";
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
    throw new AffiliateApiError(
      err.error ?? "request_failed",
      res.status,
      err.message ?? `Request failed (HTTP ${res.status}).`,
    );
  }
  return (json as ApiOk<T>).data;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** Minor-unit formatter matching TravelerPass.formatMinor semantics. */
function formatMinor(minor: number, currency: SupportedCurrency): string {
  if (!Number.isFinite(minor)) return "—";
  const zeroDecimal = currency === "VND";
  const major = zeroDecimal ? minor : minor / 100;
  const body = zeroDecimal
    ? Math.round(major).toLocaleString("en-US")
    : major.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${body} ${currency}`;
}

// ---------------------------------------------------------------------------
// UI primitives
// ---------------------------------------------------------------------------

interface CopyButtonProps {
  value: string;
  label: string;
}
function CopyButton({ value, label }: CopyButtonProps): JSX.Element {
  const [copied, setCopied] = useState(false);
  async function handleCopy() {
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard can be blocked; the URL is visible for manual copy.
    }
  }
  return (
    <button
      type="button"
      onClick={handleCopy}
      className="rounded-lg border border-slate-300 bg-white px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
      aria-label={label}
      data-testid="affiliate-copy-link"
    >
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

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
      await call<{ publicId: string; status: string }>(
        fetchImpl,
        "POST",
        "/api/affiliates/login",
        { email: email.trim(), password },
      );
      onSuccess();
    } catch (err) {
      const code = err instanceof AffiliateApiError ? err.code : "request_failed";
      const message =
        err instanceof Error ? err.message : "Could not sign in.";
      setError({ code, message });
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
          data-testid="affiliate-login-error"
          data-error-code={error.code}
        >
          {error.message}
        </div>
      )}
      <label className="block text-sm">
        <span className="font-medium text-slate-800">Email</span>
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
        data-testid="affiliate-login-submit"
      >
        {busy ? "Signing in…" : "Sign in"}
      </button>
    </form>
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

type StatsState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; stats: AffiliateStats }
  | { status: "error"; message: string };

export interface AffiliateDashboardProps {
  /** Injectable fetcher (defaults to global `fetch`). */
  fetcher?: Fetcher;
  /** Where "Apply" links to. */
  applyHref?: string;
}

export function AffiliateDashboard({
  fetcher,
  applyHref = "/affiliates/apply",
}: AffiliateDashboardProps = {}): JSX.Element {
  const fetchImpl: Fetcher = fetcher ?? ((url, init) => fetch(url, init));
  const [state, setState] = useState<MeState>({ status: "loading" });
  const [stats, setStats] = useState<StatsState>({ status: "idle" });
  const [reloadNonce, setReloadNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    call<MeResponse>(fetchImpl, "GET", "/api/affiliates/me")
      .then((me) => {
        if (!cancelled) setState({ status: "ready", me });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof AffiliateApiError && err.httpStatus === 401) {
          setState({ status: "signed_out" });
          return;
        }
        setState({
          status: "error",
          code: err instanceof AffiliateApiError ? err.code : "request_failed",
          message: err instanceof Error ? err.message : "Could not load your dashboard.",
        });
      });
    return () => {
      cancelled = true;
    };
  }, [fetchImpl, reloadNonce]);

  // Fetch stats only once we know the caller is approved.
  useEffect(() => {
    if (state.status !== "ready") return;
    if (state.me.affiliate.status !== "approved") {
      setStats({ status: "idle" });
      return;
    }
    let cancelled = false;
    setStats({ status: "loading" });
    call<AffiliateStats>(fetchImpl, "GET", "/api/affiliates/stats")
      .then((s) => {
        if (!cancelled) setStats({ status: "ready", stats: s });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setStats({
          status: "error",
          message: err instanceof Error ? err.message : "Could not load stats.",
        });
      });
    return () => {
      cancelled = true;
    };
  }, [state, fetchImpl]);

  async function handleLogout() {
    try {
      await call(fetchImpl, "POST", "/api/affiliates/logout");
    } catch {
      /* best-effort: clear local view regardless */
    }
    setReloadNonce((n) => n + 1);
  }

  const header = useMemo(
    () => (
      <header className="mb-6">
        <p className="text-xs uppercase tracking-wide text-slate-500">
          {brand.name} · Affiliates
        </p>
        <h1 className="mt-1 text-2xl font-extrabold text-slate-900">
          Affiliate dashboard
        </h1>
        <p className="mt-1 max-w-xl text-sm text-slate-600">
          Share your link. Earn a commission on every paid order — tracked for
          30 days from the first click.
        </p>
      </header>
    ),
    [],
  );

  if (state.status === "loading") {
    return (
      <main
        className="mx-auto w-full max-w-3xl px-4 py-10"
        aria-busy
        data-testid="affiliate-dashboard-loading"
      >
        <div className="h-8 w-64 animate-pulse rounded bg-slate-100" />
        <div className="mt-4 h-40 animate-pulse rounded-2xl bg-slate-100" />
      </main>
    );
  }

  if (state.status === "error") {
    return (
      <main className="mx-auto w-full max-w-3xl px-4 py-10">
        <div
          role="alert"
          className="rounded-2xl bg-rose-50 px-4 py-3 text-sm text-rose-800 ring-1 ring-rose-200"
          data-testid="affiliate-dashboard-error"
          data-error-code={state.code}
        >
          <p className="font-semibold">We couldn't load your dashboard.</p>
          <p className="mt-1">{state.message}</p>
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

  if (state.status === "signed_out") {
    return (
      <main
        className="mx-auto w-full max-w-md px-4 pb-16 pt-6"
        data-testid="affiliate-signed-out"
      >
        {header}
        <section className="rounded-2xl bg-white p-5 ring-1 ring-slate-200">
          <h2 className="text-base font-bold text-slate-900">Sign in</h2>
          <LoginForm fetchImpl={fetchImpl} onSuccess={() => setReloadNonce((n) => n + 1)} />
          <p className="mt-4 text-center text-xs text-slate-500">
            Not an affiliate yet?{" "}
            <a href={applyHref} className="font-semibold text-brand-700 hover:text-brand-800">
              Apply to the programme →
            </a>
          </p>
        </section>
      </main>
    );
  }

  const affiliate = state.me.affiliate;

  if (affiliate.status === "pending") {
    return (
      <main
        className="mx-auto w-full max-w-2xl px-4 pb-16 pt-6"
        data-testid="affiliate-pending"
      >
        {header}
        <section className="rounded-2xl bg-amber-50 px-4 py-4 text-sm text-amber-900 ring-1 ring-amber-200">
          <h2 className="font-semibold">Application under review</h2>
          <p className="mt-1">
            Thanks {affiliate.displayName} — we review applications manually.
            We'll email {affiliate.email} once you're approved.
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

  if (affiliate.status === "rejected" || affiliate.status === "suspended") {
    return (
      <main
        className="mx-auto w-full max-w-2xl px-4 pb-16 pt-6"
        data-testid="affiliate-inactive"
        data-status={affiliate.status}
      >
        {header}
        <section className="rounded-2xl bg-slate-100 px-4 py-4 text-sm text-slate-800 ring-1 ring-slate-200">
          <h2 className="font-semibold">
            {affiliate.status === "rejected" ? "Application not approved" : "Account suspended"}
          </h2>
          <p className="mt-1">
            Email{" "}
            <a href={`mailto:${brand.supportEmail}`} className="underline">
              {brand.supportEmail}
            </a>{" "}
            if you think this is a mistake.
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

  // ---- approved ----
  const link = state.me.link ?? (affiliate.code ? absoluteUrl(`/r/a/${affiliate.code}`, "") : null);

  return (
    <main
      className="mx-auto w-full max-w-3xl px-4 pb-16 pt-6"
      data-testid="affiliate-approved"
    >
      {header}

      <section className="rounded-2xl bg-white p-5 ring-1 ring-slate-200">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <p className="text-sm font-semibold text-slate-900">{affiliate.displayName}</p>
            <p className="text-xs text-slate-500">{affiliate.email}</p>
          </div>
          <div className="flex items-center gap-2">
            <span
              className="inline-flex items-center rounded-full bg-brand-50 px-2.5 py-0.5 text-xs font-semibold text-brand-800 ring-1 ring-brand-100"
              data-testid="affiliate-commission"
            >
              {affiliate.commissionPercent}% commission
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

        {link ? (
          <div className="mt-4 rounded-xl bg-slate-50 p-3 ring-1 ring-slate-200">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              Your affiliate link
            </p>
            <div className="mt-1 flex items-center gap-2">
              <code
                className="block min-w-0 flex-1 truncate text-xs text-slate-800"
                data-testid="affiliate-link"
              >
                {link}
              </code>
              <CopyButton value={link} label="Copy affiliate link" />
            </div>
            <p className="mt-2 text-[11px] text-slate-500">
              30-day attribute window ({state.me.cookieDays} days). Links refer
              back to us as soon as a visitor clicks.
            </p>
          </div>
        ) : (
          <p className="mt-3 rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-900 ring-1 ring-amber-200">
            Your link is being prepared. Refresh in a moment.
          </p>
        )}
      </section>

      <section className="mt-6" aria-labelledby="affiliate-stats-heading">
        <h2
          id="affiliate-stats-heading"
          className="text-base font-bold text-slate-900"
        >
          Performance
        </h2>

        {stats.status === "loading" && (
          <div className="mt-3 grid gap-3 sm:grid-cols-2" aria-busy>
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="h-24 animate-pulse rounded-2xl bg-slate-100" />
            ))}
          </div>
        )}

        {stats.status === "error" && (
          <p
            role="alert"
            className="mt-3 rounded-2xl bg-rose-50 px-4 py-3 text-sm text-rose-800 ring-1 ring-rose-200"
            data-testid="affiliate-stats-error"
          >
            {stats.message}
          </p>
        )}

        {stats.status === "ready" && (
          <div
            className="mt-3 grid gap-3 sm:grid-cols-2"
            data-testid="affiliate-stats"
          >
            <StatTile label="Clicks" value={stats.stats.clicks.toLocaleString()} />
            <StatTile label="Paid orders" value={stats.stats.sales.toLocaleString()} />
            <StatTile
              label="Gross sales"
              value={formatMinor(stats.stats.grossMinor, stats.stats.currency)}
            />
            <StatTile
              label="Commission owed"
              value={formatMinor(stats.stats.commissionOwedMinor, stats.stats.currency)}
              emphasised
            />
          </div>
        )}

        <p className="mt-3 text-[11px] text-slate-500">
          Commission owed is a bookkeeping total. Payouts are settled by our
          team — see your email for the current schedule.
        </p>
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

function StatTile({
  label,
  value,
  emphasised,
}: {
  label: string;
  value: string;
  emphasised?: boolean;
}): JSX.Element {
  return (
    <div
      className={`rounded-2xl p-4 ring-1 ${
        emphasised
          ? "bg-brand-50 ring-brand-200"
          : "bg-white ring-slate-200"
      }`}
    >
      <p className="text-xs uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-1 text-2xl font-extrabold text-slate-900">{value}</p>
    </div>
  );
}

export const __test__ = {
  call,
  formatMinor,
  AffiliateApiError,
};

export default AffiliateDashboard;

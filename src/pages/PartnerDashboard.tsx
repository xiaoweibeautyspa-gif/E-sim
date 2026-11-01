/**
 * Partner QR dashboard — /partners (login + QR standee view) and
 * /partners/dashboard.
 *
 * Contract (server/routes/partners.ts, previous batch):
 *   POST /api/partners/login           { email, password }
 *   POST /api/partners/logout
 *   GET  /api/partners/me              { partner: Partner }
 *   GET  /api/partners/qr              { qrCode, shortLink, landing{en,zh,vi}, instructions[] }
 *   GET  /api/partners/stats           { clicks, sales, grossMinor, commissionOwedMinor, currency }
 *
 * The printable standee is a browser-side printable card. We do NOT generate a
 * QR image here (no dependency added): the short link is shown prominently and
 * the print layout stylesheet prints the link at the top of the card. A QR
 * image renderer (server-side, from the SSR batch) can be wired into the
 * placeholder slot `<div data-testid="partner-standee-qr-slot">`.
 *
 * Honesty rules:
 *   - We don't invent a QR image or QR content beyond the short link.
 *   - The standee shows only the partner's own data — the landing page URL per
 *     locale is returned by the server and rendered faithfully.
 *   - Signed-out view shows a login form; pending shows an under-review panel.
 */
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { brand, type SupportedCurrency } from "../../server/brand.config";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface PartnerProfile {
  id: number;
  publicId: string;
  email: string;
  businessName: string;
  contactName: string;
  venueType: "hotel" | "spa" | "restaurant" | "cafe" | "other";
  venueCity: string | null;
  venueCountry: string | null;
  status: "pending" | "approved" | "rejected" | "suspended";
  commissionPercent: number;
  qrCode: string | null;
}

export interface PartnerQr {
  qrCode: string;
  shortLink: string;
  landing: { en: string; zh: string; vi: string };
  instructions: string[];
}

export interface PartnerStats {
  clicks: number;
  sales: number;
  grossMinor: number;
  commissionOwedMinor: number;
  currency: SupportedCurrency;
}

// ---------------------------------------------------------------------------
// Fetch helpers (injectable)
// ---------------------------------------------------------------------------

class PartnerApiError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  constructor(code: string, httpStatus: number, message: string) {
    super(message);
    this.name = "PartnerApiError";
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
    throw new PartnerApiError(
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
      await call<{ publicId: string; status: string }>(
        fetchImpl,
        "POST",
        "/api/partners/login",
        { email: email.trim(), password },
      );
      onSuccess();
    } catch (err) {
      const code = err instanceof PartnerApiError ? err.code : "request_failed";
      const message = err instanceof Error ? err.message : "Could not sign in.";
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
          data-testid="partner-login-error"
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
        data-testid="partner-login-submit"
      >
        {busy ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Standee print view
// ---------------------------------------------------------------------------

/**
 * Renders a printable standee with the short link prominent. The QR image is
 * a future slot: the SSR batch will render a real PNG and inject it here.
 * Today we render a sized placeholder whose surrounding print CSS still
 * prints cleanly.
 */
function Standee({
  qr,
  partner,
}: {
  qr: PartnerQr;
  partner: PartnerProfile;
}): JSX.Element {
  return (
    <section
      className="mt-6 rounded-3xl bg-white p-6 ring-1 ring-slate-200"
      aria-labelledby="standee-heading"
      data-testid="partner-standee"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2
            id="standee-heading"
            className="text-base font-bold text-slate-900"
          >
            Your printable standee
          </h2>
          <p className="mt-1 text-xs text-slate-500">
            Print at A6 or laminate at A5. Place it where guests can scan.
          </p>
        </div>
        <button
          type="button"
          onClick={() => window.print()}
          className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
          data-testid="partner-standee-print"
        >
          Print
        </button>
      </div>

      <div className="mt-4 rounded-2xl bg-gradient-to-br from-brand-600 to-brand-700 p-6 text-white">
        <p className="text-xs font-semibold uppercase tracking-widest text-brand-100/80">
          {partner.businessName}
        </p>
        <p className="mt-1 text-xl font-extrabold">
          Stay connected in {partner.venueCity ?? "town"}
        </p>
        <p className="mt-1 text-sm text-brand-50/90">
          Scan for an instant travel eSIM. Works on any unlocked phone.
        </p>
        <div
          className="mx-auto mt-4 flex h-40 w-40 items-center justify-center rounded-2xl bg-white text-center text-[11px] font-semibold text-slate-500"
          aria-label={`QR code placeholder for ${qr.qrCode}`}
          data-testid="partner-standee-qr-slot"
        >
          QR image renders once the print service is live
        </div>
        <p className="mt-3 text-center text-[11px] text-brand-100/80">
          Or visit: <span className="font-mono">{qr.shortLink}</span>
        </p>
      </div>

      <div className="mt-4 grid gap-2 text-xs text-slate-600 sm:grid-cols-3">
        <LandingLink locale="en" href={qr.landing.en} />
        <LandingLink locale="zh" href={qr.landing.zh} />
        <LandingLink locale="vi" href={qr.landing.vi} />
      </div>

      {qr.instructions.length > 0 && (
        <ul className="mt-4 list-disc space-y-1 pl-5 text-xs text-slate-600">
          {qr.instructions.map((step, i) => (
            <li key={`${i}-${step.slice(0, 16)}`}>{step}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

function LandingLink({
  locale,
  href,
}: {
  locale: "en" | "zh" | "vi";
  href: string;
}): JSX.Element {
  const label = locale === "zh" ? "中文" : locale === "vi" ? "Tiếng Việt" : "English";
  return (
    <div
      className="rounded-xl bg-slate-50 px-3 py-2 ring-1 ring-slate-200"
      data-testid={`partner-landing-${locale}`}
    >
      <p className="text-[10px] uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-0.5 truncate font-mono text-[11px] text-slate-800" title={href}>
        {href}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

type MeState =
  | { status: "loading" }
  | { status: "signed_out" }
  | { status: "ready"; partner: PartnerProfile }
  | { status: "error"; code: string; message: string };

type QrState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; qr: PartnerQr }
  | { status: "error"; message: string };

type StatsState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; stats: PartnerStats }
  | { status: "error"; message: string };

export interface PartnerDashboardProps {
  fetcher?: Fetcher;
  applyHref?: string;
}

export function PartnerDashboard({
  fetcher,
  applyHref = "/partners/apply",
}: PartnerDashboardProps = {}): JSX.Element {
  const fetchImpl: Fetcher = fetcher ?? ((url, init) => fetch(url, init));
  const [me, setMe] = useState<MeState>({ status: "loading" });
  const [qr, setQr] = useState<QrState>({ status: "idle" });
  const [stats, setStats] = useState<StatsState>({ status: "idle" });
  const [reloadNonce, setReloadNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setMe({ status: "loading" });
    setQr({ status: "idle" });
    setStats({ status: "idle" });
    call<{ partner: PartnerProfile }>(fetchImpl, "GET", "/api/partners/me")
      .then((data) => {
        if (!cancelled) setMe({ status: "ready", partner: data.partner });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof PartnerApiError && err.httpStatus === 401) {
          setMe({ status: "signed_out" });
          return;
        }
        setMe({
          status: "error",
          code: err instanceof PartnerApiError ? err.code : "request_failed",
          message: err instanceof Error ? err.message : "Could not load your dashboard.",
        });
      });
    return () => {
      cancelled = true;
    };
  }, [fetchImpl, reloadNonce]);

  // Once approved, fetch QR + stats.
  useEffect(() => {
    if (me.status !== "ready" || me.partner.status !== "approved") return;
    let cancelledQr = false;
    let cancelledStats = false;

    setQr({ status: "loading" });
    call<PartnerQr>(fetchImpl, "GET", "/api/partners/qr")
      .then((data) => {
        if (!cancelledQr) setQr({ status: "ready", qr: data });
      })
      .catch((err: unknown) => {
        if (cancelledQr) return;
        setQr({
          status: "error",
          message: err instanceof Error ? err.message : "Could not load your QR.",
        });
      });

    setStats({ status: "loading" });
    call<PartnerStats>(fetchImpl, "GET", "/api/partners/stats")
      .then((data) => {
        if (!cancelledStats) setStats({ status: "ready", stats: data });
      })
      .catch((err: unknown) => {
        if (cancelledStats) return;
        setStats({
          status: "error",
          message: err instanceof Error ? err.message : "Could not load your stats.",
        });
      });

    return () => {
      cancelledQr = true;
      cancelledStats = true;
    };
  }, [me, fetchImpl]);

  async function handleLogout() {
    try {
      await call(fetchImpl, "POST", "/api/partners/logout");
    } catch {
      /* best effort */
    }
    setReloadNonce((n) => n + 1);
  }

  const header = useMemo(
    () => (
      <header className="mb-6">
        <p className="text-xs uppercase tracking-wide text-slate-500">
          {brand.name} · Partners
        </p>
        <h1 className="mt-1 text-2xl font-extrabold text-slate-900">
          Partner dashboard
        </h1>
        <p className="mt-1 max-w-xl text-sm text-slate-600">
          Print your standee, share the short link, and earn commission on every
          paid eSIM order placed by your guests.
        </p>
      </header>
    ),
    [],
  );

  if (me.status === "loading") {
    return (
      <main
        className="mx-auto w-full max-w-3xl px-4 py-10"
        aria-busy
        data-testid="partner-dashboard-loading"
      >
        <div className="h-8 w-64 animate-pulse rounded bg-slate-100" />
        <div className="mt-4 h-40 animate-pulse rounded-2xl bg-slate-100" />
      </main>
    );
  }

  if (me.status === "error") {
    return (
      <main className="mx-auto w-full max-w-3xl px-4 py-10">
        <div
          role="alert"
          className="rounded-2xl bg-rose-50 px-4 py-3 text-sm text-rose-800 ring-1 ring-rose-200"
          data-testid="partner-dashboard-error"
          data-error-code={me.code}
        >
          <p className="font-semibold">We couldn't load your dashboard.</p>
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
        data-testid="partner-signed-out"
      >
        {header}
        <section className="rounded-2xl bg-white p-5 ring-1 ring-slate-200">
          <h2 className="text-base font-bold text-slate-900">Sign in</h2>
          <LoginForm fetchImpl={fetchImpl} onSuccess={() => setReloadNonce((n) => n + 1)} />
          <p className="mt-4 text-center text-xs text-slate-500">
            Not a partner yet?{" "}
            <a href={applyHref} className="font-semibold text-brand-700 hover:text-brand-800">
              Apply →
            </a>
          </p>
        </section>
      </main>
    );
  }

  const partner = me.partner;

  if (partner.status === "pending") {
    return (
      <main
        className="mx-auto w-full max-w-2xl px-4 pb-16 pt-6"
        data-testid="partner-pending"
      >
        {header}
        <section className="rounded-2xl bg-amber-50 px-4 py-4 text-sm text-amber-900 ring-1 ring-amber-200">
          <h2 className="font-semibold">Application under review</h2>
          <p className="mt-1">
            Thanks for applying with {partner.businessName}. We'll email{" "}
            {partner.email} once approved — usually within 1 business day.
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

  if (partner.status === "rejected" || partner.status === "suspended") {
    return (
      <main
        className="mx-auto w-full max-w-2xl px-4 pb-16 pt-6"
        data-testid="partner-inactive"
        data-status={partner.status}
      >
        {header}
        <section className="rounded-2xl bg-slate-100 px-4 py-4 text-sm text-slate-800 ring-1 ring-slate-200">
          <h2 className="font-semibold">
            {partner.status === "rejected" ? "Application not approved" : "Account suspended"}
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
  return (
    <main
      className="mx-auto w-full max-w-3xl px-4 pb-16 pt-6"
      data-testid="partner-approved"
    >
      {header}

      <section className="rounded-2xl bg-white p-5 ring-1 ring-slate-200">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <p className="text-sm font-semibold text-slate-900">{partner.businessName}</p>
            <p className="text-xs text-slate-500">
              {partner.contactName}
              {partner.venueCity ? ` · ${partner.venueCity}` : ""}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <span
              className="inline-flex items-center rounded-full bg-brand-50 px-2.5 py-0.5 text-xs font-semibold text-brand-800 ring-1 ring-brand-100"
              data-testid="partner-commission"
            >
              {partner.commissionPercent}% commission
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
      </section>

      {qr.status === "loading" && (
        <div className="mt-6 h-56 animate-pulse rounded-2xl bg-slate-100" aria-busy />
      )}

      {qr.status === "error" && (
        <p
          role="alert"
          className="mt-6 rounded-2xl bg-rose-50 px-4 py-3 text-sm text-rose-800 ring-1 ring-rose-200"
          data-testid="partner-qr-error"
        >
          {qr.message}
        </p>
      )}

      {qr.status === "ready" && <Standee qr={qr.qr} partner={partner} />}

      <section className="mt-8" aria-labelledby="partner-stats-heading">
        <h2
          id="partner-stats-heading"
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
            data-testid="partner-stats-error"
          >
            {stats.message}
          </p>
        )}

        {stats.status === "ready" && (
          <div className="mt-3 grid gap-3 sm:grid-cols-2" data-testid="partner-stats">
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

      <style>{`
        @media print {
          body * { visibility: hidden; }
          [data-testid="partner-standee"], [data-testid="partner-standee"] * {
            visibility: visible;
          }
          [data-testid="partner-standee"] {
            position: absolute; left: 0; top: 0; width: 100%;
          }
          [data-testid="partner-standee-print"],
          [data-testid="partner-standee"] nav,
          [data-testid="partner-standee"] button {
            display: none !important;
          }
        }
      `}</style>
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
        emphasised ? "bg-brand-50 ring-brand-200" : "bg-white ring-slate-200"
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
  PartnerApiError,
};

export default PartnerDashboard;

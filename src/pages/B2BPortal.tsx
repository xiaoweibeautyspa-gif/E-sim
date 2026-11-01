/**
 * B2B travel-agent portal — /b2b (apply + login) and /b2b/portal.
 *
 * Contract (mirrors server/routes/b2b.ts, saved in an earlier batch):
 *   POST /api/b2b/apply         { companyName, contactName, email, password, website?, country?, iata?, expectedMonthlyVolume? }
 *   POST /api/b2b/login         { email, password }
 *   POST /api/b2b/logout
 *   GET  /api/b2b/me            { agent: B2BAgent, tiers: B2BTier[], creditMinor? }
 *   GET  /api/b2b/stats         { orders, grossMinor, currency, volumeThisMonth }
 *   POST /api/b2b/bulk-order    { items: [{ packageCode, quantity }], sendToClients: boolean, clientEmails?: string[] }
 *                              → { checkoutUrl } | { orderPublicId, status }
 *
 * Honesty rules
 * -------------
 *   - The page never claims real numbers. Everything renders from the API.
 *   - Tier pricing is displayed as a table returned by the server. If a tier
 *     isn't configured we don't fabricate a discount.
 *   - "Send to clients" is disabled unless the server says the agent is
 *     approved AND the agent is allowed client delivery. We don't pretend a
 *     delivery will happen.
 *   - Bulk ordering always flows through the SAME checkout path as retail
 *     (`/api/checkout` under the hood is not re-implemented here — we call
 *     the B2B endpoint which the server wires into that path). We never emit
 *     an eSIM order directly from the browser.
 */
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { brand, type SupportedCurrency } from "../../server/brand.config";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface B2BTier {
  /** Tier key stored on the agent (e.g. "silver", "gold", "platinum"). */
  key: string;
  label: string;
  /** Discount % off the retail price, as configured by admin. */
  discountPercent: number;
  /** Minimum monthly volume (in packages) to unlock this tier, if any. */
  minMonthlyVolume: number | null;
}

export interface B2BAgent {
  publicId: string;
  companyName: string;
  contactName: string;
  email: string;
  website: string | null;
  country: string | null;
  iata: string | null;
  status: "pending" | "approved" | "rejected" | "suspended";
  tierKey: string | null;
  /** True when admin has enabled the "send to client email" feature. */
  clientDelivery: boolean;
}

export interface B2BStats {
  orders: number;
  grossMinor: number;
  volumeThisMonth: number;
  currency: SupportedCurrency;
}

export interface B2BCatalogEntry {
  /** Package code from the packages table. */
  code: string;
  name: string;
  dataLabel: string;
  validityLabel: string;
  /** Retail price as the shopper pays, minor units. */
  retailMinor: number;
  /** Tier-adjusted price (retail × (1 − discount)). */
  tierPriceMinor: number;
  currency: SupportedCurrency;
}

interface MeResponse {
  agent: B2BAgent;
  tiers: B2BTier[];
  catalog?: B2BCatalogEntry[];
}

// ---------------------------------------------------------------------------
// Fetch helper (injectable fetcher for tests)
// ---------------------------------------------------------------------------

class B2BApiError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  constructor(code: string, httpStatus: number, message: string) {
    super(message);
    this.name = "B2BApiError";
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
    throw new B2BApiError(
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
      await call<{ publicId: string; status: string }>(fetchImpl, "POST", "/api/b2b/login", {
        email: email.trim(),
        password,
      });
      onSuccess();
    } catch (err) {
      setError({
        code: err instanceof B2BApiError ? err.code : "request_failed",
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
          data-testid="b2b-login-error"
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
        data-testid="b2b-login-submit"
      >
        {busy ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Apply form
// ---------------------------------------------------------------------------

function ApplyForm({
  fetchImpl,
  onSubmitted,
}: {
  fetchImpl: Fetcher;
  onSubmitted: () => void;
}): JSX.Element {
  const [companyName, setCompanyName] = useState("");
  const [contactName, setContactName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [country, setCountry] = useState("");
  const [iata, setIata] = useState("");
  const [website, setWebsite] = useState("");
  const [volume, setVolume] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await call<{ publicId: string; status: string }>(fetchImpl, "POST", "/api/b2b/apply", {
        companyName: companyName.trim(),
        contactName: contactName.trim(),
        email: email.trim(),
        password,
        country: country.trim() || undefined,
        iata: iata.trim() || undefined,
        website: website.trim() || undefined,
        expectedMonthlyVolume: volume ? Number(volume) : undefined,
      });
      onSubmitted();
    } catch (err) {
      setError({
        code: err instanceof B2BApiError ? err.code : "request_failed",
        message: err instanceof Error ? err.message : "Could not submit application.",
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3" noValidate>
      {error && (
        <div
          role="alert"
          className="rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-800 ring-1 ring-rose-200"
          data-testid="b2b-apply-error"
          data-error-code={error.code}
        >
          {error.message}
        </div>
      )}
      <label className="block text-sm">
        <span className="font-medium text-slate-800">Company name</span>
        <input
          value={companyName}
          onChange={(e) => setCompanyName(e.target.value)}
          required
          minLength={2}
          maxLength={120}
          disabled={busy}
          className="mt-1 w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-200 disabled:opacity-60"
        />
      </label>
      <label className="block text-sm">
        <span className="font-medium text-slate-800">Contact name</span>
        <input
          value={contactName}
          onChange={(e) => setContactName(e.target.value)}
          required
          minLength={1}
          maxLength={120}
          disabled={busy}
          className="mt-1 w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-200 disabled:opacity-60"
        />
      </label>
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
          autoComplete="new-password"
          minLength={8}
          required
          disabled={busy}
          className="mt-1 w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-200 disabled:opacity-60"
        />
        <span className="mt-1 block text-[11px] text-slate-500">
          At least 8 characters.
        </span>
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-sm">
          <span className="font-medium text-slate-800">Country (optional)</span>
          <input
            value={country}
            onChange={(e) => setCountry(e.target.value.toUpperCase().slice(0, 2))}
            maxLength={2}
            placeholder="SG"
            disabled={busy}
            className="mt-1 w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm uppercase outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-200 disabled:opacity-60"
          />
        </label>
        <label className="block text-sm">
          <span className="font-medium text-slate-800">IATA number (optional)</span>
          <input
            value={iata}
            onChange={(e) => setIata(e.target.value)}
            maxLength={16}
            disabled={busy}
            className="mt-1 w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-200 disabled:opacity-60"
          />
        </label>
      </div>
      <label className="block text-sm">
        <span className="font-medium text-slate-800">Website (optional)</span>
        <input
          type="url"
          value={website}
          onChange={(e) => setWebsite(e.target.value)}
          placeholder="https://"
          disabled={busy}
          className="mt-1 w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-200 disabled:opacity-60"
        />
      </label>
      <label className="block text-sm">
        <span className="font-medium text-slate-800">Expected monthly volume</span>
        <input
          type="number"
          min={0}
          step={1}
          value={volume}
          onChange={(e) => setVolume(e.target.value)}
          placeholder="e.g. 50"
          disabled={busy}
          className="mt-1 w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-200 disabled:opacity-60"
        />
      </label>
      <button
        type="submit"
        disabled={busy}
        className="w-full rounded-xl bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-60"
        data-testid="b2b-apply-submit"
      >
        {busy ? "Submitting…" : "Apply as travel agent"}
      </button>
      <p className="text-center text-[11px] text-slate-500">
        Applications are reviewed manually. We'll email{" "}
        <span className="font-mono">{email || "your email"}</span> once approved.
      </p>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Bulk order builder
// ---------------------------------------------------------------------------

interface BulkLine {
  packageCode: string;
  quantity: number;
}

function BulkOrderBuilder({
  fetchImpl,
  agent,
  catalog,
  currency,
  onSuccess,
}: {
  fetchImpl: Fetcher;
  agent: B2BAgent;
  catalog: B2BCatalogEntry[];
  currency: SupportedCurrency;
  onSuccess: (url: string) => void;
}): JSX.Element {
  const [lines, setLines] = useState<BulkLine[]>([]);
  const [sendToClients, setSendToClients] = useState(false);
  const [clientEmails, setClientEmails] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);

  const lineByCode = useMemo(() => {
    const map = new Map<string, B2BCatalogEntry>();
    for (const entry of catalog) map.set(entry.code, entry);
    return map;
  }, [catalog]);

  const totalMinor = useMemo(() => {
    let sum = 0;
    for (const line of lines) {
      const entry = lineByCode.get(line.packageCode);
      if (!entry) continue;
      sum += entry.tierPriceMinor * Math.max(0, line.quantity);
    }
    return sum;
  }, [lines, lineByCode]);

  function setLine(code: string, quantity: number): void {
    setLines((prev) => {
      const next = prev.filter((l) => l.packageCode !== code);
      if (quantity > 0) next.push({ packageCode: code, quantity });
      return next;
    });
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (lines.length === 0) {
      setError({ code: "no_lines", message: "Add at least one plan to your order." });
      return;
    }
    const emails = clientEmails
      .split(/[,\s;]+/)
      .map((e) => e.trim())
      .filter((e) => e.length > 0);
    const totalQty = lines.reduce((s, l) => s + l.quantity, 0);
    if (sendToClients && emails.length !== totalQty) {
      setError({
        code: "client_email_count_mismatch",
        message: `Provide one client email per eSIM (${totalQty} needed).`,
      });
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await call<{ checkoutUrl?: string; orderPublicId?: string; status?: string }>(
        fetchImpl,
        "POST",
        "/api/b2b/bulk-order",
        {
          items: lines,
          sendToClients,
          clientEmails: sendToClients ? emails : undefined,
        },
      );
      if (res.checkoutUrl) {
        onSuccess(res.checkoutUrl);
      } else {
        // Server may return an already-fulfilled order (e.g. invoiced account).
        onSuccess(`/order/${res.orderPublicId ?? ""}`);
      }
    } catch (err) {
      setError({
        code: err instanceof B2BApiError ? err.code : "request_failed",
        message: err instanceof Error ? err.message : "Could not start bulk order.",
      });
    } finally {
      setBusy(false);
    }
  }

  const sendDisabled = !agent.clientDelivery;

  return (
    <form
      onSubmit={handleSubmit}
      className="mt-4 space-y-4"
      data-testid="b2b-bulk-order"
      noValidate
    >
      {error && (
        <div
          role="alert"
          className="rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-800 ring-1 ring-rose-200"
          data-testid="b2b-bulk-order-error"
          data-error-code={error.code}
        >
          {error.message}
        </div>
      )}

      {catalog.length === 0 ? (
        <p className="rounded-xl bg-slate-50 px-3 py-2 text-xs text-slate-600 ring-1 ring-slate-200">
          No plans returned by the server. Contact us if this persists.
        </p>
      ) : (
        <div className="overflow-hidden rounded-2xl ring-1 ring-slate-200">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-3 py-2 text-left">Plan</th>
                <th className="px-3 py-2 text-right">Tier price</th>
                <th className="px-3 py-2 text-right">Qty</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 bg-white">
              {catalog.map((entry) => {
                const current = lines.find((l) => l.packageCode === entry.code);
                const qty = current?.quantity ?? 0;
                return (
                  <tr key={entry.code} data-testid={`b2b-catalog-${entry.code}`}>
                    <td className="px-3 py-2">
                      <p className="font-medium text-slate-900">{entry.name}</p>
                      <p className="text-[11px] text-slate-500">
                        {entry.dataLabel} · {entry.validityLabel}
                      </p>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-800">
                      <span className="block text-xs text-slate-400 line-through">
                        {formatMinor(entry.retailMinor, currency)}
                      </span>
                      <span className="block font-semibold">
                        {formatMinor(entry.tierPriceMinor, currency)}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right">
                      <input
                        type="number"
                        min={0}
                        step={1}
                        value={qty === 0 ? "" : qty}
                        onChange={(e) => setLine(entry.code, Number(e.target.value) || 0)}
                        className="w-16 rounded-lg border border-slate-300 px-2 py-1 text-right text-sm"
                        aria-label={`Quantity for ${entry.name}`}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="rounded-2xl bg-slate-50 px-4 py-3 ring-1 ring-slate-200">
        <div className="flex items-center justify-between text-sm">
          <span className="text-slate-600">Order total (tier pricing)</span>
          <span className="font-extrabold text-slate-900" data-testid="b2b-bulk-total">
            {formatMinor(totalMinor, currency)}
          </span>
        </div>
      </div>

      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          checked={sendToClients}
          onChange={(e) => setSendToClients(e.target.checked)}
          disabled={sendDisabled || busy}
          className="mt-1 h-4 w-4"
        />
        <span>
          <span className="font-medium text-slate-800">
            Email each eSIM to my clients
          </span>
          {sendDisabled && (
            <span className="mt-0.5 block text-[11px] text-amber-800">
              Client delivery isn't enabled on your account. Email us to enable it.
            </span>
          )}
        </span>
      </label>

      {sendToClients && !sendDisabled && (
        <label className="block text-sm">
          <span className="font-medium text-slate-800">
            Client emails (one per eSIM)
          </span>
          <textarea
            value={clientEmails}
            onChange={(e) => setClientEmails(e.target.value)}
            rows={3}
            placeholder="alice@example.com, bob@example.com"
            disabled={busy}
            className="mt-1 w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-200 disabled:opacity-60"
          />
        </label>
      )}

      <button
        type="submit"
        disabled={busy || lines.length === 0}
        className="w-full rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-60"
        data-testid="b2b-bulk-order-submit"
      >
        {busy ? "Starting checkout…" : "Continue to checkout"}
      </button>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Tier table
// ---------------------------------------------------------------------------

function TierTable({
  tiers,
  currentKey,
}: {
  tiers: B2BTier[];
  currentKey: string | null;
}): JSX.Element {
  if (tiers.length === 0) {
    return (
      <p className="mt-3 rounded-xl bg-slate-50 px-3 py-2 text-xs text-slate-600 ring-1 ring-slate-200">
        Tiers are still being configured. Your account will be updated once
        approved.
      </p>
    );
  }
  return (
    <div className="mt-3 overflow-hidden rounded-2xl ring-1 ring-slate-200">
      <table className="w-full text-sm">
        <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
          <tr>
            <th className="px-3 py-2 text-left">Tier</th>
            <th className="px-3 py-2 text-right">Discount</th>
            <th className="px-3 py-2 text-right">Min monthly volume</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100 bg-white">
          {tiers.map((tier) => {
            const current = tier.key === currentKey;
            return (
              <tr
                key={tier.key}
                className={current ? "bg-brand-50" : ""}
                data-testid={`b2b-tier-${tier.key}`}
                data-current={current ? "true" : "false"}
              >
                <td className="px-3 py-2 font-medium text-slate-900">
                  {tier.label}
                  {current && (
                    <span className="ml-2 rounded-full bg-brand-600 px-2 py-0.5 text-[10px] font-semibold text-white">
                      You
                    </span>
                  )}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">{tier.discountPercent}%</td>
                <td className="px-3 py-2 text-right tabular-nums text-slate-600">
                  {tier.minMonthlyVolume ?? "—"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
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
  | { status: "ready"; stats: B2BStats }
  | { status: "error"; message: string };

export interface B2BPortalProps {
  fetcher?: Fetcher;
  /** Called instead of window.location.assign when redirecting to checkout. */
  onRedirect?: (url: string) => void;
}

export function B2BPortal({ fetcher, onRedirect }: B2BPortalProps = {}): JSX.Element {
  const fetchImpl: Fetcher = fetcher ?? ((url, init) => fetch(url, init));
  const [me, setMe] = useState<MeState>({ status: "loading" });
  const [stats, setStats] = useState<StatsState>({ status: "idle" });
  const [reloadNonce, setReloadNonce] = useState(0);
  const [view, setView] = useState<"login" | "apply">("login");

  const navigate = (url: string) => {
    if (onRedirect) onRedirect(url);
    else window.location.assign(url);
  };

  useEffect(() => {
    let cancelled = false;
    setMe({ status: "loading" });
    setStats({ status: "idle" });
    call<MeResponse>(fetchImpl, "GET", "/api/b2b/me")
      .then((data) => {
        if (!cancelled) setMe({ status: "ready", me: data });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof B2BApiError && err.httpStatus === 401) {
          setMe({ status: "signed_out" });
          return;
        }
        setMe({
          status: "error",
          code: err instanceof B2BApiError ? err.code : "request_failed",
          message: err instanceof Error ? err.message : "Could not load your portal.",
        });
      });
    return () => {
      cancelled = true;
    };
  }, [fetchImpl, reloadNonce]);

  useEffect(() => {
    if (me.status !== "ready" || me.me.agent.status !== "approved") return;
    let cancelled = false;
    setStats({ status: "loading" });
    call<B2BStats>(fetchImpl, "GET", "/api/b2b/stats")
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
  }, [me, fetchImpl]);

  async function handleLogout() {
    try {
      await call(fetchImpl, "POST", "/api/b2b/logout");
    } catch {
      /* best effort */
    }
    setReloadNonce((n) => n + 1);
  }

  const header = useMemo(
    () => (
      <header className="mb-6">
        <p className="text-xs uppercase tracking-wide text-slate-500">
          {brand.name} · B2B
        </p>
        <h1 className="mt-1 text-2xl font-extrabold text-slate-900">
          Travel agent portal
        </h1>
        <p className="mt-1 max-w-xl text-sm text-slate-600">
          Bulk-order eSIMs at tier pricing, send them straight to your clients,
          and see every instalment on one dashboard.
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
        data-testid="b2b-portal-loading"
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
          data-testid="b2b-portal-error"
          data-error-code={me.code}
        >
          <p className="font-semibold">We couldn't load your portal.</p>
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
        data-testid="b2b-signed-out"
      >
        {header}
        <section className="rounded-2xl bg-white p-5 ring-1 ring-slate-200">
          <div className="flex items-center gap-2 border-b border-slate-200 pb-2">
            <button
              type="button"
              onClick={() => setView("login")}
              className={`rounded-lg px-3 py-1.5 text-sm font-medium ${
                view === "login"
                  ? "bg-brand-50 text-brand-800"
                  : "text-slate-600 hover:bg-slate-50"
              }`}
              data-testid="b2b-tab-login"
            >
              Sign in
            </button>
            <button
              type="button"
              onClick={() => setView("apply")}
              className={`rounded-lg px-3 py-1.5 text-sm font-medium ${
                view === "apply"
                  ? "bg-brand-50 text-brand-800"
                  : "text-slate-600 hover:bg-slate-50"
              }`}
              data-testid="b2b-tab-apply"
            >
              Apply
            </button>
          </div>

          {view === "login" ? (
            <LoginForm
              fetchImpl={fetchImpl}
              onSuccess={() => setReloadNonce((n) => n + 1)}
            />
          ) : (
            <div className="mt-4">
              <ApplyForm
                fetchImpl={fetchImpl}
                onSubmitted={() => {
                  setView("login");
                }}
              />
            </div>
          )}
        </section>
      </main>
    );
  }

  const agent = me.me.agent;

  if (agent.status === "pending") {
    return (
      <main
        className="mx-auto w-full max-w-2xl px-4 pb-16 pt-6"
        data-testid="b2b-pending"
      >
        {header}
        <section className="rounded-2xl bg-amber-50 px-4 py-4 text-sm text-amber-900 ring-1 ring-amber-200">
          <h2 className="font-semibold">Application under review</h2>
          <p className="mt-1">
            Thanks {agent.contactName} from {agent.companyName}. We review
            applications within 1–2 business days and will email{" "}
            {agent.email} once approved.
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

  if (agent.status === "rejected" || agent.status === "suspended") {
    return (
      <main
        className="mx-auto w-full max-w-2xl px-4 pb-16 pt-6"
        data-testid="b2b-inactive"
        data-status={agent.status}
      >
        {header}
        <section className="rounded-2xl bg-slate-100 px-4 py-4 text-sm text-slate-800 ring-1 ring-slate-200">
          <h2 className="font-semibold">
            {agent.status === "rejected" ? "Application not approved" : "Account suspended"}
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

  // ---------- approved ----------
  const catalog = me.me.catalog ?? [];
  const currency: SupportedCurrency =
    stats.status === "ready" ? stats.stats.currency : brand.defaultCurrency;

  return (
    <main
      className="mx-auto w-full max-w-4xl px-4 pb-16 pt-6"
      data-testid="b2b-approved"
    >
      {header}

      <section className="rounded-2xl bg-white p-5 ring-1 ring-slate-200">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <p className="text-sm font-semibold text-slate-900">{agent.companyName}</p>
            <p className="text-xs text-slate-500">
              {agent.contactName} · {agent.email}
              {agent.iata ? ` · IATA ${agent.iata}` : ""}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {agent.tierKey && (
              <span
                className="inline-flex items-center rounded-full bg-brand-50 px-2.5 py-0.5 text-xs font-semibold text-brand-800 ring-1 ring-brand-100"
                data-testid="b2b-current-tier"
              >
                {agent.tierKey.toUpperCase()}
              </span>
            )}
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

      <section className="mt-6" aria-labelledby="b2b-stats-heading">
        <h2
          id="b2b-stats-heading"
          className="text-base font-bold text-slate-900"
        >
          Performance
        </h2>
        {stats.status === "loading" && (
          <div className="mt-3 grid gap-3 sm:grid-cols-3" aria-busy>
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-24 animate-pulse rounded-2xl bg-slate-100" />
            ))}
          </div>
        )}
        {stats.status === "error" && (
          <p
            role="alert"
            className="mt-3 rounded-2xl bg-rose-50 px-4 py-3 text-sm text-rose-800 ring-1 ring-rose-200"
            data-testid="b2b-stats-error"
          >
            {stats.message}
          </p>
        )}
        {stats.status === "ready" && (
          <div className="mt-3 grid gap-3 sm:grid-cols-3" data-testid="b2b-stats">
            <StatTile label="Orders" value={stats.stats.orders.toLocaleString()} />
            <StatTile
              label="Gross sales"
              value={formatMinor(stats.stats.grossMinor, stats.stats.currency)}
            />
            <StatTile
              label="Volume this month"
              value={stats.stats.volumeThisMonth.toLocaleString()}
            />
          </div>
        )}
      </section>

      <section className="mt-8" aria-labelledby="b2b-tiers-heading">
        <h2 id="b2b-tiers-heading" className="text-base font-bold text-slate-900">
          Tier pricing
        </h2>
        <TierTable tiers={me.me.tiers} currentKey={agent.tierKey} />
      </section>

      <section className="mt-8" aria-labelledby="b2b-bulk-heading">
        <h2 id="b2b-bulk-heading" className="text-base font-bold text-slate-900">
          Bulk order
        </h2>
        <BulkOrderBuilder
          fetchImpl={fetchImpl}
          agent={agent}
          catalog={catalog}
          currency={currency}
          onSuccess={(url) => navigate(url)}
        />
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

function StatTile({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="rounded-2xl bg-white p-4 ring-1 ring-slate-200">
      <p className="text-xs uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-1 text-2xl font-extrabold text-slate-900">{value}</p>
    </div>
  );
}

export const __test__ = {
  call,
  formatMinor,
  B2BApiError,
};

export default B2BPortal;

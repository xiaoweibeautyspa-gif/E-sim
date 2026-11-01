/**
 * Admin settings — /admin/settings.
 *
 * Editable commercial knobs, all persisted server-side through:
 *   GET  /api/admin/settings               → { settings: SettingsShape }
 *   PUT  /api/admin/settings               → { settings: SettingsShape } (echo)
 *
 * Fields (grouped in the UI):
 *   - Pricing:      globalMarkupPercent (number), defaultCurrency (already set in
 *                   brand.config; shown read-only here for clarity)
 *   - Traveler Pass: travelerPassPriceMinor, travelerPassCurrency,
 *                   travelerPassDiscountPercent, travelerPassConfigured(bool)
 *   - Conversion:   exitIntentPopupEnabled (bool)
 *
 * HONESTY RULES
 * -------------
 *   - We render server-provided values; when a field is absent from the
 *     response we show it as blank + disabled (never a silent zero).
 *   - Save sends only the fields the user touched and shows the server echo.
 *     If save fails (validation, 403, 503) we surface the server message.
 *   - Discount codes + markup overrides per country live in the DataTables
 *     page and the discount-codes admin (later), not here.
 */
import { useEffect, useState, type FormEvent } from "react";
import { brand, type SupportedCurrency } from "../../server/brand.config";

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

export interface AdminSettings {
  /** Global markup applied to wholesale on the pricing engine. */
  globalMarkupPercent: number | null;
  /** Traveler Pass yearly subscription configuration. */
  travelerPassPriceMinor: number | null;
  travelerPassCurrency: SupportedCurrency | null;
  travelerPassDiscountPercent: number | null;
  travelerPassConfigured: boolean | null;
  /** Toggleable exit-intent discount popup (conversion phase). */
  exitIntentPopupEnabled: boolean | null;
}

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

class SettingsApiError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  constructor(code: string, httpStatus: number, message: string) {
    super(message);
    this.name = "SettingsApiError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

interface ApiOk<T> { ok: true; data: T }
interface ApiErr { ok: false; error: string; message: string }

async function call<T>(fetchImpl: Fetcher, method: "GET" | "PUT", path: string, body?: unknown): Promise<T> {
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
  const json = (await res.json().catch(() => ({}))) as ApiOk<T> | ApiErr | {};
  if (!res.ok || !("ok" in json) || (json as ApiErr).ok === false) {
    const err = json as Partial<ApiErr>;
    throw new SettingsApiError(
      err.error ?? "request_failed",
      res.status,
      err.message ?? `Request failed (HTTP ${res.status}).`,
    );
  }
  return (json as ApiOk<T>).data;
}

function formatMinor(minor: number | null, currency: SupportedCurrency | null): string {
  if (minor == null || !currency) return "—";
  const zeroDecimal = currency === "VND";
  const major = zeroDecimal ? minor : minor / 100;
  const body = zeroDecimal
    ? Math.round(major).toLocaleString("en-US")
    : major.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${body} ${currency}`;
}

// ---------------------------------------------------------------------------
// Field wrapper
// ---------------------------------------------------------------------------

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <label className="block text-sm">
      <span className="font-medium text-slate-800">{label}</span>
      {children}
      {hint && <span className="mt-0.5 block text-[11px] text-slate-500">{hint}</span>}
    </label>
  );
}

const inputClass =
  "mt-1 w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-200 disabled:opacity-60";

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

type LoadState =
  | { status: "loading" }
  | { status: "ready"; settings: AdminSettings }
  | { status: "error"; code: string; message: string; httpStatus: number };

export interface AdminSettingsProps {
  fetcher?: Fetcher;
}

export function AdminSettings({ fetcher }: AdminSettingsProps = {}): JSX.Element {
  const fetchImpl: Fetcher = fetcher ?? ((url, init) => fetch(url, init));
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [reloadNonce, setReloadNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    call<{ settings: AdminSettings }>(fetchImpl, "GET", "/api/admin/settings")
      .then((d) => {
        if (!cancelled) setState({ status: "ready", settings: d.settings });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState({
          status: "error",
          code: err instanceof SettingsApiError ? err.code : "request_failed",
          httpStatus: err instanceof SettingsApiError ? err.httpStatus : 0,
          message: err instanceof Error ? err.message : "Could not load settings.",
        });
      });
    return () => {
      cancelled = true;
    };
  }, [fetchImpl, reloadNonce]);

  return (
    <main className="mx-auto w-full max-w-3xl px-4 pb-16 pt-6" data-testid="admin-settings-page">
      <header className="mb-6">
        <p className="text-xs uppercase tracking-wide text-slate-500">
          {brand.name} · Admin
        </p>
        <h1 className="mt-1 text-2xl font-extrabold text-slate-900">Settings</h1>
        <p className="mt-1 max-w-xl text-sm text-slate-600">
          Commercial knobs. Changes take effect on the next pricing run; supplier
          credentials live in Secrets, not here.
        </p>
      </header>

      {state.status === "loading" && (
        <div className="space-y-3" aria-busy>
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-40 animate-pulse rounded-2xl bg-slate-100" />
          ))}
        </div>
      )}

      {state.status === "error" && (
        <div
          role="alert"
          className="rounded-2xl bg-rose-50 px-4 py-3 text-sm text-rose-800 ring-1 ring-rose-200"
          data-testid="admin-settings-error"
          data-error-code={state.code}
        >
          <p className="font-semibold">
            {state.httpStatus === 401 || state.httpStatus === 403
              ? "You don't have access to admin settings."
              : "We couldn't load settings."}
          </p>
          <p className="mt-1">{state.message}</p>
          <button
            type="button"
            onClick={() => setReloadNonce((n) => n + 1)}
            className="mt-3 rounded-lg bg-rose-600 px-3 py-1.5 font-medium text-white hover:bg-rose-700"
          >
            Try again
          </button>
        </div>
      )}

      {state.status === "ready" && (
        <SettingsForm
          fetchImpl={fetchImpl}
          initial={state.settings}
          onSaved={() => setReloadNonce((n) => n + 1)}
        />
      )}

      <nav className="mt-8 flex flex-wrap gap-3 text-sm">
        <a href="/admin" className="rounded-xl border border-slate-300 bg-white px-4 py-2 font-medium text-slate-700 hover:bg-slate-50">
          Dashboard
        </a>
        <a href="/admin/orders" className="rounded-xl border border-slate-300 bg-white px-4 py-2 font-medium text-slate-700 hover:bg-slate-50">
          Orders
        </a>
        <a href="/admin/data-tables" className="rounded-xl border border-slate-300 bg-white px-4 py-2 font-medium text-slate-700 hover:bg-slate-50">
          Data tables
        </a>
      </nav>
    </main>
  );
}

// ---------------------------------------------------------------------------
// Form (separate component so it can freely own local draft state)
// ---------------------------------------------------------------------------

function SettingsForm({
  fetchImpl,
  initial,
  onSaved,
}: {
  fetchImpl: Fetcher;
  initial: AdminSettings;
  onSaved: () => void;
}): JSX.Element {
  const [markup, setMarkup] = useState(initial.globalMarkupPercent?.toString() ?? "");
  const [passPrice, setPassPrice] = useState(
    initial.travelerPassPriceMinor != null
      ? String(
          initial.travelerPassCurrency === "VND"
            ? initial.travelerPassPriceMinor
            : initial.travelerPassPriceMinor / 100,
        )
      : "",
  );
  const [passCurrency, setPassCurrency] = useState<SupportedCurrency>(
    initial.travelerPassCurrency ?? brand.defaultCurrency,
  );
  const [passDiscount, setPassDiscount] = useState(
    initial.travelerPassDiscountPercent?.toString() ?? "",
  );
  const [passConfigured, setPassConfigured] = useState(initial.travelerPassConfigured ?? false);
  const [popup, setPopup] = useState(initial.exitIntentPopupEnabled ?? false);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      // Convert major→minor for the price (VND is zero-decimal).
      const priceMinor =
        passPrice.trim() === ""
          ? null
          : passCurrency === "VND"
            ? Math.round(Number(passPrice))
            : Math.round(Number(passPrice) * 100);
      const payload: Partial<AdminSettings> = {
        globalMarkupPercent: markup.trim() === "" ? null : Number(markup),
        travelerPassPriceMinor: priceMinor,
        travelerPassCurrency: passCurrency,
        travelerPassDiscountPercent:
          passDiscount.trim() === "" ? null : Number(passDiscount),
        travelerPassConfigured: passConfigured,
        exitIntentPopupEnabled: popup,
      };
      await call<{ settings: AdminSettings }>(
        fetchImpl,
        "PUT",
        "/api/admin/settings",
        payload,
      );
      setSavedAt(new Date().toISOString());
      onSaved();
    } catch (err) {
      setError({
        code: err instanceof SettingsApiError ? err.code : "request_failed",
        message: err instanceof Error ? err.message : "Could not save settings.",
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(e) => void handleSubmit(e)} className="space-y-6" noValidate>
      {error && (
        <div
          role="alert"
          className="rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-800 ring-1 ring-rose-200"
          data-testid="admin-settings-save-error"
          data-error-code={error.code}
        >
          {error.message}
        </div>
      )}
      {savedAt && (
        <p
          className="rounded-xl bg-emerald-50 px-3 py-2 text-sm text-emerald-800 ring-1 ring-emerald-200"
          data-testid="admin-settings-saved"
        >
          Saved at {new Date(savedAt).toLocaleTimeString()}.
        </p>
      )}

      {/* Pricing */}
      <section className="rounded-2xl bg-white p-5 ring-1 ring-slate-200">
        <h2 className="text-base font-bold text-slate-900">Pricing</h2>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <Field
            label="Global markup (%)"
            hint="Retail = wholesale × (1 + markup%). Per-country overrides live in Data tables."
          >
            <input
              type="number"
              step="0.1"
              min="0"
              value={markup}
              onChange={(e) => setMarkup(e.target.value)}
              disabled={busy}
              className={inputClass}
              data-testid="admin-settings-markup"
            />
          </Field>
          <Field label="Display currency" hint="Storefront default (from brand config).">
            <input
              type="text"
              value={brand.defaultCurrency}
              readOnly
              disabled
              className={inputClass}
            />
          </Field>
        </div>
      </section>

      {/* Traveler Pass */}
      <section className="rounded-2xl bg-white p-5 ring-1 ring-slate-200">
        <h2 className="text-base font-bold text-slate-900">Traveler Pass</h2>
        <p className="mt-1 text-xs text-slate-500">
          Current price:{" "}
          <span className="font-semibold text-slate-700">
            {formatMinor(initial.travelerPassPriceMinor, initial.travelerPassCurrency)}
          </span>
        </p>
        <div className="mt-4 grid gap-4 sm:grid-cols-3">
          <Field label="Yearly price" hint="Major units (e.g. 29 = 29 SGD).">
            <input
              type="number"
              step={passCurrency === "VND" ? "1" : "0.01"}
              min="0"
              value={passPrice}
              onChange={(e) => setPassPrice(e.target.value)}
              disabled={busy}
              className={inputClass}
              data-testid="admin-settings-pass-price"
            />
          </Field>
          <Field label="Currency">
            <select
              value={passCurrency}
              onChange={(e) => setPassCurrency(e.target.value as SupportedCurrency)}
              disabled={busy}
              className={inputClass}
              data-testid="admin-settings-pass-currency"
            >
              {brand.currencies.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Member discount (%)">
            <input
              type="number"
              step="1"
              min="0"
              max="99"
              value={passDiscount}
              onChange={(e) => setPassDiscount(e.target.value)}
              disabled={busy}
              className={inputClass}
              data-testid="admin-settings-pass-discount"
            />
          </Field>
        </div>
        <label className="mt-4 flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={passConfigured}
            onChange={(e) => setPassConfigured(e.target.checked)}
            disabled={busy}
            data-testid="admin-settings-pass-configured"
          />
          <span className="font-medium text-slate-800">
            Traveler Pass is purchasable
          </span>
        </label>
        <p className="mt-1 text-[11px] text-slate-500">
          Leave unchecked until the Stripe price ID is set. The public page shows an
          "unavailable" notice while this is off.
        </p>
      </section>

      {/* Conversion */}
      <section className="rounded-2xl bg-white p-5 ring-1 ring-slate-200">
        <h2 className="text-base font-bold text-slate-900">Conversion</h2>
        <label className="mt-3 flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={popup}
            onChange={(e) => setPopup(e.target.checked)}
            disabled={busy}
            data-testid="admin-settings-exit-popup"
          />
          <span className="font-medium text-slate-800">
            Show exit-intent discount popup to first-time visitors
          </span>
        </label>
      </section>

      <div className="flex justify-end">
        <button
          type="submit"
          disabled={busy}
          className="rounded-xl bg-brand-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-60"
          data-testid="admin-settings-save"
        >
          {busy ? "Saving…" : "Save settings"}
        </button>
      </div>
    </form>
  );
}

export const __test__ = { formatMinor };

export default AdminSettings;

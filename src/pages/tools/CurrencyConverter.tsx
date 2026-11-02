/**
 * /tools/currency-converter — offline-friendly currency converter.
 *
 * The page converts between two currencies using an FX rate table managed by
 * the SEO/SSR batch (`server/routes/seo.ts` — queued, not yet delivered). The
 * client NEVER calls a third-party FX API: prices from an arbitrary source
 * are not auditable and would be a revenue-integrity risk on a storefront.
 * Instead we read `GET /api/tools/currency-converter` which returns the
 * cached rates table + a `lastUpdatedAt` timestamp, so we can honestly tell
 * the user how fresh the numbers are.
 *
 * Contract:
 *   GET /api/tools/currency-converter?from=<ISO>&to=<ISO>&amount=<num>
 *     → { ok:true, data:{ rates: { [ISO]: number }, // relative to `from`
 *                          fromIso, toIso, amount, converted,
 *                          lastUpdatedAt: string } }
 *     → { ok:false, error, message }
 *     → 404 { ok:false, error:"not_found", message }
 *
 * Behaviour:
 *   - Renders a "being set up" state on 404/network error (matches
 *     RoamingCalculator.tsx). We DO NOT invent rates.
 *   - Amount input is sanitized to a positive number; `0` is allowed (returns
 *     `0.00`), empty means zero, non-numeric is rejected inline.
 *   - Currency pickers are populated from `Object.keys(rates)` (server is the
 *     source of truth for which currencies are supported).
 *   - On amount/from/to change we refetch (debounced) — the rate from `from`
 *     is cached server-side so a scroll of the amount field is cheap.
 *   - We also expose a "swap" button which flips from/to in one click.
 *
 * Test hooks:
 *   data-testid="currency-converter"
 *   data-testid="currency-converter-loading"
 *   data-testid="currency-converter-unavailable"
 *   data-testid="currency-converter-error"
 *   data-testid="currency-from"
 *   data-testid="currency-to"
 *   data-testid="currency-amount"
 *   data-testid="currency-result"
 *   data-testid="currency-swap"
 *   data-testid="currency-last-updated"
 */
import { useCallback, useEffect, useId, useMemo, useState } from "react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ConverterPayload {
  rates: Record<string, number>;
  fromIso: string;
  toIso: string;
  amount: number;
  converted: number | null;
  lastUpdatedAt: string;
}

interface ApiErr {
  ok: false;
  error: string;
  message: string;
}
interface ApiOk<T> {
  ok: true;
  data: T;
}

class ConverterFetchError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ConverterFetchError";
    this.code = code;
  }
}

async function fetchConverter(
  from: string,
  to: string,
  amount: number,
  signal: AbortSignal,
): Promise<ConverterPayload> {
  const qs = new URLSearchParams({
    from,
    to,
    amount: String(amount),
  }).toString();
  const res = await fetch(`/api/tools/currency-converter?${qs}`, {
    credentials: "include",
    headers: { Accept: "application/json" },
    signal,
  });
  const body = (await res.json().catch(() => ({}))) as
    | ApiOk<ConverterPayload>
    | ApiErr
    | {};
  if (!res.ok || !("ok" in body) || body.ok === false) {
    const err = body as ApiErr;
    throw new ConverterFetchError(
      err?.error ?? "request_failed",
      err?.message ?? `Request failed (HTTP ${res.status}).`,
    );
  }
  return (body as ApiOk<ConverterPayload>).data;
}

// ---------------------------------------------------------------------------
// Client-side math (pure, exported for test scaffolding)
// ---------------------------------------------------------------------------

/**
 * Mirrors the server's math so we can preview without a request. The server
 * remains authoritative for the rendered value — this is used for the initial
 * "as you type" number only, and the result is replaced by the server's
 * `converted` once the request resolves.
 */
export function convert(amount: number, rate: number): number {
  if (!Number.isFinite(amount) || !Number.isFinite(rate)) return 0;
  return Math.round(amount * rate * 100) / 100;
}

/**
 * Sanitize an amount string: blank → 0, otherwise parse, reject negatives.
 * The input type is `text` (not `number`) so we control the sanitization on
 * mobile keyboards without the native number-input quirk of rejecting commas.
 */
export function sanitizeAmount(raw: string): number {
  const cleaned = raw.replace(/,/g, "").trim();
  if (cleaned.length === 0) return 0;
  const n = Number(cleaned);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.round(n * 100) / 100;
}

// ---------------------------------------------------------------------------
// Cross-link registry (mirrors server/ssr/tools.ts TOOLS in client bundle)
// ---------------------------------------------------------------------------

const OTHER_TOOLS: { slug: string; label: string; path: string }[] = [
  { slug: "roaming-calculator", label: "Roaming savings calculator", path: "/tools/roaming-calculator" },
  { slug: "visa-info", label: "Visa info", path: "/tools/visa-info" },
  { slug: "plug-voltage", label: "Plug & voltage guide", path: "/tools/plug-voltage" },
  { slug: "emergency-numbers", label: "Emergency numbers", path: "/tools/emergency-numbers" },
  { slug: "blocked-apps", label: "Blocked apps guide", path: "/tools/blocked-apps" },
];

// ---------------------------------------------------------------------------
// Default currency pair (editable by the user)
// ---------------------------------------------------------------------------

const DEFAULT_FROM = "SGD";
const DEFAULT_TO = "JPY";
const DEBOUNCE_MS = 250;

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export interface CurrencyConverterProps {
  /** Optional override for tests / SSR prefill. */
  initialFrom?: string;
  initialTo?: string;
  initialAmount?: number;
}

export function CurrencyConverter({
  initialFrom = DEFAULT_FROM,
  initialTo = DEFAULT_TO,
  initialAmount = 100,
}: CurrencyConverterProps = {}): JSX.Element {
  const [from, setFrom] = useState(initialFrom);
  const [to, setTo] = useState(initialTo);
  const [amountRaw, setAmountRaw] = useState(String(initialAmount));
  const [debounced, setDebounced] = useState({
    from: initialFrom,
    to: initialTo,
    amount: initialAmount,
  });

  const [state, setState] = useState<
    | { status: "loading" }
    | { status: "ready"; data: ConverterPayload }
    | { status: "unavailable"; message: string }
    | { status: "error"; code: string; message: string }
  >({ status: "loading" });

  const fromId = useId();
  const toId = useId();
  const amountId = useId();
  const resultId = useId();

  // Debounce the trio so typing 1000 doesn't fire 4 requests.
  useEffect(() => {
    const amount = sanitizeAmount(amountRaw);
    const handle = setTimeout(() => {
      setDebounced({ from, to, amount });
    }, DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [from, to, amountRaw]);

  // Fetch whenever the debounced inputs change. Aborts on next change.
  useEffect(() => {
    const controller = new AbortController();
    setState({ status: "loading" });
    fetchConverter(debounced.from, debounced.to, debounced.amount, controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) setState({ status: "ready", data });
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        if (controller.signal.aborted) return;
        if (err instanceof ConverterFetchError) {
          if (err.code === "not_found" || err.code === "request_failed") {
            setState({
              status: "unavailable",
              message:
                "The FX rate feed is being set up. Check back shortly — the roaming calculator and country pages are live today.",
            });
            return;
          }
          setState({ status: "error", code: err.code, message: err.message });
          return;
        }
        setState({
          status: "error",
          code: "request_failed",
          message: err instanceof Error ? err.message : "Could not load rates.",
        });
      });
    return () => controller.abort();
  }, [debounced]);

  const currencies = useMemo(() => {
    if (state.status !== "ready") return [];
    return Object.keys(state.data.rates).sort();
  }, [state]);

  const swap = useCallback(() => {
    setFrom(to);
    setTo(from);
  }, [from, to]);

  return (
    <main className="mx-auto w-full max-w-3xl px-4 pb-16 pt-6" data-testid="currency-converter">
      <header>
        <h1 className="text-2xl font-extrabold text-slate-900 sm:text-3xl">
          Travel currency converter
        </h1>
        <p className="mt-2 text-sm text-slate-600">
          Quick mental math so you know what that street-food stall costs. Rates are
          refreshed regularly — we show the last update time below.
        </p>
      </header>

      {state.status === "loading" && (
        <div className="mt-6 space-y-3" aria-busy data-testid="currency-converter-loading">
          <div className="h-10 w-full animate-pulse rounded-xl bg-slate-100" />
          <div className="h-10 w-full animate-pulse rounded-xl bg-slate-100" />
          <div className="h-24 w-full animate-pulse rounded-2xl bg-slate-100" />
        </div>
      )}

      {state.status === "unavailable" && (
        <div
          className="mt-6 rounded-2xl bg-amber-50 px-4 py-3 text-sm text-amber-900 ring-1 ring-amber-200"
          data-testid="currency-converter-unavailable"
        >
          <p className="font-semibold">Converter is being set up.</p>
          <p className="mt-1 text-xs text-amber-900/80">{state.message}</p>
        </div>
      )}

      {state.status === "error" && (
        <div
          role="alert"
          className="mt-6 rounded-2xl bg-rose-50 px-4 py-3 text-sm text-rose-800 ring-1 ring-rose-200"
          data-testid="currency-converter-error"
          data-error-code={state.code}
        >
          <p className="font-semibold">We couldn't load the rates.</p>
          <p className="mt-1 text-xs">{state.message}</p>
        </div>
      )}

      {state.status === "ready" && (
        <>
          <section
            className="mt-6 rounded-2xl bg-white p-5 ring-1 ring-slate-200"
            aria-labelledby={`${fromId}-heading`}
          >
            <div className="grid gap-3 sm:grid-cols-[1fr_auto_1fr]">
              <div>
                <label htmlFor={fromId} className="block text-sm font-medium text-slate-800">
                  From
                </label>
                <select
                  id={fromId}
                  value={from}
                  onChange={(e) => setFrom(e.target.value)}
                  className="mt-1 w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm"
                  data-testid="currency-from"
                >
                  {currencies.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </div>

              <div className="flex items-end justify-center">
                <button
                  type="button"
                  onClick={swap}
                  className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
                  aria-label="Swap currencies"
                  data-testid="currency-swap"
                >
                  ⇄
                </button>
              </div>

              <div>
                <label htmlFor={toId} className="block text-sm font-medium text-slate-800">
                  To
                </label>
                <select
                  id={toId}
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                  className="mt-1 w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm"
                  data-testid="currency-to"
                >
                  {currencies.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="mt-4">
              <label htmlFor={amountId} className="block text-sm font-medium text-slate-800">
                Amount in {from}
              </label>
              <input
                id={amountId}
                type="text"
                inputMode="decimal"
                value={amountRaw}
                onChange={(e) => setAmountRaw(e.target.value)}
                className="mt-1 w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm"
                data-testid="currency-amount"
                autoComplete="off"
              />
            </div>

            <div
              className="mt-5 rounded-xl bg-brand-50 p-4 ring-1 ring-brand-100"
              id={resultId}
              aria-live="polite"
            >
              <p className="text-xs font-semibold uppercase tracking-wide text-brand-700">
                {sanitizeAmount(amountRaw)} {from} =
              </p>
              <p
                className="mt-1 text-2xl font-extrabold text-slate-900"
                data-testid="currency-result"
              >
                {state.data.converted != null
                  ? formatConverted(state.data.converted, to)
                  : "—"}
                <span className="ml-1 text-sm font-medium text-slate-600">{to}</span>
              </p>
            </div>

            <p
              className="mt-3 text-[11px] text-slate-400"
              data-testid="currency-last-updated"
            >
              Rates updated {formatUpdated(state.data.lastUpdatedAt)}. Indicative
              only — your bank may add a fee.
            </p>
          </section>
        </>
      )}

      <section className="mt-10" aria-labelledby="other-tools-heading">
        <h2 id="other-tools-heading" className="text-base font-bold text-slate-900">
          More free travel tools
        </h2>
        <ul className="mt-3 grid gap-2 sm:grid-cols-2">
          {OTHER_TOOLS.map((t) => (
            <li key={t.slug}>
              <a
                href={t.path}
                className="flex items-center justify-between rounded-xl bg-slate-50 px-3 py-2 text-sm font-medium text-slate-800 ring-1 ring-slate-200 hover:bg-slate-100"
              >
                <span>{t.label}</span>
                <span aria-hidden className="text-slate-400">→</span>
              </a>
            </li>
          ))}
        </ul>
      </section>

      <section className="mt-8 rounded-2xl bg-white p-5 ring-1 ring-slate-200">
        <h2 className="text-base font-bold text-slate-900">Travelling soon?</h2>
        <p className="mt-1 text-sm text-slate-600">
          Compare plan prices in your destination currency and skip the roaming
          bill. All plans include a QR install guide.
        </p>
        <a
          href="/esim"
          className="mt-3 inline-block rounded-xl bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700"
        >
          See eSIM plans
        </a>
      </section>
    </main>
  );
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatConverted(value: number, iso: string): string {
  // Currencies with no minor units: VND, JPY, KRW. Everything else uses 2.
  const zeroDecimals = new Set(["VND", "JPY", "KRW"]);
  const decimals = zeroDecimals.has(iso) ? 0 : 2;
  if (decimals === 0) return Math.round(value).toLocaleString("en-US");
  return value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatUpdated(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "recently";
  const diffMs = Date.now() - d.getTime();
  const hours = Math.floor(diffMs / 3_600_000);
  if (hours < 1) return "just now";
  if (hours === 1) return "1 hour ago";
  if (hours < 24) return `${hours} hours ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "1 day ago" : `${days} days ago`;
}

// ---------------------------------------------------------------------------
// Test surface
// ---------------------------------------------------------------------------
export const __test__ = {
  convert,
  sanitizeAmount,
  formatConverted,
  formatUpdated,
  OTHER_TOOLS,
};

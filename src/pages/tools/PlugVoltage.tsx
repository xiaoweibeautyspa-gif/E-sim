/**
 * /tools/plug-voltage — plug types and voltage by country.
 *
 * Reads a country-keyed reference table managed by the SEO/SSR batch
 * (`server/routes/seo.ts` — queued). No hardcoded plug/voltage data in the
 * client because a wrong plug type at the airport is a real-world failure;
 * admin must be able to fix it without a redeploy.
 *
 * Contract:
 *   GET /api/tools/plug-voltage?q=<country-or-slug>
 *     → { ok:true, data:{ results: PlugVoltageCountry[] } }
 *     → { ok:false, error, message }
 *     → 404 { ok:false, error:"not_found", message }
 *
 *   PlugVoltageCountry:
 *     {
 *       countrySlug: string;       // e.g. "jp"
 *       countryName: string;       // e.g. "Japan"
 *       plugTypes: string[];       // e.g. ["A","B"]
 *       voltage: number;           // e.g. 100
 *       frequencyHz: number;       // e.g. 50 | 60
 *       notes: string | null;      // e.g. "Tokyo is 50Hz, Osaka is 60Hz"
 *     }
 *
 * Behaviour:
 *   - Search box with debounce; empty query fetches a small "popular
 *     destinations" default set from the server (same endpoint, empty `q`).
 *   - Each result card can link to that country's eSIM page
 *     (`/esim/<slug>`).
 *   - Renders an honest "being set up" state on 404, matching the pattern in
 *     RoamingCalculator.tsx and CurrencyConverter.tsx.
 *   - A static "adapter basics" explainer is always visible, because it's
 *     general knowledge (adapter vs converter) not country-specific data.
 */
import { useEffect, useId, useMemo, useState } from "react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PlugVoltageCountry {
  countrySlug: string;
  countryName: string;
  plugTypes: string[];
  voltage: number;
  frequencyHz: number;
  notes: string | null;
}

interface PlugVoltagePayload {
  results: PlugVoltageCountry[];
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

class PlugFetchError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "PlugFetchError";
    this.code = code;
  }
}

async function fetchPlugVoltage(q: string, signal: AbortSignal): Promise<PlugVoltagePayload> {
  const qs = q.trim() ? `?q=${encodeURIComponent(q.trim())}` : "";
  const res = await fetch(`/api/tools/plug-voltage${qs}`, {
    credentials: "include",
    headers: { Accept: "application/json" },
    signal,
  });
  const body = (await res.json().catch(() => ({}))) as
    | ApiOk<PlugVoltagePayload>
    | ApiErr
    | {};
  if (!res.ok || !("ok" in body) || body.ok === false) {
    const err = body as ApiErr;
    throw new PlugFetchError(
      err?.error ?? "request_failed",
      err?.message ?? `Request failed (HTTP ${res.status}).`,
    );
  }
  return (body as ApiOk<PlugVoltagePayload>).data;
}

// ---------------------------------------------------------------------------
// Cross-link registry
// ---------------------------------------------------------------------------

const OTHER_TOOLS: { slug: string; label: string; path: string }[] = [
  { slug: "roaming-calculator", label: "Roaming savings calculator", path: "/tools/roaming-calculator" },
  { slug: "visa-info", label: "Visa info", path: "/tools/visa-info" },
  { slug: "currency-converter", label: "Currency converter", path: "/tools/currency-converter" },
  { slug: "emergency-numbers", label: "Emergency numbers", path: "/tools/emergency-numbers" },
  { slug: "blocked-apps", label: "Blocked apps guide", path: "/tools/blocked-apps" },
];

const DEBOUNCE_MS = 250;

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function PlugVoltage(): JSX.Element {
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [state, setState] = useState<
    | { status: "loading" }
    | { status: "ready"; data: PlugVoltagePayload }
    | { status: "unavailable"; message: string }
    | { status: "error"; code: string; message: string }
  >({ status: "loading" });

  const inputId = useId();

  useEffect(() => {
    const handle = setTimeout(() => setDebouncedQuery(query.trim()), DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [query]);

  useEffect(() => {
    const controller = new AbortController();
    setState({ status: "loading" });
    fetchPlugVoltage(debouncedQuery, controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) setState({ status: "ready", data });
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        if (controller.signal.aborted) return;
        if (err instanceof PlugFetchError) {
          if (err.code === "not_found" || err.code === "request_failed") {
            setState({
              status: "unavailable",
              message:
                "The plug & voltage table is being set up. The adapter basics below are still useful — check the wall label when you land.",
            });
            return;
          }
          setState({ status: "error", code: err.code, message: err.message });
          return;
        }
        setState({
          status: "error",
          code: "request_failed",
          message: err instanceof Error ? err.message : "Could not load data.",
        });
      });
    return () => controller.abort();
  }, [debouncedQuery]);

  const results = useMemo(() => (state.status === "ready" ? state.data.results : []), [state]);

  return (
    <main className="mx-auto w-full max-w-3xl px-4 pb-16 pt-6" data-testid="plug-voltage">
      <header>
        <h1 className="text-2xl font-extrabold text-slate-900 sm:text-3xl">
          Plug &amp; voltage guide
        </h1>
        <p className="mt-2 text-sm text-slate-600">
          Which wall adapter do you need for your trip? Type a country — we'll show the
          plug types, voltage and frequency. Bring a universal adapter if you're visiting
          several countries; most modern chargers are dual-voltage (100–240V).
        </p>
      </header>

      <div className="mt-6">
        <label htmlFor={inputId} className="block text-sm font-medium text-slate-800">
          Country
          <span className="ml-1 text-xs font-normal text-slate-500">
            (leave blank to see popular destinations)
          </span>
        </label>
        <input
          id={inputId}
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="e.g. Japan, Vietnam, United Kingdom"
          autoComplete="off"
          className="mt-1 w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-200"
          data-testid="plug-voltage-search"
        />
      </div>

      <section className="mt-6" aria-live="polite">
        {state.status === "loading" && (
          <div className="space-y-3" aria-busy data-testid="plug-voltage-loading">
            {[0, 1].map((i) => (
              <div key={i} className="h-24 animate-pulse rounded-2xl bg-slate-100" />
            ))}
          </div>
        )}

        {state.status === "unavailable" && (
          <div
            className="rounded-2xl bg-amber-50 px-4 py-3 text-sm text-amber-900 ring-1 ring-amber-200"
            data-testid="plug-voltage-unavailable"
          >
            <p className="font-semibold">Plug data is being set up.</p>
            <p className="mt-1 text-xs text-amber-900/80">{state.message}</p>
          </div>
        )}

        {state.status === "error" && (
          <div
            role="alert"
            className="rounded-2xl bg-rose-50 px-4 py-3 text-sm text-rose-800 ring-1 ring-rose-200"
            data-testid="plug-voltage-error"
            data-error-code={state.code}
          >
            <p className="font-semibold">We couldn't load plug data.</p>
            <p className="mt-1 text-xs">{state.message}</p>
          </div>
        )}

        {state.status === "ready" && results.length === 0 && (
          <p
            className="rounded-2xl bg-slate-50 px-4 py-3 text-sm text-slate-600 ring-1 ring-slate-200"
            data-testid="plug-voltage-empty"
          >
            No country matched &ldquo;{debouncedQuery}&rdquo;. Try the English name or
            the two-letter code (e.g. &ldquo;JP&rdquo;).
          </p>
        )}

        {state.status === "ready" && results.length > 0 && (
          <ul className="space-y-3">
            {results.map((c) => (
              <PlugCard key={c.countrySlug} country={c} />
            ))}
          </ul>
        )}
      </section>

      <section
        className="mt-8 rounded-2xl bg-white p-5 ring-1 ring-slate-200"
        aria-labelledby="adapter-basics-heading"
      >
        <h2 id="adapter-basics-heading" className="text-base font-bold text-slate-900">
          Adapter vs converter — what do you actually need?
        </h2>
        <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-slate-700">
          <li>
            <strong>Adapter</strong> changes the shape of the plug. Required whenever
            the destination&rsquo;s socket doesn&rsquo;t match your plug.
          </li>
          <li>
            <strong>Converter</strong> changes the voltage. Most laptops, phones and
            camera chargers are dual-voltage (look for “100–240V” on the brick), so you
            only need a converter for single-voltage appliances like hair dryers.
          </li>
          <li>
            <strong>Frequency</strong> (50Hz vs 60Hz) rarely matters for
            electronics with a power brick. It matters for analog clocks and some
            appliances — check before you pack a motorised device.
          </li>
          <li>
            Bring a universal adapter if you&rsquo;re visiting several countries with
            different plugs — otherwise the collection of single-country adapters adds
            up fast.
          </li>
        </ul>
      </section>

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
    </main>
  );
}

// ---------------------------------------------------------------------------
// Card
// ---------------------------------------------------------------------------

function PlugCard({ country }: { country: PlugVoltageCountry }): JSX.Element {
  return (
    <li
      className="rounded-2xl bg-white p-4 ring-1 ring-slate-200"
      data-testid={`plug-voltage-card-${country.countrySlug}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-bold text-slate-900">{country.countryName}</h3>
          <p className="mt-0.5 text-xs text-slate-500">
            {country.frequencyHz} Hz
            {country.notes ? ` · ${country.notes}` : ""}
          </p>
        </div>
        <a
          href={`/esim/${country.countrySlug}`}
          className="whitespace-nowrap rounded-xl bg-brand-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-700"
          data-testid={`plug-voltage-esim-${country.countrySlug}`}
        >
          Get eSIM
        </a>
      </div>

      <dl className="mt-3 grid grid-cols-2 gap-3 text-sm">
        <div>
          <dt className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
            Plug types
          </dt>
          <dd
            className="mt-0.5 flex flex-wrap gap-1"
            data-testid={`plug-voltage-types-${country.countrySlug}`}
          >
            {country.plugTypes.length === 0 ? (
              <span className="text-slate-500">—</span>
            ) : (
              country.plugTypes.map((p) => (
                <span
                  key={p}
                  className="inline-flex h-6 min-w-6 items-center justify-center rounded-md bg-slate-100 px-1.5 text-xs font-semibold text-slate-800 ring-1 ring-slate-200"
                >
                  {p}
                </span>
              ))
            )}
          </dd>
        </div>
        <div>
          <dt className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
            Voltage
          </dt>
          <dd
            className="mt-0.5 text-sm font-semibold text-slate-900"
            data-testid={`plug-voltage-voltage-${country.countrySlug}`}
          >
            {country.voltage} V
          </dd>
        </div>
      </dl>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Test surface
// ---------------------------------------------------------------------------
export const __test__ = {
  OTHER_TOOLS,
};

/**
 * /tools/emergency-numbers — police, ambulance, and fire numbers.
 *
 * Reads a country-keyed table from `GET /api/tools/emergency-numbers?q=<country-or-slug>`
 * (endpoint delivered by the SEO/SSR batch — queued). No hardcoded emergency
 * numbers in the client: an emergency number must be correct, and admin
 * needs to be able to change it without a shipment.
 *
 * Contract:
 *   GET /api/tools/emergency-numbers?q=<country-or-slug>
 *     → { ok:true, data:{ results: EmergencyCountry[] } }
 *     → { ok:false, error, message }
 *     → 404 { ok:false, error:"not_found", message }
 *
 *   EmergencyCountry:
 *     {
 *       countrySlug: string;
 *       countryName: string;
 *       general: string | null;   // e.g. "112" (EU)
 *       police: string | null;
 *       ambulance: string | null;
 *       fire: string | null;
 *       touristPolice: string | null;
 *       notes: string | null;      // e.g. "English-speaking operators available"
 *     }
 *
 * Behaviour:
 *   - Search box with debounce.
 *   - Each number is a `tel:` link so it dials on mobile.
 *   - "Add to contacts" is intentionally NOT wired here (vCard download is a
 *     nice-to-have that would expand scope; a later enhancement).
 *   - Shows a permanent "read this first" notice with general safety guidance
 *     (embassy, travel insurance, 112 fallback). General knowledge is safe
 *     to ship in the client. Country-specific numbers come from the server.
 *   - Cross-links the other free tools + a buy CTA.
 */
import { useEffect, useId, useMemo, useState } from "react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface EmergencyCountry {
  countrySlug: string;
  countryName: string;
  general: string | null;
  police: string | null;
  ambulance: string | null;
  fire: string | null;
  touristPolice: string | null;
  notes: string | null;
}

interface EmergencyPayload {
  results: EmergencyCountry[];
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

class EmergencyFetchError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "EmergencyFetchError";
    this.code = code;
  }
}

async function fetchEmergency(
  q: string,
  signal: AbortSignal,
): Promise<EmergencyPayload> {
  const qs = q.trim() ? `?q=${encodeURIComponent(q.trim())}` : "";
  const res = await fetch(`/api/tools/emergency-numbers${qs}`, {
    credentials: "include",
    headers: { Accept: "application/json" },
    signal,
  });
  const body = (await res.json().catch(() => ({}))) as
    | ApiOk<EmergencyPayload>
    | ApiErr
    | {};
  if (!res.ok || !("ok" in body) || body.ok === false) {
    const err = body as ApiErr;
    throw new EmergencyFetchError(
      err?.error ?? "request_failed",
      err?.message ?? `Request failed (HTTP ${res.status}).`,
    );
  }
  return (body as ApiOk<EmergencyPayload>).data;
}

// ---------------------------------------------------------------------------
// Cross-link registry
// ---------------------------------------------------------------------------

const OTHER_TOOLS: { slug: string; label: string; path: string }[] = [
  { slug: "roaming-calculator", label: "Roaming savings calculator", path: "/tools/roaming-calculator" },
  { slug: "visa-info", label: "Visa info", path: "/tools/visa-info" },
  { slug: "currency-converter", label: "Currency converter", path: "/tools/currency-converter" },
  { slug: "plug-voltage", label: "Plug & voltage guide", path: "/tools/plug-voltage" },
  { slug: "blocked-apps", label: "Blocked apps guide", path: "/tools/blocked-apps" },
];

const DEBOUNCE_MS = 250;

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function EmergencyNumbers(): JSX.Element {
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [state, setState] = useState<
    | { status: "loading" }
    | { status: "ready"; data: EmergencyPayload }
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
    fetchEmergency(debouncedQuery, controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) setState({ status: "ready", data });
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        if (controller.signal.aborted) return;
        if (err instanceof EmergencyFetchError) {
          if (err.code === "not_found" || err.code === "request_failed") {
            setState({
              status: "unavailable",
              message:
                "The emergency number table is being set up. If you're in an emergency right now, dial 112 (works in most countries) or ask a nearby person to call local services.",
            });
            return;
          }
          setState({ status: "error", code: err.code, message: err.message });
          return;
        }
        setState({
          status: "error",
          code: "request_failed",
          message: err instanceof Error ? err.message : "Could not load numbers.",
        });
      });
    return () => controller.abort();
  }, [debouncedQuery]);

  const results = useMemo(() => (state.status === "ready" ? state.data.results : []), [state]);

  return (
    <main className="mx-auto w-full max-w-3xl px-4 pb-16 pt-6" data-testid="emergency-numbers">
      <header>
        <h1 className="text-2xl font-extrabold text-slate-900 sm:text-3xl">
          Emergency numbers
        </h1>
        <p className="mt-2 text-sm text-slate-600">
          Police, ambulance and fire numbers for the countries you&rsquo;re visiting.
          Save the numbers before you travel — you shouldn&rsquo;t have to search for
          them in a crisis.
        </p>
      </header>

      <div
        role="note"
        className="mt-4 rounded-2xl bg-amber-50 px-4 py-3 text-sm text-amber-900 ring-1 ring-amber-200"
        data-testid="emergency-read-first"
      >
        <p className="font-semibold">Read this first</p>
        <ul className="mt-1 list-disc space-y-1 pl-5 text-xs">
          <li>
            <strong>112</strong> is the fallback emergency number in much of the
            world (EU, and increasingly elsewhere). If you don&rsquo;t know the local
            number, dialing 112 is usually a safe first attempt.
          </li>
          <li>
            Note your embassy &amp; travel insurance details in your phone&rsquo;s
            “Medical ID” / emergency contacts.
          </li>
          <li>
            If unsure which service you need, ask the operator for police,
            ambulance, or fire explicitly — many countries share one number.
          </li>
        </ul>
      </div>

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
          placeholder="e.g. Japan, Vietnam, Singapore"
          autoComplete="off"
          className="mt-1 w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-200"
          data-testid="emergency-numbers-search"
        />
      </div>

      <section className="mt-6" aria-live="polite">
        {state.status === "loading" && (
          <div className="space-y-3" aria-busy data-testid="emergency-numbers-loading">
            {[0, 1].map((i) => (
              <div key={i} className="h-40 animate-pulse rounded-2xl bg-slate-100" />
            ))}
          </div>
        )}

        {state.status === "unavailable" && (
          <div
            className="rounded-2xl bg-amber-50 px-4 py-3 text-sm text-amber-900 ring-1 ring-amber-200"
            data-testid="emergency-numbers-unavailable"
          >
            <p className="font-semibold">Emergency number table is being set up.</p>
            <p className="mt-1 text-xs text-amber-900/80">{state.message}</p>
          </div>
        )}

        {state.status === "error" && (
          <div
            role="alert"
            className="rounded-2xl bg-rose-50 px-4 py-3 text-sm text-rose-800 ring-1 ring-rose-200"
            data-testid="emergency-numbers-error"
            data-error-code={state.code}
          >
            <p className="font-semibold">We couldn't load emergency numbers.</p>
            <p className="mt-1 text-xs">{state.message}</p>
          </div>
        )}

        {state.status === "ready" && results.length === 0 && (
          <p
            className="rounded-2xl bg-slate-50 px-4 py-3 text-sm text-slate-600 ring-1 ring-slate-200"
            data-testid="emergency-numbers-empty"
          >
            No country matched &ldquo;{debouncedQuery}&rdquo;. Try the English name or
            the two-letter code (e.g. &ldquo;JP&rdquo;).
          </p>
        )}

        {state.status === "ready" && results.length > 0 && (
          <ul className="space-y-3">
            {results.map((c) => (
              <EmergencyCard key={c.countrySlug} country={c} />
            ))}
          </ul>
        )}
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

      <section className="mt-8 rounded-2xl bg-white p-5 ring-1 ring-slate-200">
        <h2 className="text-base font-bold text-slate-900">Staying connected matters in an emergency</h2>
        <p className="mt-1 text-sm text-slate-600">
          A travel eSIM keeps your own number reachable while you use local data.
          Make sure you have working mobile data before you leave the airport.
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
// Card
// ---------------------------------------------------------------------------

function EmergencyCard({ country }: { country: EmergencyCountry }): JSX.Element {
  return (
    <li
      className="rounded-2xl bg-white p-4 ring-1 ring-slate-200"
      data-testid={`emergency-numbers-card-${country.countrySlug}`}
    >
      <header className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-bold text-slate-900">{country.countryName}</h3>
          {country.notes && (
            <p className="mt-0.5 text-xs text-slate-500">{country.notes}</p>
          )}
        </div>
        <a
          href={`/esim/${country.countrySlug}`}
          className="whitespace-nowrap rounded-xl bg-brand-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-700"
          data-testid={`emergency-numbers-esim-${country.countrySlug}`}
        >
          Get eSIM
        </a>
      </header>

      <dl className="mt-3 grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
        <NumberCell
          label="All"
          value={country.general}
          testId={`emergency-number-${country.countrySlug}-general`}
          variant="primary"
        />
        <NumberCell
          label="Police"
          value={country.police}
          testId={`emergency-number-${country.countrySlug}-police`}
        />
        <NumberCell
          label="Ambulance"
          value={country.ambulance}
          testId={`emergency-number-${country.countrySlug}-ambulance`}
        />
        <NumberCell
          label="Fire"
          value={country.fire}
          testId={`emergency-number-${country.countrySlug}-fire`}
        />
      </dl>

      {country.touristPolice && (
        <p
          className="mt-2 rounded-lg bg-slate-50 px-3 py-1.5 text-xs text-slate-700 ring-1 ring-slate-200"
          data-testid={`emergency-number-${country.countrySlug}-tourist`}
        >
          <span className="font-semibold">Tourist police:</span>{" "}
          <a href={`tel:${country.touristPolice}`} className="text-brand-700 underline-offset-2 hover:underline">
            {country.touristPolice}
          </a>
        </p>
      )}
    </li>
  );
}

interface NumberCellProps {
  label: string;
  value: string | null;
  testId: string;
  variant?: "primary";
}

function NumberCell({ label, value, testId, variant }: NumberCellProps): JSX.Element {
  const base =
    "rounded-xl p-2 ring-1 " +
    (variant === "primary"
      ? "bg-brand-50 ring-brand-100"
      : "bg-slate-50 ring-slate-200");
  return (
    <div className={base} data-testid={testId}>
      <dt className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
        {label}
      </dt>
      <dd className="mt-0.5">
        {value ? (
          <a
            href={`tel:${value}`}
            className="text-base font-extrabold text-slate-900 underline-offset-2 hover:underline"
          >
            {value}
          </a>
        ) : (
          <span className="text-slate-400">—</span>
        )}
      </dd>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Test surface
// ---------------------------------------------------------------------------
export const __test__ = {
  OTHER_TOOLS,
};

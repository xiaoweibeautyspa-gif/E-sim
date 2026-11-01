/**
 * /phone-checker — "Does my phone support eSIM?"
 *
 * Data source: GET /api/ai/compatibility?q=<model>
 *   → { ok: true, data: CompatibilityResult }
 *   → { ok: false, error, message }                         (400 bad query)
 *   → { ok: false, error: "compatibility_unavailable", ... } (503, DB down)
 *   → { ok: false, error: "rate_limited", retryAfterSeconds }
 *
 * Scope:
 *  - Search box + debounced lookup against the admin-maintained phone list in
 *    the DB (no client-side hardcoded devices — admin is the source of truth).
 *  - Verdict banner: capable / incapable / unknown, styled honestly. An unknown
 *    result is NOT rendered as "no", it explicitly says we couldn't find the
 *    model and lists the manual steps.
 *  - Carrier-lock guidance block is always shown (from the server). If the
 *    server is down we still show a static fallback so the page is useful —
 *    the guidance is not personalised so a client-side copy is safe.
 *  - Each "capable" match links to the country-plan picker? No: the checker is
 *    about the device. The primary CTA when a match is capable is "Find a plan"
 *    pointing to `/` (destination search) so the user can proceed.
 *
 * State model: idle / loading / ready / error. No fabricated devices.
 */
import { useEffect, useId, useMemo, useRef, useState } from "react";

interface CompatibleModel {
  id: number;
  brand: string;
  model: string;
  esimCapable: boolean;
  notes: string | null;
  minOs: string | null;
}

interface CompatibilityResult {
  query: string;
  matches: CompatibleModel[];
  verdict: "capable" | "incapable" | "unknown";
  carrierLockGuidance: string[];
}

interface ApiErr {
  ok: false;
  error: string;
  message: string;
  retryAfterSeconds?: number;
}
interface ApiOk<T> {
  ok: true;
  data: T;
}

class CompatError extends Error {
  readonly code: string;
  readonly retryAfterSeconds: number | null;
  constructor(code: string, message: string, retryAfterSeconds: number | null = null) {
    super(message);
    this.name = "CompatError";
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

async function lookupCompatibility(q: string, signal: AbortSignal): Promise<CompatibilityResult> {
  const url = `/api/ai/compatibility?q=${encodeURIComponent(q)}`;
  const res = await fetch(url, {
    method: "GET",
    credentials: "include",
    headers: { Accept: "application/json" },
    signal,
  });
  const json = (await res.json().catch(() => ({}))) as ApiOk<CompatibilityResult> | ApiErr | {};
  if (!res.ok || !("ok" in json) || json.ok === false) {
    const err = json as ApiErr;
    throw new CompatError(
      err?.error ?? "request_failed",
      err?.message ?? `Request failed (HTTP ${res.status}).`,
      err?.retryAfterSeconds ?? null,
    );
  }
  return (json as ApiOk<CompatibilityResult>).data;
}

/** Static fallback guidance in case the server is unreachable. */
const FALLBACK_GUIDANCE = [
  "Open Settings → General → About on iPhone (or Settings → About phone on Android).",
  "Look for 'Carrier Lock' (iPhone) or 'SIM lock' / 'Network lock' (Android).",
  "If your phone is carrier-locked, contact your carrier to unlock it before installing a travel eSIM.",
];

const DEBOUNCE_MS = 300;
const MIN_QUERY_LENGTH = 2;

export function PhoneChecker(): JSX.Element {
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [state, setState] = useState<
    | { status: "idle" }
    | { status: "loading" }
    | { status: "ready"; result: CompatibilityResult }
    | { status: "error"; code: string; message: string; retryAfterSeconds: number | null }
  >({ status: "idle" });

  const inputId = useId();
  const hintId = useId();
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Debounce the query so we don't hammer the server on every keystroke.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query.trim()), DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [query]);

  // Auto-focus on mount for a snappy first interaction.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Fetch when the debounced query is long enough. Empty → idle.
  useEffect(() => {
    if (debouncedQuery.length < MIN_QUERY_LENGTH) {
      setState({ status: "idle" });
      return;
    }
    const controller = new AbortController();
    setState({ status: "loading" });
    lookupCompatibility(debouncedQuery, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setState({ status: "ready", result });
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        if (controller.signal.aborted) return;
        if (err instanceof CompatError) {
          setState({
            status: "error",
            code: err.code,
            message: err.message,
            retryAfterSeconds: err.retryAfterSeconds,
          });
        } else {
          setState({
            status: "error",
            code: "request_failed",
            message: err instanceof Error ? err.message : "Could not check compatibility.",
            retryAfterSeconds: null,
          });
        }
      });
    return () => controller.abort();
  }, [debouncedQuery]);

  const guidance = useMemo(() => {
    if (state.status === "ready") return state.result.carrierLockGuidance;
    return FALLBACK_GUIDANCE;
  }, [state]);

  return (
    <main className="mx-auto w-full max-w-3xl px-4 pb-16 pt-6" data-testid="phone-checker">
      <header>
        <h1 className="text-2xl font-extrabold text-slate-900 sm:text-3xl">
          Does my phone support eSIM?
        </h1>
        <p className="mt-2 text-sm text-slate-600">
          Search your phone model below. Most recent iPhones and many Android flagships
          support eSIM — but not every model in a lineup does, and carrier lock matters too.
        </p>
      </header>

      <div className="mt-6">
        <label htmlFor={inputId} className="block text-sm font-medium text-slate-800">
          Phone brand or model
        </label>
        <div className="mt-1 flex gap-2">
          <input
            ref={inputRef}
            id={inputId}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="e.g. iPhone 15 Pro, Galaxy S24, Pixel 7"
            aria-describedby={hintId}
            className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-200"
            data-testid="phone-checker-input"
          />
          {state.status === "loading" && (
            <span
              className="flex w-10 items-center justify-center text-slate-400"
              aria-hidden
              data-testid="phone-checker-loading"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M12 3a9 9 0 1 0 9 9" strokeLinecap="round">
                  <animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="0.9s" repeatCount="indefinite" />
                </path>
              </svg>
            </span>
          )}
        </div>
        <p id={hintId} className="mt-1 text-xs text-slate-500">
          We search brand and model names. Two characters minimum.
        </p>
      </div>

      <section className="mt-6" aria-live="polite">
        {state.status === "idle" && (
          <p className="rounded-2xl bg-slate-50 px-4 py-3 text-sm text-slate-600 ring-1 ring-slate-200">
            Start typing your phone model to check eSIM support.
          </p>
        )}

        {state.status === "loading" && (
          <div className="rounded-2xl bg-white p-4 ring-1 ring-slate-200" aria-busy>
            <div className="h-5 w-1/2 animate-pulse rounded bg-slate-100" />
            <div className="mt-2 h-4 w-1/3 animate-pulse rounded bg-slate-100" />
          </div>
        )}

        {state.status === "error" && (
          <div
            role="alert"
            className="rounded-2xl bg-rose-50 px-4 py-3 text-sm text-rose-800 ring-1 ring-rose-200"
            data-testid="phone-checker-error"
            data-error-code={state.code}
          >
            <p className="font-semibold">We couldn't check right now.</p>
            <p className="mt-1">{state.message}</p>
            {state.retryAfterSeconds != null && (
              <p className="mt-1 text-xs">Try again in about {state.retryAfterSeconds}s.</p>
            )}
          </div>
        )}

        {state.status === "ready" && <ResultBlock result={state.result} />}
      </section>

      <section className="mt-8 rounded-2xl bg-slate-50 p-5 ring-1 ring-slate-200" aria-labelledby="lock-heading">
        <h2 id="lock-heading" className="text-base font-bold text-slate-900">
          How to check for a carrier lock
        </h2>
        <ol className="mt-3 list-decimal space-y-1 pl-5 text-sm text-slate-700">
          {guidance.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
        <p className="mt-3 text-xs text-slate-500">
          Even an eSIM-capable phone must be unlocked to use a travel eSIM.
        </p>
      </section>
    </main>
  );
}

function ResultBlock({ result }: { result: CompatibilityResult }): JSX.Element {
  if (result.verdict === "capable") {
    return (
      <div
        className="rounded-2xl bg-emerald-50 p-4 ring-1 ring-emerald-200"
        data-testid="phone-checker-result"
        data-verdict="capable"
      >
        <div className="flex items-center gap-2">
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-emerald-600 text-white">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" aria-hidden>
              <path d="M20 6L9 17l-5-5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
          <p className="text-sm font-semibold text-emerald-900">
            Yes — this phone supports eSIM.
          </p>
        </div>
        <MatchList matches={result.matches} />
        <a
          href="/"
          className="mt-3 inline-block rounded-xl bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700"
        >
          Find a plan for your trip
        </a>
      </div>
    );
  }
  if (result.verdict === "incapable") {
    return (
      <div
        className="rounded-2xl bg-amber-50 p-4 ring-1 ring-amber-200"
        data-testid="phone-checker-result"
        data-verdict="incapable"
      >
        <p className="text-sm font-semibold text-amber-900">
          This model doesn't support eSIM.
        </p>
        <p className="mt-1 text-sm text-amber-900/80">
          Some models in a lineup omit eSIM even when siblings support it (common on
          carrier-specific variants). You can still buy an eSIM for a travel companion
          whose phone is compatible, or use a physical SIM for this trip.
        </p>
        <MatchList matches={result.matches} />
      </div>
    );
  }
  return (
    <div
      className="rounded-2xl bg-slate-50 p-4 ring-1 ring-slate-200"
      data-testid="phone-checker-result"
      data-verdict="unknown"
    >
      <p className="text-sm font-semibold text-slate-800">
        We couldn't find that model in our list.
      </p>
      <p className="mt-1 text-sm text-slate-600">
        Try a shorter search (e.g. "iPhone 14" or "Pixel 7"). If it's still not there you can
        verify manually: the phone supports eSIM if its settings show "Add eSIM" under
        Cellular/Mobile Network.
      </p>
    </div>
  );
}

function MatchList({ matches }: { matches: CompatibleModel[] }): JSX.Element | null {
  if (matches.length === 0) return null;
  return (
    <ul className="mt-3 space-y-1.5 text-sm" data-testid="phone-checker-matches">
      {matches.map((m) => (
        <li
          key={m.id}
          className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-white px-3 py-2 ring-1 ring-slate-200"
          data-testid={`phone-match-${m.id}`}
        >
          <div>
            <p className="font-medium text-slate-900">
              {m.brand} {m.model}
            </p>
            {(m.minOs || m.notes) && (
              <p className="text-xs text-slate-500">
                {[m.minOs, m.notes].filter(Boolean).join(" · ")}
              </p>
            )}
          </div>
          <span
            className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ${
              m.esimCapable
                ? "bg-emerald-50 text-emerald-700 ring-emerald-200"
                : "bg-slate-100 text-slate-600 ring-slate-200"
            }`}
          >
            {m.esimCapable ? "eSIM capable" : "No eSIM"}
          </span>
        </li>
      ))}
    </ul>
  );
}

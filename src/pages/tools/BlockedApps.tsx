/**
 * /tools/blocked-apps — which apps and services may be restricted where.
 *
 * Same shape as the other free-tool pages in this batch (RoamingCalculator,
 * CurrencyConverter, PlugVoltage, EmergencyNumbers): a search box that hits an
 * admin-managed data table via a JSON endpoint, plus an always-visible
 * general-knowledge section. Country/region-specific app blocks change without
 * notice and are managed in admin — nothing here hardcodes a list of blocked
 * services, because a wrong "X is blocked" claim could cost a traveller their
 * trip.
 *
 * Contract (served by server/routes/seo.ts in this batch):
 *   GET /api/tools/blocked-apps?q=<country-or-slug>
 *     → { ok:true, data:{ results: BlockedAppsCountry[] } }
 *     → { ok:false, error:"blocked_apps_unavailable", message }   (table not provisioned)
 *     → 404 { ok:false, error:"not_found", message }
 *
 *   BlockedAppsCountry:
 *     {
 *       countrySlug: string;       // e.g. "cn"
 *       countryName: string;       // e.g. "China"
 *       blocked: string[];         // e.g. ["Google", "WhatsApp", "Instagram"]
 *       vpnNotes: string | null;    // admin-authored guidance, e.g. "VPNs are restricted"
 *       tips: string | null;        // e.g. "Install your VPN before departure"
 *     }
 *
 * Behaviour:
 *   - Search box with debounce; empty query fetches a small default set.
 *   - Each card links to that country's eSIM page.
 *   - On "not configured" the page shows an honest "being set up" state and
 *     keeps the general guidance visible.
 *   - The general "before you fly" block is safe general knowledge: install and
 *     test a VPN before travel, and remember that an eSIM provides mobile data —
 *     it does not route around a country's network-level restrictions.
 *
 * Test hooks:
 *   data-testid="blocked-apps"
 *   data-testid="blocked-apps-search"
 *   data-testid="blocked-apps-loading"
 *   data-testid="blocked-apps-unavailable"
 *   data-testid="blocked-apps-error"
 *   data-testid="blocked-apps-empty"
 *   data-testid="blocked-apps-card-<slug>"
 *   data-testid="blocked-apps-esim-<slug>"
 */
import { useEffect, useId, useMemo, useState } from "react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface BlockedAppsCountry {
  countrySlug: string;
  countryName: string;
  blocked: string[];
  vpnNotes: string | null;
  tips: string | null;
}

interface BlockedAppsPayload {
  results: BlockedAppsCountry[];
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

class BlockedFetchError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "BlockedFetchError";
    this.code = code;
  }
}

async function fetchBlockedApps(q: string, signal: AbortSignal): Promise<BlockedAppsPayload> {
  const qs = q.trim() ? `?q=${encodeURIComponent(q.trim())}` : "";
  const res = await fetch(`/api/tools/blocked-apps${qs}`, {
    credentials: "include",
    headers: { Accept: "application/json" },
    signal,
  });
  const body = (await res.json().catch(() => ({}))) as
    | ApiOk<BlockedAppsPayload>
    | ApiErr
    | {};
  if (!res.ok || !("ok" in body) || body.ok === false) {
    const err = body as ApiErr;
    throw new BlockedFetchError(
      err?.error ?? "request_failed",
      err?.message ?? `Request failed (HTTP ${res.status}).`,
    );
  }
  return (body as ApiOk<BlockedAppsPayload>).data;
}

// ---------------------------------------------------------------------------
// Cross-link registry
// ---------------------------------------------------------------------------

const OTHER_TOOLS: { slug: string; label: string; path: string }[] = [
  { slug: "roaming-calculator", label: "Roaming savings calculator", path: "/tools/roaming-calculator" },
  { slug: "visa-info", label: "Visa info", path: "/tools/visa-info" },
  { slug: "currency-converter", label: "Currency converter", path: "/tools/currency-converter" },
  { slug: "plug-voltage", label: "Plug & voltage guide", path: "/tools/plug-voltage" },
  { slug: "emergency-numbers", label: "Emergency numbers", path: "/tools/emergency-numbers" },
];

const DEBOUNCE_MS = 250;

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function BlockedApps(): JSX.Element {
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [state, setState] = useState<
    | { status: "loading" }
    | { status: "ready"; data: BlockedAppsPayload }
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
    fetchBlockedApps(debouncedQuery, controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) setState({ status: "ready", data });
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        if (controller.signal.aborted) return;
        if (err instanceof BlockedFetchError) {
          if (err.code === "not_found" || err.code === "blocked_apps_unavailable") {
            setState({
              status: "unavailable",
              message:
                "The blocked-apps table is being set up. The general guidance below still applies — install and test your tools before you fly.",
            });
            return;
          }
          setState({ status: "error", code: err.code, message: err.message });
          return;
        }
        setState({
          status: "error",
          code: "request_failed",
          message: err instanceof Error ? err.message : "Could not load blocked-app data.",
        });
      });
    return () => controller.abort();
  }, [debouncedQuery]);

  const results = useMemo(() => (state.status === "ready" ? state.data.results : []), [state]);

  return (
    <main className="mx-auto w-full max-w-3xl px-4 pb-16 pt-6" data-testid="blocked-apps">
      <header>
        <h1 className="text-2xl font-extrabold text-slate-900 sm:text-3xl">
          Blocked apps guide
        </h1>
        <p className="mt-2 text-sm text-slate-600">
          Some destinations restrict certain apps and services. Check what may be
          affected before you travel, so you can set up alternatives while you still
          can.
        </p>
      </header>

      <div
        role="note"
        className="mt-4 rounded-2xl bg-amber-50 px-4 py-3 text-sm text-amber-900 ring-1 ring-amber-200"
        data-testid="blocked-apps-before-you-fly"
      >
        <p className="font-semibold">Before you fly</p>
        <ul className="mt-1 list-disc space-y-1 pl-5 text-xs">
          <li>
            <strong>Install and test any tools you rely on before departure.</strong>{" "}
            Some services are hard to set up once you&rsquo;re inside a restricted
            network.
          </li>
          <li>
            A travel eSIM gives you <strong>mobile data</strong>. It does not route
            around a country&rsquo;s network-level restrictions by itself — plan
            accordingly.
          </li>
          <li>
            Keep a backup: download offline maps, save your contacts and have a local
            messaging alternative ready.
          </li>
          <li>
            Rules change. Treat the lists below as a starting point and confirm before
            you rely on any single app.
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
          placeholder="e.g. China, Vietnam, Singapore"
          autoComplete="off"
          className="mt-1 w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-200"
          data-testid="blocked-apps-search"
        />
      </div>

      <section className="mt-6" aria-live="polite">
        {state.status === "loading" && (
          <div className="space-y-3" aria-busy data-testid="blocked-apps-loading">
            {[0, 1].map((i) => (
              <div key={i} className="h-32 animate-pulse rounded-2xl bg-slate-100" />
            ))}
          </div>
        )}

        {state.status === "unavailable" && (
          <div
            className="rounded-2xl bg-amber-50 px-4 py-3 text-sm text-amber-900 ring-1 ring-amber-200"
            data-testid="blocked-apps-unavailable"
          >
            <p className="font-semibold">Blocked-app data is being set up.</p>
            <p className="mt-1 text-xs text-amber-900/80">{state.message}</p>
          </div>
        )}

        {state.status === "error" && (
          <div
            role="alert"
            className="rounded-2xl bg-rose-50 px-4 py-3 text-sm text-rose-800 ring-1 ring-rose-200"
            data-testid="blocked-apps-error"
            data-error-code={state.code}
          >
            <p className="font-semibold">We couldn't load blocked-app data.</p>
            <p className="mt-1 text-xs">{state.message}</p>
          </div>
        )}

        {state.status === "ready" && results.length === 0 && (
          <p
            className="rounded-2xl bg-slate-50 px-4 py-3 text-sm text-slate-600 ring-1 ring-slate-200"
            data-testid="blocked-apps-empty"
          >
            No country matched &ldquo;{debouncedQuery}&rdquo;. Try the English name or
            the two-letter code (e.g. &ldquo;CN&rdquo;).
          </p>
        )}

        {state.status === "ready" && results.length > 0 && (
          <ul className="space-y-3">
            {results.map((c) => (
              <BlockedCard key={c.countrySlug} country={c} />
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
        <h2 className="text-base font-bold text-slate-900">A local data plan helps</h2>
        <p className="mt-1 text-sm text-slate-600">
          A travel eSIM gives you reliable mobile data so you can use the apps that
          <em> do </em>work, follow live updates, and reach support if you get stuck.
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

function BlockedCard({ country }: { country: BlockedAppsCountry }): JSX.Element {
  return (
    <li
      className="rounded-2xl bg-white p-4 ring-1 ring-slate-200"
      data-testid={`blocked-apps-card-${country.countrySlug}`}
    >
      <header className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-bold text-slate-900">{country.countryName}</h3>
          {country.vpnNotes && (
            <p className="mt-0.5 text-xs text-slate-500">{country.vpnNotes}</p>
          )}
        </div>
        <a
          href={`/esim/${country.countrySlug}`}
          className="whitespace-nowrap rounded-xl bg-brand-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-700"
          data-testid={`blocked-apps-esim-${country.countrySlug}`}
        >
          Get eSIM
        </a>
      </header>

      <div className="mt-3">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
          May be restricted
        </p>
        {country.blocked.length === 0 ? (
          <p className="mt-1 text-sm text-slate-500">
            No specific restrictions on file. Still install offline maps and a backup
            messaging app before you go.
          </p>
        ) : (
          <ul
            className="mt-1 flex flex-wrap gap-1.5"
            data-testid={`blocked-apps-list-${country.countrySlug}`}
          >
            {country.blocked.map((app) => (
              <li
                key={app}
                className="inline-flex items-center rounded-md bg-rose-50 px-2 py-0.5 text-xs font-medium text-rose-800 ring-1 ring-rose-200"
              >
                {app}
              </li>
            ))}
          </ul>
        )}
      </div>

      {country.tips && (
        <p
          className="mt-3 rounded-lg bg-slate-50 px-3 py-1.5 text-xs text-slate-700 ring-1 ring-slate-200"
          data-testid={`blocked-apps-tips-${country.countrySlug}`}
        >
          <span className="font-semibold">Tip:</span> {country.tips}
        </p>
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------
// Test surface
// ---------------------------------------------------------------------------
export const __test__ = {
  OTHER_TOOLS,
};

export default BlockedApps;

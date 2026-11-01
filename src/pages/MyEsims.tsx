/**
 * /my-esims — the signed-in user's eSIM dashboard.
 *
 * Contract:
 *   GET /api/esims  → { ok, data: { esims: MyEsim[], usageFreshnessMinutes: number|null } }
 *                   | 401 { ok:false, error:"unauthorized", message }
 *                   | 503 { ok:false, error:"esims_unavailable", message }
 *   Each eSIM's `qrPath` is fetched on demand by <EsimCard>.
 *   Top-up is started via <TopUpModal> (batched in this phase).
 *
 * Scope of this page (My eSIMs + Top-ups batch):
 * - Auth gate + fetch with explicit loading/error/ready union.
 * - Lists the user's eSIMs as <EsimCard>. Each card's Top-up CTA is wired to
 *   open <TopUpModal> when the server says `topUpEligible` and the caller is
 *   authenticated (top-up auth is enforced server side regardless).
 * - Page-level freshness caption reflects the 3-hourly refresh cadence.
 * - Refund/status actions still live in a later batch; the cards hide them
 *   when no handler is supplied, so nothing is dead.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { EsimCard, type MyEsim } from "../components/EsimCard";
import { TopUpModal } from "../components/TopUpModal";
import { useAuth } from "../context/AuthContext";

// ---------------------------------------------------------------------------
// Types + fetch
// ---------------------------------------------------------------------------

interface EsimsPayload {
  esims: MyEsim[];
  usageFreshnessMinutes?: number | null;
}

class EsimsError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  constructor(code: string, message: string, httpStatus: number) {
    super(message);
    this.name = "EsimsError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

async function fetchEsims(signal: AbortSignal): Promise<EsimsPayload> {
  const res = await fetch("/api/esims", {
    method: "GET",
    credentials: "include",
    headers: { Accept: "application/json" },
    signal,
  });
  const body = (await res.json().catch(() => ({}))) as
    | { ok: true; data: EsimsPayload }
    | { ok: false; error: string; message: string };
  if (!res.ok || !body || body.ok === false) {
    const code = body?.ok === false ? body.error : "request_failed";
    const message =
      body?.ok === false ? body.message : `Request failed (HTTP ${res.status}).`;
    throw new EsimsError(code, message, res.status);
  }
  return body.data;
}

// ---------------------------------------------------------------------------
// Sub-views
// ---------------------------------------------------------------------------

function PageSkeleton(): JSX.Element {
  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-8" aria-busy data-testid="my-esims-loading">
      <div className="h-8 w-48 animate-pulse rounded bg-slate-100" />
      <div className="mt-6 space-y-4">
        {[0, 1].map((i) => (
          <div key={i} className="h-40 animate-pulse rounded-2xl bg-slate-100" />
        ))}
      </div>
    </main>
  );
}

function GateMessage({
  title,
  body,
  ctaLabel,
  ctaHref,
  testId,
}: {
  title: string;
  body: string;
  ctaLabel?: string;
  ctaHref?: string;
  testId: string;
}): JSX.Element {
  return (
    <main className="mx-auto w-full max-w-md px-4 py-16 text-center" data-testid={testId}>
      <h1 className="text-xl font-bold text-slate-900">{title}</h1>
      <p className="mt-2 text-sm text-slate-600">{body}</p>
      {ctaLabel && ctaHref && (
        <a
          href={ctaHref}
          className="mt-6 inline-block rounded-xl bg-brand-600 px-4 py-2 font-semibold text-white hover:bg-brand-700"
        >
          {ctaLabel}
        </a>
      )}
    </main>
  );
}

function EmptyState(): JSX.Element {
  return (
    <div
      className="rounded-2xl bg-slate-50 p-8 text-center ring-1 ring-slate-200"
      data-testid="my-esims-empty"
    >
      <p className="text-base font-semibold text-slate-900">No eSIMs yet</p>
      <p className="mt-1 text-sm text-slate-600">
        Once you buy a plan, it shows up here with its QR code and live data usage.
      </p>
      <a
        href="/"
        className="mt-4 inline-block rounded-xl bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700"
      >
        Browse destinations
      </a>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Top-up wiring
// ---------------------------------------------------------------------------

/**
 * Convert the display-facing `MyEsim.id` (string) back to the numeric server
 * PK. The server uses SERIAL ids; a non-numeric id would be a contract bug
 * upstream, so we refuse rather than make a request that will 400.
 */
function numericEsimId(id: string): number | null {
  const n = Number(id);
  return Number.isFinite(n) && n > 0 && Number.isInteger(n) ? n : null;
}

function labelForEsim(esim: MyEsim): string {
  const bits = [esim.country];
  if (esim.network) bits.push(esim.network);
  if (esim.planName) bits.push(esim.planName);
  return bits.join(" · ");
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export function MyEsims(): JSX.Element {
  const auth = useAuth();
  const [state, setState] = useState<
    | { status: "idle" }
    | { status: "loading" }
    | { status: "ready"; data: EsimsPayload }
    | { status: "error"; code: string; message: string; httpStatus: number }
  >({ status: "idle" });
  const [nonce, setNonce] = useState(0);
  const [activeTopUp, setActiveTopUp] = useState<MyEsim | null>(null);

  const load = useCallback((signal: AbortSignal) => {
    setState({ status: "loading" });
    fetchEsims(signal)
      .then((data) => {
        if (!signal.aborted) setState({ status: "ready", data });
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        if (signal.aborted) return;
        const code = err instanceof EsimsError ? err.code : "request_failed";
        const httpStatus = err instanceof EsimsError ? err.httpStatus : 0;
        const message = err instanceof Error ? err.message : "Could not load your eSIMs.";
        setState({ status: "error", code, message, httpStatus });
      });
  }, []);

  useEffect(() => {
    if (auth.status !== "authenticated") return;
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
  }, [auth.status, nonce, load]);

  const freshnessCopy = useMemo(() => {
    if (state.status !== "ready") return "Usage updated every few hours.";
    const minutes = state.data.usageFreshnessMinutes;
    if (minutes && minutes >= 60) {
      const hours = Math.round(minutes / 60);
      return `Usage updated every ${hours} ${hours === 1 ? "hour" : "hours"}.`;
    }
    return "Usage updated every few hours.";
  }, [state]);

  const openTopUp = useCallback((esim: MyEsim) => setActiveTopUp(esim), []);
  const closeTopUp = useCallback(() => setActiveTopUp(null), []);

  // -- Auth gates -----------------------------------------------------------
  if (auth.status === "loading") return <PageSkeleton />;

  if (auth.status === "error") {
    return (
      <GateMessage
        testId="my-esims-auth-error"
        title="We couldn't check your session"
        body={auth.error ?? "Please try again."}
        ctaLabel="Reload"
        ctaHref="/my-esims"
      />
    );
  }

  if (auth.status !== "authenticated" || !auth.user) {
    const returnTo = "/my-esims";
    return (
      <GateMessage
        testId="my-esims-auth-required"
        title="Sign in to see your eSIMs"
        body="Your QR codes, data usage and top-ups live in your account."
        ctaLabel="Sign in"
        ctaHref={`/login?returnTo=${encodeURIComponent(returnTo)}`}
      />
    );
  }

  // -- Data states ---------------------------------------------------------
  if (state.status === "idle" || state.status === "loading") return <PageSkeleton />;

  if (state.status === "error") {
    const unavailable =
      state.httpStatus === 503 || state.code === "esims_unavailable";
    return (
      <main className="mx-auto w-full max-w-3xl px-4 py-8">
        <h1 className="text-2xl font-extrabold text-slate-900">My eSIMs</h1>
        <div
          role="alert"
          className="mt-4 rounded-2xl bg-rose-50 px-4 py-3 text-sm text-rose-800 ring-1 ring-rose-200"
          data-testid="my-esims-error"
          data-error-code={state.code}
        >
          <p className="font-semibold">
            {unavailable ? "This page isn't wired up yet." : "We couldn't load your eSIMs."}
          </p>
          <p className="mt-1">
            {unavailable
              ? "The eSIM dashboard backend is still being built. Your purchases and install emails are unaffected."
              : state.message}
          </p>
          {!unavailable && (
            <button
              type="button"
              onClick={() => setNonce((n) => n + 1)}
              className="mt-3 rounded-lg bg-rose-600 px-3 py-1.5 font-medium text-white hover:bg-rose-700"
            >
              Try again
            </button>
          )}
        </div>
      </main>
    );
  }

  const esims = state.data.esims;
  const topUpId = activeTopUp ? numericEsimId(activeTopUp.id) : null;

  return (
    <main className="mx-auto w-full max-w-3xl px-4 pb-16 pt-6" data-testid="my-esims">
      <header className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-2xl font-extrabold text-slate-900">My eSIMs</h1>
          <p className="mt-1 text-sm text-slate-600">
            {auth.user.email}
            {esims.length > 0 && (
              <> · {esims.length} eSIM{esims.length === 1 ? "" : "s"}</>
            )}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setNonce((n) => n + 1)}
          className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
          data-testid="my-esims-refresh"
        >
          Refresh
        </button>
      </header>

      <p className="mt-3 rounded-xl bg-slate-50 px-3 py-2 text-xs text-slate-500" data-testid="usage-freshness-note">
        {freshnessCopy} Usage data can lag 1–3 hours behind your device.
      </p>

      <section className="mt-6" aria-label="Your eSIMs">
        {esims.length === 0 ? (
          <EmptyState />
        ) : (
          <div className="space-y-4">
            {esims.map((esim) => (
              <EsimCard
                key={esim.id}
                esim={esim}
                detailsHref={`/my-esims/${esim.id}`}
                onTopUp={esim.topUpEligible ? openTopUp : undefined}
              />
            ))}
          </div>
        )}
      </section>

      {activeTopUp && topUpId != null && (
        <TopUpModal
          esimId={topUpId}
          esimLabel={labelForEsim(activeTopUp)}
          currency="SGD"
          successPath="/my-esims"
          onClose={closeTopUp}
          autoTopUpHref="/my-esims/auto-topup"
        />
      )}
    </main>
  );
}

// Named re-export so test scaffolding added in a later batch can import the
// fetch helper without a module-level mutation of globalThis.
export const __test__ = { fetchEsims, EsimsError, numericEsimId, labelForEsim };

/**
 * DataEstimator — "How much data will I need?" AI helper.
 *
 * Contract with the backend (server/routes/ai.ts):
 *   POST /api/ai/data-estimator
 *     body: { destination: string; tripDays: number; habits: EstimatorHabits; notes?: string }
 *     → 200 { ok: true, data: EstimatorResponse }
 *     → 400 { ok: false, error: "invalid_input", message }
 *     → 429 { ok: false, error: "rate_limited", message, retryAfterSeconds }
 *     → 503 { ok: false, error: "ai_unavailable" | "catalog_unavailable", message }
 *
 * EstimatorResponse:
 *   estimatedGb: number
 *   assumption: string            // one-line "we assumed maps + social, no video"
 *   bestPlan: RecommendedPlan | null
 *   biggerPlan: RecommendedPlan | null
 *   note: string | null           // model caveat, e.g. "assumes 1080p streaming"
 *
 * RecommendedPlan is a REAL package from our DB (server-side join in
 * server/routes/ai.ts). Each carries its own `buyHref`, which the server builds
 * from the package's country slug. We render "Buy now" as a real link — the
 * component never invents a plan or a price.
 *
 * Behaviour:
 *  - The form is a small, explicit set of habit toggles plus a duration slider.
 *    Nothing is preselected as "yes" to avoid over-estimating silently; the
 *    user must opt into each habit.
 *  - On submit we POST once, then render three explicit states: loading,
 *    result, error. A rate limit shows a countdown; an "AI unavailable" shows
 *    the raw form values back with a "Try again" button so the user isn't stuck
 *    re-entering.
 *  - The "best" plan is the server's choice; the "bigger" plan is a strictly
 *    larger package for people who want headroom. We don't compute either here.
 *
 * No client-side AI. No hardcoded plan prices. No fake fallback plan.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { formatMoney, type DisplayCurrency } from "../lib/apiClient";

// ---------------------------------------------------------------------------
// Types (mirrored structurally from server/routes/ai.ts — keep in sync)
// ---------------------------------------------------------------------------

export type HabitKey =
  | "maps"
  | "social"
  | "videoCalls"
  | "streaming"
  | "hotspot";

export type EstimatorHabits = Record<HabitKey, boolean>;

export interface RecommendedPlan {
  code: string;
  name: string;
  countrySlug: string | null;
  countryName: string | null;
  dataGb: number | null;
  durationDays: number | null;
  isDailyPlan: boolean;
  /** Retail price in USD (server-priced). */
  retailUsd: number;
  /** Operator display names, e.g. ["Singtel 5G"]. */
  operators: string[];
  /** Server-built navigation URL, e.g. "/esim/sg". */
  buyHref: string;
}

export interface EstimatorResponse {
  estimatedGb: number;
  assumption: string;
  bestPlan: RecommendedPlan | null;
  biggerPlan: RecommendedPlan | null;
  note: string | null;
}

interface ApiOk<T> {
  ok: true;
  data: T;
}
interface ApiErr {
  ok: false;
  error: string;
  message: string;
  retryAfterSeconds?: number;
}

class EstimatorError extends Error {
  readonly code: string;
  readonly retryAfterSeconds: number | null;
  constructor(code: string, message: string, retryAfterSeconds: number | null = null) {
    super(message);
    this.name = "EstimatorError";
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

async function estimate(
  body: {
    destination: string;
    tripDays: number;
    habits: EstimatorHabits;
    notes?: string;
  },
  signal: AbortSignal,
): Promise<EstimatorResponse> {
  const res = await fetch("/api/ai/data-estimator", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  const json = (await res.json().catch(() => ({}))) as ApiOk<EstimatorResponse> | ApiErr | {};
  if (!res.ok || !("ok" in json) || json.ok === false) {
    const err = json as ApiErr;
    throw new EstimatorError(
      err?.error ?? "request_failed",
      err?.message ?? `Request failed (HTTP ${res.status}).`,
      err?.retryAfterSeconds ?? null,
    );
  }
  return (json as ApiOk<EstimatorResponse>).data;
}

// ---------------------------------------------------------------------------
// Habit metadata (labels are static; the SERVER owns the GB model)
// ---------------------------------------------------------------------------

const HABITS: { key: HabitKey; label: string; hint: string }[] = [
  { key: "maps", label: "Maps & directions", hint: "Navigation most days" },
  { key: "social", label: "Social media", hint: "Instagram, TikTok, WeChat" },
  { key: "videoCalls", label: "Video calls", hint: "Zoom, FaceTime, WhatsApp" },
  { key: "streaming", label: "Streaming", hint: "YouTube, Netflix, Spotify video" },
  { key: "hotspot", label: "Hotspot / tethering", hint: "Share data with a laptop or friend" },
];

const EMPTY_HABITS: EstimatorHabits = {
  maps: false,
  social: false,
  videoCalls: false,
  streaming: false,
  hotspot: false,
};

// ---------------------------------------------------------------------------
// Result rendering
// ---------------------------------------------------------------------------

function planDataLabel(plan: RecommendedPlan): string {
  if (plan.isDailyPlan) return "Unlimited / day";
  if (plan.dataGb == null) return "Data included";
  return plan.dataGb >= 1
    ? `${Number.isInteger(plan.dataGb) ? plan.dataGb : plan.dataGb.toFixed(1)} GB`
    : `${Math.round(plan.dataGb * 1024)} MB`;
}

function planValidityLabel(plan: RecommendedPlan): string | null {
  if (plan.durationDays == null) return null;
  return `${plan.durationDays} ${plan.durationDays === 1 ? "day" : "days"}`;
}

function PlanCard({
  plan,
  currency,
  variant,
}: {
  plan: RecommendedPlan;
  currency: DisplayCurrency;
  variant: "best" | "bigger";
}): JSX.Element {
  const isBest = variant === "best";
  const data = planDataLabel(plan);
  const validity = planValidityLabel(plan);
  return (
    <article
      className={`flex flex-col rounded-2xl p-4 ring-1 ${
        isBest ? "bg-brand-50 ring-brand-200" : "bg-white ring-slate-200"
      }`}
      data-testid={`estimator-plan-${variant}`}
      data-plan-code={plan.code}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p
            className={`text-[11px] font-semibold uppercase tracking-wide ${
              isBest ? "text-brand-700" : "text-slate-500"
            }`}
          >
            {isBest ? "Best fit" : "More headroom"}
          </p>
          <h4 className="mt-0.5 truncate text-sm font-bold text-slate-900">
            {plan.countryName ?? plan.name}
          </h4>
        </div>
        <p className="shrink-0 text-sm font-extrabold text-slate-900" data-testid={`estimator-price-${variant}`}>
          {formatMoney(plan.retailUsd, currency)}
        </p>
      </div>
      <p className="mt-1 text-xs text-slate-600">
        {data}
        {validity ? ` · ${validity}` : ""}
        {plan.operators.length > 0
          ? ` · Runs on ${plan.operators.slice(0, 2).join(", ")}`
          : ""}
      </p>
      <a
        href={plan.buyHref}
        className={`mt-3 inline-flex items-center justify-center rounded-xl px-3 py-2 text-sm font-semibold ${
          isBest
            ? "bg-brand-600 text-white hover:bg-brand-700"
            : "border border-slate-300 bg-white text-slate-800 hover:bg-slate-50"
        }`}
        data-testid={`estimator-buy-${variant}`}
      >
        Buy now
      </a>
    </article>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface DataEstimatorProps {
  /** Prefill the destination (e.g. from a country page). */
  initialDestination?: string;
  /** Currency used to display plan prices. */
  currency?: DisplayCurrency;
  /** Optional class hook for layout embedding. */
  className?: string;
}

export function DataEstimator({
  initialDestination = "",
  currency = "SGD",
  className = "",
}: DataEstimatorProps): JSX.Element {
  const [destination, setDestination] = useState(initialDestination);
  const [tripDays, setTripDays] = useState(7);
  const [habits, setHabits] = useState<EstimatorHabits>(EMPTY_HABITS);
  const [notes, setNotes] = useState("");

  const [state, setState] = useState<
    | { status: "idle" }
    | { status: "loading" }
    | { status: "ready"; result: EstimatorResponse }
    | { status: "error"; code: string; message: string; retryAfterSeconds: number | null }
  >({ status: "idle" });

  const abortRef = useRef<AbortController | null>(null);
  const formId = useId();
  const destId = useId();
  const daysId = useId();
  const notesId = useId();

  // Cancel any in-flight request on unmount.
  useEffect(() => () => abortRef.current?.abort(), []);

  const toggleHabit = useCallback((key: HabitKey) => {
    setHabits((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);

  const canSubmit = useMemo(
    () => destination.trim().length >= 2 && tripDays >= 1 && tripDays <= 90 && state.status !== "loading",
    [destination, tripDays, state.status],
  );

  const submit = useCallback(
    async (e?: React.FormEvent) => {
      if (e) e.preventDefault();
      if (!canSubmit) return;
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setState({ status: "loading" });
      try {
        const result = await estimate(
          {
            destination: destination.trim(),
            tripDays,
            habits,
            notes: notes.trim() || undefined,
          },
          controller.signal,
        );
        if (!controller.signal.aborted) setState({ status: "ready", result });
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        if (controller.signal.aborted) return;
        if (err instanceof EstimatorError) {
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
            message: err instanceof Error ? err.message : "Could not estimate your data use.",
            retryAfterSeconds: null,
          });
        }
      }
    },
    [canSubmit, destination, tripDays, habits, notes],
  );

  return (
    <section
      className={`rounded-3xl bg-white p-5 ring-1 ring-slate-200 sm:p-6 ${className}`}
      aria-labelledby={`${formId}-heading`}
      data-testid="data-estimator"
    >
      <header>
        <h2 id={`${formId}-heading`} className="text-lg font-bold text-slate-900 sm:text-xl">
          How much data will I need?
        </h2>
        <p className="mt-1 text-sm text-slate-600">
          Tell us where you're going and how you use your phone. We'll estimate your data and
          point you at a real plan from our catalogue.
        </p>
      </header>

      <form onSubmit={submit} className="mt-5 space-y-4" data-testid="estimator-form">
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor={destId} className="block text-sm font-medium text-slate-800">
              Destination
            </label>
            <input
              id={destId}
              type="text"
              value={destination}
              onChange={(e) => setDestination(e.target.value)}
              placeholder="e.g. Japan"
              className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-200"
              data-testid="estimator-destination"
            />
          </div>
          <div>
            <label htmlFor={daysId} className="block text-sm font-medium text-slate-800">
              Trip length: <span className="font-semibold text-brand-700">{tripDays} {tripDays === 1 ? "day" : "days"}</span>
            </label>
            <input
              id={daysId}
              type="range"
              min={1}
              max={30}
              step={1}
              value={tripDays}
              onChange={(e) => setTripDays(Number(e.target.value))}
              className="mt-3 w-full accent-brand-600"
              data-testid="estimator-days"
            />
          </div>
        </div>

        <fieldset>
          <legend className="text-sm font-medium text-slate-800">How do you use your phone?</legend>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            {HABITS.map((h) => {
              const checked = habits[h.key];
              return (
                <label
                  key={h.key}
                  className={`flex cursor-pointer items-start gap-2 rounded-xl border px-3 py-2 text-sm ${
                    checked
                      ? "border-brand-400 bg-brand-50 text-brand-900"
                      : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
                  }`}
                >
                  <input
                    type="checkbox"
                    className="mt-0.5 h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
                    checked={checked}
                    onChange={() => toggleHabit(h.key)}
                    data-testid={`estimator-habit-${h.key}`}
                  />
                  <span>
                    <span className="font-medium">{h.label}</span>
                    <span className="block text-xs text-slate-500">{h.hint}</span>
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>

        <div>
          <label htmlFor={notesId} className="block text-sm font-medium text-slate-800">
            Anything else? <span className="font-normal text-slate-500">(optional)</span>
          </label>
          <textarea
            id={notesId}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
            placeholder="e.g. I'll be working remotely a few days"
            className="mt-1 w-full resize-none rounded-xl border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-200"
            data-testid="estimator-notes"
          />
        </div>

        <button
          type="submit"
          disabled={!canSubmit}
          className="w-full rounded-xl bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-700 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-400 sm:w-auto"
          data-testid="estimator-submit"
        >
          {state.status === "loading" ? "Estimating…" : "Estimate my data"}
        </button>
      </form>

      <div className="mt-5" aria-live="polite">
        {state.status === "loading" && (
          <div className="rounded-2xl bg-slate-50 p-4" aria-busy data-testid="estimator-loading">
            <div className="h-5 w-1/3 animate-pulse rounded bg-slate-200" />
            <div className="mt-2 h-20 animate-pulse rounded-xl bg-slate-200" />
          </div>
        )}

        {state.status === "error" && (
          <div
            role="alert"
            className="rounded-2xl bg-rose-50 px-4 py-3 text-sm text-rose-800 ring-1 ring-rose-200"
            data-testid="estimator-error"
            data-error-code={state.code}
          >
            <p className="font-semibold">
              {state.code === "rate_limited"
                ? "You're going a bit fast."
                : state.code === "ai_unavailable"
                  ? "The estimator is offline right now."
                  : "We couldn't estimate your data."}
            </p>
            <p className="mt-1">{state.message}</p>
            {state.retryAfterSeconds != null && (
              <p className="mt-1 text-xs">Try again in about {state.retryAfterSeconds}s.</p>
            )}
            <button
              type="button"
              onClick={() => void submit()}
              className="mt-3 rounded-lg bg-rose-600 px-3 py-1.5 font-medium text-white hover:bg-rose-700"
              data-testid="estimator-retry"
            >
              Try again
            </button>
          </div>
        )}

        {state.status === "ready" && (
          <div data-testid="estimator-result">
            <div className="rounded-2xl bg-slate-50 p-4 ring-1 ring-slate-200">
              <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
                Estimated data
              </p>
              <p className="mt-1 text-2xl font-extrabold text-slate-900" data-testid="estimator-estimated-gb">
                ~{state.result.estimatedGb} GB
              </p>
              <p className="mt-1 text-sm text-slate-600" data-testid="estimator-assumption">
                {state.result.assumption}
              </p>
              {state.result.note && (
                <p className="mt-2 text-xs text-slate-500">{state.result.note}</p>
              )}
            </div>

            {(state.result.bestPlan || state.result.biggerPlan) ? (
              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                {state.result.bestPlan && (
                  <PlanCard plan={state.result.bestPlan} currency={currency} variant="best" />
                )}
                {state.result.biggerPlan && (
                  <PlanCard plan={state.result.biggerPlan} currency={currency} variant="bigger" />
                )}
              </div>
            ) : (
              <p
                className="mt-4 rounded-2xl bg-amber-50 px-4 py-3 text-sm text-amber-900 ring-1 ring-amber-200"
                data-testid="estimator-no-plans"
              >
                We don't have a matching plan for {destination.trim()} yet. Browse all destinations to
                see what's available.
              </p>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

export const __test__ = { HABITS, EMPTY_HABITS, planDataLabel, planValidityLabel };

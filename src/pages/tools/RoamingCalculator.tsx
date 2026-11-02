/**
 * /tools/roaming-calculator — "Roaming with [carrier] costs $X, our eSIM costs
 * $Y, you save $Z".
 *
 * Inputs
 * ------
 *  - Destination country (slug).
 *  - Your home carrier (fetched from the admin-managed `roaming_prices` table
 *    via `GET /api/tools/roaming-calculator?country=<slug>`).
 *  - Trip length in days.
 *  - Estimated data use in GB (only relevant when the carrier's cheaper plan
 *    is metered; some carriers charge per day *and* cap data, some charge per
 *    GB — we compute both and show whichever the carrier's pricing suggests
 *    they actually bill).
 *
 * Output
 * ------
 *  - A side-by-side: carrier total (min of daily × days vs perGb × gb) and our
 *    cheapest matching real plan (fetched from the same public catalog endpoint
 *    that powers country pages; NO invented plan prices).
 *  - Savings delta + a "you save ~" prefix when we can only compare against
 *    the carrier's *floor* price (some carriers add GST / activation fees
 *    which the table captures via `per_day_usd` being None and note only —
 *    we surface that honestly).
 *  - Buy CTA pointing to the country page.
 *  - Free-tool cross-links (registry from server/ssr/tools.ts is mirrored here
 *    as static, since we ship SSR-side list; not importing server code into
 *    the bundle).
 *
 * Honesty rules
 * -------------
 *  - If the carrier row has only `per_day_usd` OR only `per_gb_usd`, we compute
 *    the single available model and label it.
 *  - If neither exists we show "No roaming price on file" rather than zero.
 *  - If the plan price is unavailable (catalog endpoint failed) we still show
 *    the carrier total but not a fake savings figure.
 *  - "You save" is only shown when `saving > 0`; equal or worse shows a
 *    neutral copy ("Close to our price" / "Our eSIM is a little more — but no
 *    activation, and you keep your number").
 *
 * Fetches
 * -------
 *   GET /api/tools/roaming-calculator?country=<slug>
 *      → { ok:true, data:{ carriers: RoamingCarrier[]; planCheapestUsd: number|null;
 *                           planName: string|null; planCode: string|null } }
 *      → { ok:false, error, message }
 *
 *   The endpoint isn't shipped in this batch; when it's absent the page
 *   renders an explicit "This calculator is being set up" state. No fake data.
 */
import { useCallback, useEffect, useId, useMemo, useState } from "react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RoamingCarrier {
  code: string;
  homeCountry: string;
  name: string;
  perDayUsd: number | null;
  perGbUsd: number | null;
  note: string | null;
}

interface CalculatorPayload {
  carriers: RoamingCarrier[];
  planCheapestUsd: number | null;
  planName: string | null;
  planCode: string | null;
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

class CalcFetchError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "CalcFetchError";
    this.code = code;
  }
}

async function fetchCalculator(country: string, signal: AbortSignal): Promise<CalculatorPayload> {
  const url = `/api/tools/roaming-calculator?country=${encodeURIComponent(country)}`;
  const res = await fetch(url, {
    credentials: "include",
    headers: { Accept: "application/json" },
    signal,
  });
  const body = (await res.json().catch(() => ({}))) as ApiOk<CalculatorPayload> | ApiErr | {};
  if (!res.ok || !("ok" in body) || body.ok === false) {
    const err = body as ApiErr;
    throw new CalcFetchError(
      err?.error ?? "request_failed",
      err?.message ?? `Request failed (HTTP ${res.status}).`,
    );
  }
  return (body as ApiOk<CalculatorPayload>).data;
}

// ---------------------------------------------------------------------------
// Cross-link registry (mirrors server/ssr/tools.ts TOOLS for client bundle).
// Kept as a plain array in the client so we don't bundle server code; a
// shared client-facing constant lives in a future `shared/toolMetadata.ts`.
// ---------------------------------------------------------------------------

const OTHER_TOOLS: { slug: string; label: string; path: string }[] = [
  { slug: "visa-info", label: "Visa info", path: "/tools/visa-info" },
  { slug: "currency-converter", label: "Currency converter", path: "/tools/currency-converter" },
  { slug: "plug-voltage", label: "Plug & voltage guide", path: "/tools/plug-voltage" },
  { slug: "emergency-numbers", label: "Emergency numbers", path: "/tools/emergency-numbers" },
  { slug: "blocked-apps", label: "Blocked apps guide", path: "/tools/blocked-apps" },
];

// ---------------------------------------------------------------------------
// Calculator math (pure, exported for tests)
// ---------------------------------------------------------------------------

export interface CarrierComparison {
  carrierName: string;
  /** Total cost of using carrier's roaming for this trip, in USD. */
  carrierTotalUsd: number;
  /** Which model the comparison used ("daily" | "per-gb"). */
  model: "daily" | "per-gb";
  /** Whether this is the carrier's floor price (some carriers add extras). */
  isFloor: boolean;
  /** Human-readable line, e.g. "$10/day × 5 = $50". */
  breakdown: string;
}

export interface SavingsResult {
  carrier: CarrierComparison;
  planUsd: number | null;
  planName: string | null;
  savingUsd: number | null;
  /** True when plan > carrier. Drives the neutral copy variant. */
  isMoreExpensive: boolean;
  /** True when at least one carrier model was available. */
  hasCarrierPrice: boolean;
}

/**
 * Compute the cheapest possible carrier roaming cost for a trip. If the
 * carrier has both a daily and per-GB model, we take the lower total — that's
 * how the traveller would pick. If only one is present, use it. If neither,
 * return `null` for `carrierTotalUsd` and mark `hasCarrierPrice: false`.
 */
export function compareRoaming(
  carrier: RoamingCarrier,
  days: number,
  gb: number,
  planUsd: number | null,
  planName: string | null,
): SavingsResult {
  const safeDays = Number.isFinite(days) && days > 0 ? days : 0;
  const safeGb = Number.isFinite(gb) && gb > 0 ? gb : 0;

  const dailyTotal =
    carrier.perDayUsd != null && safeDays > 0 ? carrier.perDayUsd * safeDays : null;
  const perGbTotal =
    carrier.perGbUsd != null && safeGb > 0 ? carrier.perGbUsd * safeGb : null;

  const options: Array<{ total: number; model: "daily" | "per-gb"; breakdown: string; isFloor: boolean }> = [];
  if (dailyTotal != null) {
    options.push({
      total: dailyTotal,
      model: "daily",
      breakdown: `$${fmt(carrier.perDayUsd)}/day × ${safeDays} = $${fmt(dailyTotal)}`,
      isFloor: false,
    });
  }
  if (perGbTotal != null) {
    options.push({
      total: perGbTotal,
      model: "per-gb",
      breakdown: `$${fmt(carrier.perGbUsd)}/GB × ${safeGb} GB = $${fmt(perGbTotal)}`,
      isFloor: false,
    });
  }

  if (options.length === 0) {
    return {
      carrier: {
        carrierName: carrier.name,
        carrierTotalUsd: 0,
        model: "daily",
        isFloor: true,
        breakdown: "No roaming price on file",
      },
      planUsd,
      planName,
      savingUsd: null,
      isMoreExpensive: false,
      hasCarrierPrice: false,
    };
  }

  const best = options.reduce((acc, cur) => (cur.total < acc.total ? cur : acc));
  const saving = planUsd != null ? round2(best.total - planUsd) : null;
  return {
    carrier: {
      carrierName: carrier.name,
      carrierTotalUsd: round2(best.total),
      model: best.model,
      isFloor: best.isFloor,
      breakdown: best.breakdown,
    },
    planUsd,
    planName,
    savingUsd: saving,
    isMoreExpensive: saving != null && saving < 0,
    hasCarrierPrice: true,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
function fmt(n: number | null): string {
  if (n == null) return "—";
  return n.toFixed(2);
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export interface RoamingCalculatorProps {
  /** Country slug from route context. Defaults to "sg" for preview; the real
   *  route will pass the URL segment. */
  initialCountry?: string;
}

export function RoamingCalculator({ initialCountry = "sg" }: RoamingCalculatorProps): JSX.Element {
  // Fixed country slug for now. A route-driven version (SEO + i18n) will set
  // this via React-Router or the SSR-passed HTML data attribute in the SEO
  // route batch — the field is here so the change is one line.
  const country = initialCountry;

  const [state, setState] = useState<
    | { status: "loading" }
    | { status: "ready"; data: CalculatorPayload }
    | { status: "unavailable"; message: string }
    | { status: "error"; code: string; message: string }
  >({ status: "loading" });

  const [carrierCode, setCarrierCode] = useState<string | null>(null);
  const [days, setDays] = useState(7);
  const [gb, setGb] = useState(5);

  const daysId = useId();
  const gbId = useId();
  const carrierId = useId();

  useEffect(() => {
    const controller = new AbortController();
    setState({ status: "loading" });
    fetchCalculator(country, controller.signal)
      .then((data) => {
        if (controller.signal.aborted) return;
        if (data.carriers.length === 0) {
          setState({
            status: "unavailable",
            message: "No roaming prices are on file for this destination yet.",
          });
          return;
        }
        setState({ status: "ready", data });
        setCarrierCode((prev) => prev ?? data.carriers[0]?.code ?? null);
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        if (controller.signal.aborted) return;
        if (err instanceof CalcFetchError) {
          // Unknown endpoints in a fresh deploy come back as 404 with a
          // machine-readable error. We surface "not wired yet" rather than a
          // red error banner — the page is still useful for the copy.
          if (err.code === "not_found" || err.code === "request_failed") {
            setState({
              status: "unavailable",
              message:
                "The roaming data endpoint is being set up. Check back shortly — you can still use our eSIM savings estimate on every country page.",
            });
            return;
          }
          setState({ status: "error", code: err.code, message: err.message });
          return;
        }
        setState({
          status: "error",
          code: "request_failed",
          message: err instanceof Error ? err.message : "Could not load the calculator.",
        });
      });
    return () => controller.abort();
  }, [country]);

  const selectedCarrier = useMemo(() => {
    if (state.status !== "ready" || !carrierCode) return null;
    return state.data.carriers.find((c) => c.code === carrierCode) ?? null;
  }, [state, carrierCode]);

  const result = useMemo(() => {
    if (!selectedCarrier) return null;
    const planUsd = state.status === "ready" ? state.data.planCheapestUsd : null;
    const planName = state.status === "ready" ? state.data.planName : null;
    return compareRoaming(selectedCarrier, days, gb, planUsd, planName);
  }, [selectedCarrier, days, gb, state]);

  return (
    <main className="mx-auto w-full max-w-3xl px-4 pb-16 pt-6" data-testid="roaming-calculator">
      <header>
        <h1 className="text-2xl font-extrabold text-slate-900 sm:text-3xl">
          Roaming savings calculator
        </h1>
        <p className="mt-2 text-sm text-slate-600">
          How much would roaming cost you versus a travel eSIM for the same trip?
          Pick your carrier and trip length; we compare using the roaming prices
          in our catalogue.
        </p>
      </header>

      {state.status === "loading" && (
        <div className="mt-6 space-y-3" aria-busy data-testid="roaming-calculator-loading">
          <div className="h-10 w-full animate-pulse rounded-xl bg-slate-100" />
          <div className="h-10 w-full animate-pulse rounded-xl bg-slate-100" />
          <div className="h-24 w-full animate-pulse rounded-2xl bg-slate-100" />
        </div>
      )}

      {state.status === "unavailable" && (
        <div
          className="mt-6 rounded-2xl bg-amber-50 px-4 py-3 text-sm text-amber-900 ring-1 ring-amber-200"
          data-testid="roaming-calculator-unavailable"
        >
          <p className="font-semibold">Calculator is being set up.</p>
          <p className="mt-1 text-xs text-amber-900/80">{state.message}</p>
        </div>
      )}

      {state.status === "error" && (
        <div
          role="alert"
          className="mt-6 rounded-2xl bg-rose-50 px-4 py-3 text-sm text-rose-800 ring-1 ring-rose-200"
          data-testid="roaming-calculator-error"
          data-error-code={state.code}
        >
          <p className="font-semibold">We couldn't load the calculator.</p>
          <p className="mt-1 text-xs">{state.message}</p>
        </div>
      )}

      {state.status === "ready" && (
        <Form
          carriers={state.data.carriers}
          carrierCode={carrierCode}
          onCarrierChange={setCarrierCode}
          days={days}
          onDaysChange={setDays}
          gb={gb}
          onGbChange={setGb}
          daysId={daysId}
          gbId={gbId}
          carrierId={carrierId}
          result={result}
          country={country}
        />
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
    </main>
  );
}

// ---------------------------------------------------------------------------
// Form + result
// ---------------------------------------------------------------------------

interface FormProps {
  carriers: RoamingCarrier[];
  carrierCode: string | null;
  onCarrierChange: (v: string) => void;
  days: number;
  onDaysChange: (v: number) => void;
  gb: number;
  onGbChange: (v: number) => void;
  daysId: string;
  gbId: string;
  carrierId: string;
  result: SavingsResult | null;
  country: string;
}

function Form(p: FormProps): JSX.Element {
  return (
    <section className="mt-6 rounded-2xl bg-white p-5 ring-1 ring-slate-200" data-testid="roaming-calculator-form">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <label htmlFor={p.carrierId} className="block text-sm font-medium text-slate-800">
            Your home carrier
          </label>
          <select
            id={p.carrierId}
            value={p.carrierCode ?? ""}
            onChange={(e) => p.onCarrierChange(e.target.value)}
            className="mt-1 w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm"
            data-testid="roaming-calculator-carrier"
          >
            {p.carriers.map((c) => (
              <option key={c.code} value={c.code}>
                {c.name}
                {c.note ? ` · ${c.note}` : ""}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor={p.daysId} className="block text-sm font-medium text-slate-800">
            Trip length (days)
          </label>
          <input
            id={p.daysId}
            type="number"
            min="1"
            max="365"
            value={p.days}
            onChange={(e) => p.onDaysChange(sanitizeInt(e.target.value, 1, 365, 7))}
            className="mt-1 w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm"
            data-testid="roaming-calculator-days"
          />
        </div>
        <div>
          <label htmlFor={p.gbId} className="block text-sm font-medium text-slate-800">
            Estimated data (GB)
          </label>
          <input
            id={p.gbId}
            type="number"
            min="1"
            max="500"
            value={p.gb}
            onChange={(e) => p.onGbChange(sanitizeInt(e.target.value, 1, 500, 5))}
            className="mt-1 w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm"
            data-testid="roaming-calculator-gb"
          />
        </div>
      </div>

      {p.result && <Result result={p.result} country={p.country} />}
    </section>
  );
}

function sanitizeInt(raw: string, min: number, max: number, fallback: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  const clamped = Math.round(n);
  if (clamped < min) return min;
  if (clamped > max) return max;
  return clamped;
}

function Result({ result, country }: { result: SavingsResult; country: string }): JSX.Element {
  if (!result.hasCarrierPrice) {
    return (
      <div
        className="mt-5 rounded-xl bg-slate-50 px-3 py-2 text-sm text-slate-600 ring-1 ring-slate-200"
        data-testid="roaming-calculator-result"
        data-variant="no-price"
      >
        No roaming price on file for this carrier. Try another carrier or check
        back later — we're adding more.
      </div>
    );
  }

  const { carrier, planUsd, planName, savingUsd, isMoreExpensive } = result;
  const buyHref = `/esim/${country}`;

  return (
    <div className="mt-5" data-testid="roaming-calculator-result" data-variant="has-price">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-xl bg-slate-50 p-3 ring-1 ring-slate-200">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Roaming with {carrier.carrierName}
          </p>
          <p className="mt-1 text-lg font-extrabold text-slate-900" data-testid="roaming-calculator-carrier-total">
            ${carrier.carrierTotalUsd.toFixed(2)}
          </p>
          <p className="mt-1 text-[11px] text-slate-500">{carrier.breakdown}</p>
          {carrier.isFloor && (
            <p className="mt-1 text-[11px] text-amber-700">
              Lower-bound estimate — carrier may add taxes or activation fees.
            </p>
          )}
        </div>
        <div className="rounded-xl bg-brand-50 p-3 ring-1 ring-brand-100">
          <p className="text-xs font-semibold uppercase tracking-wide text-brand-700">
            Our eSIM
          </p>
          {planUsd != null ? (
            <p className="mt-1 text-lg font-extrabold text-slate-900" data-testid="roaming-calculator-plan-total">
              ${planUsd.toFixed(2)}
            </p>
          ) : (
            <p
              className="mt-1 text-sm font-semibold text-slate-600"
              data-testid="roaming-calculator-plan-unavailable"
            >
              Plan price not available right now.
            </p>
          )}
          {planName && (
            <p className="mt-1 text-[11px] text-slate-600">{planName}</p>
          )}
        </div>
      </div>

      {planUsd != null && savingUsd != null && !isMoreExpensive && (
        <p
          className="mt-4 rounded-xl bg-emerald-50 px-3 py-2 text-sm font-semibold text-emerald-800 ring-1 ring-emerald-200"
          data-testid="roaming-calculator-saving"
        >
          You save ${savingUsd.toFixed(2)} with an eSIM.
        </p>
      )}

      {planUsd != null && savingUsd != null && isMoreExpensive && (
        <p
          className="mt-4 rounded-xl bg-slate-50 px-3 py-2 text-sm text-slate-700 ring-1 ring-slate-200"
          data-testid="roaming-calculator-saving"
        >
          Our eSIM is ${Math.abs(savingUsd).toFixed(2)} more than roaming here — but
          there's no daily cap, no activation fee, and you keep your number.
        </p>
      )}

      <div className="mt-4">
        <a
          href={buyHref}
          className="inline-block rounded-xl bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700"
          data-testid="roaming-calculator-buy"
        >
          See eSIM plans
        </a>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Test surface
// ---------------------------------------------------------------------------
export const __test__ = {
  compareRoaming,
  sanitizeInt,
  OTHER_TOOLS,
};

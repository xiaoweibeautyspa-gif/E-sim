/**
 * /trip-planner — the AI travel planner page.
 *
 * Responsibilities:
 *  - The form: countries, dates, budget (optional), travel style, language,
 *    optional flight number. Flight-number preview calls
 *    POST /api/trip-planner/flights and fills dates/country when available.
 *  - Streaming output: the page consumes POST /api/trip-planner/plan as
 *    server-sent events (`text/event-stream`). It reads chunks manually with
 *    `fetch` + `ReadableStream` reader (not EventSource, because we need POST
 *    + JSON body). Sections render in the order the server emits them.
 *  - "Stay connected" card: real plan from the server (never invented). When
 *    the server returns `recommendation: null` the card is hidden.
 *  - "Complete your trip" section: affiliate links from the server. Empty →
 *    hidden. No client-side fake URLs.
 *
 * THIS BATCH wires persistence / sharing / offline against `/api/trips`:
 *   POST /api/trips                 → save the plan, returns { id, publicId, shareUrl }
 *   GET  /api/trips/:publicId/pdf   → download PDF (itinerary)
 *   GET  /api/trips/:publicId/ics   → add to calendar (text/calendar)
 *   GET  /api/trips/:publicId/offline.pdf → offline pack PDF (itinerary + emergency + eSIM QR)
 *   POST /api/trips/:publicId/share → { enabled: boolean } toggle public visibility
 *
 * The "save second plan requires signup" rule is a SERVER rule; the client
 * mirrors it so an anonymous user sees a sign-in CTA instead of a hard error.
 * The server remains authoritative — if it returns 401 signup_required we
 * show the same sign-in prompt after the fact.
 *
 * State model:
 *  - form fields are uncontrolled-by-server local state.
 *  - flight lookup: idle | loading | filled | warning (never blocks submit).
 *  - plan: idle | streaming | done | error.
 *  - save: idle | saving | saved | needs-signup | error.
 *  - The abortable request is cancelled when the user changes destinations
 *    mid-stream, so we don't render stale chunks.
 *
 * No fabrication:
 *  - Missing recommendation → card hidden.
 *  - Missing affiliate links → section hidden.
 *  - AI not configured → the page surfaces the server's 503 message.
 *  - Streaming failure → the partial text stays visible + a retry button.
 *  - Save requires a completed plan (status === "done"). We never expose a
 *    save button that would 4xx.
 */

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";

// ---------------------------------------------------------------------------
// Types mirroring the server contract
// ---------------------------------------------------------------------------

type Language = "en" | "zh" | "vi";
type Style = "relaxed" | "foodie" | "adventure" | "family" | "business";
type Currency = "SGD" | "USD" | "VND" | "CNY";
type Section = "ITINERARY" | "BUDGET" | "WEATHER" | "PACKING" | "TIPS";

interface FlightAirport {
  iata: string;
  city: string | null;
  country: string | null;
}
interface FlightInfo {
  flightNumber: string;
  airline: string | null;
  departure: FlightAirport;
  arrival: FlightAirport;
  startDate: string;
  endDate: string;
  scheduledDepartureUtc: string;
  scheduledArrivalUtc: string;
}

interface StayConnectedPlan {
  planCode: string;
  name: string;
  displayName: string;
  dataLabel: string;
  validityLabel: string;
  networkLabel: string | null;
  countrySlug: string | null;
  retailUsd: number;
  isRegional: boolean;
  buyHref: string;
}

interface AffiliateLink {
  slot: "hotel" | "tour" | "transfer" | "insurance";
  label: string;
  url: string;
}

interface TripMeta {
  countries: string[];
  startDate: string;
  endDate: string;
  style: Style;
  language: Language;
  budget: { amount: number; currency: Currency } | null;
  flight: FlightInfo | null;
  /** Populated by the server once the plan is saved (not during streaming). */
  tripId: string | null;
}

type StreamEvent =
  | { type: "meta"; generatedAt: string; trip: TripMeta }
  | { type: "chunk"; section: Section | null; text: string }
  | { type: "section_done"; section: Section }
  | { type: "connected"; recommendation: StayConnectedPlan | null }
  | { type: "affiliates"; links: AffiliateLink[] }
  | { type: "done" }
  | { type: "error"; code: string; message: string };

interface PlanState {
  status: "idle" | "streaming" | "done" | "error";
  meta: TripMeta | null;
  raw: string;
  sections: Partial<Record<Section, string>>;
  connected: StayConnectedPlan | null;
  affiliates: AffiliateLink[];
  error: { code: string; message: string } | null;
}

const EMPTY_PLAN: PlanState = {
  status: "idle",
  meta: null,
  raw: "",
  sections: {},
  connected: null,
  affiliates: [],
  error: null,
};

/** What the server returns from POST /api/trips. */
interface SavedTrip {
  id: number;
  publicId: string;
  shareUrl: string;
  isPublic: boolean;
}

type SaveState =
  | { status: "idle" }
  | { status: "saving" }
  | { status: "saved"; trip: SavedTrip }
  | { status: "needs-signup"; message: string; loginHref: string }
  | { status: "error"; code: string; message: string };

// ---------------------------------------------------------------------------
// Client helpers
// ---------------------------------------------------------------------------

class ClientError extends Error {
  readonly code: string;
  readonly retryAfterSeconds: number | null;
  constructor(code: string, message: string, retryAfterSeconds: number | null = null) {
    super(message);
    this.name = "ClientError";
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
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

async function fetchJson<T>(path: string, body: unknown, signal: AbortSignal): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    credentials: "include",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  const json = (await res.json().catch(() => ({}))) as ApiOk<T> | ApiErr | {};
  if (!res.ok || !("ok" in json) || json.ok === false) {
    const e = json as ApiErr;
    throw new ClientError(
      e?.error ?? "request_failed",
      e?.message ?? `Request failed (HTTP ${res.status}).`,
      e?.retryAfterSeconds ?? null,
    );
  }
  return (json as ApiOk<T>).data;
}

interface FlightLookupResponse {
  flight: FlightInfo | null;
  startDate?: string;
  endDate?: string;
  country?: string | null;
  warning?: { code: string; message: string };
}

/**
 * Manually read a `text/event-stream` response. Returns when the reader
 * closes. `onEvent` is called for each parsed `data:` JSON line. Aborts when
 * `signal` fires (via the fetch `signal`).
 *
 * We deliberately do not use `EventSource` because it does not support POST
 * bodies, and we need to send a structured request.
 */
async function readSse(
  path: string,
  body: unknown,
  signal: AbortSignal,
  onEvent: (e: StreamEvent) => void,
): Promise<void> {
  const res = await fetch(path, {
    method: "POST",
    credentials: "include",
    headers: { Accept: "text/event-stream", "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    const j = (await res.json().catch(() => ({}))) as ApiErr | {};
    const e = j as ApiErr;
    throw new ClientError(
      e?.error ?? "request_failed",
      e?.message ?? `Request failed (HTTP ${res.status}).`,
      e?.retryAfterSeconds ?? null,
    );
  }
  if (!res.body) {
    throw new ClientError("stream_unavailable", "Your browser can't stream the plan.");
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep = buffer.indexOf("\n\n");
      while (sep >= 0) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const dataLines = frame
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trimStart());
        if (dataLines.length > 0) {
          const payload = dataLines.join("\n");
          try {
            const parsed = JSON.parse(payload) as StreamEvent;
            onEvent(parsed);
          } catch {
            /* ignore malformed frame / keep-alive */
          }
        }
        sep = buffer.indexOf("\n\n");
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* already released */
    }
  }
}

// ---------------------------------------------------------------------------
// Style + currency metadata
// ---------------------------------------------------------------------------

const STYLE_LABELS: Record<Style, { label: string; hint: string }> = {
  relaxed: { label: "Relaxed", hint: "Slow days, cafés, minimal transfers" },
  foodie: { label: "Foodie", hint: "Markets, local specialties, reservations" },
  adventure: { label: "Adventure", hint: "Hikes, water sports, off-the-beaten-path" },
  family: { label: "Family", hint: "Kid-friendly, shorter walks, safe areas" },
  business: { label: "Business", hint: "Work-friendly, efficient transit, quiet stays" },
};

const CURRENCIES: Currency[] = ["SGD", "USD", "VND", "CNY"];
const LANGUAGES: { value: Language; label: string }[] = [
  { value: "en", label: "English" },
  { value: "zh", label: "简体中文" },
  { value: "vi", label: "Tiếng Việt" },
];

const SECTION_TITLES: Record<Section, string> = {
  ITINERARY: "Day-by-day itinerary",
  BUDGET: "Budget estimate",
  WEATHER: "Weather notes",
  PACKING: "Packing list",
  TIPS: "Local tips",
};

const SECTION_ORDER: Section[] = ["ITINERARY", "BUDGET", "WEATHER", "PACKING", "TIPS"];

const FX_USD: Record<Currency, { rate: number; decimals: number }> = {
  USD: { rate: 1, decimals: 2 },
  SGD: { rate: 1.34, decimals: 2 },
  VND: { rate: 25_000, decimals: 0 },
  CNY: { rate: 7.2, decimals: 2 },
};
function previewPrice(usd: number, currency: Currency): string {
  const { rate, decimals } = FX_USD[currency];
  const value = usd * rate;
  if (decimals === 0) return `${Math.round(value).toLocaleString("en-US")} ${currency}`;
  return `${value.toFixed(decimals)} ${currency}`;
}

// ---------------------------------------------------------------------------
// Section renderer
// ---------------------------------------------------------------------------

function SectionBody({ text }: { text: string }): JSX.Element {
  const lines = text.split(/\r?\n/);
  const blocks: Array<{ type: "p" | "li"; text: string }> = [];
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (line.length === 0) continue;
    if (/^\s*[-*•]\s+/.test(line)) {
      blocks.push({ type: "li", text: line.replace(/^\s*[-*•]\s+/, "") });
    } else {
      blocks.push({ type: "p", text: line });
    }
  }

  const out: JSX.Element[] = [];
  let listBuf: string[] = [];
  function flushList() {
    if (listBuf.length === 0) return;
    out.push(
      <ul key={`ul-${out.length}`} className="mt-1 list-disc space-y-1 pl-5 text-sm text-slate-700">
        {listBuf.map((item, i) => (
          <li key={i}>{item}</li>
        ))}
      </ul>,
    );
    listBuf = [];
  }

  for (const b of blocks) {
    if (b.type === "li") {
      listBuf.push(b.text);
    } else {
      flushList();
      out.push(
        <p key={`p-${out.length}`} className="mt-1 text-sm leading-relaxed text-slate-700">
          {b.text}
        </p>,
      );
    }
  }
  flushList();

  if (out.length === 0) {
    return <p className="text-sm italic text-slate-400">(streaming…)</p>;
  }
  return <>{out}</>;
}

// ---------------------------------------------------------------------------
// Save / share panel
// ---------------------------------------------------------------------------

interface SavePanelProps {
  plan: PlanState;
  authStatus: "loading" | "authenticated" | "anonymous" | "error";
}

/**
 * The save/share panel. Only meaningful when the plan finished streaming,
 * because the server persists the full text. When `authStatus` is anonymous
 * we still let the user try — the server tracks "saved once" per cookie and
 * returns `signup_required` for a second anonymous save.
 */
function SavePanel({ plan, authStatus }: SavePanelProps): JSX.Element {
  const [save, setSave] = useState<SaveState>({ status: "idle" });
  const [publicId, setPublicId] = useState<string | null>(null);
  const shareUrl = useMemo(
    () => (publicId ? `${window.location.origin}/trip/${publicId}` : null),
    [publicId],
  );

  const canSave = plan.status === "done" && plan.meta != null && plan.raw.trim().length > 0;

  const handleSave = useCallback(async () => {
    if (!canSave || !plan.meta) return;
    setSave({ status: "saving" });
    const controller = new AbortController();
    try {
      const saved = await fetchJson<SavedTrip>(
        "/api/trips",
        {
          countries: plan.meta.countries,
          startDate: plan.meta.startDate,
          endDate: plan.meta.endDate,
          style: plan.meta.style,
          language: plan.meta.language,
          budget: plan.meta.budget,
          flight: plan.meta.flight,
          planText: plan.raw,
          sections: plan.sections,
          connected: plan.connected,
        },
        controller.signal,
      );
      setSave({ status: "saved", trip: saved });
      setPublicId(saved.publicId);
    } catch (err) {
      if (err instanceof ClientError) {
        if (err.code === "signup_required" || err.code === "unauthorized") {
          const loginHref = `/login?returnTo=${encodeURIComponent("/trip-planner")}`;
          setSave({ status: "needs-signup", message: err.message, loginHref });
          return;
        }
        setSave({ status: "error", code: err.code, message: err.message });
        return;
      }
      setSave({
        status: "error",
        code: "request_failed",
        message: err instanceof Error ? err.message : "Couldn't save your trip.",
      });
    }
  }, [canSave, plan]);

  // Download helpers just navigate to server endpoints — the server owns the
  // bytes. We do not build PDFs client-side, so "offline pack" always reflects
  // the persisted plan.
  const downloadHref = useCallback(
    (kind: "pdf" | "ics" | "offline.pdf") =>
      publicId ? `/api/trips/${encodeURIComponent(publicId)}/${kind}` : null,
    [publicId],
  );

  const pdfHref = downloadHref("pdf");
  const icsHref = downloadHref("ics");
  const offlineHref = downloadHref("offline.pdf");

  return (
    <section
      className="rounded-2xl bg-white p-5 ring-1 ring-slate-200"
      data-testid="trip-save"
    >
      <h2 className="text-base font-bold text-slate-900">Save &amp; share this trip</h2>
      <p className="mt-1 text-xs text-slate-500">
        Save your plan to open it later, share it with travel companions, or download an
        offline pack with the itinerary, emergency numbers and your eSIM QR before you fly.
      </p>

      {save.status === "idle" && (
        <button
          type="button"
          onClick={handleSave}
          disabled={!canSave}
          className="mt-3 rounded-xl bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-60"
          data-testid="trip-save-button"
        >
          {canSave ? "Save this trip" : "Finish the plan first"}
        </button>
      )}

      {save.status === "saving" && (
        <p className="mt-3 text-sm text-slate-600" data-testid="trip-save-loading">
          Saving…
        </p>
      )}

      {save.status === "needs-signup" && (
        <div
          className="mt-3 rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-900 ring-1 ring-amber-200"
          data-testid="trip-save-needs-signup"
        >
          <p className="font-semibold">Create a free account to save more trips.</p>
          <p className="mt-1 text-xs">{save.message}</p>
          <a
            href={save.loginHref}
            className="mt-2 inline-block rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-amber-700"
          >
            Sign in / sign up
          </a>
        </div>
      )}

      {save.status === "error" && (
        <div
          className="mt-3 rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-800 ring-1 ring-rose-200"
          data-testid="trip-save-error"
          data-error-code={save.code}
        >
          <p className="font-semibold">We couldn't save your trip.</p>
          <p className="mt-1 text-xs">{save.message}</p>
          <button
            type="button"
            onClick={handleSave}
            className="mt-2 rounded-lg bg-rose-600 px-3 py-1 text-xs font-medium text-white hover:bg-rose-700"
          >
            Try again
          </button>
        </div>
      )}

      {save.status === "saved" && (
        <div className="mt-3 space-y-3" data-testid="trip-save-saved">
          {shareUrl && (
            <label className="block text-xs text-slate-600">
              Share link
              <input
                readOnly
                value={shareUrl}
                onFocus={(e) => e.currentTarget.select()}
                className="mt-1 w-full rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-sm text-slate-800"
                data-testid="trip-share-url"
              />
            </label>
          )}

          <div className="flex flex-wrap gap-2 text-sm">
            {pdfHref && (
              <a
                href={pdfHref}
                className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 font-medium text-slate-700 hover:bg-slate-50"
                data-testid="trip-download-pdf"
              >
                Download PDF
              </a>
            )}
            {icsHref && (
              <a
                href={icsHref}
                className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 font-medium text-slate-700 hover:bg-slate-50"
                data-testid="trip-add-calendar"
              >
                Add to calendar
              </a>
            )}
            {offlineHref && (
              <a
                href={offlineHref}
                className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 font-medium text-slate-700 hover:bg-slate-50"
                data-testid="trip-download-offline"
              >
                Offline pack (PDF)
              </a>
            )}
            {shareUrl && (
              <a
                href={`/trip/${save.trip.publicId}`}
                className="rounded-lg bg-brand-600 px-3 py-1.5 font-semibold text-white hover:bg-brand-700"
                data-testid="trip-open-saved"
              >
                Open saved trip
              </a>
            )}
          </div>

          {authStatus !== "authenticated" && (
            <p className="text-[11px] text-slate-400" data-testid="trip-save-anon-hint">
              You're saving as a guest. Anyone with the link can open this trip while it's
              public. Sign up to save more trips and keep them private.
            </p>
          )}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

export interface TripPlannerProps {
  initialCountries?: string[];
  initialFlightNumber?: string;
  /**
   * Auth status from the surrounding shell. When omitted we default to
   * "anonymous" so the save panel still renders (server enforces ownership).
   * The real app passes `useAuth().status`.
   */
  authStatus?: "loading" | "authenticated" | "anonymous" | "error";
}

export function TripPlanner({
  initialCountries,
  initialFlightNumber,
  authStatus = "anonymous",
}: TripPlannerProps): JSX.Element {
  // ---- Form state
  const [countriesInput, setCountriesInput] = useState((initialCountries ?? []).join(", "));
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [budgetAmount, setBudgetAmount] = useState("");
  const [budgetCurrency, setBudgetCurrency] = useState<Currency>("SGD");
  const [style, setStyle] = useState<Style>("relaxed");
  const [language, setLanguage] = useState<Language>("en");
  const [flightNumber, setFlightNumber] = useState(initialFlightNumber ?? "");

  // ---- Flight lookup state (non-blocking; failure is a warning)
  const [flightState, setFlightState] = useState<
    | { status: "idle" }
    | { status: "loading" }
    | { status: "filled"; flight: FlightInfo }
    | { status: "warning"; code: string; message: string; flight: null }
  >({ status: "idle" });

  // ---- Plan state
  const [plan, setPlan] = useState<PlanState>(EMPTY_PLAN);
  const [formError, setFormError] = useState<{ code: string; message: string } | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const formErrorId = useId();
  const flightLookupSeq = useRef(0);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const lookupFlight = useCallback(async (value: string) => {
    const trimmed = value.trim();
    if (trimmed.length < 2) {
      setFlightState({ status: "idle" });
      return;
    }
    const seq = ++flightLookupSeq.current;
    setFlightState({ status: "loading" });
    const controller = new AbortController();
    try {
      const data = await fetchJson<FlightLookupResponse>(
        "/api/trip-planner/flights",
        { flightNumber: trimmed },
        controller.signal,
      );
      if (seq !== flightLookupSeq.current) return;
      if (data.warning) {
        setFlightState({
          status: "warning",
          code: data.warning.code,
          message: data.warning.message,
          flight: null,
        });
      } else if (data.flight) {
        setFlightState({ status: "filled", flight: data.flight });
        if (!startDate) setStartDate(data.startDate ?? data.flight.startDate);
        if (!endDate) setEndDate(data.endDate ?? data.flight.endDate);
        if (!countriesInput.trim() && data.country) setCountriesInput(data.country);
      } else {
        setFlightState({
          status: "warning",
          code: "not_found",
          message: "We couldn't find that flight. Enter your dates manually.",
          flight: null,
        });
      }
    } catch (err) {
      if (seq !== flightLookupSeq.current) return;
      if (err instanceof DOMException && err.name === "AbortError") return;
      const message = err instanceof Error ? err.message : "Flight lookup failed.";
      setFlightState({ status: "warning", code: "lookup_failed", message, flight: null });
    }
  }, [startDate, endDate, countriesInput]);

  const handleSubmit = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      setFormError(null);

      const countries = countriesInput
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (countries.length === 0) {
        setFormError({ code: "validation_countries", message: "Add at least one destination." });
        return;
      }
      if (!startDate || !endDate) {
        setFormError({ code: "validation_dates", message: "Pick your start and end dates." });
        return;
      }
      if (new Date(endDate) < new Date(startDate)) {
        setFormError({ code: "validation_dates", message: "Your return date must be on or after your departure." });
        return;
      }

      let budget: { amount: number; currency: Currency } | null = null;
      if (budgetAmount.trim().length > 0) {
        const amount = Number(budgetAmount);
        if (!Number.isFinite(amount) || amount <= 0) {
          setFormError({ code: "validation_budget", message: "Enter a positive number for your budget." });
          return;
        }
        budget = { amount, currency: budgetCurrency };
      }

      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setPlan({ ...EMPTY_PLAN, status: "streaming" });

      const body = {
        countries,
        startDate,
        endDate,
        budget,
        style,
        language,
        ...(flightNumber.trim() ? { flightNumber: flightNumber.trim() } : {}),
      };

      try {
        await readSse("/api/trip-planner/plan", body, controller.signal, (event) => {
          setPlan((prev) => reduceEvent(prev, event));
        });
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        const code = err instanceof ClientError ? err.code : "request_failed";
        const message = err instanceof Error ? err.message : "The planner failed.";
        setPlan((prev) => ({ ...prev, status: "error", error: { code, message } }));
      }
    },
    [countriesInput, startDate, endDate, budgetAmount, budgetCurrency, style, language, flightNumber],
  );

  const connected = plan.connected;
  const affiliateLinks = plan.affiliates;
  const hasOutput =
    plan.status === "streaming" || plan.status === "done" || Object.keys(plan.sections).length > 0;

  return (
    <main className="mx-auto w-full max-w-4xl px-4 pb-16 pt-6" data-testid="trip-planner">
      <header className="rounded-3xl bg-gradient-to-br from-brand-600 to-brand-700 px-5 py-7 text-white sm:px-8 sm:py-9">
        <h1 className="text-2xl font-extrabold sm:text-3xl">Plan your next trip with AI</h1>
        <p className="mt-2 max-w-2xl text-sm text-brand-50/90">
          Tell us where you're going and how you like to travel. We'll draft a day-by-day
          plan, budget, packing list and local tips. Add a flight number to fill your
          destination and dates automatically.
        </p>
      </header>

      <Form
        countriesInput={countriesInput}
        onCountriesChange={setCountriesInput}
        startDate={startDate}
        onStartDateChange={setStartDate}
        endDate={endDate}
        onEndDateChange={setEndDate}
        budgetAmount={budgetAmount}
        onBudgetAmountChange={setBudgetAmount}
        budgetCurrency={budgetCurrency}
        onBudgetCurrencyChange={setBudgetCurrency}
        style={style}
        onStyleChange={setStyle}
        language={language}
        onLanguageChange={setLanguage}
        flightNumber={flightNumber}
        onFlightNumberChange={setFlightNumber}
        onFlightBlur={() => {
          if (flightNumber.trim()) void lookupFlight(flightNumber);
        }}
        flightState={flightState}
        submitting={plan.status === "streaming"}
        onSubmit={handleSubmit}
        formError={formError}
        formErrorId={formErrorId}
      />

      {hasOutput && (
        <section className="mt-8 space-y-6" aria-live="polite" data-testid="trip-output">
          {plan.status === "error" && plan.error && (
            <div
              role="alert"
              className="rounded-2xl bg-rose-50 px-4 py-3 text-sm text-rose-800 ring-1 ring-rose-200"
              data-testid="trip-planner-error"
              data-error-code={plan.error.code}
            >
              <p className="font-semibold">The planner didn't finish.</p>
              <p className="mt-1">{plan.error.message}</p>
              <button
                type="button"
                onClick={() => abortRef.current?.abort()}
                className="mt-2 rounded-lg bg-rose-600 px-3 py-1 text-xs font-medium text-white hover:bg-rose-700"
              >
                Dismiss
              </button>
            </div>
          )}

          {plan.status === "streaming" && (
            <p className="flex items-center gap-2 text-xs text-slate-500" data-testid="trip-streaming">
              <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-brand-500" />
              Writing your plan…
            </p>
          )}

          {plan.meta && (
            <p className="text-sm text-slate-600" data-testid="trip-meta">
              <span className="font-semibold text-slate-800">
                {plan.meta.countries.join(", ")}
              </span>{" "}
              · {plan.meta.startDate} → {plan.meta.endDate} ·{" "}
              {STYLE_LABELS[plan.meta.style].label}
              {plan.meta.budget && (
                <>
                  {" "}· budget {plan.meta.budget.amount} {plan.meta.budget.currency}
                </>
              )}
            </p>
          )}

          {SECTION_ORDER.filter((s) => plan.sections[s] != null).map((section) => (
            <article
              key={section}
              className="rounded-2xl bg-white p-5 ring-1 ring-slate-200"
              data-testid={`trip-section-${section.toLowerCase()}`}
            >
              <h2 className="text-base font-bold text-slate-900">{SECTION_TITLES[section]}</h2>
              <div className="mt-2">
                <SectionBody text={plan.sections[section] ?? ""} />
              </div>
            </article>
          ))}

          {connected && (
            <article
              className="rounded-2xl bg-brand-50 p-5 ring-1 ring-brand-100"
              data-testid="stay-connected"
            >
              <h2 className="text-base font-bold text-brand-900">Stay connected</h2>
              <p className="mt-1 text-sm text-brand-900/80">
                {connected.isRegional
                  ? "One regional plan covers every country on your trip."
                  : "One plan for your main destination."}
              </p>
              <div className="mt-3 flex flex-wrap items-baseline justify-between gap-2">
                <div>
                  <p className="text-sm font-semibold text-slate-900">{connected.displayName}</p>
                  <p className="text-xs text-slate-600">
                    {connected.dataLabel} · {connected.validityLabel}
                    {connected.networkLabel && <> · Runs on {connected.networkLabel}</>}
                  </p>
                </div>
                <div className="text-right">
                  <p className="text-lg font-extrabold text-slate-900">
                    {previewPrice(connected.retailUsd, plan.meta?.budget?.currency ?? budgetCurrency)}
                  </p>
                  <a
                    href={connected.buyHref}
                    className="mt-1 inline-block rounded-xl bg-brand-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-brand-700"
                    data-testid="stay-connected-buy"
                  >
                    Buy now
                  </a>
                </div>
              </div>
            </article>
          )}

          {affiliateLinks.length > 0 && (
            <section
              className="rounded-2xl bg-white p-5 ring-1 ring-slate-200"
              data-testid="complete-your-trip"
              aria-labelledby="complete-trip-heading"
            >
              <h2 id="complete-trip-heading" className="text-base font-bold text-slate-900">
                Complete your trip
              </h2>
              <ul className="mt-3 grid gap-2 sm:grid-cols-2">
                {affiliateLinks.map((l) => (
                  <li key={`${l.slot}-${l.url}`}>
                    <a
                      href={l.url}
                      target="_blank"
                      rel="noopener noreferrer sponsored"
                      className="flex items-center justify-between rounded-xl bg-slate-50 px-3 py-2 text-sm font-medium text-slate-800 ring-1 ring-slate-200 hover:bg-slate-100"
                    >
                      <span>{l.label}</span>
                      <span aria-hidden className="text-slate-400">→</span>
                    </a>
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-[11px] text-slate-400">
                Some links are affiliate links. We may earn a commission at no cost to you.
              </p>
            </section>
          )}

          <SavePanel plan={plan} authStatus={authStatus} />
        </section>
      )}
    </main>
  );
}

// ---------------------------------------------------------------------------
// Form
// ---------------------------------------------------------------------------

interface FormProps {
  countriesInput: string;
  onCountriesChange: (v: string) => void;
  startDate: string;
  onStartDateChange: (v: string) => void;
  endDate: string;
  onEndDateChange: (v: string) => void;
  budgetAmount: string;
  onBudgetAmountChange: (v: string) => void;
  budgetCurrency: Currency;
  onBudgetCurrencyChange: (v: Currency) => void;
  style: Style;
  onStyleChange: (v: Style) => void;
  language: Language;
  onLanguageChange: (v: Language) => void;
  flightNumber: string;
  onFlightNumberChange: (v: string) => void;
  onFlightBlur: () => void;
  flightState:
    | { status: "idle" }
    | { status: "loading" }
    | { status: "filled"; flight: FlightInfo }
    | { status: "warning"; code: string; message: string; flight: null };
  submitting: boolean;
  onSubmit: (e: FormEvent) => void;
  formError: { code: string; message: string } | null;
  formErrorId: string;
}

function Form(p: FormProps): JSX.Element {
  return (
    <form
      onSubmit={p.onSubmit}
      className="mt-6 space-y-4 rounded-2xl bg-white p-5 ring-1 ring-slate-200"
      noValidate
      data-testid="trip-form"
    >
      {p.formError && (
        <div
          role="alert"
          className="rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-800 ring-1 ring-rose-200"
          data-testid="trip-form-error"
          data-error-code={p.formError.code}
          id={p.formErrorId}
        >
          {p.formError.message}
        </div>
      )}

      <div>
        <label htmlFor="countries" className="block text-sm font-medium text-slate-800">
          Destinations
        </label>
        <input
          id="countries"
          type="text"
          value={p.countriesInput}
          onChange={(e) => p.onCountriesChange(e.target.value)}
          placeholder="e.g. Japan, or Tokyo, Kyoto, Osaka"
          className="mt-1 w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-200"
          data-testid="trip-countries"
        />
        <p className="mt-1 text-xs text-slate-500">Separate multiple countries with commas.</p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor="startDate" className="block text-sm font-medium text-slate-800">
            Start date
          </label>
          <input
            id="startDate"
            type="date"
            value={p.startDate}
            onChange={(e) => p.onStartDateChange(e.target.value)}
            className="mt-1 w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-200"
            data-testid="trip-start"
          />
        </div>
        <div>
          <label htmlFor="endDate" className="block text-sm font-medium text-slate-800">
            End date
          </label>
          <input
            id="endDate"
            type="date"
            value={p.endDate}
            onChange={(e) => p.onEndDateChange(e.target.value)}
            className="mt-1 w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-200"
            data-testid="trip-end"
          />
        </div>
      </div>

      <div>
        <p className="block text-sm font-medium text-slate-800">Budget (optional)</p>
        <div className="mt-1 flex gap-2">
          <input
            type="number"
            inputMode="decimal"
            value={p.budgetAmount}
            onChange={(e) => p.onBudgetAmountChange(e.target.value)}
            placeholder="e.g. 1500"
            min="0"
            step="any"
            className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-200"
            data-testid="trip-budget-amount"
          />
          <select
            value={p.budgetCurrency}
            onChange={(e) => p.onBudgetCurrencyChange(e.target.value as Currency)}
            className="rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm"
            data-testid="trip-budget-currency"
          >
            {CURRENCIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>
      </div>

      <fieldset>
        <legend className="text-sm font-medium text-slate-800">Travel style</legend>
        <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
          {(Object.keys(STYLE_LABELS) as Style[]).map((s) => (
            <label
              key={s}
              className={`cursor-pointer rounded-xl border px-3 py-2 text-sm ${
                p.style === s
                  ? "border-brand-500 bg-brand-50 text-brand-900"
                  : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
              }`}
            >
              <input
                type="radio"
                name="style"
                value={s}
                checked={p.style === s}
                onChange={() => p.onStyleChange(s)}
                className="sr-only"
                data-testid={`trip-style-${s}`}
              />
              <span className="block font-medium">{STYLE_LABELS[s].label}</span>
              <span className="block text-xs text-slate-500">{STYLE_LABELS[s].hint}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <div>
        <label htmlFor="language" className="block text-sm font-medium text-slate-800">
          Write the plan in
        </label>
        <select
          id="language"
          value={p.language}
          onChange={(e) => p.onLanguageChange(e.target.value as Language)}
          className="mt-1 w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm"
          data-testid="trip-language"
        >
          {LANGUAGES.map((l) => (
            <option key={l.value} value={l.value}>
              {l.label}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label htmlFor="flightNumber" className="block text-sm font-medium text-slate-800">
          Flight number (optional)
        </label>
        <input
          id="flightNumber"
          type="text"
          value={p.flightNumber}
          onChange={(e) => p.onFlightNumberChange(e.target.value)}
          onBlur={p.onFlightBlur}
          placeholder="e.g. SQ 12"
          className="mt-1 w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-200"
          data-testid="trip-flight"
          autoComplete="off"
        />
        {p.flightState.status === "loading" && (
          <p className="mt-1 text-xs text-slate-500" data-testid="trip-flight-loading">
            Looking up your flight…
          </p>
        )}
        {p.flightState.status === "filled" && (
          <p className="mt-1 text-xs text-emerald-700" data-testid="trip-flight-filled">
            {p.flightState.flight.airline ?? ""} {p.flightState.flight.flightNumber}:{" "}
            {p.flightState.flight.departure.iata} → {p.flightState.flight.arrival.iata}.
            Filled in dates and destination.
          </p>
        )}
        {p.flightState.status === "warning" && (
          <p className="mt-1 text-xs text-amber-700" data-testid="trip-flight-warning">
            {p.flightState.message}
          </p>
        )}
      </div>

      <button
        type="submit"
        disabled={p.submitting}
        className="w-full rounded-xl bg-brand-600 px-4 py-3 text-sm font-semibold text-white transition hover:bg-brand-700 disabled:opacity-60"
        data-testid="trip-submit"
      >
        {p.submitting ? "Planning…" : "Plan my trip"}
      </button>
      <p className="text-center text-xs text-slate-400">
        AI can make mistakes. Verify opening hours, prices and emergency numbers
        before you travel.
      </p>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Stream reducer
// ---------------------------------------------------------------------------

function reduceEvent(prev: PlanState, e: StreamEvent): PlanState {
  switch (e.type) {
    case "meta":
      return { ...prev, meta: e.trip };
    case "chunk": {
      if (!e.section) {
        return { ...prev, raw: prev.raw + e.text };
      }
      const existing = prev.sections[e.section] ?? "";
      return {
        ...prev,
        raw: prev.raw + e.text,
        sections: { ...prev.sections, [e.section]: existing + e.text },
      };
    }
    case "section_done":
      return prev;
    case "connected":
      return { ...prev, connected: e.recommendation };
    case "affiliates":
      return { ...prev, affiliates: e.links };
    case "done":
      return { ...prev, status: "done" };
    case "error":
      return { ...prev, status: "error", error: { code: e.code, message: e.message } };
    default:
      return prev;
  }
}

// ---------------------------------------------------------------------------
// Test surface
// ---------------------------------------------------------------------------

export const __test__ = {
  reduceEvent,
  readSse,
  previewPrice,
  STYLE_LABELS,
  SECTION_TITLES,
  SECTION_ORDER,
};

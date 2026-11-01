/**
 * /trip/[id] — the shareable, public trip page.
 *
 * This is the render surface for trips saved by the trip planner. It is
 * read-only: a visitor can view the itinerary, budget, weather, packing, tips,
 * the recommended eSIM, "complete your trip" affiliate links, and download the
 * PDF / add-to-calendar / offline pack, but cannot edit anything.
 *
 * Data contract (from server/routes/trips.ts, delivered in the previous batch):
 *
 *   GET /api/trips/public/:publicId
 *     → 200 { ok:true, data: { trip: PublicTrip } }
 *     → 404 { ok:false, error:"trip_not_found", message }
 *     → 500 { ok:false, error:"internal_error", message }
 *
 *   POST /api/trips/:publicId/pdf              (binary application/pdf)
 *   POST /api/trips/:publicId/calendar         (text/calendar .ics)
 *   POST /api/trips/:publicId/offline-pack     (binary application/pdf)
 *
 *   All three take the empty body; they are POSTs so the server can log the
 *   download for analytics without needing a signed URL. They DO NOT mutate
 *   the trip.
 *
 * Server-side "PublicTrip" shape (documented in server/services/tripExport.ts
 * and server/routes/trips.ts):
 *
 *   {
 *     publicId:     string;
 *     countries:    string[];
 *     startDate:    string;    // YYYY-MM-DD
 *     endDate:      string;    // YYYY-MM-DD
 *     departureDate:string;    // YYYY-MM-DD
 *     style:        'relaxed' | 'foodie' | 'adventure' | 'family' | 'business';
 *     language:     'en' | 'zh' | 'vi';
 *     planText:     string;    // raw Markdown-ish model output
 *     sections:     { ITINERARY?: string; BUDGET?: string; WEATHER?: string;
 *                     PACKING?: string; TIPS?: string };
 *     meta:         { budget?: { amount:number; currency:'SGD'|'USD'|'VND'|'CNY' } | null;
 *                     flight?: { flightNumber:string; airline:string|null;
 *                               departure:{iata:string}; arrival:{iata:string} } | null;
 *                     recommendation?: StayConnectedPlan | null;
 *                     affiliates?: AffiliateLink[] };
 *     createdAt:    string;
 *     ownerName:    string | null;   // never the email
 *   }
 *
 * Why the sections field AND planText exist:
 *   The planner route streams section-tagged chunks; the persistence layer
 *   stores `planText` verbatim (as the source of truth) and derives `sections`
 *   on save. Sharing renders `sections`. If the server ever changes the
 *   derivation and a section goes missing, we fall back to nothing rather than
 *   duplicating content under the wrong header.
 *
 * OG meta:
 *   This component is a client page. The server-rendered HTML for /trip/[id]
 *   is produced by the SEO/SSR phase and injects the <meta property="og:*">
 *   tags into the shell. From this component we set a small amount of
 *   additional document metadata (page title, canonical link) as a defence
 *   against a bare client render (e.g. dev mode, or a direct hit before the
 *   SSR layer catches up). We do NOT try to inject og:image from JS: crawlers
 *   that matter (WhatsApp, iMessage, Slack, Twitter, Facebook, LinkedIn) do
 *   not execute JavaScript for og:* extraction, so an SSR-rendered tag is the
 *   only one that works. This is documented as a limitation of the client
 *   page rather than pretending the JS injection helps.
 *
 * Actions:
 *   - "Save PDF"        → POST /api/trips/:publicId/pdf
 *   - "Add to calendar" → POST /api/trips/:publicId/calendar
 *   - "Offline pack"    → POST /api/trips/:publicId/offline-pack
 *   Each action triggers a browser download. We do not need to parse the
 *   content, and we never assume the server succeeded — the browser download
 *   only fires after the HTTP 200.
 *
 * States:
 *   loading | ready | not_found | error | downloading(actionLabel).
 *
 * Mobile-first, same Tailwind primitives as TripPlanner.tsx (rounded-2xl,
 * ring-1 ring-slate-200, bg-brand-50), so a shared link feels like the same
 * product.
 *
 * Test hooks:
 *   data-testid="public-trip"
 *   data-testid="public-trip-loading"
 *   data-testid="public-trip-not-found"
 *   data-testid="public-trip-error"
 *   data-testid="public-trip-section-itinerary" (and budget/weather/packing/tips)
 *   data-testid="public-trip-stay-connected"
 *   data-testid="public-trip-affiliates"
 *   data-testid="public-trip-download-pdf"
 *   data-testid="public-trip-download-calendar"
 *   data-testid="public-trip-download-offline-pack"
 *
 * The tests that use these hooks are shipped in a later batch
 * (server/routes/trips.test.ts), not here — this response only ships the
 * component. Those tests will mount the component with a fake `fetch` that
 * returns the shape documented above.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Style = "relaxed" | "foodie" | "adventure" | "family" | "business";
type Language = "en" | "zh" | "vi";
type Currency = "SGD" | "USD" | "VND" | "CNY";
type SectionKey = "ITINERARY" | "BUDGET" | "WEATHER" | "PACKING" | "TIPS";

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

interface PublicTripFlight {
  flightNumber: string;
  airline: string | null;
  departure: { iata: string; city?: string | null };
  arrival: { iata: string; city?: string | null };
}

interface PublicTrip {
  publicId: string;
  countries: string[];
  startDate: string;
  endDate: string;
  departureDate: string;
  style: Style;
  language: Language;
  planText: string;
  sections: Partial<Record<SectionKey, string>>;
  meta: {
    budget?: { amount: number; currency: Currency } | null;
    flight?: PublicTripFlight | null;
    recommendation?: StayConnectedPlan | null;
    affiliates?: AffiliateLink[];
  };
  createdAt: string;
  ownerName: string | null;
}

interface FetchState {
  status: "loading" | "ready" | "not_found" | "error";
  trip: PublicTrip | null;
  errorMessage: string | null;
}

interface DownloadState {
  /** Which action is currently downloading; null when idle. */
  action: "pdf" | "calendar" | "offline-pack" | null;
  error: { action: string; message: string } | null;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STYLE_LABEL: Record<Style, string> = {
  relaxed: "Relaxed",
  foodie: "Foodie",
  adventure: "Adventure",
  family: "Family",
  business: "Business",
};

const SECTION_ORDER: SectionKey[] = ["ITINERARY", "BUDGET", "WEATHER", "PACKING", "TIPS"];

const SECTION_TITLE: Record<SectionKey, string> = {
  ITINERARY: "Day-by-day itinerary",
  BUDGET: "Budget estimate",
  WEATHER: "Weather notes",
  PACKING: "Packing list",
  TIPS: "Local tips",
};

/**
 * Small USD → display price helper. Mirrors the same fallback the planner page
 * uses so a shared link and a freshly-planned trip look consistent. Server
 * always persists the recommendation at USD retail; the page only re-labels.
 */
const FX_USD: Record<Currency, { rate: number; decimals: number }> = {
  USD: { rate: 1, decimals: 2 },
  SGD: { rate: 1.34, decimals: 2 },
  VND: { rate: 25_000, decimals: 0 },
  CNY: { rate: 7.2, decimals: 2 },
};
function formatUsdAs(usd: number, currency: Currency): string {
  const { rate, decimals } = FX_USD[currency];
  const v = usd * rate;
  if (decimals === 0) return `${Math.round(v).toLocaleString("en-US")} ${currency}`;
  return `${v.toFixed(decimals)} ${currency}`;
}

// ---------------------------------------------------------------------------
// Fetch helpers
// ---------------------------------------------------------------------------

/**
 * Normalise the { publicId } from the route path. `/trip/[id]` is a client
 * route; we read the id from the URL directly. Base32-ish tokens the DB emits
 * are `[a-z0-9]+` and 12 chars — but we don't enforce that here (server 404s
 * on garbage) so the browser bookmark never breaks if the format evolves.
 */
function readPublicId(): string {
  // /trip/ABC123  → "ABC123"; /trip/ABC123/anything → "ABC123"
  const parts = window.location.pathname.split("/").filter(Boolean);
  return parts[1] ?? "";
}

class PublicTripFetchError extends Error {
  readonly httpStatus: number;
  readonly code: string;
  constructor(httpStatus: number, code: string, message: string) {
    super(message);
    this.name = "PublicTripFetchError";
    this.httpStatus = httpStatus;
    this.code = code;
  }
}

async function fetchPublicTrip(publicId: string, signal: AbortSignal): Promise<PublicTrip> {
  const res = await fetch(`/api/trips/public/${encodeURIComponent(publicId)}`, {
    method: "GET",
    credentials: "omit", // shared links are public; no session cookies needed
    headers: { Accept: "application/json" },
    signal,
  });
  const body = (await res.json().catch(() => ({}))) as
    | { ok: true; data: { trip: PublicTrip } }
    | { ok: false; error: string; message: string }
    | Record<string, unknown>;

  if (res.status === 404 || (body as { ok?: false }).ok === false) {
    const err = body as { ok: false; error: string; message: string };
    if (err.ok === false) {
      throw new PublicTripFetchError(
        res.status,
        err.error,
        err.message || "This trip could not be found.",
      );
    }
  }
  if (!res.ok) {
    throw new PublicTripFetchError(
      res.status,
      "http_error",
      `The server responded with HTTP ${res.status}.`,
    );
  }
  if (!("ok" in body) || body.ok !== true) {
    throw new PublicTripFetchError(
      res.status,
      "invalid_response",
      "The server returned an unexpected response.",
    );
  }
  return body.data.trip;
}

/**
 * Trigger a binary download from a POST endpoint. We do NOT assume the
 * server succeeded: we only call `URL.createObjectURL` + `.click()` on a 200.
 * Non-200 responses are read as JSON when possible so the error toast can
 * show the server's message.
 */
async function downloadFile(
  url: string,
  fallbackFilename: string,
  signal: AbortSignal,
): Promise<void> {
  const res = await fetch(url, {
    method: "POST",
    credentials: "omit",
    signal,
    // Use the server's Content-Disposition filename when present, so the
    // downloaded file is named consistently on every browser.
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as
      | { message?: string; error?: string }
      | null;
    throw new Error(
      body?.message || body?.error || `Download failed (HTTP ${res.status}).`,
    );
  }

  // Derive filename from Content-Disposition if present.
  let filename = fallbackFilename;
  const cd = res.headers.get("content-disposition") ?? "";
  const match = /filename\*?=(?:UTF-8''|")?([^\";]+)/i.exec(cd);
  if (match && match[1]) {
    try {
      filename = decodeURIComponent(match[1].replace(/["']/g, "").trim());
    } catch {
      filename = match[1].replace(/["']/g, "").trim();
    }
  }

  const blob = await res.blob();
  const objectUrl = URL.createObjectURL(blob);
  try {
    const a = document.createElement("a");
    a.href = objectUrl;
    a.download = filename;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    // Revoke after a tick; some browsers need the URL live for one frame after
    // the click before they've started reading the blob.
    setTimeout(() => URL.revokeObjectURL(objectUrl), 1_000);
  }
}

// ---------------------------------------------------------------------------
// Section renderer (same rules as TripPlanner.tsx so shared pages look alike)
// ---------------------------------------------------------------------------

function SectionBody({ text }: { text: string }): JSX.Element {
  const lines = text.split(/\r?\n/);
  const out: JSX.Element[] = [];
  let listBuf: string[] = [];
  function flush() {
    if (listBuf.length === 0) return;
    out.push(
      <ul
        key={`ul-${out.length}`}
        className="mt-1 list-disc space-y-1 pl-5 text-sm text-slate-700"
      >
        {listBuf.map((t, i) => (
          <li key={i}>{t}</li>
        ))}
      </ul>,
    );
    listBuf = [];
  }
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (line.length === 0) continue;
    if (/^\s*[-*•]\s+/.test(line)) {
      listBuf.push(line.replace(/^\s*[-*•]\s+/, ""));
    } else {
      flush();
      out.push(
        <p key={`p-${out.length}`} className="mt-1 text-sm leading-relaxed text-slate-700">
          {line}
        </p>,
      );
    }
  }
  flush();
  if (out.length === 0) {
    return <p className="text-sm italic text-slate-400">(empty)</p>;
  }
  return <>{out}</>;
}

// ---------------------------------------------------------------------------
// Sub-views
// ---------------------------------------------------------------------------

function LoadingView(): JSX.Element {
  return (
    <main
      className="mx-auto w-full max-w-3xl px-4 py-10"
      aria-busy
      data-testid="public-trip-loading"
    >
      <div className="h-8 w-48 animate-pulse rounded bg-slate-100" />
      <div className="mt-4 h-4 w-64 animate-pulse rounded bg-slate-100" />
      <div className="mt-8 space-y-4">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-40 animate-pulse rounded-2xl bg-slate-100" />
        ))}
      </div>
    </main>
  );
}

function NotFoundView(): JSX.Element {
  return (
    <main
      className="mx-auto w-full max-w-md px-4 py-16 text-center"
      data-testid="public-trip-not-found"
    >
      <h1 className="text-2xl font-extrabold text-slate-900">This trip was not found</h1>
      <p className="mt-2 text-sm text-slate-600">
        The link may have expired, or the person who shared it made it private.
      </p>
      <a
        href="/trip-planner"
        className="mt-6 inline-block rounded-xl bg-brand-600 px-4 py-2 font-semibold text-white hover:bg-brand-700"
      >
        Plan your own trip
      </a>
    </main>
  );
}

function ErrorView({ message }: { message: string }): JSX.Element {
  return (
    <main
      className="mx-auto w-full max-w-md px-4 py-16 text-center"
      data-testid="public-trip-error"
    >
      <h1 className="text-xl font-bold text-slate-900">We couldn't load this trip</h1>
      <p className="mt-2 text-sm text-slate-600">{message}</p>
      <button
        type="button"
        onClick={() => window.location.reload()}
        className="mt-6 rounded-xl bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700"
      >
        Reload
      </button>
    </main>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export interface PublicTripPageProps {
  /**
   * Override the trip id for tests. In production, leave undefined: the page
   * reads it from window.location.pathname.
   */
  publicId?: string;
  /**
   * Override the fetch implementation. Tests inject this; production uses
   * fetch. Kept as a prop (not a module global) so two tests can run in
   * parallel without racing.
   */
  fetcher?: typeof fetch;
}

export function PublicTripPage(props: PublicTripPageProps = {}): JSX.Element {
  const publicId = props.publicId ?? readPublicId();

  const [state, setState] = useState<FetchState>({
    status: "loading",
    trip: null,
    errorMessage: null,
  });
  const [download, setDownload] = useState<DownloadState>({ action: null, error: null });

  const abortRef = useRef<AbortController | null>(null);

  // Load the trip once per publicId. The page is read-only, so no refresh
  // button is required: a static shareable page can be reloaded, which is
  // what a recipient does naturally.
  useEffect(() => {
    if (!publicId) {
      setState({
        status: "not_found",
        trip: null,
        errorMessage: null,
      });
      return;
    }
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setState({ status: "loading", trip: null, errorMessage: null });

    const fetcher = props.fetcher ?? fetch;
    // The helper `fetchPublicTrip` uses the global fetch; if a fetcher is
    // supplied we wrap it minimally by passing through the same shape. This
    // is the only reason we don't call fetchPublicTrip here.
    if (props.fetcher) {
      fetcher(`/api/trips/public/${encodeURIComponent(publicId)}`, {
        method: "GET",
        credentials: "omit",
        headers: { Accept: "application/json" },
        signal: controller.signal,
      })
        .then(async (res) => {
          const body = (await res.json().catch(() => ({}))) as
            | { ok: true; data: { trip: PublicTrip } }
            | { ok: false; error: string; message: string };
          if (res.status === 404) {
            if (!controller.signal.aborted) {
              setState({ status: "not_found", trip: null, errorMessage: null });
            }
            return;
          }
          if (!res.ok || !("ok" in body) || body.ok !== true) {
            const msg =
              "ok" in body && body.ok === false
                ? body.message
                : `The server responded with HTTP ${res.status}.`;
            if (!controller.signal.aborted) {
              setState({ status: "error", trip: null, errorMessage: msg });
            }
            return;
          }
          if (!controller.signal.aborted) {
            setState({ status: "ready", trip: body.data.trip, errorMessage: null });
          }
        })
        .catch((err: unknown) => {
          if (err instanceof DOMException && err.name === "AbortError") return;
          if (controller.signal.aborted) return;
          setState({
            status: "error",
            trip: null,
            errorMessage:
              err instanceof Error ? err.message : "Could not load this trip.",
          });
        });
      return () => controller.abort();
    }

    fetchPublicTrip(publicId, controller.signal)
      .then((trip) => {
        if (controller.signal.aborted) return;
        setState({ status: "ready", trip, errorMessage: null });
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        if (controller.signal.aborted) return;
        if (err instanceof PublicTripFetchError && err.httpStatus === 404) {
          setState({ status: "not_found", trip: null, errorMessage: null });
          return;
        }
        setState({
          status: "error",
          trip: null,
          errorMessage:
            err instanceof Error ? err.message : "Could not load this trip.",
        });
      });

    return () => controller.abort();
  }, [publicId, props.fetcher]);

  // ---- Document metadata for direct client hits.
  // The SSR layer (SEO phase) renders the canonical og:* tags server-side.
  // This useEffect can only fix the <title>/<link rel=canonical>; it cannot
  // make a JS-less crawler see og:image, which is why the SSR phase matters.
  useEffect(() => {
    if (state.status !== "ready" || !state.trip) return;
    const t = state.trip;
    const title = `${t.countries.join(", ")} · ${t.startDate} → ${t.endDate}`;
    const original = document.title;
    document.title = `${title} · Trip plan`;
    const existing = document.querySelector<HTMLLinkElement>('link[rel="canonical"]');
    const prevHref = existing?.href ?? null;
    let node = existing;
    if (!node) {
      node = document.createElement("link");
      node.rel = "canonical";
      document.head.appendChild(node);
    }
    node.href = `${window.location.origin}/trip/${t.publicId}`;
    return () => {
      document.title = original;
      if (node) {
        if (prevHref) node.href = prevHref;
        else node.remove();
      }
    };
  }, [state]);

  // ---- Download handlers -------------------------------------------------
  const triggerDownload = useCallback(
    async (action: DownloadState["action"] & ("pdf" | "calendar" | "offline-pack")) => {
      if (!publicId) return;
      const map: Record<typeof action, { path: string; filename: string }> = {
        pdf: {
          path: `/api/trips/${encodeURIComponent(publicId)}/pdf`,
          filename: `trip-${publicId}.pdf`,
        },
        calendar: {
          path: `/api/trips/${encodeURIComponent(publicId)}/calendar`,
          filename: `trip-${publicId}.ics`,
        },
        "offline-pack": {
          path: `/api/trips/${encodeURIComponent(publicId)}/offline-pack`,
          filename: `trip-${publicId}-offline.pdf`,
        },
      };
      const { path, filename } = map[action];
      setDownload({ action, error: null });
      const controller = new AbortController();
      try {
        await downloadFile(path, filename, controller.signal);
        setDownload({ action: null, error: null });
      } catch (err) {
        setDownload({
          action: null,
          error: {
            action,
            message: err instanceof Error ? err.message : "Download failed.",
          },
        });
      }
    },
    [publicId],
  );

  // ---- Derived view data
  const currency: Currency = state.trip?.meta.budget?.currency ?? "USD";
  const recommended = state.trip?.meta.recommendation ?? null;
  const affiliates = state.trip?.meta.affiliates ?? [];
  const sectionsPresent = useMemo(
    () =>
      state.trip
        ? SECTION_ORDER.filter((k) => Boolean(state.trip?.sections[k]))
        : [],
    [state.trip],
  );

  // ---- Render switch -----------------------------------------------------
  if (state.status === "loading") return <LoadingView />;
  if (state.status === "not_found") return <NotFoundView />;
  if (state.status === "error") {
    return <ErrorView message={state.errorMessage ?? "Please try again."} />;
  }
  const trip = state.trip!;

  return (
    <main
      className="mx-auto w-full max-w-3xl px-4 pb-16 pt-6"
      data-testid="public-trip"
      data-public-id={trip.publicId}
    >
      <header className="rounded-3xl bg-gradient-to-br from-brand-600 to-brand-700 px-5 py-7 text-white sm:px-8 sm:py-9">
        <p className="text-xs uppercase tracking-wide text-brand-100/80">
          Shared trip plan
        </p>
        <h1 className="mt-1 text-2xl font-extrabold sm:text-3xl">
          {trip.countries.join(", ")}
        </h1>
        <p className="mt-2 text-sm text-brand-50/90">
          {trip.startDate} → {trip.endDate} · {STYLE_LABEL[trip.style]}
          {trip.meta.budget && (
            <>
              {" "}· budget {trip.meta.budget.amount} {trip.meta.budget.currency}
            </>
          )}
          {trip.ownerName && (
            <>
              {" "}· by {trip.ownerName}
            </>
          )}
        </p>
        {trip.meta.flight && (
          <p className="mt-1 text-xs text-brand-100/80">
            {trip.meta.flight.airline ?? ""} {trip.meta.flight.flightNumber}:{" "}
            {trip.meta.flight.departure.iata} → {trip.meta.flight.arrival.iata}
          </p>
        )}
      </header>

      {/* Actions */}
      <section className="mt-4 flex flex-wrap gap-2" aria-label="Trip actions">
        <button
          type="button"
          onClick={() => void triggerDownload("pdf")}
          disabled={download.action !== null}
          className="rounded-xl bg-brand-600 px-3 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-60"
          data-testid="public-trip-download-pdf"
        >
          {download.action === "pdf" ? "Preparing PDF…" : "Save PDF"}
        </button>
        <button
          type="button"
          onClick={() => void triggerDownload("calendar")}
          disabled={download.action !== null}
          className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-800 hover:bg-slate-50 disabled:opacity-60"
          data-testid="public-trip-download-calendar"
        >
          {download.action === "calendar" ? "Preparing…" : "Add to calendar"}
        </button>
        <button
          type="button"
          onClick={() => void triggerDownload("offline-pack")}
          disabled={download.action !== null}
          className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-800 hover:bg-slate-50 disabled:opacity-60"
          data-testid="public-trip-download-offline-pack"
        >
          {download.action === "offline-pack" ? "Preparing…" : "Offline pack (PDF + QR)"}
        </button>
      </section>

      {download.error && (
        <div
          role="alert"
          className="mt-2 rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-800 ring-1 ring-rose-200"
          data-testid="public-trip-download-error"
        >
          {download.error.message}
        </div>
      )}

      {/* Sections */}
      <section className="mt-8 space-y-6">
        {sectionsPresent.length === 0 && (
          <p className="rounded-2xl bg-slate-50 p-5 text-sm text-slate-600 ring-1 ring-slate-200">
            This trip's written plan isn't available. The download actions above
            still include the itinerary dates and destination.
          </p>
        )}
        {sectionsPresent.map((section) => (
          <article
            key={section}
            className="rounded-2xl bg-white p-5 ring-1 ring-slate-200"
            data-testid={`public-trip-section-${section.toLowerCase()}`}
          >
            <h2 className="text-base font-bold text-slate-900">{SECTION_TITLE[section]}</h2>
            <div className="mt-2">
              <SectionBody text={trip.sections[section] ?? ""} />
            </div>
          </article>
        ))}
      </section>

      {/* Stay connected */}
      {recommended && (
        <article
          className="mt-6 rounded-2xl bg-brand-50 p-5 ring-1 ring-brand-100"
          data-testid="public-trip-stay-connected"
        >
          <h2 className="text-base font-bold text-brand-900">Stay connected</h2>
          <p className="mt-1 text-sm text-brand-900/80">
            {recommended.isRegional
              ? "One regional plan covers every country on this trip."
              : "One plan for your main destination."}
          </p>
          <div className="mt-3 flex flex-wrap items-baseline justify-between gap-2">
            <div>
              <p className="text-sm font-semibold text-slate-900">{recommended.displayName}</p>
              <p className="text-xs text-slate-600">
                {recommended.dataLabel} · {recommended.validityLabel}
                {recommended.networkLabel && <> · Runs on {recommended.networkLabel}</>}
              </p>
            </div>
            <div className="text-right">
              <p className="text-lg font-extrabold text-slate-900">
                {formatUsdAs(recommended.retailUsd, currency)}
              </p>
              <a
                href={recommended.buyHref}
                className="mt-1 inline-block rounded-xl bg-brand-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-brand-700"
                data-testid="public-trip-stay-connected-buy"
              >
                Buy now
              </a>
            </div>
          </div>
        </article>
      )}

      {/* Affiliates */}
      {affiliates.length > 0 && (
        <section
          className="mt-6 rounded-2xl bg-white p-5 ring-1 ring-slate-200"
          data-testid="public-trip-affiliates"
          aria-labelledby="public-trip-affiliates-heading"
        >
          <h2 id="public-trip-affiliates-heading" className="text-base font-bold text-slate-900">
            Complete your trip
          </h2>
          <ul className="mt-3 grid gap-2 sm:grid-cols-2">
            {affiliates.map((l) => (
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

      <footer className="mt-10 flex flex-wrap items-center justify-between gap-2 border-t border-slate-200 pt-4 text-xs text-slate-500">
        <p>
          Saved {new Date(trip.createdAt).toLocaleDateString(undefined, {
            year: "numeric",
            month: "short",
            day: "numeric",
          })}
          {" · "}
          <a href="/trip-planner" className="text-brand-700 underline-offset-2 hover:underline">
            Plan your own trip
          </a>
        </p>
        <p>AI can make mistakes — verify before you travel.</p>
      </footer>
    </main>
  );
}

// ---------------------------------------------------------------------------
// Test surface
// ---------------------------------------------------------------------------

export const __test__ = {
  readPublicId,
  fetchPublicTrip,
  formatUsdAs,
  SECTION_ORDER,
  SECTION_TITLE,
  STYLE_LABEL,
};

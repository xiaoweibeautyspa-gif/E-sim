/**
 * Optional flight-number → destination/dates lookup.
 *
 * Purpose (AI trip planner batch, deliverable #3):
 *   The trip planner form lets a user type a flight number (e.g. "SQ 12").
 *   When FLIGHT_API_KEY is configured we look up the destination airport and
 *   the flight's scheduled dates so the planner can prefill countries/start/end
 *   dates. When the key is missing we return `{ configured: false }` — the page
 *   treats this as "flight lookup unavailable" and lets the user fill dates by
 *   hand. We NEVER pretend a lookup succeeded.
 *
 * Provider:
 *   AeroDataBox (RapidAPI). The user's spec said "FLIGHT_API_KEY, e.g.
 *   AeroDataBox". We keep the provider pluggable behind `FlightLookupProvider`
 *   so a different API can be swapped without touching callers. Today only the
 *   AeroDataBox implementation exists; the contract is narrow enough to add a
 *   second provider later.
 *
 * Secrets policy:
 *   FLIGHT_API_KEY is read server-side only (process.env, not exposed to the
 *   client). We do not cache keys in module scope; a lookup failure logs at
 *   most the status code, never the key.
 *
 * Response shape:
 *   - `{ ok: true, configured: true, flight: FlightInfo }` — a match.
 *   - `{ ok: true, configured: true, flight: null }` — no flight found (still a
 *     200-equivalent; the user typed a flight number that isn't in the feed).
 *   - `{ ok: false, configured: true, reason }` — the provider failed
 *     (network, rate limit, malformed payload). The UI surfaces this without
 *     blocking manual entry.
 *   - `{ ok: true, configured: false, reason: "not_configured" }` — no key.
 *     Callers must not treat this as an error; it's the honest degraded state.
 *
 * Date handling:
 *   The provider returns UTC timestamps. We derive `startDate`/`endDate` as
 *   `YYYY-MM-DD` (calendar days in the departure/arrival airport's local
 *   timezone when the payload provides one; otherwise UTC). The trip planner
 *   only needs day-granularity dates, not times.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single airport reference we expose from a flight lookup. */
export interface FlightAirport {
  /** IATA code, uppercase (e.g. "SIN"). */
  iata: string;
  /** Human city name when the provider knows it. */
  city: string | null;
  /** Country name when the provider knows it. */
  country: string | null;
}

/** What we return for a successful flight lookup, trimmed to planner needs. */
export interface FlightInfo {
  /** Airline IATA + flight number, normalised (e.g. "SQ12"). */
  flightNumber: string;
  /** Airline display name, when known. */
  airline: string | null;
  departure: FlightAirport;
  arrival: FlightAirport;
  /** Departure calendar date in the departure airport's local timezone. */
  startDate: string;
  /** Arrival calendar date in the arrival airport's local timezone. */
  endDate: string;
  /** Scheduled departure ISO timestamp, verbatim from the provider. */
  scheduledDepartureUtc: string;
  /** Scheduled arrival ISO timestamp, verbatim from the provider. */
  scheduledArrivalUtc: string;
}

export type FlightLookupResult =
  | { ok: true; configured: true; flight: FlightInfo }
  | { ok: true; configured: true; flight: null }
  | { ok: false; configured: true; reason: string }
  | { ok: true; configured: false; reason: "not_configured" };

/** Pluggable provider contract. Implementations must not throw on provider errors. */
export interface FlightLookupProvider {
  /** True when the provider has an API key configured. */
  isConfigured(): boolean;
  lookup(flightNumber: string, signal?: AbortSignal): Promise<FlightLookupResult>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Normalise a flight number the way airlines/APIs commonly format it:
 * upper-case, no spaces between airline code and number, "SQ12" not "sq 12".
 * Rejects obviously malformed input so we don't spam the provider.
 */
export function normaliseFlightNumber(raw: string): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().toUpperCase().replace(/\s+/g, "");
  // Airline code (2-3 letters or digits) + up to 4 digits. Conservative to
  // avoid false positives on arbitrary text.
  if (!/^[A-Z0-9]{2,3}\d{1,4}$/.test(trimmed)) return null;
  return trimmed;
}

/**
 * Convert an ISO timestamp to a calendar `YYYY-MM-DD` using the given IANA
 * timezone, or UTC when no timezone is supplied / the runtime doesn't support
 * it. We use `Intl.DateTimeFormat` so no timezone library is needed.
 */
export function isoToCalendarDate(iso: string, timeZone: string | null): string | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  if (!timeZone) return date.toISOString().slice(0, 10);
  try {
    const fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    // en-CA renders YYYY-MM-DD.
    const parts = fmt.formatToParts(date);
    const year = parts.find((p) => p.type === "year")?.value;
    const month = parts.find((p) => p.type === "month")?.value;
    const day = parts.find((p) => p.type === "day")?.value;
    if (!year || !month || !day) return date.toISOString().slice(0, 10);
    return `${year}-${month}-${day}`;
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

/**
 * Structural shape of the AeroDataBox "flight by number" response we consume.
 * It's a partial: we only read the fields we need, and the provider can evolve.
 */
interface AeroDataBoxFlight {
  number?: string;
  airline?: { name?: string; iata?: string; icao?: string };
  departure?: {
    airport?: {
      iata?: string;
      name?: string;
      municipalityName?: string;
      countryName?: string;
      timeZone?: string;
    };
    scheduledTimeUtc?: string;
    scheduledTimeLocal?: string;
  };
  arrival?: {
    airport?: {
      iata?: string;
      name?: string;
      municipalityName?: string;
      countryName?: string;
      timeZone?: string;
    };
    scheduledTimeUtc?: string;
    scheduledTimeLocal?: string;
  };
}

/**
 * Map one AeroDataBox flight object to our `FlightInfo`. Returns null if the
 * object is missing the minimum required fields (airports + scheduled times).
 * Defensive rather than trusting the provider's schema.
 */
export function mapAeroDataBoxFlight(
  raw: unknown,
  requestedFlightNumber: string,
): FlightInfo | null {
  if (!raw || typeof raw !== "object") return null;
  const f = raw as AeroDataBoxFlight;
  const dep = f.departure;
  const arr = f.arrival;
  const depIata = dep?.airport?.iata;
  const arrIata = arr?.airport?.iata;
  const depUtc = dep?.scheduledTimeUtc;
  const arrUtc = arr?.scheduledTimeUtc;
  if (!depIata || !arrIata || !depUtc || !arrUtc) return null;

  const startDate = isoToCalendarDate(depUtc, dep?.airport?.timeZone ?? null);
  const endDate = isoToCalendarDate(arrUtc, arr?.airport?.timeZone ?? null);
  if (!startDate || !endDate) return null;

  return {
    flightNumber: normaliseFlightNumber(f.number ?? requestedFlightNumber) ?? requestedFlightNumber,
    airline: f.airline?.name ?? null,
    departure: {
      iata: depIata.toUpperCase(),
      city: dep?.airport?.municipalityName ?? null,
      country: dep?.airport?.countryName ?? null,
    },
    arrival: {
      iata: arrIata.toUpperCase(),
      city: arr?.airport?.municipalityName ?? null,
      country: arr?.airport?.countryName ?? null,
    },
    startDate,
    endDate,
    scheduledDepartureUtc: depUtc,
    scheduledArrivalUtc: arrUtc,
  };
}

// ---------------------------------------------------------------------------
// AeroDataBox provider
// ---------------------------------------------------------------------------

const AERODATABOX_BASE = "https://aerodatabox.p.rapidapi.com";
const AERODATABOX_HOST = "aerodatabox.p.rapidapi.com";
const LOOKUP_TIMEOUT_MS = 6_000;

export interface AeroDataBoxOptions {
  /** Optional override; defaults to a lazy read of process.env.FLIGHT_API_KEY. */
  apiKey?: string | null;
  /** Optional fetch override for tests. Must not be used to mock real calls in prod. */
  fetchImpl?: typeof fetch;
}

/**
 * AeroDataBox provider. We call the "flight by number within ±day of now"
 * endpoint; the planner only needs *a* scheduled occurrence of the flight.
 *
 * Honest limitations:
 * - AeroDataBox rate-limits per RapidAPI plan. A 429 → we return
 *   `{ ok: false, reason: "rate_limited" }`; the UI surfaces it as
 *   "flight lookup unavailable right now".
 * - We look up the current occurrence (the API's default). A user planning a
 *   flight a month out may get no match; they can override dates manually.
 * - We do NOT look up arbitrary historical flights.
 */
export class AeroDataBoxFlightProvider implements FlightLookupProvider {
  private readonly apiKeyOverride: string | null | undefined;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: AeroDataBoxOptions = {}) {
    this.apiKeyOverride = opts.apiKey;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private getApiKey(): string | null {
    if (this.apiKeyOverride !== undefined) return this.apiKeyOverride;
    const v = process.env.FLIGHT_API_KEY;
    return typeof v === "string" && v.length > 0 ? v : null;
  }

  isConfigured(): boolean {
    return this.getApiKey() != null;
  }

  async lookup(flightNumber: string, signal?: AbortSignal): Promise<FlightLookupResult> {
    const apiKey = this.getApiKey();
    if (!apiKey) return { ok: true, configured: false, reason: "not_configured" };

    const normalised = normaliseFlightNumber(flightNumber);
    if (!normalised) {
      return { ok: false, configured: true, reason: "invalid_flight_number" };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), LOOKUP_TIMEOUT_MS);
    const composite = mergeSignals(signal, controller.signal);

    try {
      const url = `${AERODATABOX_BASE}/flights/number/${encodeURIComponent(
        normalised,
      )}?withAircraftImage=false&withLocation=false&dateLocalRole=Both`;
      const res = await this.fetchImpl(url, {
        method: "GET",
        headers: {
          "X-RapidAPI-Key": apiKey,
          "X-RapidAPI-Host": AERODATABOX_HOST,
          Accept: "application/json",
        },
        signal: composite,
      });

      if (res.status === 429) return { ok: false, configured: true, reason: "rate_limited" };
      if (res.status === 404) return { ok: true, configured: true, flight: null };
      if (!res.ok) {
        return { ok: false, configured: true, reason: `provider_status_${res.status}` };
      }

      const body = (await res.json().catch(() => null)) as unknown;
      if (!Array.isArray(body) || body.length === 0) {
        return { ok: true, configured: true, flight: null };
      }
      // Prefer the first occurrence that maps cleanly.
      for (const item of body) {
        const mapped = mapAeroDataBoxFlight(item, normalised);
        if (mapped) return { ok: true, configured: true, flight: mapped };
      }
      return { ok: true, configured: true, flight: null };
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        return { ok: false, configured: true, reason: "timeout" };
      }
      // Never log the URL or key; only the error class message.
      return {
        ok: false,
        configured: true,
        reason: err instanceof Error ? `lookup_failed:${err.name}` : "lookup_failed",
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}

/**
 * Standard AbortSignal composition: abort when either the caller aborts or the
 * internal timeout fires. Available natively as `AbortSignal.any` in Node 20+,
 * but we keep a small local implementation so tests can inject signals the
 * runtime may not support yet.
 */
function mergeSignals(a: AbortSignal | undefined, b: AbortSignal): AbortSignal {
  if (!a) return b;
  if (typeof AbortSignal.any === "function") return AbortSignal.any([a, b]);
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (a.aborted || b.aborted) {
    controller.abort();
    return controller.signal;
  }
  a.addEventListener("abort", onAbort, { once: true });
  b.addEventListener("abort", onAbort, { once: true });
  return controller.signal;
}

// ---------------------------------------------------------------------------
// Default provider + convenience export
// ---------------------------------------------------------------------------

/**
 * Resolve a provider at request time so an env change (Secrets rotated /
 * added in Replit) is picked up without a redeploy in dev. In production the
 * env is set at boot; this is cheap either way.
 */
export function getFlightLookupProvider(): FlightLookupProvider {
  return new AeroDataBoxFlightProvider();
}

/**
 * Convenience wrapper used by the trip planner route. Never throws; see
 * `FlightLookupResult` for the four outcomes.
 */
export async function lookupFlight(
  flightNumber: string,
  signal?: AbortSignal,
  provider: FlightLookupProvider = getFlightLookupProvider(),
): Promise<FlightLookupResult> {
  if (!provider.isConfigured()) {
    return { ok: true, configured: false, reason: "not_configured" };
  }
  const normalised = normaliseFlightNumber(flightNumber);
  if (!normalised) {
    return { ok: false, configured: true, reason: "invalid_flight_number" };
  }
  return provider.lookup(normalised, signal);
}

// ---------------------------------------------------------------------------
// Test surface
// ---------------------------------------------------------------------------

export const __test__ = {
  normaliseFlightNumber,
  isoToCalendarDate,
  mapAeroDataBoxFlight,
};

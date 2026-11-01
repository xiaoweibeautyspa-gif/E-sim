/**
 * Typed browser client for the catalog API.
 *
 * Contract (mirrors server/routes/catalog.ts):
 * - Every catalog route answers `{ ok: true, data }` or `{ ok: false, error, message }`.
 * - Prices arrive as USD (`retailUsd`); the UI converts to a display currency
 *   using the static `DISPLAY_RATES` table below. Rates are indicative display
 *   helpers, NOT checkout rates — checkout pricing is settled server-side in a
 *   later phase. Keep them clearly labelled so nobody treats them as billing.
 * - No route ever disappears into a silent default: a failed call surfaces as a
 *   typed `ApiError` with the HTTP status and server `error` code.
 */

/** Structured error thrown by any catalog call. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

/** A priced plan as returned by the catalog (server-authoritative). */
export interface CatalogPlan {
  id: number;
  code: string;
  name: string;
  countries: string[];
  countrySlug: string | null;
  region: string | null;
  dataGb: number | null;
  durationDays: number | null;
  isDailyPlan: boolean;
  wholesaleUsd: number;
  retailUsd: number;
  profitUsd: number;
  markupPercent: number;
  markupSource: "default" | "country" | "package";
  supportTopUpType: number;
  operators: string[];
  packageType: string;
}

/** One popular/available destination derived from the catalog. */
export interface DestinationSummary {
  slug: string;
  plans: number;
  /** Cheapest retail price in USD; Infinity never appears on the wire. */
  minPriceUsd: number;
}

export interface CountryPlansResponse {
  country: string;
  plans: CatalogPlan[];
  bestValueCode: string | null;
}

/** ISO-3166 alpha-2 → display name. Used for search matching in the UI. */
export const COUNTRY_NAMES: Record<string, string> = {
  sg: "Singapore",
  my: "Malaysia",
  th: "Thailand",
  vn: "Vietnam",
  id: "Indonesia",
  ph: "Philippines",
  jp: "Japan",
  kr: "South Korea",
  cn: "China",
  hk: "Hong Kong",
  tw: "Taiwan",
  in: "India",
  ae: "United Arab Emirates",
  sa: "Saudi Arabia",
  qa: "Qatar",
  il: "Israel",
  tr: "Turkey",
  gb: "United Kingdom",
  fr: "France",
  de: "Germany",
  it: "Italy",
  es: "Spain",
  nl: "Netherlands",
  ch: "Switzerland",
  at: "Austria",
  pt: "Portugal",
  gr: "Greece",
  ie: "Ireland",
  se: "Sweden",
  no: "Norway",
  dk: "Denmark",
  fi: "Finland",
  pl: "Poland",
  cz: "Czechia",
  be: "Belgium",
  is: "Iceland",
  us: "United States",
  ca: "Canada",
  mx: "Mexico",
  au: "Australia",
  nz: "New Zealand",
  za: "South Africa",
  eg: "Egypt",
  ma: "Morocco",
  ke: "Kenya",
  ng: "Nigeria",
  br: "Brazil",
  ar: "Argentina",
  cl: "Chile",
  co: "Colombia",
  pe: "Peru",
};

/** Display name for a slug; falls back to the uppercased slug (honest, not a guess). */
export function countryName(slug: string): string {
  return COUNTRY_NAMES[slug.toLowerCase()] ?? slug.toUpperCase();
}

/**
 * Static indicative FX rates (units per 1 USD) for DISPLAY ONLY.
 * Checkout settles in the order currency server-side in a later phase; these
 * must never be treated as billing rates.
 */
export const DISPLAY_RATES: Record<"USD" | "SGD" | "VND" | "CNY", number> = {
  USD: 1,
  SGD: 1.35,
  VND: 25_000,
  CNY: 7.2,
};

export type DisplayCurrency = keyof typeof DISPLAY_RATES;

/**
 * Format a USD amount into a display currency.
 * Currencies with no decimal minor unit commonly used (VND) render as whole numbers.
 */
export function formatMoney(
  usd: number,
  currency: DisplayCurrency = "USD",
): string {
  const rate = DISPLAY_RATES[currency];
  const value = usd * rate;
  const zeroDecimal = currency === "VND";
  try {
    return new Intl.NumberFormat(currency === "VND" ? "vi-VN" : "en-US", {
      style: "currency",
      currency,
      minimumFractionDigits: 0,
      maximumFractionDigits: zeroDecimal ? 0 : 2,
    }).format(value);
  } catch {
    // Intl currency data missing (rare); fall back to a plain string, not a fake price.
    return `${currency} ${value.toFixed(zeroDecimal ? 0 : 2)}`;
  }
}

/** Build the API path relative to the current origin (dev proxies /api to Express). */
function apiUrl(path: string): string {
  return `/api${path}`;
}

interface OkEnvelope<T> {
  ok: true;
  data: T;
}
interface ErrEnvelope {
  ok: false;
  error: string;
  message: string;
}

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  let res: Response;
  try {
    res = await fetch(apiUrl(path), {
      method: "GET",
      headers: { Accept: "application/json" },
      signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    throw new ApiError(
      0,
      "network_error",
      "Could not reach the server. Check your connection and try again.",
    );
  }

  let body: unknown = undefined;
  const text = await res.text();
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
  }

  if (!res.ok) {
    const env = body as Partial<ErrEnvelope> | undefined;
    throw new ApiError(
      res.status,
      env && typeof env.error === "string" ? env.error : "http_error",
      env && typeof env.message === "string"
        ? env.message
        : `Request failed with status ${res.status}.`,
    );
  }

  const env = body as OkEnvelope<T> | undefined;
  if (!env || env.ok !== true) {
    throw new ApiError(res.status, "bad_response", "The server returned an unexpected response.");
  }
  return env.data;
}

export const apiClient = {
  /** Popular destinations, ranked by plan availability server-side. */
  async listDestinations(
    opts: { limit?: number; signal?: AbortSignal } = {},
  ): Promise<DestinationSummary[]> {
    const qs = opts.limit != null ? `?limit=${encodeURIComponent(opts.limit)}` : "";
    const data = await getJson<{ destinations: DestinationSummary[] }>(
      `/catalog/destinations${qs}`,
      opts.signal,
    );
    return data.destinations;
  },

  /** Regional (multi-country, non-global) plans. */
  async listRegionalPlans(signal?: AbortSignal): Promise<CatalogPlan[]> {
    const data = await getJson<{ plans: CatalogPlan[] }>("/catalog/regional", signal);
    return data.plans;
  },

  /** Global / multi-region plans. */
  async listGlobalPlans(signal?: AbortSignal): Promise<CatalogPlan[]> {
    const data = await getJson<{ plans: CatalogPlan[] }>("/catalog/global", signal);
    return data.plans;
  },

  /** Daily unlimited plans. */
  async listDailyPlans(signal?: AbortSignal): Promise<CatalogPlan[]> {
    const data = await getJson<{ plans: CatalogPlan[] }>("/catalog/daily", signal);
    return data.plans;
  },

  /** Every active plan for a country, plus the server-picked best-value code. */
  async getCountryPlans(
    slug: string,
    opts: { signal?: AbortSignal } = {},
  ): Promise<CountryPlansResponse> {
    return getJson<CountryPlansResponse>(
      `/catalog/country/${encodeURIComponent(slug)}`,
      opts.signal,
    );
  },

  /** Server-side destination search (matches country slug / country lists). */
  async search(q: string, signal?: AbortSignal): Promise<DestinationSummary[]> {
    const data = await getJson<{ destinations: DestinationSummary[] }>(
      `/catalog/search?q=${encodeURIComponent(q)}`,
      signal,
    );
    return data.destinations;
  },
};

export type ApiClient = typeof apiClient;

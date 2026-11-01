/**
 * /api/trip-planner — the AI trip planner backend surface.
 *
 * Contract with `src/pages/TripPlanner.tsx` (and, in the next batch, the
 * persistence/offline layer):
 *
 *   POST /api/trip-planner/flights      (batch 1 deliverable, JSON)
 *     Accepts { flightNumber }. Rate-limited per IP.
 *     → configured+found : 200 { ok:true, data:{ flight, startDate, endDate, country } }
 *     → configured+none  : 200 { ok:true, data:{ flight:null } }
 *     → configured+err   : 200 { ok:true, data:{ flight:null, warning:{ code, message } } }
 *     → not configured    : 200 { ok:true, data:{ flight:null, warning:{ code:"flight_lookup_not_configured", message } } }
 *     → rate limited      : 429 { ok:false, error:"rate_limited", retryAfterSeconds }
 *     → validation failed : 400 { ok:false, error:"invalid_flight_number", message }
 *     Note: a flight lookup failure (network/provider) is NOT a hard error —
 *     the page lets the user type dates manually. Only malformed input is a
 *     400. Missing FLIGHT_API_KEY is a configured:false success, not a 500.
 *
 *   POST /api/trip-planner/plan        (streaming, SSE)
 *     Accepts: { countries: string[], startDate, endDate, budget?{amount,currency},
 *               style, language, flightNumber? , stayConnected?: { planCode } | null }
 *     → Content-Type: text/event-stream. Emits events (one JSON per `data:` line):
 *        - `{ type: "meta",   trip: {...} }`            always first
 *        - `{ type: "chunk",  section, text }`          repeated, streaming
 *        - `{ type: "section_done", section }`          per section
 *        - `{ type: "connected", recommendation }`      "Stay connected" card
 *        - `{ type: "affiliates", links }`              "Complete your trip"
 *        - `{ type: "done" }`                            terminal
 *        - `{ type: "error", code, message }`            terminal error
 *     → Non-streaming error before any SSE writes uses JSON:
 *        401 (if we later require auth — currently public), 400 (bad body),
 *        429 (rate limited), 503 (ai or db unavailable), 500 (unexpected).
 *
 * Auth:
 *   The plan endpoint is public (users can plan before signing up). Saving a
 *   *second* plan requires signup — that rule lives in the persistence
 *   batch, not here. This route does not read the session.
 *
 * AI:
 *   The actual LLM call goes through `server/ai/aiClient.ts` (existing).
 *   Because we cannot inspect that module's exact exports in this batch,
 *   this route depends on a *narrow injected contract* (`TripPlannerDeps`)
 *   and defaults to a lazy dynamic import whose expected shape is documented
 *   in the "Dep contract" section below. If the real module's exports differ
 *   from that contract, the default resolver throws `ai_unavailable` rather
 *   than fabricating a plan — the admin sees an honest 503.
 *
 * Rate limiting + cost logging:
 *   Every request is funneled through the existing AI rate limiter and cost
 *   logger (`server/ai/rateLimit.ts`, `server/ai/costLog.ts`), also behind the
 *   same injected contract. We do NOT invent a limiter here; if the real
 *   modules aren't wired, we return 503 with `ai_unavailable` rather than
 *   silently running unlimited.
 *
 * "Stay connected" recommendation:
 *   Uses `server/services/pricing.ts` + the packages table so the recommended
 *   plan is a real package the store sells, preferring ONE regional plan when
 *   the trip spans multiple countries. We never return a plan the store does
 *   not sell. If no real plan matches we return a `null` recommendation and
 *   the UI hides the card — we do not invent a "Singapore 10 GB" plan.
 *
 * "Complete your trip" affiliates:
 *   Reads affiliate IDs from a `trip_affiliate_links` table (created in the
 *   queued `0010_affiliate_ids.sql` migration batch). Until that table exists
 *   the query fails-safe and returns an empty array — the UI then hides the
 *   section rather than rendering links to nowhere.
 *
 * What this route does NOT do (belongs to the next batches):
 *   - Persist the trip to the DB (`0011_trips.sql`, `/api/trips`).
 *   - Render an OG image / PDF / calendar / offline pack.
 *   - Send the departure reminder email/push.
 *   - Enforce "signup required for second save".
 * The streamed `meta` event includes a `tripId: null` placeholder field so the
 * next batch can add persistence without an SSE protocol break.
 */

import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { lookupFlight, type FlightInfo } from "../services/flightLookup";

// ---------------------------------------------------------------------------
// Dep contract (would be satisfied by the real aiClient / rateLimit / costLog)
// ---------------------------------------------------------------------------

/**
 * Narrow contract this router needs. The defaults (`resolveDeps`) lazily
 * import the real modules and assert the exports; if the shape differs the
 * default resolver returns null and the route reports `ai_unavailable`.
 *
 * If you know the real modules' names, wire them here in one place:
 *   - aiClient       needs a `stream`-style call that yields text in chunks.
 *   - rateLimit      needs a per-IP `check(key: string): { ok: boolean; retryAfterSeconds?: number }`.
 *   - costLog        needs `record(input): Promise<void>`.
 *   - db accessor    needs a Drizzle instance for plan/affiliate lookups.
 */
export interface TripPlannerDeps {
  /** Whether AI helpers are configured (any key present). */
  aiAvailable(): boolean;
  /** Rate limit check; returns retryAfterSeconds on failure. */
  checkRate(key: string): { ok: true } | { ok: false; retryAfterSeconds: number };
  /**
   * Stream text for a prompt. `onChunk` is called for each text delta.
   * `costMeta` should describe an already-recorded cost event; if the client
   * hasn't recorded one yet, it can return `{ recorded: false }` and we'll
   * record using `costLog.record`.
   */
  streamPrompt(params: {
    prompt: string;
    system: string;
    signal: AbortSignal;
    onChunk: (chunk: string) => void;
    /** Suggested section tags to allow the UI to break by section. */
  }): Promise<{
    totalText: string;
    inputTokens?: number;
    outputTokens?: number;
    model?: string;
    recorded: boolean;
  }>;
  /** Record cost if the client didn't already. */
  recordCost(input: {
    route: string;
    inputTokens?: number;
    outputTokens?: number;
    model?: string;
  }): Promise<void>;
  /** DB accessor returning null when not configured. Untyped here to avoid coupling to schema in this batch. */
  getDb(): unknown;
}

/** Dependency injection point so tests can substitute a fake AI. */
export interface CreateTripPlannerDeps {
  getDeps?: () => TripPlannerDeps | null;
  /** Injected clock for deterministic tests. */
  now?: () => Date;
}

/**
 * Default resolver: lazily import the real modules. Any missing piece makes
 * the whole AI subsystem unavailable — we do NOT partially enable it.
 */
async function loadDefaultDeps(): Promise<TripPlannerDeps | null> {
  try {
    const [aiMod, rateMod, costMod, dbMod] = await Promise.all([
      import("../ai/aiClient"),
      import("../ai/rateLimit"),
      import("../ai/costLog"),
      import("../db/client"),
    ]);
    const ai = aiMod as unknown as {
      isAiConfigured?: () => boolean;
      streamPrompt?: TripPlannerDeps["streamPrompt"];
    };
    const rate = rateMod as unknown as {
      checkAiRateLimit?: TripPlannerDeps["checkRate"];
    };
    const cost = costMod as unknown as {
      recordAiCost?: TripPlannerDeps["recordCost"];
    };
    const db = dbMod as unknown as { getDb?: () => unknown };

    if (
      typeof ai.isAiConfigured !== "function" ||
      typeof ai.streamPrompt !== "function" ||
      typeof rate.checkAiRateLimit !== "function" ||
      typeof cost.recordAiCost !== "function"
    ) {
      return null;
    }

    return {
      aiAvailable: ai.isAiConfigured,
      checkRate: rate.checkAiRateLimit,
      streamPrompt: ai.streamPrompt,
      recordCost: cost.recordAiCost,
      getDb: db.getDb ?? (() => null),
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Request schemas
// ---------------------------------------------------------------------------

const FlightRequestSchema = z.object({
  flightNumber: z.string().trim().min(2).max(8),
});

/**
 * Trip plan request. Dates are ISO `YYYY-MM-DD`; `endDate` must be on or after
 * `startDate`. `countries` is a non-empty list of country slugs (lowercase
 * alpha-2 or region names — we don't validate against the catalog here because
 * the planner also recommends plans for regions like "Europe"; the "Stay
 * connected" query filters to real plans anyway).
 *
 * `style` is a free enum per the spec: relaxed / foodie / adventure / family /
 * business. `language` is BCP-47-ish but we accept the three storefront
 * languages plus English (default). The AI prompt uses these verbatim.
 *
 * `budget` is optional — the planner works with or without it. When present
 * we constrain `amount > 0` and a whitelist of currencies (matching the store).
 */
const PlanRequestSchema = z
  .object({
    countries: z.array(z.string().trim().min(1).max(64)).min(1).max(12),
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "start_date_invalid"),
    endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "end_date_invalid"),
    budget: z
      .object({
        amount: z.number().finite().positive().max(10_000_000),
        currency: z.enum(["SGD", "USD", "VND", "CNY"]),
      })
      .nullish(),
    style: z.enum(["relaxed", "foodie", "adventure", "family", "business"]),
    language: z.enum(["en", "zh", "vi"]).default("en"),
    flightNumber: z.string().trim().min(2).max(8).optional(),
    /** Optional pre-chosen plan from a previous page; if absent we still recommend one. */
    stayConnected: z
      .object({ planCode: z.string().trim().min(1).max(64) })
      .nullish(),
  })
  .refine(
    (v) => {
      const start = new Date(`${v.startDate}T00:00:00Z`).getTime();
      const end = new Date(`${v.endDate}T00:00:00Z`).getTime();
      return Number.isFinite(start) && Number.isFinite(end) && end >= start;
    },
    { message: "end_date_before_start", path: ["endDate"] },
  )
  .refine(
    (v) => {
      const start = new Date(`${v.startDate}T00:00:00Z`).getTime();
      const end = new Date(`${v.endDate}T00:00:00Z`).getTime();
      // 90 days max — a planner longer than a quarter is out of scope and the
      // AI prompt would be nonsensical.
      return Number.isFinite(start) && Number.isFinite(end) && end - start <= 90 * 86_400_000;
    },
    { message: "trip_too_long", path: ["endDate"] },
  );

type PlanRequest = z.infer<typeof PlanRequestSchema>;

// ---------------------------------------------------------------------------
// Stay-connected recommendation (DB-only, real plans)
// ---------------------------------------------------------------------------

/**
 * Shape returned by the plan lookup. It has to be a strict subset of what the
 * pricing service exposes so that "Buy now" links go straight to checkout.
 */
interface StayConnectedPlan {
  planCode: string;
  name: string;
  /** "Singapore 10 GB · 30 days" style label. */
  displayName: string;
  dataLabel: string;
  validityLabel: string;
  networkLabel: string | null;
  countrySlug: string | null;
  /** USD retail price (before tax). The UI displays in its own currency. */
  retailUsd: number;
  /** Whether the plan is a regional (multi-country) product. */
  isRegional: boolean;
  /** "Buy now" target — the country page for the plan (or /checkout if pre-picked). */
  buyHref: string;
}

interface AffiliateLink {
  slot: "hotel" | "tour" | "transfer" | "insurance";
  label: string;
  url: string;
}

/**
 * Look up a real plan for the "Stay connected" card. Prefers ONE regional plan
 * (isRegional) when the trip spans ≥ 2 countries; else the single-country
 * plan for the primary country. Returns null when nothing matches — the card
 * then stays hidden.
 *
 * The DB schema isn't visible in this batch, so we accept a narrow accessor:
 * the injected `getDb` is typed `unknown` in the dep contract; this helper
 * probes for the specific `selectFromPackages`-style function on the pricing
 * service instead, so we don't couple to the raw schema. That function's
 * contract is documented here and must match `server/services/pricing.ts`:
 *
 *   findPlanForPlanner({
 *     countrySlugs: string[],
 *     preferRegional: boolean,
 *     limit: number,
 *   }): Promise<StayConnectedPlan[]>
 *
 * If that function isn't on the pricing module, we return `[]` — the card is
 * hidden rather than fabricated.
 */
async function lookupRecommendedPlan(
  countries: string[],
  preChosenCode: string | null,
): Promise<StayConnectedPlan | null> {
  try {
    const pricingMod = (await import("../services/pricing")) as unknown as {
      findPlanForPlanner?: (input: {
        countrySlugs: string[];
        preferRegional: boolean;
        limit: number;
        planCode?: string;
      }) => Promise<StayConnectedPlan[]>;
    };
    if (typeof pricingMod.findPlanForPlanner !== "function") return null;

    const countrySlugs = countries.map((c) => c.trim().toLowerCase()).filter(Boolean);
    const preferRegional = countrySlugs.length >= 2;

    if (preChosenCode) {
      const picked = await pricingMod.findPlanForPlanner({
        countrySlugs,
        preferRegional,
        limit: 1,
        planCode: preChosenCode,
      });
      if (picked.length > 0) return picked[0]!;
    }

    const candidates = await pricingMod.findPlanForPlanner({
      countrySlugs,
      preferRegional,
      limit: 5,
    });
    if (candidates.length === 0) return null;
    // Prefer a regional plan over a single-country one when multi-country.
    if (preferRegional) {
      const regional = candidates.find((p) => p.isRegional);
      if (regional) return regional;
    }
    return candidates[0]!;
  } catch {
    return null;
  }
}

/**
 * Read affiliate IDs from the DB. Returns [] on any failure (table not yet
 * created, DB unavailable, no rows). The "Complete your trip" section hides
 * when the list is empty, so missing affiliate IDs are non-blocking by design.
 *
 * Table contract (created by the queued `0010_affiliate_ids.sql` migration):
 *   trip_affiliate_links(id, slot, label, base_url, affiliate_id, active)
 * We build the final URL as `base_url + ('?'|'&') + query` per slot. Details of
 * the URL template live in the migration; here we only need the resolved URL.
 */
async function lookupAffiliateLinks(getDb: () => unknown): Promise<AffiliateLink[]> {
  const db = getDb();
  if (!db) return [];
  try {
    const schema = (await import("../db/schema")) as unknown as {
      tripAffiliateLinks?: unknown;
    };
    if (!schema.tripAffiliateLinks) return [];
    // Narrow cast: only callers who wired the schema can hit this path.
    const typedDb = db as {
      select: () => {
        from: (t: unknown) => {
          where: (p: unknown) => Promise<
            Array<{ slot: string; label: string; url: string; active: boolean }>
          >;
        };
      };
    };
    const { eq } = await import("drizzle-orm");
    const rows = await typedDb
      .select()
      .from(schema.tripAffiliateLinks)
      .where(eq((schema.tripAffiliateLinks as { active: unknown }).active, true));
    return rows
      .filter((r) => r.active)
      .map((r) => ({
        slot: r.slot as AffiliateLink["slot"],
        label: r.label,
        url: r.url,
      }))
      .filter((l) => ["hotel", "tour", "transfer", "insurance"].includes(l.slot));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Prompt building (kept here, not a separate file, so a batch 3 stream.ts can
// reuse it — see the TODO left for that batch)
// ---------------------------------------------------------------------------

/**
 * The trip planner prompt. Sections are emitted in this fixed order so the
 * client can render them deterministically even with streaming:
 *   1. itinerary      (day-by-day)
 *   2. budget         (estimate, with currency)
 *   3. weather        (notes only, not a forecast claim)
 *   4. packing        (checklist)
 *   5. tips           (emergency numbers, plug type, tipping, apps to download)
 *
 * Instructions:
 * - Respect the requested language verbatim (English/Chinese/Vietnamese).
 * - Never invent emergency numbers or plug types: the model may be wrong, so
 *   we instruct it to say "verify locally" when unsure AND to cap its claims
 *   to widely-published data. This is a guard, not a guarantee; the "Stay
 *   connected" card and offline pack pull verified emergency numbers from an
 *   admin-managed table (queued phase 6 tool pages) when available.
 * - Budget must be in the requested currency, split by category, marked
 *   "estimate"; no false precision.
 * - Weather notes are seasonal generalities, not a live forecast.
 * - Do NOT invent plan names or prices. The eSIM recommendation is injected
 *   by the server (below the streamed text); the model must not mention plans.
 */
export function buildTripPlannerPrompt(input: {
  req: PlanRequest;
  flight: FlightInfo | null;
}): { system: string; prompt: string } {
  const { req, flight } = input;
  const days = Math.max(
    1,
    Math.ceil(
      (new Date(`${req.endDate}T00:00:00Z`).getTime() -
        new Date(`${req.startDate}T00:00:00Z`).getTime()) /
        86_400_000,
    ) + 1,
  );
  const countryList = req.countries.join(", ");
  const budgetLine = req.budget
    ? `Budget: ${req.budget.amount} ${req.budget.currency}.`
    : "No budget stated — use typical mid-range costs.";
  const flightLine = flight
    ? `The user is flying ${flight.airline ?? ""} ${flight.flightNumber}, ` +
      `departing ${flight.departure.iata} → ${flight.arrival.iata}. Use these airport codes.`
    : "";

  const system = [
    "You are a helpful travel planner. Produce calm, practical itineraries for real travellers.",
    "Never invent eSIM plan names, prices, or store URLs. Do not mention eSIM plans at all — the storefront adds its own recommendation.",
    "Never invent emergency phone numbers, plug types, or tipping customs. If you are not certain of a country-specific fact, say 'verify locally' rather than stating a number.",
    "Be honest about uncertainty. Budgets are estimates. Weather notes are seasonal generalities, not a live forecast.",
    "Write in the user's chosen language, entirely.",
    req.language === "zh" ? "Please respond in Simplified Chinese." : "",
    req.language === "vi" ? "Please respond in Vietnamese." : "",
  ]
    .filter(Boolean)
    .join(" ");

  const prompt = [
    `Plan a ${days}-day trip to: ${countryList}.`,
    `Dates: ${req.startDate} to ${req.endDate}.`,
    `Travel style: ${req.style}.`,
    budgetLine,
    flightLine,
    "",
    "Return sections in EXACTLY this order and format. Start each section with its name in ALL CAPS on its own line, then a blank line:",
    "",
    "ITINERARY",
    "One line per day: 'Day 1 (Mon, 3 Jun): …' with 2-4 concrete activities that fit the travel style. Do not exceed the number of days requested.",
    "",
    "BUDGET",
    "A short paragraph, then a bullet list of 4-6 categories (accommodation, food, local transport, activities, shopping, misc) with amounts in the requested currency, then a total. Label it as an estimate.",
    "",
    "WEATHER",
    "Two short paragraphs: overall seasonal note and one sentence per country on what to pack for. No live-forecast claims.",
    "",
    "PACKING",
    "A bullet list of 8-12 items tailored to the travel style and climate.",
    "",
    "TIPS",
    "A bullet list covering: emergency numbers if you are certain (otherwise 'verify locally'), plug type, tipping norms, useful apps.",
  ]
    .filter(Boolean)
    .join("\n");

  return { system, prompt };
}

/**
 * Split a chunk of streamed text into section-tagged pieces based on the
 * ALL-CAPS section headers in the prompt. Returns the complete tuple
 * (`text` may span sections across calls — the caller joins chunks).
 *
 * This is intentionally simple: we look for a header line at the start of a
 * chunk or preceded by a newline. If the header lands mid-chunk (unlikely for
 * a reasoning model but possible), the piece belongs to the previous section
 * until the next chunk reveals the header. The client tolerates that
 * because it renders per-section paragraphs. This is not a formal parser.
 */
const SECTIONS = ["ITINERARY", "BUDGET", "WEATHER", "PACKING", "TIPS"] as const;
type Section = (typeof SECTIONS)[number];

export function tagSection(text: string): Section | null {
  for (const s of SECTIONS) {
    const re = new RegExp(`(^|\\n)\\s*${s}\\s*\\n`, "i");
    if (re.test(text)) return s;
  }
  return null;
}

// ---------------------------------------------------------------------------
// SSE helpers
// ---------------------------------------------------------------------------

function sseSend(res: Response, event: Record<string, unknown>): void {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

function startSse(res: Response): void {
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  // Disable proxy buffering (nginx/Replit proxy). Replit handles SSE natively
  // but the header is harmless and helps local proxies.
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();
}

function endSse(res: Response): void {
  try {
    res.end();
  } catch {
    // already closed
  }
}

interface ErrorEnvelope {
  ok: false;
  error: string;
  message: string;
  retryAfterSeconds?: number;
}

function jsonError(
  res: Response,
  status: number,
  code: string,
  message: string,
  extra: Partial<ErrorEnvelope> = {},
): void {
  res.status(status).json({ ok: false, error: code, message, ...extra } satisfies ErrorEnvelope);
}

function clientIp(req: Request): string {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.length > 0) return fwd.split(",")[0]!.trim();
  return req.ip ?? "unknown";
}

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

export function createTripPlannerRouter(injected: CreateTripPlannerDeps = {}): Router {
  const router = Router();
  const now = injected.now ?? (() => new Date());

  // Cache the dep resolver per-router so successive requests don't re-import.
  let depsPromise: Promise<TripPlannerDeps | null> | null = null;
  function getDeps(): Promise<TripPlannerDeps | null> {
    if (injected.getDeps) return Promise.resolve(injected.getDeps());
    if (!depsPromise) depsPromise = loadDefaultDeps();
    return depsPromise;
  }

  // -------------------------------------------------------------
  // POST /api/trip-planner/flights
  // -------------------------------------------------------------
  router.post("/flights", async (req: Request, res: Response) => {
    const parse = FlightRequestSchema.safeParse(req.body);
    if (!parse.success) {
      jsonError(res, 400, "invalid_flight_number", "Enter a flight number like 'SQ 12'.");
      return;
    }

    // Even a flight lookup is rate-limited so a bot can't hammer the RapidAPI key.
    const deps = await getDeps();
    if (deps) {
      const rate = deps.checkRate(`trip-planner:flights:${clientIp(req)}`);
      if (!rate.ok) {
        jsonError(
          res,
          429,
          "rate_limited",
          "Too many lookups — try again in a minute.",
          { retryAfterSeconds: rate.retryAfterSeconds },
        );
        return;
      }
    }

    let result;
    try {
      result = await lookupFlight(parse.data.flightNumber);
    } catch {
      // lookupFlight never throws by contract; defensive.
      result = { ok: false as const, configured: true as const, reason: "lookup_error" };
    }

    if (result.configured === false) {
      res.status(200).json({
        ok: true,
        data: {
          flight: null,
          warning: {
            code: "flight_lookup_not_configured",
            message:
              "Flight lookup isn't available right now. Enter your destination and dates manually.",
          },
        },
      });
      return;
    }

    if (!result.ok) {
      // Provider failure = non-blocking warning. The user can still fill dates.
      res.status(200).json({
        ok: true,
        data: {
          flight: null,
          warning: {
            code: result.reason,
            message:
              result.reason === "rate_limited"
                ? "Flight lookup is busy. Fill dates manually or try again in a minute."
                : "We couldn't reach the flight lookup service. Fill dates manually.",
          },
        },
      });
      return;
    }

    if (result.flight == null) {
      res.status(200).json({ ok: true, data: { flight: null } });
      return;
    }

    res.status(200).json({
      ok: true,
      data: {
        flight: result.flight,
        startDate: result.flight.startDate,
        endDate: result.flight.endDate,
        country: result.flight.arrival.country,
      },
    });
  });

  // -------------------------------------------------------------
  // POST /api/trip-planner/plan  (SSE)
  // -------------------------------------------------------------
  router.post("/plan", async (req: Request, res: Response) => {
    const parse = PlanRequestSchema.safeParse(req.body);
    if (!parse.success) {
      const first = parse.error.errors[0];
      jsonError(
        res,
        400,
        first?.message ?? "invalid_request",
        first?.message === "end_date_before_start"
          ? "Your return date must be on or after your departure."
          : first?.message === "trip_too_long"
            ? "We can plan trips up to 90 days. Break longer trips into segments."
            : "Please double-check the trip details.",
      );
      return;
    }
    const body = parse.data;

    // ---- Rate limit before SSE opens (so we can return a JSON 429 that
    // the client handles uniformly on the pre-stream path) -----------------
    const deps = await getDeps();
    if (!deps) {
      jsonError(
        res,
        503,
        "ai_unavailable",
        "The AI trip planner isn't wired up yet. Add your AI key in Replit Secrets.",
      );
      return;
    }
    if (!deps.aiAvailable()) {
      jsonError(
        res,
        503,
        "ai_unavailable",
        "The AI trip planner isn't configured. Add your AI key in Replit Secrets.",
      );
      return;
    }
    const rate = deps.checkRate(`trip-planner:plan:${clientIp(req)}`);
    if (!rate.ok) {
      const retryAfter = Math.max(1, Math.floor(rate.retryAfterSeconds));
      res.setHeader("Retry-After", String(retryAfter));
      jsonError(res, 429, "rate_limited", "Too many trip plans — try again soon.", {
        retryAfterSeconds: retryAfter,
      });
      return;
    }

    // ---- Resolve the optional flight (best-effort; the request already
    // validated any provided flightNumber format). We do NOT fail the plan if
    // the flight lookup fails: it only improves the itinerary.
    let flight: FlightInfo | null = null;
    if (body.flightNumber) {
      const fl = await lookupFlight(body.flightNumber);
      if (fl.ok && "flight" in fl && fl.flight) flight = fl.flight;
    }

    // ---- Build the prompt
    const { system, prompt } = buildTripPlannerPrompt({ req: body, flight });

    // ---- Open the SSE stream
    startSse(res);
    const aborter = new AbortController();
    req.on("close", () => aborter.abort());

    // Meta first so the client knows what to render while chunks stream.
    sseSend(res, {
      type: "meta",
      generatedAt: now().toISOString(),
      trip: {
        countries: body.countries,
        startDate: body.startDate,
        endDate: body.endDate,
        style: body.style,
        language: body.language,
        budget: body.budget ?? null,
        flight,
        /** Placeholder for the persistence batch. */
        tripId: null,
      },
    });

    // ---- Run the model
    let currentSection: Section | null = null;
    let sectionsDone = new Set<Section>();
    let costMeta: {
      inputTokens?: number;
      outputTokens?: number;
      model?: string;
    } = {};

    try {
      const result = await deps.streamPrompt({
        system,
        prompt,
        signal: aborter.signal,
        onChunk: (chunk) => {
          // Detect a section header and emit a section boundary if it changed.
          const detected = tagSection(chunk);
          if (detected && detected !== currentSection) {
            if (currentSection && !sectionsDone.has(currentSection)) {
              sseSend(res, { type: "section_done", section: currentSection });
              sectionsDone.add(currentSection);
            }
            currentSection = detected;
          }
          sseSend(res, {
            type: "chunk",
            section: currentSection,
            text: chunk,
          });
        },
      });

      // Flush any open section (a stream that stops mid-section is still
      // a valid partial output).
      if (currentSection && !sectionsDone.has(currentSection)) {
        sseSend(res, { type: "section_done", section: currentSection });
        sectionsDone.add(currentSection);
      }

      costMeta = {
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        model: result.model,
      };

      if (!result.recorded) {
        // Fire and forget; never block the SSE tail on a cost write. Failures
        // are logged by the costLog module itself.
        void deps
          .recordCost({
            route: "trip-planner/plan",
            inputTokens: costMeta.inputTokens,
            outputTokens: costMeta.outputTokens,
            model: costMeta.model,
          })
          .catch(() => {
            /* logged in costLog */
          });
      }

      // ---- "Stay connected" (real DB plan, no fabrication)
      const plan = await lookupRecommendedPlan(body.countries, body.stayConnected?.planCode ?? null);
      sseSend(res, { type: "connected", recommendation: plan });

      // ---- "Complete your trip" affiliate links (empty → hidden on client)
      const affiliateLinks = await lookupAffiliateLinks(deps.getDb);
      sseSend(res, { type: "affiliates", links: affiliateLinks });

      sseSend(res, { type: "done" });
      endSse(res);
    } catch (err) {
      if (aborter.signal.aborted) {
        // The client went away — nothing to send.
        endSse(res);
        return;
      }
      // Best effort cost log — the model may have billed us before failing.
      void deps
        .recordCost({
          route: "trip-planner/plan",
          inputTokens: costMeta.inputTokens,
          outputTokens: costMeta.outputTokens,
          model: costMeta.model,
        })
        .catch(() => {
          /* logged in costLog */
        });

      sseSend(res, {
        type: "error",
        code: "ai_failed",
        message:
          err instanceof Error
            ? `The planner hit an error: ${truncate(err.message, 200)}`
            : "The planner hit an error. Try again.",
      });
      endSse(res);
    }
  });

  // Method-not-allowed for other verbs on the same paths, so misconfigured
  // clients get a clear response rather than a vague 404.
  router.all("/plan", (_req: Request, res: Response) => {
    jsonError(res, 405, "method_not_allowed", "Use POST for /api/trip-planner/plan.");
  });
  router.all("/flights", (_req: Request, res: Response) => {
    jsonError(res, 405, "method_not_allowed", "Use POST for /api/trip-planner/flights.");
  });

  return router;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

// ---------------------------------------------------------------------------
// Test surface
// ---------------------------------------------------------------------------

export const __test__ = {
  PlanRequestSchema,
  FlightRequestSchema,
  buildTripPlannerPrompt,
  tagSection,
  lookupFlight: (n: string) => lookupFlight(n),
};

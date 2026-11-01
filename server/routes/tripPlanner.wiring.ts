/**
 * Wiring for the AI trip planner into the main Express app.
 *
 * This file replaces the two-line fragment previously queued as `file4.txt`.
 * That fragment was:
 *
 *     app.use(attachUser);
 *     app.use("/api/auth", createAuthRouter());
 *
 * ...which is *not* trip-planner work and (worse) references `attachUser`,
 * `createAuthRouter` and `express` types we cannot verify from here. Wiring a
 * route into the app belongs in `server/app.ts`; this file provides the two
 * pieces that file needs to compose, without re-declaring app-level middleware
 * that already exists there:
 *
 *   1. `mountTripPlanner(app)` — mounts `/api/trip-planner` with an optional
 *      dependency override (used by tests) and returns a disposer that is a
 *      no-op today but gives future background work (SAVE, PDF, reminders) a
 *      place to clean up.
 *
 *   2. `tripPlannerBootDiagnostics()` — a small pure function that reports
 *      what the planner will do at runtime (ai/rate/cost module shapes present
 *      or not, flight lookup configured or not). `server/app.ts` can log this
 *      once at boot so an operator sees "AI planner: unavailable (aiClient
 *      shape mismatch)" instead of discovering it from a 503 in production.
 *
 * Both functions are deliberately side-effect-light: they do NOT call the
 * supplier, do NOT read request state, and do NOT invent configuration. If a
 * module is missing a function, diagnostics say so plainly.
 *
 * Not in scope for this batch:
 *   - Session/auth wiring. The planner is public by design: users can plan
 *     before signing up; saving a *second* plan is the signup gate, and that
 *     lives in the persistence batch (`/api/trips`), not here.
 *   - The `/api/trips` persistence router. Queued.
 *   - Starting background jobs. The departure reminder job is queued too.
 */

import type { Express, RequestHandler } from "express";
import { createTripPlannerRouter, type TripPlannerDeps } from "./tripPlanner";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Where the planner should mount. Kept explicit so an app refactor is grep-able. */
export const TRIP_PLANNER_BASE_PATH = "/api/trip-planner" as const;

export interface MountTripPlannerOptions {
  /**
   * Override the dependency resolver. Tests pass a fake that returns a
   * deterministic `TripPlannerDeps`. Production callers omit this so the
   * router lazily imports the real AI/rate/cost modules and reports
   * `ai_unavailable` if they don't match its contract.
   */
  getDeps?: () => TripPlannerDeps | null;
  /** Injected clock (tests). Defaults to `() => new Date()`. */
  now?: () => Date;
  /**
   * Optional pass-through middleware mounted *before* the planner (e.g. a
   * body-size limiter). Kept as an array so callers can add it later without
   * a signature change.
   */
  preHandlers?: RequestHandler[];
}

export interface MountedTripPlanner {
  /** Path the router is mounted at (`/api/trip-planner`). */
  basePath: string;
  /**
   * Dispose hook. No background work is started by this batch, so calling it
   * is currently a no-op — but it exists so the persistence batch can add
   * cleanups (e.g. an abort of the SSE streams served here) without changing
   * the mount contract.
   */
  dispose: () => void;
}

// ---------------------------------------------------------------------------
// Mount
// ---------------------------------------------------------------------------

/**
 * Mount `/api/trip-planner` on an Express app.
 *
 * The router is created via `createTripPlannerRouter(...)` from
 * `server/routes/tripPlanner.ts`, which owns the SSE protocol and error
 * envelopes. This function only decides *where* it mounts and applies any
 * pre-handlers. It does not add a body parser: `express.json()` is expected
 * to already be installed by `server/app.ts` for all `/api` routes, and
 * adding a second one here would silently reject large bodies or double-parse
 * them.
 *
 * Idempotency: calling this twice on the same app will mount the router
 * twice. We do not try to detect that; instead the returned `basePath` is
 * exported as a constant so tests can assert the mount point directly.
 */
export function mountTripPlanner(
  app: Express,
  opts: MountTripPlannerOptions = {},
): MountedTripPlanner {
  const router = createTripPlannerRouter({
    getDeps: opts.getDeps,
    now: opts.now,
  });

  const pre = opts.preHandlers ?? [];
  app.use(TRIP_PLANNER_BASE_PATH, ...pre, router);

  // No background work started here; the disposer exists for symmetry with
  // future batches that will add it. Do not remove — call sites will depend
  // on it once the departure reminder job lands.
  return {
    basePath: TRIP_PLANNER_BASE_PATH,
    dispose: () => {
      /* no-op until background work is added */
    },
  };
}

// ---------------------------------------------------------------------------
// Boot diagnostics
// ---------------------------------------------------------------------------

/**
 * Snapshot of what the planner can do given the currently imported modules.
 * This is *not* a health check that calls the LLM — it only checks module
 * shapes and env presence, which is cheap and safe to run at boot.
 */
export interface TripPlannerBootDiagnostics {
  /** True when the AI/rate/cost modules all expose the required functions. */
  plannerReady: boolean;
  /** Human-readable reason when `plannerReady` is false. */
  reason: string | null;
  /** True when FLIGHT_API_KEY is set (flight lookup reacts to this at request time). */
  flightLookupConfigured: boolean;
  /** One-line summary suitable for a boot log. */
  summary: string;
}

/**
 * Build the boot diagnostic. Imports the same modules the router's default
 * resolver imports, so a mismatch here is exactly what a request would hit.
 *
 * Never throws: any import failure is caught and reported as `plannerReady:
 * false` with the error class name. That keeps `server/app.ts` from crashing
 * if, for example, `server/ai/aiClient.ts` isn't compiled yet in a dev setup.
 */
export async function tripPlannerBootDiagnostics(): Promise<TripPlannerBootDiagnostics> {
  const flightLookupConfigured =
    typeof process.env.FLIGHT_API_KEY === "string" && process.env.FLIGHT_API_KEY.length > 0;

  let plannerReady = false;
  let reason: string | null = null;

  try {
    const [aiMod, rateMod, costMod] = await Promise.all([
      import("../ai/aiClient"),
      import("../ai/rateLimit"),
      import("../ai/costLog"),
    ]);
    const ai = aiMod as unknown as {
      isAiConfigured?: unknown;
      streamPrompt?: unknown;
    };
    const rate = rateMod as unknown as { checkAiRateLimit?: unknown };
    const cost = costMod as unknown as { recordAiCost?: unknown };

    const missing: string[] = [];
    if (typeof ai.isAiConfigured !== "function") missing.push("aiClient.isAiConfigured");
    if (typeof ai.streamPrompt !== "function") missing.push("aiClient.streamPrompt");
    if (typeof rate.checkAiRateLimit !== "function") missing.push("rateLimit.checkAiRateLimit");
    if (typeof cost.recordAiCost !== "function") missing.push("costLog.recordAiCost");

    if (missing.length === 0) {
      plannerReady = true;
    } else {
      reason = `missing exports: ${missing.join(", ")}`;
    }
  } catch (e) {
    reason = `import failed: ${e instanceof Error ? e.name : "unknown"}`;
  }

  const summary = plannerReady
    ? `AI trip planner ready (flight lookup ${flightLookupConfigured ? "on" : "off"}).`
    : `AI trip planner unavailable — ${reason ?? "unknown reason"}. ` +
      `Requests will return 503 ai_unavailable. Flight lookup ${
        flightLookupConfigured ? "on" : "off"
      }.`;

  return { plannerReady, reason, flightLookupConfigured, summary };
}

// ---------------------------------------------------------------------------
// Test surface
// ---------------------------------------------------------------------------

export const __test__ = {
  TRIP_PLANNER_BASE_PATH,
};

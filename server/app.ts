import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { loadEnv } from "./config/env";

// Trip planner wiring. The helper mounts `/api/trip-planner` and reports a
// boot diagnostic. It is exported from its own module so this file stays a
// thin compositor; the helper itself owns the SSE routers detail.
import {
  mountTripPlanner,
  TRIP_PLANNER_BASE_PATH,
  tripPlannerBootDiagnostics,
} from "./routes/tripPlanner.wiring";

// Growth routes (referrals, membership, gift cards, discount codes). This
// router is self-contained: it builds its own DB adapters from the shared
// `getDb()` client and returns `{ ok, data } | { ok, error, message }`.
import { createGrowthRouter } from "./routes/growth";

// Webhook routers whose factory names, mount paths and body-parser
// requirements are *verifiable* from the files supplied to this phase.
//
// NOTE: the other routers (auth, catalog, checkout, esims, topup, refunds,
// push, AI, blog, reviews, trips, seo...) are not mounted here because their
// source files were not included in this request. Guessing their factory
// names would be worse than leaving them out: a wrong import either fails the
// build or silently mounts the wrong router. Add each alongside the ones
// below once the file (`server/routes/<name>.ts`) is available.
import { createEsimAccessWebhookRouter } from "./routes/webhooks.esimaccess";
import { createStripeWebhookRouter } from "./routes/stripeWebhook";

/**
 * Build the Express application.
 *
 * Design notes:
 * - `createApp` is pure wiring so tests can mount it without binding a port.
 * - Body parsing is scoped: JSON for general API routes, raw for webhook
 *   routes that verify a signature over the exact bytes Stripe sent.
 * - Only routers with a verified factory + mount contract are wired. The
 *   others are added as their sources land; nothing is stubbed to fake a
 *   successful response, so unimplemented surfaces return 404.
 * - The trip planner is mounted first so its streaming responses aren't
 *   disturbed by any generic JSON middleware below.
 */
export function createApp(): Express {
  const env = loadEnv();
  const app = express();

  // Trust the platform proxy so req.protocol/req.ip are correct behind
  // Replit's edge. This matters for IP-scoped rate limits in the planner
  // (they key on req.ip via the clientIp helper inside the router).
  app.set("trust proxy", true);
  app.disable("x-powered-by");

  // -----------------------------------------------------------------
  // Body parsers — ORDER MATTERS
  //
  // The Stripe webhook verifies HMAC over the raw bytes,
  // so it MUST receive a raw Buffer, not a pre-parsed object.
  // Mount the raw parser and the router *before* `express.json(...)`
  // so a client that forgets `Content-Type: application/json` still
  // hits the correct handler (Stripe sends `application/json`).
  //
  // The eSIM Access webhook does *not* verify a signature today
  // (see `server/routes/webhooks.esimaccess.ts` — trust is scoped to
  // the shared secret URL + notifyId dedupe). It expects a parsed
  // JSON body, so it can be installed after `express.json`.
  // -----------------------------------------------------------------
  app.use(
    "/api/webhooks/stripe",
    express.raw({ type: "*/*", limit: "1mb" }),
    createStripeWebhookRouter(),
  );

  // General JSON body parser for everything else.
  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: false }));

  // -----------------------------------------------------------------
  // Basic security headers (kept minimal; no external dep in this phase)
  // -----------------------------------------------------------------
  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    res.setHeader("X-Frame-Options", "SAMEORIGIN");
    next();
  });

  // -----------------------------------------------------------------
  // Health & readiness
  // -----------------------------------------------------------------
  app.get("/api/health", (_req: Request, res: Response) => {
    res.status(200).json({
      ok: true,
      env: env.raw.NODE_ENV,
      time: new Date().toISOString(),
      featureFlags: env.featureFlags,
      warnings: env.warnings,
    });
  });

  // -----------------------------------------------------------------
  // Trip planner (AI) — public. Saving a *second* plan requires signup;
  // that rule lives in the queued persistence batch, not here.
  // The mount helper applies no auth middleware, so the endpoint is reachable
  // before signup (by design). Missing AI keys surface as 503 from the
  // router's own rate/ai guard.
  // -----------------------------------------------------------------
  mountTripPlanner(app);

  // -----------------------------------------------------------------
  // eSIM Access supplier webhook — responds 200 immediately, then
  // processes in the background. See webhooks.esimaccess.ts for the
  // dedupe and logging contract. It expects `req.body` to be a parsed
  // JSON object (the JSON parser above already ran for this path).
  // -----------------------------------------------------------------
  app.use("/api/webhooks/esimaccess", createEsimAccessWebhookRouter());

  // -----------------------------------------------------------------
  // Growth (referrals, membership, gift cards, discount codes).
  // Mounted after the JSON parser so req.body is populated. Routes are
  // namespaced under /api/growth/* for a single, honest surface. The
  // router is the source of truth for auth (referrals/membership require a
  // session, most checkout-side previews allow guests) and for
  // service-role internal calls (qualify/commit/admin-create).
  // -----------------------------------------------------------------
  app.use("/api/growth", createGrowthRouter());

  // -----------------------------------------------------------------
  // API not-yet-mounted guard — any remaining /api/* is a JSON 404.
  // Placed AFTER the mounts above so only truly unknown API routes
  // fall through. A future router mounts *above* this line.
  // -----------------------------------------------------------------
  app.use("/api", (_req: Request, res: Response) => {
    res
      .status(404)
      .json({ error: "not_found", message: "API route not implemented yet." });
  });

  // -----------------------------------------------------------------
  // Client / SSR routes are registered by later phases (Vite dev
  // middleware in dev, static assets in prod). Until then, non-API
  // requests return a plain 404 so tests can assert cleanly.
  // -----------------------------------------------------------------
  app.use((_req: Request, res: Response) => {
    res.status(404).type("text/plain").send("Not found");
  });

  // -----------------------------------------------------------------
  // Centralized error handler
  // -----------------------------------------------------------------
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const isProd = env.isProduction;
    const message =
      err instanceof Error && !isProd ? err.message : "Internal server error";
    if (err instanceof Error) {
      // eslint-disable-next-line no-console
      console.error("[server error]", err.stack || err.message);
    } else {
      // eslint-disable-next-line no-console
      console.error("[server error]", err);
    }
    if (res.headersSent) return;
    res.status(500).json({ error: "internal_error", message });
  });

  // Fire-and-forget boot diagnostic so the operator sees "AI trip planner
  // ready/unavailable" once, rather than discovering it via a 503 in prod.
  // It never throws and never blocks the app.
  void tripPlannerBootDiagnostics()
    .then((d) => {
      // The route module also exports its mount path; log both for a
      // single readable line.
      // eslint-disable-next-line no-console
      console.log(`[boot] ${d.summary} (mounted at ${TRIP_PLANNER_BASE_PATH})`);
    })
    .catch((e: unknown) => {
      // eslint-disable-next-line no-console
      console.log(
        `[boot] trip planner diagnostics failed: ${
          e instanceof Error ? e.name : "unknown"
        }`,
      );
    });

  return app;
}

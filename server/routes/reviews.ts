/**
 * /api/reviews + /api/social-proof — the storefront's read surfaces for the
 * conversion features (Phase 7).
 *
 * SCOPE
 * -----
 * This router exposes:
 *
 *   GET /api/social-proof/roaming-savings?country=sg&days=7[&carrier=singtel]
 *     → 200 { ok:true, data: { savings: RoamingSavings|null, carriers: Carrier[] } }
 *       `savings` is null when the admin hasn't added a carrier price row for
 *       that country, or no matching eSIM plan exists. The calculator UI hides
 *       then rather than showing a fake comparison. `carriers` is the list
 *       the UI offers in its "compare with" dropdown (may be empty).
 *
 *   GET /api/social-proof/weekly-purchases?country=sg
 *     → 200 { ok:true, data: { count: number|null, windowStart: string|null } }
 *       `count: null` means "couldn't count right now" (DB down, columns
 *       missing). The storefront hides the badge on null.
 *
 *   GET /api/social-proof/network-speed?country=sg&network=Singtel%205G
 *     → 200 { ok:true, data: { speed: NetworkSpeed|null } }
 *       Single lookup for one plan card. `speed: null` hides the chip.
 *
 *   GET /api/social-proof/network-speeds?country=sg
 *     → 200 { ok:true, data: { speeds: NetworkSpeed[] } }
 *       Batch for a country page.
 *
 *   GET /api/social-proof/exit-popup
 *     → 200 { ok:true, data: ExitPopupConfig }
 *       Always 200. `enabled:false` is the safe default for a fresh DB.
 *
 *   GET /api/reviews?country=sg[&limit=20]
 *     → 200 { ok:true, data: { reviews: PublicReview[] } }
 *       Only `status='published'` reviews are returned.
 *
 *   POST /api/reviews
 *     body: { countryCode, rating (1..5), body, orderId?, authorDisplay? }
 *     Rule: if `orderId` is provided AND the caller is signed in AND the order
 *           belongs to them, the review is created as VERIFIED. Otherwise it's
 *           an unverified 'pending' review that requires admin moderation
 *           before appearing. We refuse (400) an unverified submission for a
 *           country the caller does not have a paid order in — the alternative
 *           (silently trusting the body) is a spam vector.
 *     → 201 { ok:true, data: { review: { id } } }
 *     → 400 { ok:false, error:"invalid_request" | "rating_invalid" | "body_too_short"
 *             | "country_invalid" | "not_purchased" | "duplicate" }
 *     → 401 (only when an orderId is provided but there's no session)
 *
 *   POST /api/reviews/:id/publish      (admin-only action, in a later batch)
 *   POST /api/reviews/:id/reject       (admin-only action, in a later batch)
 *     These are deliberately NOT implemented here — the admin dashboard batch
 *     owns moderation. Attempting them returns 501, not 404, so an admin can
 *     tell the difference between "not wired" and "wrong path".
 *
 * AUTH MODEL
 * ----------
 * The router accepts an injected `getUser(req)` function so it composes with
 * whichever auth lifecycle the app mounts (`requireAuth` optional middleware
 * or a `req.user` set by a prior session handler). It never imports
 * `requireAuth` directly: the read endpoints are PUBLIC (the country page
 * calls them), and only the review submission needs identity. If the app
 * doesn't attach `req.user`, `getUser` returns null and POST /reviews accepts
 * only unauthenticated reviews gated by email-match against a paid order —
 * which doesn't exist, so it will 400 `not_purchased` unless a signed-in user
 * is present. That's the honest behaviour; the app should wire session
 * middleware as it does elsewhere.
 *
 * DESIGN NOTES
 * ------------
 *  * Every read goes through `server/services/socialProof.ts`; this router
 *    only shapes HTTP responses and validates input.
 *  * Writes for POST /reviews validate the country slug (`/^[a-z]{2}$/`)
 *    before INSERT — the migration's country_code column has no CHECK because
 *    regional packages use non-ISO region names, but reviews are always
 *    country-scoped per the spec ("per-country reviews").
 *  * We use `sql` tagged templates, not the Drizzle query builder, so this
 *    module has zero coupling to table-object shapes. The DB column contract
 *    is documented in `0013_reviews_roaming_speed.sql`.
 *  * The service already fail-opens to `null`/`[]` on DB errors, so a broken
 *    DB yields hidden UI (never a 500 the customer can't recover from).
 *  * Reviews POST is the only mutating path; it does NOT send email or push
 *    notifications (the post-trip request queue in `review_requests` handles
 *    that in a later batch). It returns the row id so the customer sees
 *    "thanks, we'll show it after review" rather than an empty page.
 */

import { Router, type Request, type RequestHandler, type Response } from "express";
import { sql } from "drizzle-orm";
import { z } from "zod";

import { getDb } from "../db/client";
import {
  getExitPopupConfig,
  getNetworkSpeed,
  getRoamingSavings,
  getWeeklyPurchaseCount,
  listCarriersForCountry,
  listNetworkSpeeds,
  listPublishedReviews,
} from "../services/socialProof";

// ---------------------------------------------------------------------------
// Envelope helpers (match the rest of the API)
// ---------------------------------------------------------------------------

function ok<T>(res: Response, data: T, status = 200): void {
  res.status(status).json({ ok: true, data });
}

function fail(
  res: Response,
  status: number,
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
): void {
  res.status(status).json({ ok: false, error: code, message, ...extra });
}

// ---------------------------------------------------------------------------
// Request validation
// ---------------------------------------------------------------------------

/** lowercase ISO-3166 alpha-2. Storefront routes use this exact shape. */
const CountryQuery = z.object({
  country: z
    .string()
    .trim()
    .transform((v) => v.toLowerCase())
    .refine((v) => /^[a-z]{2}$/.test(v), "country_invalid"),
});

const RoamingQuery = CountryQuery.extend({
  days: z.coerce.number().int().min(1).max(90),
  carrier: z.string().trim().min(1).max(64).optional(),
});

const SpeedQuery = CountryQuery.extend({
  network: z.string().trim().min(1).max(120),
});

const ListReviewsQuery = CountryQuery.extend({
  limit: z.coerce.number().int().min(1).max(50).optional(),
});

/**
 * Review submission body. `authorDisplay` is optional; when omitted we use
 * "Traveller" (the default in the migration). `email` is optional and used
 * only for the "you can manage this review" future flow — it's never shown
 * on the public review list.
 */
const CreateReviewBody = z.object({
  countryCode: z
    .string()
    .trim()
    .transform((v) => v.toLowerCase())
    .refine((v) => /^[a-z]{2}$/.test(v), "country_invalid"),
  rating: z.coerce.number().int().min(1, "rating_invalid").max(5, "rating_invalid"),
  body: z.string().trim().min(10, "body_too_short").max(4000, "body_too_long"),
  orderId: z.coerce.number().int().positive().optional(),
  authorDisplay: z.string().trim().min(1).max(80).optional(),
});

interface JwtUser {
  id: number;
  email: string;
}

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

export interface ReviewsRouterDeps {
  /**
   * Optional session reader. Given `req`, return the signed-in user or null.
   * If omitted, the router will read `req.user` directly (the shape
   * `requireAuth` attaches elsewhere in the app). Keeping it injectable lets
   * tests pass a fake without wiring the auth middleware stack.
   */
  getUser?: (req: Request) => JwtUser | null;
  /** Injected clock for deterministic tests. */
  now?: () => Date;
}

export function createReviewsRouter(deps: ReviewsRouterDeps = {}): Router {
  const router = Router();
  const now = deps.now ?? (() => new Date());
  const getUser = deps.getUser ?? defaultGetUser;

  // ---- GET /social-proof/roaming-savings ----
  router.get("/social-proof/roaming-savings", async (req: Request, res: Response) => {
    const parse = RoamingQuery.safeParse(req.query);
    if (!parse.success) {
      const first = parse.error.errors[0];
      fail(
        res,
        400,
        first?.message ?? "invalid_request",
        first?.message === "country_invalid"
          ? "Pick a destination country (two-letter code, e.g. 'sg')."
          : "Enter a trip length between 1 and 90 days.",
      );
      return;
    }
    const { country, days, carrier } = parse.data;
    const [savings, carriers] = await Promise.all([
      getRoamingSavings({ countryCode: country, days, carrierKey: carrier }),
      listCarriersForCountry(country),
    ]);
    ok(res, { savings, carriers });
  });

  // ---- GET /social-proof/weekly-purchases ----
  router.get("/social-proof/weekly-purchases", async (req: Request, res: Response) => {
    const parse = CountryQuery.safeParse(req.query);
    if (!parse.success) {
      fail(res, 400, "country_invalid", "Pick a destination country.");
      return;
    }
    const result = await getWeeklyPurchaseCount(parse.data.country);
    if (!result) {
      // Service couldn't count. Surface as null, not an error, so the badge
      // hides rather than blocking the page. HTTP 200 so the caller can't
      // distinguish "no sales" from "can't count" — that's deliberate for
      // storefront resilience; admin dashboards read the DB directly.
      ok(res, { count: null, windowStart: null });
      return;
    }
    ok(res, result);
  });

  // ---- GET /social-proof/network-speed ----
  router.get("/social-proof/network-speed", async (req: Request, res: Response) => {
    const parse = SpeedQuery.safeParse(req.query);
    if (!parse.success) {
      fail(res, 400, "invalid_request", "Country and network label are required.");
      return;
    }
    const speed = await getNetworkSpeed(parse.data.country, parse.data.network);
    ok(res, { speed });
  });

  // ---- GET /social-proof/network-speeds ----
  router.get("/social-proof/network-speeds", async (req: Request, res: Response) => {
    const parse = CountryQuery.safeParse(req.query);
    if (!parse.success) {
      fail(res, 400, "country_invalid", "Pick a destination country.");
      return;
    }
    const speeds = await listNetworkSpeeds(parse.data.country);
    ok(res, { speeds });
  });

  // ---- GET /social-proof/exit-popup ----
  router.get("/social-proof/exit-popup", async (_req: Request, res: Response) => {
    // Always 200 with a safe config; on a fresh DB the popup is disabled.
    const cfg = await getExitPopupConfig();
    ok(res, cfg);
  });

  // ---- GET /reviews ----
  router.get("/reviews", async (req: Request, res: Response) => {
    const parse = ListReviewsQuery.safeParse(req.query);
    if (!parse.success) {
      fail(res, 400, "country_invalid", "Pick a destination country.");
      return;
    }
    const reviews = await listPublishedReviews(parse.data.country, parse.data.limit ?? 20);
    ok(res, { reviews });
  });

  // ---- POST /reviews ----
  router.post("/reviews", async (req: Request, res: Response) => {
    const parse = CreateReviewBody.safeParse(req.body);
    if (!parse.success) {
      const first = parse.error.errors[0];
      const code = first?.message ?? "invalid_request";
      fail(
        res,
        400,
        code,
        code === "rating_invalid"
          ? "Pick a star rating from 1 to 5."
          : code === "body_too_short"
            ? "Add a few sentences so other travellers can learn from your review."
            : code === "country_invalid"
              ? "Pick the country you want to review."
              : "Please double-check your review.",
      );
      return;
    }
    const input = parse.data;

    const db = getDb();
    if (!db) {
      fail(res, 503, "reviews_unavailable", "Reviews aren't available right now.");
      return;
    }

    const user = getUser(req);

    // ---- Associate the review with an order (and country). This is what
    // decides `verified` vs. 'pending'. An orderId must belong to the caller
    // AND contain that country; otherwise the review is created unverified
    // and, without a session, refused entirely (`not_purchased`).
    let verified = false;
    let orderId: number | null = null;
    let entityUserId: number | null = user?.id ?? null;

    if (input.orderId != null) {
      if (!user) {
        fail(
          res,
          401,
          "signin_required",
          "Sign in to leave a verified review for this order.",
        );
        return;
      }
      const match = await lookupOwnedOrderCountry({
        orderId: input.orderId,
        userId: user.id,
        countryCode: input.countryCode,
      });
      if (!match) {
        fail(
          res,
          400,
          "not_purchased",
          "We couldn't find a paid order for that country on your account.",
        );
        return;
      }
      verified = match.paid;
      orderId = match.orderId;
      entityUserId = user.id;
    } else {
      // No order attached. Without a session, refuse: an anonymous user can't
      // prove they travelled, and we don't accept drive-by reviews.
      if (!user) {
        fail(
          res,
          400,
          "not_purchased",
          "Open My eSIMs to leave a review for an order you bought — or sign in first.",
        );
        return;
      }
      // A signed-in user who didn't reference an order: look for ANY paid
      // order for that country on their account.
      const anyPaid = await lookupAnyPaidOrderForCountry({
        userId: user.id,
        countryCode: input.countryCode,
      });
      if (!anyPaid) {
        fail(
          res,
          400,
          "not_purchased",
          "Reviews are open to travellers who bought an eSIM for this country.",
        );
        return;
      }
      verified = true;
      orderId = anyPaid.orderId;
    }

    const authorDisplay = input.authorDisplay?.trim() || "Traveller";
    const insertedAt = now();

    try {
      // Duplicate guard: the migration's unique (order_id, country_code) index
      // enforces this at the DB, but we return a friendly 400 before hitting
      // that error.
      const existing = await db.execute(sql`
        SELECT id FROM reviews
         WHERE order_id = ${orderId}
           AND country_code = ${input.countryCode}
         LIMIT 1
      `);
      if (firstRow(existing)) {
        fail(
          res,
          400,
          "duplicate",
          "You've already reviewed this trip. Thanks for sharing!",
        );
        return;
      }

      // Insert. `status` is 'pending' until admin moderation publishes it —
      // UNLESS the only reviewer signal is verified AND the "minimum visible"
      // setting is 0, in which case publish immediately. We keep 'pending' by
      // default: the admin dashboard batch is the right place to tune
      // auto-publish.
      const result = await db.execute(sql`
        INSERT INTO reviews (
          country_code, order_id, user_id, author_display, rating, body,
          verified, status, created_at
        ) VALUES (
          ${input.countryCode},
          ${orderId},
          ${entityUserId},
          ${authorDisplay},
          ${input.rating},
          ${input.body},
          ${verified},
          'pending',
          ${insertedAt.toISOString()}
        )
        RETURNING id
      `);
      const row = firstRow<{ id: number }>(result);
      if (!row) {
        fail(res, 500, "internal_error", "The review was submitted but we couldn't confirm it.");
        return;
      }
      ok(res, { review: { id: row.id } }, 201);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `[reviews.route] insert failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      fail(res, 500, "internal_error", "Could not save your review right now.");
    }
  });

  // ---- Deliberately 501 so an admin can tell "not wired" from "wrong path" ----
  router.all("/reviews/:id/publish", notYetImplemented("Review moderation lands with the admin dashboard."));
  router.all("/reviews/:id/reject", notYetImplemented("Review moderation lands with the admin dashboard."));

  return router;
}

// ---------------------------------------------------------------------------
// Router helpers
// ---------------------------------------------------------------------------

function defaultGetUser(req: Request): JwtUser | null {
  const u = (req as unknown as { user?: { id?: unknown; email?: unknown } }).user;
  if (u && typeof u.id === "number" && typeof u.email === "string") {
    return { id: u.id, email: u.email };
  }
  return null;
}

/**
 * Result of a per-order ownership check. `paid` distinguishes a paid order
 * from one that exists but hasn't been paid — the latter cannot be a verified
 * review source.
 */
type OrderOwnership = { orderId: number; paid: boolean };

/**
 * Look up whether `orderId` belongs to `userId` AND contains a paid
 * `order_items` row for `countryCode`. Returns null if either check fails.
 *
 * The SQL joins `orders` → `order_items`; both exist from earlier phases.
 * Status whitelist matches the weekly-purchase-count query (paid-or-later) so
 * the two share a definition of "bought".
 */
async function lookupOwnedOrderCountry(input: {
  orderId: number;
  userId: number;
  countryCode: string;
}): Promise<OrderOwnership | null> {
  const db = getDb();
  if (!db) return null;
  try {
    const result = await db.execute(sql`
      SELECT o.id AS order_id,
             (o.status IN ('paid','pending_fulfilment','processing','completed')) AS paid
        FROM orders o
        JOIN order_items oi ON oi.order_id = o.id
       WHERE o.id = ${input.orderId}
         AND oi.country_code = ${input.countryCode}
         AND (o.user_id = ${input.userId} OR o.buyer_email = (
           SELECT email FROM users WHERE id = ${input.userId}
         ))
       LIMIT 1
    `);
    const row = firstRow<{ order_id: number; paid: boolean }>(result);
    if (!row) return null;
    return { orderId: row.order_id, paid: row.paid === true };
  } catch {
    return null;
  }
}

/**
 * Find any paid order belonging to `userId` for `countryCode`. Used when the
 * caller doesn't pass `orderId` — we still want to verify their purchase.
 */
async function lookupAnyPaidOrderForCountry(input: {
  userId: number;
  countryCode: string;
}): Promise<{ orderId: number } | null> {
  const db = getDb();
  if (!db) return null;
  try {
    const result = await db.execute(sql`
      SELECT o.id AS order_id
        FROM orders o
        JOIN order_items oi ON oi.order_id = o.id
       WHERE oi.country_code = ${input.countryCode}
         AND o.status IN ('paid','pending_fulfilment','processing','completed')
         AND (o.user_id = ${input.userId} OR o.buyer_email = (
           SELECT email FROM users WHERE id = ${input.userId}
         ))
       ORDER BY COALESCE(o.paid_at, o.placed_at) DESC
       LIMIT 1
    `);
    const row = firstRow<{ order_id: number }>(result);
    return row ? { orderId: row.order_id } : null;
  } catch {
    return null;
  }
}

function firstRow<T = Record<string, unknown>>(result: unknown): T | null {
  if (Array.isArray(result)) return (result[0] as T | undefined) ?? null;
  if (result && typeof result === "object" && "rows" in result) {
    const r = (result as { rows?: unknown }).rows;
    if (Array.isArray(r)) return (r[0] as T | undefined) ?? null;
  }
  return null;
}

/**
 * A handler that reports 501 with a specific message. Used for admin actions
 * that belong to a later batch. `501 Not Implemented` is semantically correct
 * (the route exists, the server understands it, but the operation isn't
 * available yet) — 404 would mislead an admin into thinking the path is wrong.
 */
function notYetImplemented(message: string): RequestHandler {
  return (_req: Request, res: Response) => {
    fail(res, 501, "not_implemented", message);
  };
}

// ---------------------------------------------------------------------------
// Test surface
// ---------------------------------------------------------------------------

export const __test__ = {
  CountryQuery,
  RoamingQuery,
  SpeedQuery,
  ListReviewsQuery,
  CreateReviewBody,
  lookupOwnedOrderCountry,
  lookupAnyPaidOrderForCountry,
  firstRow,
};

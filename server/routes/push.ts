/**
 * Push subscription management API.
 *
 * Endpoints (mount under `/api/push`):
 *   GET  /api/push/key          → { ok, data: { publicKey } } | 503 when VAPID absent
 *   GET  /api/push/subscriptions→ list the signed-in user's subscriptions
 *   POST /api/push/subscribe    → upsert one subscription (endpoint is the unique key)
 *   POST /api/push/unsubscribe  → delete one subscription by endpoint
 *
 * Contract notes:
 *  - Subscriptions are stored in `push_subscriptions` (migration 0021). The
 *    notification service (server/services/notifications.ts) reads the same
 *    table via raw SQL, joining `esims.user_id`. The column names here MUST
 *    match what that query selects: `endpoint`, `p256dh`, `auth`, `user_id`.
 *  - We do not require a logged-in user for the *public key* endpoint (the PWA
 *    needs it before sign-in), but every write requires auth: a push target is
 *    personal data and must be tied to a user's account so low-data alerts
 *    only go to the right device.
 *  - All error bodies use the project-wide envelope { ok:false, error, message }
 *    and never leak the endpoint or keys back to the caller.
 *  - The route never pushes outbound; the notifications service does. This file
 *    is CRUD only.
 */
import { Router, type Request, type RequestHandler, type Response } from "express";
import { and, eq } from "drizzle-orm";

import { getDb } from "../db/client";
import { pushSubscriptions } from "../db/schema";
import { requireAuth } from "../middleware/requireAuth";
import {
  isPushConfigured,
  getPushPublicKey,
  type PushSubscriptionRecord,
} from "../lib/push";

// ---------------------------------------------------------------------------
// Request/response helpers
// ---------------------------------------------------------------------------

function ok<T>(res: Response, data: T, status = 200): void {
  res.status(status).json({ ok: true, data });
}

function fail(
  res: Response,
  status: number,
  error: string,
  message: string,
): void {
  res.status(status).json({ ok: false, error, message });
}

/** Narrow an unknown body to the shape a browser `PushSubscription.toJSON()` produces. */
function parseSubscriptionBody(
  body: unknown,
):
  | { ok: true; value: PushSubscriptionRecord & { userAgent: string | null } }
  | { ok: false; reason: string } {
  if (!body || typeof body !== "object") {
    return { ok: false, reason: "body_must_be_object" };
  }
  const b = body as Record<string, unknown>;
  const endpoint = typeof b.endpoint === "string" ? b.endpoint.trim() : "";
  if (!endpoint) return { ok: false, reason: "missing_endpoint" };
  // A push endpoint is always https. Accept nothing else so a device cannot
  // register an http:// URL that would leak payloads in the clear.
  if (!/^https:\/\//i.test(endpoint)) {
    return { ok: false, reason: "endpoint_must_be_https" };
  }
  if (endpoint.length > 2048) return { ok: false, reason: "endpoint_too_long" };

  const keys =
    b.keys && typeof b.keys === "object"
      ? (b.keys as Record<string, unknown>)
      : null;
  const p256dh = keys && typeof keys.p256dh === "string" ? keys.p256dh : "";
  const auth = keys && typeof keys.auth === "string" ? keys.auth : "";
  if (!p256dh || !auth) {
    return { ok: false, reason: "missing_keys" };
  }

  const userAgent =
    typeof b.userAgent === "string" && b.userAgent.length > 0
      ? b.userAgent.slice(0, 500)
      : null;

  return {
    ok: true,
    value: { endpoint, keys: { p256dh, auth }, userAgent },
  };
}

// ---------------------------------------------------------------------------
// Router factory (injectable seams for tests)
// ---------------------------------------------------------------------------

export interface PushRouterDeps {
  requireAuth?: RequestHandler;
  getDb?: typeof getDb;
  isPushConfigured?: () => boolean;
  getPushPublicKey?: () => string | null;
  /** Injectable "now" for the updated_at column so tests are deterministic. */
  now?: () => Date;
}

/**
 * The concrete handler bodies live on a factory so tests can inject a fake DB
 * and a stub `requireAuth`. Production calls `createPushRouter()` with no
 * arguments and gets the real DB + real auth middleware.
 */
export function createPushRouter(deps: PushRouterDeps = {}): Router {
  const auth = deps.requireAuth ?? requireAuth;
  const dbOf = deps.getDb ?? getDb;
  const configured = deps.isPushConfigured ?? isPushConfigured;
  const publicKeyOf = deps.getPushPublicKey ?? getPushPublicKey;
  const now = deps.now ?? (() => new Date());

  const router = Router();

  // ----- Public key (no auth) --------------------------------------------------
  router.get("/key", (_req: Request, res: Response) => {
    if (!configured()) {
      // Honest: without VAPID we cannot sign subscriptions, so we refuse.
      fail(
        res,
        503,
        "push_not_configured",
        "Push notifications are not configured on this deployment.",
      );
      return;
    }
    const publicKey = publicKeyOf();
    if (!publicKey) {
      fail(
        res,
        503,
        "push_not_configured",
        "Push public key is not set.",
      );
      return;
    }
    ok(res, { publicKey });
  });

  // ----- List (auth) ----------------------------------------------------------
  router.get("/subscriptions", auth, async (req: Request, res: Response) => {
    const user = getReqUser(req);
    if (!user) {
      fail(res, 401, "unauthenticated", "Sign in required.");
      return;
    }
    const db = dbOf();
    if (!db) {
      fail(res, 503, "db_unavailable", "Subscription store is not configured.");
      return;
    }
    try {
      const rows = await db
        .select({
          endpoint: pushSubscriptions.endpoint,
          createdAt: pushSubscriptions.createdAt,
          updatedAt: pushSubscriptions.updatedAt,
        })
        .from(pushSubscriptions)
        .where(eq(pushSubscriptions.userId, user.id));
      ok(res, {
        subscriptions: rows.map((r) => ({
          // Never echo keys; the client already has them.
          endpoint: r.endpoint,
          createdAt: toIso(r.createdAt),
          updatedAt: toIso(r.updatedAt),
        })),
      });
    } catch (err) {
      fail(
        res,
        500,
        "subscriptions_read_failed",
        err instanceof Error ? err.message : "Could not read subscriptions.",
      );
    }
  });

  // ----- Subscribe (auth) -----------------------------------------------------
  router.post("/subscribe", auth, async (req: Request, res: Response) => {
    const user = getReqUser(req);
    if (!user) {
      fail(res, 401, "unauthenticated", "Sign in required.");
      return;
    }
    if (!configured()) {
      fail(
        res,
        503,
        "push_not_configured",
        "Push notifications are not configured on this deployment.",
      );
      return;
    }
    const parsed = parseSubscriptionBody(req.body);
    if (!parsed.ok) {
      fail(res, 400, "invalid_subscription", `Invalid subscription: ${parsed.reason}.`);
      return;
    }
    const db = dbOf();
    if (!db) {
      fail(res, 503, "db_unavailable", "Subscription store is not configured.");
      return;
    }
    const stamp = now();
    try {
      // Upsert on `endpoint`: the browser may rotate nothing new when the
      // user re-grants permission, so we keep the same row and refresh keys.
      // Ownership: if the same endpoint was previously registered under *another*
      // user (e.g. shared device), we override `user_id` to the current caller.
      // That is the correct behaviour — a push target always belongs to whoever
      // is currently signed in and granting permission on this device.
      await db
        .insert(pushSubscriptions)
        .values({
          userId: user.id,
          endpoint: parsed.value.endpoint,
          p256dh: parsed.value.keys.p256dh,
          auth: parsed.value.keys.auth,
          userAgent: parsed.value.userAgent,
          createdAt: stamp,
          updatedAt: stamp,
        })
        .onConflictDoUpdate({
          target: pushSubscriptions.endpoint,
          set: {
            userId: user.id,
            p256dh: parsed.value.keys.p256dh,
            auth: parsed.value.keys.auth,
            userAgent: parsed.value.userAgent,
            updatedAt: stamp,
          },
        });
      ok(res, { subscribed: true });
    } catch (err) {
      fail(
        res,
        500,
        "subscribe_failed",
        err instanceof Error ? err.message : "Could not save subscription.",
      );
    }
  });

  // ----- Unsubscribe (auth) ---------------------------------------------------
  router.post("/unsubscribe", auth, async (req: Request, res: Response) => {
    const user = getReqUser(req);
    if (!user) {
      fail(res, 401, "unauthenticated", "Sign in required.");
      return;
    }
    const body = req.body as { endpoint?: unknown } | undefined;
    const endpoint =
      body && typeof body.endpoint === "string" ? body.endpoint.trim() : "";
    if (!endpoint) {
      fail(res, 400, "invalid_subscription", "endpoint is required.");
      return;
    }
    const db = dbOf();
    if (!db) {
      fail(res, 503, "db_unavailable", "Subscription store is not configured.");
      return;
    }
    try {
      await db
        .delete(pushSubscriptions)
        .where(
          and(
            eq(pushSubscriptions.endpoint, endpoint),
            // Ownership: a user may only remove their own row.
            eq(pushSubscriptions.userId, user.id),
          ),
        );
      ok(res, { unsubscribed: true });
    } catch (err) {
      fail(
        res,
        500,
        "unsubscribe_failed",
        err instanceof Error ? err.message : "Could not remove subscription.",
      );
    }
  });

  return router;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Matches the shape requireAuth attaches. Kept local so this route compiles
 *  even if the middleware changes its module export list. */
function getReqUser(req: Request): { id: number } | null {
  const u = (req as unknown as { user?: { id?: unknown } }).user;
  if (u && typeof u.id === "number") return { id: u.id };
  return null;
}

function toIso(v: Date | string | null | undefined): string | null {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString();
  return v;
}

// ---------------------------------------------------------------------------
// Test surface
// ---------------------------------------------------------------------------
export const __test__ = {
  parseSubscriptionBody,
  getReqUser,
};

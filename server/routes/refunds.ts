/**
 * Refund routes.
 *
 * Endpoints (mounted at /api/refunds by the app):
 *   POST /              — request a refund for an eSIM
 *   GET  /me            — list the signed-in user's refund requests
 *   POST /:publicId/decide — admin: approve/reject a review request
 *
 * Auth: `POST /` and `GET /me` call the real `requireAuth` middleware via the
 * router factory's injectable seam. `POST /:publicId/decide` additionally
 * requires an admin flag on the session user; the middleware stack tolerates
 * a narrower session shape than `req.user.is_admin` in case `requireAuth`
 * doesn't expose it yet, but we do not silently fall through: without an
 * admin flag we return 403. Later phases can extend `requireAuth` to enforce
 * admin there too.
 *
 * Response envelope matches the rest of the API: `{ ok, data }` / `{ ok:false,
 * error, message }`.
 *
 * Nothing here fakes a successful refund. If Stripe or eSIM Access is not
 * configured, the route returns `{ ok:false }` with a stable `error` code so
 * the UI can show the honest state instead of a hopeful one.
 */
import { Router, type Request, type RequestHandler, type Response } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/requireAuth";
import { getDb } from "../db/client";
import {
  requestRefund,
  listRefundRequestsForUser,
  decideRefundReview,
  RefundError,
  type RefundSupplier,
  type RefundStripe,
  type RefundNotifier,
} from "../services/refund";

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

const requestSchema = z
  .object({
    esimId: z.number().int().positive(),
    reason: z.string().trim().max(2_000).optional(),
  })
  .strict();

const decideSchema = z
  .object({
    decision: z.enum(["approve", "reject"]),
    note: z.string().trim().max(2_000).optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Envelope helpers
// ---------------------------------------------------------------------------

function ok<T>(res: Response, data: T): void {
  res.status(200).json({ ok: true, data });
}
function err(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ ok: false, error: code, message });
}

// ---------------------------------------------------------------------------
// Dependencies (default to the real modules; tests inject narrower fakes)
// ---------------------------------------------------------------------------

export interface RefundsRouterDeps {
  requireAuth?: RequestHandler;
  /** Return true if the signed-in user is an admin. Defaults to a check on req.user.is_admin. */
  isAdmin?: (req: Request) => boolean;
  getDb?: typeof getDb;
  /**
   * Supplier client used by the service. Defaults to lazy-loading
   * `esimAccess` so this route works even when the credentials are missing
   * (the service then records `failed` honestly).
   */
  supplier?: () => Promise<RefundSupplier>;
  stripe?: () => Promise<RefundStripe>;
  notifier?: () => Promise<RefundNotifier | undefined>;
  now?: () => Date;
  log?: (line: string) => void;
}

/**
 * Adapter: turn the shared `esimAccess` client into the narrow shape the
 * refund service uses. Missing credentials are surfaced as `cancel: undefined`
 * so the service records `supplier_not_configured` instead of throwing during
 * import.
 */
async function loadSupplier(): Promise<RefundSupplier> {
  try {
    const modulePath = "../esimaccess";
    const mod = (await import(modulePath)) as {
      esimAccess?: {
        isConfigured?: boolean;
        cancel?: (input: {
          esimTranNo?: string;
          iccid?: string;
          transactionId?: string;
        }) => Promise<{ ok: boolean; reason?: string }>;
      };
    };
    const client = mod.esimAccess;
    if (!client || client.isConfigured === false || typeof client.cancel !== "function") {
      return {};
    }
    return { cancel: client.cancel.bind(client) };
  } catch {
    return {};
  }
}

/**
 * Adapter: turn the shared `stripeProvider` into the narrow shape the refund
 * service uses. Missing STRIPE_SECRET_KEY surfaces as `refund: undefined`.
 */
async function loadStripe(): Promise<RefundStripe> {
  try {
    const modulePath = "../payments/stripeProvider";
    const mod = (await import(modulePath)) as {
      getStripeProvider?: () => {
        isConfigured?: boolean;
        refund?: (input: {
          paymentIntentId: string;
          amountMinor?: number;
          reason?: string;
          idempotencyKey: string;
        }) => Promise<{
          ok: boolean;
          refundId?: string;
          reason?: string;
          amountMinor?: number;
          currency?: string;
        }>;
      };
    };
    const provider = mod.getStripeProvider?.();
    if (!provider || provider.isConfigured === false || typeof provider.refund !== "function") {
      return {};
    }
    return { refund: provider.refund.bind(provider) };
  } catch {
    return {};
  }
}

/**
 * Adapter: use the notifications service if it exposes refund helpers. The
 * current notifications module is scoped to the three supplier alerts, so
 * this resolves to `undefined` and the service's notifier is a no-op — a
 * documented gap (a dedicated refund-email template is a future batch).
 */
async function loadNotifier(): Promise<RefundNotifier | undefined> {
  return undefined;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export function createRefundsRouter(deps: RefundsRouterDeps = {}): Router {
  const router = Router();
  const auth = deps.requireAuth ?? requireAuth;
  const getDbAccessor = deps.getDb ?? getDb;
  const isAdmin =
    deps.isAdmin ??
    ((req: Request) => {
      const user = (req as Request & { user?: { isAdmin?: boolean; is_admin?: boolean } }).user;
      return Boolean(user?.isAdmin ?? user?.is_admin);
    });

  // -------------------------------------------------------------------------
  // POST /api/refunds — request a refund
  // -------------------------------------------------------------------------
  router.post("/", auth, async (req: Request, res: Response) => {
    const user = (req as Request & { user?: { id: number } }).user;
    if (!user) {
      err(res, 401, "unauthorized", "Sign in to request a refund.");
      return;
    }
    const parsed = requestSchema.safeParse(req.body);
    if (!parsed.success) {
      err(
        res,
        400,
        "invalid_request",
        parsed.error.issues[0]?.message ?? "Invalid refund payload.",
      );
      return;
    }
    const supplier = deps.supplier
      ? await deps.supplier()
      : await loadSupplier();
    const stripe = deps.stripe ? await deps.stripe() : await loadStripe();
    const notifier = deps.notifier ? await deps.notifier() : await loadNotifier();

    try {
      const outcome = await requestRefund({
        userId: user.id,
        esimId: parsed.data.esimId,
        reason: parsed.data.reason,
        getDb: getDbAccessor,
        supplier,
        stripe,
        notifier,
        now: deps.now,
        log: deps.log,
      });
      ok(res, outcome);
    } catch (e) {
      if (e instanceof RefundError) {
        const status =
          e.code === "esim_not_found" ? 404 : e.code === "db_unavailable" ? 503 : 400;
        err(res, status, e.code, e.message);
        return;
      }
      (deps.log ?? defaultLog)(`POST /api/refunds error: ${e instanceof Error ? e.message : String(e)}`);
      err(res, 500, "internal_error", "Could not process refund request.");
    }
  });

  // -------------------------------------------------------------------------
  // GET /api/refunds/me — list the caller's refund requests
  // -------------------------------------------------------------------------
  router.get("/me", auth, async (req: Request, res: Response) => {
    const user = (req as Request & { user?: { id: number } }).user;
    if (!user) {
      err(res, 401, "unauthorized", "Sign in to view your refunds.");
      return;
    }
    try {
      const rows = await listRefundRequestsForUser({ userId: user.id, getDb: getDbAccessor });
      ok(res, { refunds: rows });
    } catch (e) {
      if (e instanceof RefundError && e.code === "db_unavailable") {
        err(res, 503, "refunds_unavailable", "Refund store is not configured.");
        return;
      }
      (deps.log ?? defaultLog)(`GET /api/refunds/me error: ${e instanceof Error ? e.message : String(e)}`);
      err(res, 500, "internal_error", "Could not load your refund requests.");
    }
  });

  // -------------------------------------------------------------------------
  // POST /api/refunds/:publicId/decide — admin approve/reject
  // -------------------------------------------------------------------------
  router.post("/:publicId/decide", auth, async (req: Request, res: Response) => {
    const user = (req as Request & { user?: { id: number } }).user;
    if (!user) {
      err(res, 401, "unauthorized", "Sign in.");
      return;
    }
    if (!isAdmin(req)) {
      // Do not confirm the endpoint exists to non-admins — but a 404 would be
      // misleading if the id is valid. 403 is honest.
      err(res, 403, "forbidden", "Admins only.");
      return;
    }
    const publicId = typeof req.params.publicId === "string" ? req.params.publicId.trim() : "";
    if (!publicId || publicId.length > 40) {
      err(res, 400, "invalid_id", "Refund request id is invalid.");
      return;
    }
    const parsed = decideSchema.safeParse(req.body);
    if (!parsed.success) {
      err(res, 400, "invalid_request", parsed.error.issues[0]?.message ?? "Invalid decision.");
      return;
    }
    const stripe = deps.stripe ? await deps.stripe() : await loadStripe();
    try {
      const result = await decideRefundReview({
        reviewerUserId: user.id,
        requestPublicId: publicId,
        decision: parsed.data.decision,
        note: parsed.data.note,
        getDb: getDbAccessor,
        stripe,
        now: deps.now,
        log: deps.log,
      });
      ok(res, result);
    } catch (e) {
      if (e instanceof RefundError) {
        err(res, e.code === "db_unavailable" ? 503 : 400, e.code, e.message);
        return;
      }
      (deps.log ?? defaultLog)(
        `POST /api/refunds/:id/decide error: ${e instanceof Error ? e.message : String(e)}`,
      );
      err(res, 500, "internal_error", "Could not apply decision.");
    }
  });

  return router;
}

function defaultLog(line: string): void {
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ at: new Date().toISOString(), channel: "refund_route", line }));
}

// ---------------------------------------------------------------------------
// Test surface
// ---------------------------------------------------------------------------

export const __test__ = {
  requestSchema,
  decideSchema,
  loadSupplier,
  loadStripe,
};

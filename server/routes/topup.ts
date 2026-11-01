/**
 * /api/topups — list options, start a top-up, and manage auto top-up.
 *
 * Contract (used by `src/components/TopUpModal.tsx` and the My eSIMs page):
 *
 *   GET /api/topups/options?esimId=<id>
 *     200 { ok:true, data: TopupOptionsResult }
 *     401 unauthorized
 *     400 invalid_id
 *     404 { ok:false, error:"esim_not_found" } — including someone else's eSIM
 *     503 { ok:false, error:"topups_unavailable" } — DB not configured
 *
 *   POST /api/topups/start   { esimId, packageCode, successUrl, cancelUrl }
 *     200 { ok:true, data: { topupPublicId, checkoutUrl } }
 *     400 invalid_input | topup_unsupported | esim_expired | invalid_id
 *     404 esim_not_found
 *     503 topups_unavailable | payment_not_configured | supplier_not_configured
 *
 *   GET /api/topups/auto
 *     200 { ok:true, data: { enabled, currency, monthlyCap, savedCard:boolean,
 *                            topupPackageCode, monthSpent } }
 *     401 / 503
 *
 *   PUT /api/topups/auto  { enabled, currency?, monthlyCap?, topupPackageCode? }
 *     200 { ok:true, data: AutoTopupView }
 *     400 invalid_input
 *     401 / 503
 *
 * Auth: uses `requireAuth` — auto top-up is per-user. Guest top-up is not
 * offered (a guest has no saved payment method to charge off-session, which
 * is required for auto). Manual top-ups for guests are still possible via a
 * later batch's UI: that UI creates a Checkout session without an account,
 * mirroring the guest checkout flow. This route is the signed-in surface.
 *
 * Stated limitation: `chargeAutoTopupForLowData` (in server/services/topup.ts)
 * currently returns `off_session_unsupported` unless the caller injects an
 * `offSessionCharge` function. That is intentional: the shared
 * PaymentProvider interface does not yet expose an off-session charge API.
 * Wiring a real Stripe off-session charge is a small follow-up that touches
 * stripeProvider.ts and does not need to change this route.
 */
import { Router, type Request, type Response, type RequestHandler } from "express";
import { eq, sql } from "drizzle-orm";
import { getDb } from "../db/client";
import { autoTopupSettings } from "../db/schema";
import { requireAuth } from "../middleware/requireAuth";
import { brand, type SupportedCurrency } from "../brand.config";
import {
  listTopupOptions,
  beginTopup,
  TopupError,
  type TopupReason,
} from "../services/topup";

// ---------------------------------------------------------------------------
// Envelope helpers
// ---------------------------------------------------------------------------

function ok<T>(res: Response, data: T): void {
  res.status(200).json({ ok: true, data });
}
function fail(res: Response, status: number, error: string, message: string): void {
  res.status(status).json({ ok: false, error, message });
}

// ---------------------------------------------------------------------------
// Seams
// ---------------------------------------------------------------------------

export interface TopupRouterDeps {
  requireAuth?: RequestHandler;
  getDb?: typeof getDb;
  listOptions?: typeof listTopupOptions;
  begin?: typeof beginTopup;
  now?: () => Date;
}

interface AuthedUser {
  id: number;
  email?: string;
}

function userOf(req: Request): AuthedUser | null {
  const u = (req as Request & { user?: AuthedUser }).user;
  return u ?? null;
}

function parsePositiveInt(raw: unknown): number | null {
  if (typeof raw !== "string" && typeof raw !== "number") return null;
  const n = typeof raw === "number" ? raw : Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function mapTopupError(res: Response, err: TopupError): void {
  const mapping: Record<TopupReason, { status: number; message: string }> = {
    esim_not_found: { status: 404, message: "That eSIM is not on your account." },
    esim_expired: { status: 400, message: "That eSIM has expired and cannot be topped up." },
    esim_not_installed: { status: 400, message: "Install the eSIM before topping up." },
    topup_unsupported: { status: 400, message: "This plan does not support top-ups." },
    no_options: { status: 400, message: "No top-up options are available for this eSIM." },
    supplier_not_configured: {
      status: 503,
      message: "Top-ups are temporarily unavailable. Please try again shortly.",
    },
    db_unavailable: { status: 503, message: "Top-up store is unavailable." },
    off_session_unsupported: {
      status: 400,
      message: "Auto top-up is unavailable with the current payment setup.",
    },
    cap_exceeded: { status: 400, message: "Monthly cap reached." },
    no_saved_card: { status: 400, message: "Save a card to enable auto top-up." },
    auto_disabled: { status: 400, message: "Auto top-up is disabled." },
    off_session_charge_failed: { status: 400, message: "The charge did not go through." },
    supplier_topup_unavailable: {
      status: 503,
      message: "Top-up could not be completed. The card will not be charged.",
    },
    supplier_topup_failed: {
      status: 502,
      message: "The provider did not accept the top-up.",
    },
    payment_not_configured: { status: 503, message: "Payments are not configured." },
    invalid_input: { status: 400, message: "Invalid request." },
  };
  const m = mapping[err.code] ?? { status: 400, message: "Invalid request." };
  fail(res, m.status, err.code, err.message.length > 0 ? m.message : err.message);
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export interface AutoTopupView {
  enabled: boolean;
  currency: SupportedCurrency;
  monthlyCap: number | null;
  savedCard: boolean;
  topupPackageCode: string | null;
  monthSpent: number;
  lastChargedAt: string | null;
}

export function createTopupRouter(deps: TopupRouterDeps = {}): Router {
  const router = Router();
  const auth = deps.requireAuth ?? requireAuth;
  const dbAccessor = deps.getDb ?? getDb;
  const listOptions = deps.listOptions ?? listTopupOptions;
  const begin = deps.begin ?? beginTopup;
  const now = deps.now ?? (() => new Date());

  // -------------------------------------------------------------
  // GET /api/topups/options?esimId=…
  // -------------------------------------------------------------
  router.get("/options", auth, async (req: Request, res: Response) => {
    const user = userOf(req);
    if (!user) return fail(res, 401, "unauthorized", "Sign in.");

    const esimId = parsePositiveInt(req.query.esimId);
    if (esimId == null) return fail(res, 400, "invalid_id", "esimId is required.");

    try {
      const result = await listOptions({
        userId: user.id,
        esimId,
        getDb: dbAccessor,
        now,
      });
      if (!result.eligible) {
        if (result.reason === "esim_not_found") {
          // A foreign eSIM is treated exactly like "not found" — no
          // existence leak — so the two share a status code here.
          return fail(res, 404, "esim_not_found", "That eSIM is not on your account.");
        }
        if (result.reason === "db_unavailable") {
          return fail(res, 503, "topups_unavailable", "Top-up store is unavailable.");
        }
        if (result.reason === "supplier_not_configured") {
          return fail(res, 503, "supplier_not_configured", "Top-ups are temporarily unavailable.");
        }
        // Otherwise we still return 200 so the modal can show a precise
        // reason ("This plan doesn't support top-ups") without treating it
        // as a network error. The client can choose to render the reason.
        ok(res, result);
        return;
      }
      ok(res, result);
    } catch (err) {
      (req as Request & { log?: (m: string) => void }).log?.(
        `[topups.route] list failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      fail(res, 500, "internal_error", "Could not load top-up options.");
    }
  });

  // -------------------------------------------------------------
  // POST /api/topups/start
  // -------------------------------------------------------------
  router.post("/start", auth, async (req: Request, res: Response) => {
    const user = userOf(req);
    if (!user) return fail(res, 401, "unauthorized", "Sign in.");

    const body = (req.body ?? {}) as {
      esimId?: unknown;
      packageCode?: unknown;
      successUrl?: unknown;
      cancelUrl?: unknown;
      currency?: unknown;
    };
    const esimId = parsePositiveInt(body.esimId);
    const packageCode = typeof body.packageCode === "string" ? body.packageCode.trim() : "";
    const successUrl = typeof body.successUrl === "string" ? body.successUrl : "/my-esims?topup=success";
    const cancelUrl = typeof body.cancelUrl === "string" ? body.cancelUrl : "/my-esims?topup=cancel";
    if (esimId == null || packageCode.length === 0) {
      return fail(res, 400, "invalid_input", "esimId and packageCode are required.");
    }
    const currency =
      typeof body.currency === "string" && isCurrency(body.currency)
        ? (body.currency as SupportedCurrency)
        : brand.defaultCurrency;

    try {
      const result = await begin({
        userId: user.id,
        esimId,
        packageCode,
        successUrl,
        cancelUrl,
        currency,
        getDb: dbAccessor,
        now,
      });
      ok(res, result);
    } catch (err) {
      if (err instanceof TopupError) return mapTopupError(res, err);
      (req as Request & { log?: (m: string) => void }).log?.(
        `[topups.route] start failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      fail(res, 500, "internal_error", "Could not start the top-up.");
    }
  });

  // -------------------------------------------------------------
  // GET /api/topups/auto — current auto top-up settings
  // -------------------------------------------------------------
  router.get("/auto", auth, async (req: Request, res: Response) => {
    const user = userOf(req);
    if (!user) return fail(res, 401, "unauthorized", "Sign in.");

    const db = dbAccessor();
    if (!db) return fail(res, 503, "topups_unavailable", "Top-up store is unavailable.");
    try {
      const [row] = await db
        .select()
        .from(autoTopupSettings)
        .where(eq(autoTopupSettings.userId, user.id))
        .limit(1);

      const view: AutoTopupView = {
        enabled: Boolean(row?.enabled),
        currency: (row?.currency as SupportedCurrency | undefined) ?? brand.defaultCurrency,
        monthlyCap: row?.monthlyCapAmount != null ? Number(row.monthlyCapAmount) : null,
        savedCard: Boolean(row?.paymentMethodRef),
        topupPackageCode: row?.topupPackageCode ?? null,
        monthSpent: row?.monthSpentAmount != null ? Number(row.monthSpentAmount) : 0,
        lastChargedAt: row?.lastChargedAt ? row.lastChargedAt.toISOString() : null,
      };
      ok(res, view);
    } catch (err) {
      (req as Request & { log?: (m: string) => void }).log?.(
        `[topups.route] auto read failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      fail(res, 500, "internal_error", "Could not load auto top-up settings.");
    }
  });

  // -------------------------------------------------------------
  // PUT /api/topups/auto — update auto top-up settings
  // -------------------------------------------------------------
  router.put("/auto", auth, async (req: Request, res: Response) => {
    const user = userOf(req);
    if (!user) return fail(res, 401, "unauthorized", "Sign in.");

    const body = (req.body ?? {}) as {
      enabled?: unknown;
      monthlyCap?: unknown;
      topupPackageCode?: unknown;
      currency?: unknown;
    };
    const enabled = typeof body.enabled === "boolean" ? body.enabled : null;
    const cap =
      body.monthlyCap == null || body.monthlyCap === ""
        ? null
        : Number(body.monthlyCap);
    const packageCode =
      typeof body.topupPackageCode === "string" && body.topupPackageCode.trim().length > 0
        ? body.topupPackageCode.trim()
        : null;
    const currency =
      typeof body.currency === "string" && isCurrency(body.currency)
        ? (body.currency as SupportedCurrency)
        : brand.defaultCurrency;

    if (enabled == null) return fail(res, 400, "invalid_input", "enabled (boolean) is required.");
    if (cap != null && (!Number.isFinite(cap) || cap < 0)) {
      return fail(res, 400, "invalid_input", "monthlyCap must be a non-negative number.");
    }
    // Auto top-up requires a package code, so admin cannot accidentally
    // introduce an enabled-but-unconfigured state that fails at charge time.
    if (enabled && (!packageCode || cap == null || cap <= 0)) {
      return fail(
        res,
        400,
        "invalid_input",
        "Enabling auto top-up requires a package and a positive monthly cap.",
      );
    }

    const db = dbAccessor();
    if (!db) return fail(res, 503, "topups_unavailable", "Top-up store is unavailable.");
    const at = now();
    try {
      // Upsert on user_id. We use raw values via drizzle `.onConflictDoUpdate`
      // to keep this a single round trip; a missing row is created with the
      // defaults from the migration.
      await db
        .insert(autoTopupSettings)
        .values({
          userId: user.id,
          enabled,
          topupPackageCode: packageCode,
          monthlyCapAmount: cap == null ? null : String(cap),
          currency,
          monthKey: at.toISOString().slice(0, 7),
          updatedAt: at,
        })
        .onConflictDoUpdate({
          target: autoTopupSettings.userId,
          set: {
            enabled,
            topupPackageCode: packageCode,
            monthlyCapAmount: cap == null ? null : String(cap),
            currency,
            updatedAt: at,
          },
        });

      const [row] = await db
        .select()
        .from(autoTopupSettings)
        .where(eq(autoTopupSettings.userId, user.id))
        .limit(1);
      const view: AutoTopupView = {
        enabled: Boolean(row?.enabled),
        currency: (row?.currency as SupportedCurrency | undefined) ?? currency,
        monthlyCap: row?.monthlyCapAmount != null ? Number(row.monthlyCapAmount) : null,
        savedCard: Boolean(row?.paymentMethodRef),
        topupPackageCode: row?.topupPackageCode ?? null,
        monthSpent: row?.monthSpentAmount != null ? Number(row.monthSpentAmount) : 0,
        lastChargedAt: row?.lastChargedAt ? row.lastChargedAt.toISOString() : null,
      };
      ok(res, view);
    } catch (err) {
      (req as Request & { log?: (m: string) => void }).log?.(
        `[topups.route] auto write failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      fail(res, 500, "internal_error", "Could not save auto top-up settings.");
    }
  });

  return router;
}

function isCurrency(v: string): v is SupportedCurrency {
  return (brand.currencies as readonly string[]).includes(v);
}

// ---------------------------------------------------------------------------
// Test surface
// ---------------------------------------------------------------------------

export const __test__ = {
  parsePositiveInt,
};

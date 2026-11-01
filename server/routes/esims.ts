/**
 * /api/esims — read model + QR re-view for the My eSIMs dashboard.
 *
 * Contract (must stay compatible with `src/pages/MyEsims.tsx`):
 *   GET /api/esims
 *     200 { ok:true, data:{ esims: MyEsim[], usageFreshnessMinutes: number } }
 *     401 { ok:false, error:"unauthorized",  message }
 *     503 { ok:false, error:"esims_unavailable", message }
 *   GET /api/esims/:id
 *     200 { ok:true, data:{ esim: MyEsim } }
 *     401 / 404 / 503
 *   GET /api/esims/:id/qr
 *     200 { ok:true, data:{ lpaCode: string|null, qrCodeUrl: string|null } }
 *     401 / 404 / 503
 *
 * Auth: uses the existing `requireAuth` middleware from
 * `server/middleware/requireAuth.ts`, which sets `req.user`. The route does
 * not re-parse the session itself (single place to change cookie rules).
 *
 * Freshness: the response carries `usageFreshnessMinutes` so the page can say
 * "Usage updated every 3 hours" using the server's cadence, not a hardcoded
 * string. That number comes from the job constant, so changing the cadence
 * changes the copy — no drift.
 *
 * Honest limitations
 * ------------------
 * - This route does NOT trigger a refresh; reads are cheap and the 3-hourly job
 *   owns freshness. That means a just-purchased eSIM can show "no usage yet"
 *   until the next tick — which is correct and matches the supplier's own lag.
 * - The QR route returns the LPA / URL we stored. It does not generate an image
 *   server-side (the client renders the QR from the LPA, which is what the
 *   install email also does). Swapping in a server-rendered PNG is a client
 *   change, not a route change.
 * - When the DB is not configured, reads return 503 — never an empty 200 — so
 *   the page shows the honest "backend not wired yet" state.
 */
import { Router, type Request, type Response, type RequestHandler } from "express";
import { eq, and } from "drizzle-orm";
import { getDb } from "../db/client";
import { esims } from "../db/schema";
import { requireAuth } from "../middleware/requireAuth";
import {
  readEsimsForUser,
  EsimsUnavailableError,
  daysLeftFrom,
  type MyEsim,
} from "../services/usageService";

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
// Injectable seams (tests pass a fake requireAuth + fake db)
// ---------------------------------------------------------------------------

export interface EsimsRouterDeps {
  /** Defaults to the real `requireAuth`. */
  requireAuth?: RequestHandler;
  /** Defaults to the real `getDb`. */
  getDb?: typeof getDb;
  /** Clock for `daysLeft` and freshness copy. */
  now?: () => Date;
}

/**
 * Build the router. The dependency object is intentionally narrow: only the
 * three spots that would go outside the process (auth, DB, clock) are swappable
 * so tests are deterministic without mocking the supplier.
 */
export function createEsimsRouter(deps: EsimsRouterDeps = {}): Router {
  const router = Router();
  const auth = deps.requireAuth ?? requireAuth;
  const dbAccessor = deps.getDb ?? getDb;
  const now = deps.now ?? (() => new Date());

  // -------------------------------------------------------------
  // GET /api/esims
  // -------------------------------------------------------------
  router.get("/", auth, async (req: Request, res: Response) => {
    const user = (req as Request & { user?: { id: number } }).user;
    if (!user) {
      // requireAuth should have 401'd; this is defence-in-depth.
      err(res, 401, "unauthorized", "Sign in to view your eSIMs.");
      return;
    }
    try {
      const result = await readEsimsForUser({
        userId: user.id,
        getDb: dbAccessor,
        now,
      });
      ok(res, result);
    } catch (e) {
      if (e instanceof EsimsUnavailableError) {
        err(res, 503, "esims_unavailable", "eSIM store is not configured.");
        return;
      }
      (req as Request & { log?: (m: string) => void }).log?.(
        `[esims.route] read failed: ${e instanceof Error ? e.message : String(e)}`,
      );
      err(res, 500, "internal_error", "Could not load your eSIMs.");
    }
  });

  // -------------------------------------------------------------
  // GET /api/esims/:id  (single eSIM; used by /my-esims/:id)
  // -------------------------------------------------------------
  router.get("/:id", auth, async (req: Request, res: Response) => {
    const user = (req as Request & { user?: { id: number } }).user;
    if (!user) {
      err(res, 401, "unauthorized", "Sign in to view your eSIMs.");
      return;
    }
    const id = parseId(req.params.id);
    if (id == null) {
      err(res, 400, "invalid_id", "eSIM id is invalid.");
      return;
    }
    const db = dbAccessor();
    if (!db) {
      err(res, 503, "esims_unavailable", "eSIM store is not configured.");
      return;
    }
    try {
      const row = await loadOwnedRow(db, id, user.id);
      if (!row) {
        err(res, 404, "not_found", "eSIM not found.");
        return;
      }
      ok(res, { esim: toMyEsim(row, now()) });
    } catch (e) {
      (req as Request & { log?: (m: string) => void }).log?.(
        `[esims.route] single read failed: ${e instanceof Error ? e.message : String(e)}`,
      );
      err(res, 500, "internal_error", "Could not load the eSIM.");
    }
  });

  // -------------------------------------------------------------
  // GET /api/esims/:id/qr  (re-view QR / LPA)
  // -------------------------------------------------------------
  router.get("/:id/qr", auth, async (req: Request, res: Response) => {
    const user = (req as Request & { user?: { id: number } }).user;
    if (!user) {
      err(res, 401, "unauthorized", "Sign in to view your eSIM QR.");
      return;
    }
    const id = parseId(req.params.id);
    if (id == null) {
      err(res, 400, "invalid_id", "eSIM id is invalid.");
      return;
    }
    const db = dbAccessor();
    if (!db) {
      err(res, 503, "esims_unavailable", "eSIM store is not configured.");
      return;
    }
    try {
      const row = await loadOwnedRow(db, id, user.id);
      if (!row) {
        err(res, 404, "not_found", "eSIM not found.");
        return;
      }
      if (!row.lpaCode && !row.qrCodeUrl) {
        // Not a 404: the row exists, but the QR is not yet ready. The page
        // should keep showing "processing" via its own state, not "not found".
        err(
          res,
          409,
          "qr_not_ready",
          "The QR code is still being generated. It will appear here shortly.",
        );
        return;
      }
      ok(res, { lpaCode: row.lpaCode ?? null, qrCodeUrl: row.qrCodeUrl ?? null });
    } catch (e) {
      (req as Request & { log?: (m: string) => void }).log?.(
        `[esims.route] qr read failed: ${e instanceof Error ? e.message : String(e)}`,
      );
      err(res, 500, "internal_error", "Could not load the QR code.");
    }
  });

  return router;
}

// ---------------------------------------------------------------------------
// Row helpers
// ---------------------------------------------------------------------------

interface EsimRow {
  id: number;
  orderPublicId: string;
  country: string | null;
  countrySlug: string | null;
  network: string | null;
  status: string;
  totalBytes: string | number | null;
  usedBytes: string | number | null;
  usageUpdatedAt: Date | null;
  expiresAt: Date | null;
  iccid: string | null;
  esimTranNo: string | null;
  lpaCode: string | null;
  qrCodeUrl: string | null;
}

/**
 * Load a single eSIM for the signed-in user. Ownership is enforced by the
 * `userId` predicate — a leak of someone else's row returns 404, not 403,
 * so the response doesn't reveal that the id exists.
 */
async function loadOwnedRow(
  db: NonNullable<ReturnType<typeof getDb>>,
  id: number,
  userId: number,
): Promise<EsimRow | null> {
  const [row] = await db
    .select({
      id: esims.id,
      orderPublicId: esims.orderPublicId,
      country: esims.country,
      countrySlug: esims.countrySlug,
      network: esims.network,
      status: esims.status,
      totalBytes: esims.totalBytes,
      usedBytes: esims.usedBytes,
      usageUpdatedAt: esims.usageUpdatedAt,
      expiresAt: esims.expiresAt,
      iccid: esims.iccid,
      esimTranNo: esims.esimTranNo,
      lpaCode: esims.lpaCode,
      qrCodeUrl: esims.qrCodeUrl,
    })
    .from(esims)
    .where(and(eq(esims.id, id), eq(esims.userId, userId)))
    .limit(1);
  return row ?? null;
}

function toMyEsim(row: EsimRow, now: Date): MyEsim {
  const totalBytes = parseBytesLocal(row.totalBytes);
  const usedBytes = parseBytesLocal(row.usedBytes);
  const hasQr = Boolean(row.lpaCode || row.qrCodeUrl);
  return {
    id: row.id,
    orderPublicId: row.orderPublicId,
    country: row.country,
    countrySlug: row.countrySlug,
    network: row.network,
    status: row.status,
    totalBytes,
    usedBytes,
    usageUpdatedAt: row.usageUpdatedAt ? row.usageUpdatedAt.toISOString() : null,
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    daysLeft: daysLeftFrom(row.expiresAt, now),
    iccid: row.iccid,
    esimTranNo: row.esimTranNo,
    hasQr,
    qrPath: hasQr ? `/api/esims/${row.id}/qr` : null,
  };
}

function parseId(raw: unknown): number | null {
  if (typeof raw !== "string") return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function parseBytesLocal(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : Number.NaN;
  return Number.isFinite(n) && n >= 0 ? n : null;
}

// ---------------------------------------------------------------------------
// Test-only surface
// ---------------------------------------------------------------------------

export const __test__ = {
  parseId,
  parseBytesLocal,
  toMyEsim,
};

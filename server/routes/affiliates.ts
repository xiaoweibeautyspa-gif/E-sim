/**
 * Affiliate programme — API surface for travel bloggers.
 *
 * SCOPE (this batch)
 * ------------------
 *   POST   /api/affiliates/apply            Public application.
 *   POST   /api/affiliates/login            Email + password login.
 *   POST   /api/affiliates/logout           Clear session.
 *   GET    /api/affiliates/me               Current affiliate profile + link.
 *   GET    /api/affiliates/stats            Clicks / sales / commission owed.
 *   POST   /api/affiliates/click            Public click tracker (called by /r/a/:code).
 *   GET    /api/affiliates/public/:code     Public affiliate metadata (safe fields).
 *
 * NOT IN THIS BATCH (see build report)
 *   - /r/a/:code 30-day cookie setter (redirect.affiliate.ts, batch 3).
 *   - Commission crediting on paid orders (checkout webhook, later).
 *   - Payout execution (this is a bookkeeping total, not a money movement).
 *
 * DESIGN
 * ------
 *  - Same `Deps`-injection pattern as partners.ts so the router is testable
 *    without a real DB and doesn't claim the exact shapes of `getDb` or
 *    `requireAuth` from upstream.
 *  - Passwords use scrypt in this file for the SAME reason as partners.ts:
 *    the auth service's password helper is not part of the supplied files.
 *    When that helper is confirmed the two modules can delegate to it — the
 *    wire format (`scrypt$salt$hash`) is identical.
 *  - Affiliate codes are 8-char, human-typable, unambiguous, and printable.
 */
import {
  Router,
  type Request,
  type Response,
  type NextFunction,
  type RequestHandler,
} from "express";
import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Types shared with the dashboard component and later redirect route.
// ---------------------------------------------------------------------------

export interface Affiliate {
  id: number;
  publicId: string;
  email: string;
  displayName: string;
  website: string | null;
  socialUrl: string | null;
  promoMethod: string | null;
  status: "pending" | "approved" | "rejected" | "suspended";
  commissionPercent: number;
  code: string | null; // short code used in /r/a/:code
  cookieDays: number; // 30 by default; admin may adjust, kept on the row
  createdAt: string;
}

export interface AffiliateClickRow {
  affiliateId: number;
  code: string;
  clickedAt: Date;
  locale: "en" | "zh" | "vi";
  userAgentHash: string | null;
  referrerHost: string | null;
  ipHash: string | null;
}

export interface AffiliateDb {
  insertAffiliate(input: {
    publicId: string;
    email: string;
    emailNormalised: string;
    passwordHash: string;
    displayName: string;
    website: string | null;
    socialUrl: string | null;
    promoMethod: string | null;
    status: "pending";
    commissionPercent: number;
    cookieDays: number;
    createdAt: Date;
  }): Promise<{ id: number }>;

  findAffiliateByEmail(emailNormalised: string): Promise<
    | {
        id: number;
        publicId: string;
        email: string;
        passwordHash: string;
        status: "pending" | "approved" | "rejected" | "suspended";
      }
    | null
  >;

  findAffiliateById(id: number): Promise<Affiliate | null>;
  findAffiliateByCode(code: string): Promise<Affiliate | null>;

  setAffiliateCode(input: { id: number; code: string; updatedAt: Date }): Promise<void>;

  insertAffiliateClick(row: AffiliateClickRow): Promise<void>;

  getAffiliateTotals(affiliateId: number): Promise<{
    clicks: number;
    sales: number;
    grossMinor: number;
    commissionOwedMinor: number;
    currency: "SGD" | "USD" | "VND" | "CNY";
  }>;

  getDefaultCommissionPercent(): Promise<number | null>;
  getDefaultCookieDays(): Promise<number | null>;
}

// ---------------------------------------------------------------------------
// Password hashing — identical wire format to partners.ts.
// ---------------------------------------------------------------------------

const SCRYPT_KEYLEN = 64;
const SCRYPT_SALT_BYTES = 16;

function hashPassword(plain: string): string {
  const salt = randomBytes(SCRYPT_SALT_BYTES);
  const hash = scryptSync(plain, salt, SCRYPT_KEYLEN);
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

function verifyPassword(plain: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  try {
    const salt = Buffer.from(parts[1]!, "hex");
    const expected = Buffer.from(parts[2]!, "hex");
    const actual = scryptSync(plain, salt, expected.length);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function ok<T>(res: Response, data: T, status = 200): void {
  res.status(status).json({ ok: true, data });
}
function fail(res: Response, status: number, error: string, message: string): void {
  res.status(status).json({ ok: false, error, message });
}
function normaliseEmail(raw: string): string {
  return raw.trim().toLowerCase();
}
function makePublicId(prefix = "aff"): string {
  const bytes = randomBytes(8);
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  let out = "";
  for (const b of bytes) out += alphabet[b % 32];
  return `${prefix}_${out}`;
}
function makeAffiliateCode(length = 8): string {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // uppercase, no I/L/O/0/1
  const bytes = randomBytes(length);
  let out = "";
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}
function hashIp(ip: string | undefined): string | null {
  if (!ip) return null;
  const salt = process.env.AFFILIATES_IP_SALT ?? "unsalted-affiliates";
  return createHash("sha256").update(`${salt}:${ip}`).digest("hex").slice(0, 32);
}
function hashUa(userAgent: string | undefined): string | null {
  if (!userAgent) return null;
  return createHash("sha256").update(userAgent).digest("hex").slice(0, 16);
}
function pickLocale(v: unknown): "en" | "zh" | "vi" {
  return v === "zh" || v === "vi" ? v : "en";
}

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

export interface AffiliateDeps {
  getDb: () => AffiliateDb | null;
  requireAffiliate: RequestHandler;
  setAffiliateSession: (input: { affiliateId: number; res: Response }) => void | Promise<void>;
  clearAffiliateSession: (res: Response) => void | Promise<void>;
  notifyAdmin?: (input: {
    kind: "affiliate_application";
    affiliateId: number;
    displayName: string;
    email: string;
  }) => Promise<void>;
  publicBaseUrl: string;
  now?: () => Date;
  getSetting?: (key: string) => Promise<string | null>;
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const applySchema = z
  .object({
    displayName: z.string().trim().min(2).max(80),
    email: z.string().trim().email(),
    password: z.string().min(8).max(200),
    website: z.string().trim().url().max(300).optional(),
    socialUrl: z.string().trim().url().max(300).optional(),
    promoMethod: z.string().trim().max(500).optional(),
  })
  .strict();

const loginSchema = z
  .object({
    email: z.string().trim().email(),
    password: z.string().min(1).max(200),
  })
  .strict();

const clickSchema = z
  .object({
    code: z.string().trim().min(4).max(32),
    locale: z.enum(["en", "zh", "vi"]).optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

export function createAffiliatesRouter(deps: AffiliateDeps): Router {
  const router = Router();
  const now = deps.now ?? (() => new Date());

  const dbOrFail = (res: Response): AffiliateDb | null => {
    const db = deps.getDb();
    if (!db) {
      fail(res, 503, "affiliate_db_not_configured", "Affiliate programme is not configured.");
      return null;
    }
    return db;
  };

  // -------------------------------------------------------------------------
  // POST /apply
  // -------------------------------------------------------------------------
  router.post("/apply", async (req: Request, res: Response) => {
    const parsed = applySchema.safeParse(req.body);
    if (!parsed.success) {
      fail(res, 400, "invalid_request", parsed.error.issues[0]?.message ?? "Invalid payload");
      return;
    }
    const db = dbOrFail(res);
    if (!db) return;

    // Commission % and cookie window come from settings; we refuse to invent
    // either. If both settings keys are absent the admin hasn't configured
    // the programme.
    let commission: number | null = null;
    let cookieDays: number | null = null;
    try {
      commission = await db.getDefaultCommissionPercent();
      cookieDays = await db.getDefaultCookieDays();
    } catch {
      /* leave null; handled below */
    }
    if (commission == null && deps.getSetting) {
      try {
        const raw = await deps.getSetting("affiliates.default_commission_percent");
        if (raw != null) {
          const n = Number(raw);
          if (Number.isFinite(n) && n >= 0 && n <= 50) commission = n;
        }
      } catch {
        commission = null;
      }
    }
    if (cookieDays == null && deps.getSetting) {
      try {
        const raw = await deps.getSetting("affiliates.cookie_days");
        if (raw != null) {
          const n = Number(raw);
          if (Number.isFinite(n) && n >= 1 && n <= 120) cookieDays = Math.round(n);
        }
      } catch {
        cookieDays = null;
      }
    }
    if (commission == null || cookieDays == null) {
      fail(
        res,
        503,
        "affiliate_settings_unavailable",
        "Affiliate commission or cookie window is not configured yet.",
      );
      return;
    }

    const emailNorm = normaliseEmail(parsed.data.email);
    const existing = await db.findAffiliateByEmail(emailNorm);
    if (existing) {
      fail(res, 409, "email_taken", "An application with that email already exists.");
      return;
    }

    const publicId = makePublicId();
    const passwordHash = hashPassword(parsed.data.password);
    const createdAt = now();

    let inserted: { id: number };
    try {
      inserted = await db.insertAffiliate({
        publicId,
        email: parsed.data.email.trim(),
        emailNormalised: emailNorm,
        passwordHash,
        displayName: parsed.data.displayName,
        website: parsed.data.website ?? null,
        socialUrl: parsed.data.socialUrl ?? null,
        promoMethod: parsed.data.promoMethod ?? null,
        status: "pending",
        commissionPercent: commission,
        cookieDays,
        createdAt,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Could not save application";
      fail(res, 409, "email_taken", message);
      return;
    }

    if (deps.notifyAdmin) {
      try {
        await deps.notifyAdmin({
          kind: "affiliate_application",
          affiliateId: inserted.id,
          displayName: parsed.data.displayName,
          email: emailNorm,
        });
      } catch {
        /* non-fatal */
      }
    } else {
      // eslint-disable-next-line no-console
      console.log(
        JSON.stringify({
          at: now().toISOString(),
          channel: "affiliates.apply",
          note: "notifyAdmin not wired; application stored but admin not emailed",
          affiliateId: inserted.id,
        }),
      );
    }

    ok(
      res,
      { publicId, status: "pending", message: "Application received. We'll email once approved." },
      201,
    );
  });

  // -------------------------------------------------------------------------
  // POST /login
  // -------------------------------------------------------------------------
  router.post("/login", async (req: Request, res: Response) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      fail(res, 400, "invalid_request", "Email and password are required.");
      return;
    }
    const db = dbOrFail(res);
    if (!db) return;
    const row = await db.findAffiliateByEmail(normaliseEmail(parsed.data.email));
    if (!row || !verifyPassword(parsed.data.password, row.passwordHash)) {
      fail(res, 401, "invalid_credentials", "Email or password is incorrect.");
      return;
    }
    if (row.status !== "approved") {
      fail(
        res,
        row.status === "pending" ? 403 : 423,
        row.status === "pending" ? "pending_approval" : "account_suspended",
        row.status === "pending"
          ? "Your application is still being reviewed."
          : "Your affiliate account is not active.",
      );
      return;
    }
    await deps.setAffiliateSession({ affiliateId: row.id, res });
    ok(res, { publicId: row.publicId, status: row.status });
  });

  // -------------------------------------------------------------------------
  // POST /logout
  // -------------------------------------------------------------------------
  router.post("/logout", async (_req: Request, res: Response) => {
    await deps.clearAffiliateSession(res);
    ok(res, { loggedOut: true });
  });

  // -------------------------------------------------------------------------
  // GET /me
  // -------------------------------------------------------------------------
  router.get("/me", deps.requireAffiliate, async (req: Request, res: Response) => {
    const affiliateId = readAffiliateId(req);
    if (affiliateId == null) {
      fail(res, 401, "unauthorized", "Sign in to view your affiliate dashboard.");
      return;
    }
    const db = dbOrFail(res);
    if (!db) return;
    const affiliate = await db.findAffiliateById(affiliateId);
    if (!affiliate) {
      fail(res, 404, "not_found", "Affiliate not found.");
      return;
    }
    // Lazily assign the tracking code on first read (approved affiliates
    // always have one).
    let code = affiliate.code;
    if (!code && affiliate.status === "approved") {
      code = makeAffiliateCode();
      await db.setAffiliateCode({ id: affiliateId, code, updatedAt: now() });
    }
    const base = deps.publicBaseUrl.replace(/\/+$/, "");
    ok(res, {
      affiliate: {
        publicId: affiliate.publicId,
        displayName: affiliate.displayName,
        email: affiliate.email,
        website: affiliate.website,
        socialUrl: affiliate.socialUrl,
        status: affiliate.status,
        commissionPercent: affiliate.commissionPercent,
        cookieDays: affiliate.cookieDays,
        code,
      },
      link: code ? `${base}/r/a/${code}` : null,
      cookieDays: affiliate.cookieDays,
    });
  });

  // -------------------------------------------------------------------------
  // GET /stats
  // -------------------------------------------------------------------------
  router.get("/stats", deps.requireAffiliate, async (req: Request, res: Response) => {
    const affiliateId = readAffiliateId(req);
    if (affiliateId == null) {
      fail(res, 401, "unauthorized", "Sign in to view your stats.");
      return;
    }
    const db = dbOrFail(res);
    if (!db) return;
    try {
      const totals = await db.getAffiliateTotals(affiliateId);
      ok(res, totals);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.log(
        JSON.stringify({
          at: now().toISOString(),
          channel: "affiliates.stats",
          error: err instanceof Error ? err.message : String(err),
        }),
      );
      fail(res, 500, "internal_error", "Could not compute stats.");
    }
  });

  // -------------------------------------------------------------------------
  // POST /click — public click tracker
  // -------------------------------------------------------------------------
  router.post("/click", async (req: Request, res: Response) => {
    const parsed = clickSchema.safeParse(req.body);
    if (!parsed.success) {
      fail(res, 400, "invalid_request", "Missing or invalid code.");
      return;
    }
    const db = dbOrFail(res);
    if (!db) return;
    const affiliate = await db.findAffiliateByCode(parsed.data.code);
    if (!affiliate || affiliate.status !== "approved") {
      fail(res, 404, "not_found", "Affiliate code not recognised.");
      return;
    }
    await db.insertAffiliateClick({
      affiliateId: affiliate.id,
      code: parsed.data.code,
      clickedAt: now(),
      locale: pickLocale(parsed.data.locale),
      userAgentHash: hashUa(req.get("user-agent") ?? undefined),
      referrerHost: safeHost(req.get("referer") ?? undefined),
      ipHash: hashIp(clientIp(req)),
    });
    ok(res, {
      affiliateId: affiliate.publicId,
      displayName: affiliate.displayName,
      // Landing is the homepage for now; the redirect route may override.
      landing: "/",
    });
  });

  // -------------------------------------------------------------------------
  // GET /public/:code — safe public metadata
  // -------------------------------------------------------------------------
  router.get("/public/:code", async (req: Request, res: Response) => {
    const code = String(req.params.code ?? "").toUpperCase();
    if (!/^[A-Z0-9]{4,32}$/.test(code)) {
      fail(res, 400, "invalid_code", "Malformed affiliate code.");
      return;
    }
    const db = dbOrFail(res);
    if (!db) return;
    const affiliate = await db.findAffiliateByCode(code);
    if (!affiliate || affiliate.status !== "approved") {
      fail(res, 404, "not_found", "This affiliate code is not active.");
      return;
    }
    ok(res, {
      displayName: affiliate.displayName,
      website: affiliate.website,
    });
  });

  // Local 500 fallback.
  router.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    // eslint-disable-next-line no-console
    console.error("[affiliates error]", err instanceof Error ? err.message : String(err));
    res.status(500).json({ ok: false, error: "internal_error", message: "Unexpected error" });
    void next;
  });

  return router;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface AffiliateScopedRequest extends Request {
  affiliate?: { id: number };
}
function readAffiliateId(req: Request): number | null {
  const a = (req as AffiliateScopedRequest).affiliate;
  return a && typeof a.id === "number" && a.id > 0 ? a.id : null;
}
function clientIp(req: Request): string | undefined {
  const xff = req.get("x-forwarded-for");
  if (xff) return xff.split(",")[0]?.trim();
  return req.socket.remoteAddress;
}
function safeHost(rawUrl: string | undefined): string | null {
  if (!rawUrl) return null;
  try {
    return new URL(rawUrl).host.slice(0, 120);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Test surface
// ---------------------------------------------------------------------------

export const __test__ = {
  hashPassword,
  verifyPassword,
  normaliseEmail,
  makeAffiliateCode,
  makePublicId,
  pickLocale,
  safeHost,
  readAffiliateId,
  applySchema,
  loginSchema,
  clickSchema,
};

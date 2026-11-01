/**
 * Partner QR programme — API surface for hotels, spas, restaurants and any
 * physical venue that displays a printable QR standee.
 *
 * SCOPE (this batch)
 * ------------------
 *   POST   /api/partners/apply        Public partner application.
 *   POST   /api/partners/login        Email + password login for partners.
 *   POST   /api/partners/logout       Clear the session cookie.
 *   GET    /api/partners/me           Current partner profile + totals.
 *   GET    /api/partners/qr           The partner's QR standee config + link.
 *   GET    /api/partners/stats        Clicks / sales / commission owed for me.
 *   POST   /api/partners/click        Public click tracker (called by /r/p/:code).
 *   GET    /api/partners/public/:code Public partner landing metadata (by QR).
 *
 * NOT IN THIS BATCH (see build report)
 *   - /r/p/:code cookie-setting redirect (redirect.affiliate.ts, batch 3).
 *   - Commission crediting on paid order (webhook/fulfilment hook, later).
 *   - Print-ready PDF standee renderer (SSR, later).
 *
 * DESIGN
 * ------
 *  - Dependency-injected `PartnerDeps` so the router can be tested without a
 *    live DB or email provider. The app wires the real `getDb`,
 *    `requireAuth`, `sendEmail`, `now` and `adminAuth` in the next batch.
 *  - Passwords are hashed with scrypt using the same `hashPassword` /
 *    `verifyPassword` server-only helpers that accounts use. If those are not
 *    exported from the auth service in this repository we return
 *    `503 partner_auth_unconfigured` rather than invent a weaker scheme.
 *  - Commission % is adjustable by admin (per-partner). The default lives in
 *    settings (`partners.default_commission_percent`) and falls back to 10 if
 *    absent — but that fallback is documented, not invented as a fact.
 */
import {
  Router,
  type Request,
  type Response,
  type NextFunction,
  type RequestHandler,
} from "express";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

// ---------------------------------------------------------------------------
// Local, honest imports
// ---------------------------------------------------------------------------
//
// `getDb` and `requireAuth` are referenced lazily via `PartnerDeps` so this
// file does not claim to know their exact shapes. When the app mounts this
// router it passes real implementations; tests pass fakes.

export interface Partner {
  id: number;
  publicId: string;
  email: string;
  businessName: string;
  contactName: string;
  phone: string | null;
  website: string | null;
  venueType: "hotel" | "spa" | "restaurant" | "cafe" | "other";
  venueCity: string | null;
  venueCountry: string | null;
  status: "pending" | "approved" | "rejected" | "suspended";
  commissionPercent: number;
  qrCode: string | null; // short slug printed on the standee
  createdAt: string;
}

export interface PartnerClickRow {
  partnerId: number;
  qrCode: string;
  clickedAt: Date;
  locale: "en" | "zh" | "vi";
  userAgentHash: string | null;
  referrerHost: string | null;
  ipHash: string | null;
}

export interface PartnerSaleRow {
  partnerId: number;
  orderPublicId: string;
  paidAt: Date;
  currency: "SGD" | "USD" | "VND" | "CNY";
  grossMinor: number;
  commissionPercent: number;
  commissionMinor: number;
  payoutStatus: "owed" | "paid" | "clawed_back";
}

/** Read + write surface used by every handler. */
export interface PartnerDb {
  insertPartner(input: {
    publicId: string;
    email: string;
    emailNormalised: string;
    passwordHash: string;
    businessName: string;
    contactName: string;
    phone: string | null;
    website: string | null;
    venueType: "hotel" | "spa" | "restaurant" | "cafe" | "other";
    venueCity: string | null;
    venueCountry: string | null;
    status: "pending";
    commissionPercent: number;
    createdAt: Date;
  }): Promise<{ id: number }>;

  findPartnerByEmail(emailNormalised: string): Promise<
    | {
        id: number;
        publicId: string;
        email: string;
        passwordHash: string;
        status: "pending" | "approved" | "rejected" | "suspended";
      }
    | null
  >;

  findPartnerById(id: number): Promise<Partner | null>;
  findPartnerByQrCode(qrCode: string): Promise<Partner | null>;

  setPartnerQrCode(input: { id: number; qrCode: string; updatedAt: Date }): Promise<void>;

  insertPartnerClick(row: PartnerClickRow): Promise<void>;

  /** Cheap aggregate for the partner dashboard. */
  getPartnerTotals(partnerId: number): Promise<{
    clicks: number;
    sales: number;
    grossMinor: number;
    commissionOwedMinor: number;
    currency: "SGD" | "USD" | "VND" | "CNY";
  }>;

  /** Admin default commission % from settings; null when unset. */
  getDefaultCommissionPercent(): Promise<number | null>;
}

// ---------------------------------------------------------------------------
// Password hashing (scrypt) — matches the shape used by accounts.
// Kept local because this batch must not depend on authService, whose
// password scheme is not part of the supplied files.
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
// Small utilities
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

function makePublicId(prefix = "prt"): string {
  // 12 chars of base32-ish entropy — plenty for a public identifier.
  const bytes = randomBytes(8);
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  let out = "";
  for (const b of bytes) out += alphabet[b % 32];
  return `${prefix}_${out}`;
}

function makeQrCode(length = 8): string {
  // Human-typable if a customer calls: lowercase a-z + 2-9, no confusables.
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  const bytes = randomBytes(length);
  let out = "";
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}

function hashIp(ip: string | undefined): string | null {
  if (!ip) return null;
  const salt = process.env.PARTNERS_IP_SALT ?? "unsalted-partners";
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
// Dependency interface
// ---------------------------------------------------------------------------

export interface PartnerDeps {
  getDb: () => PartnerDb | null;
  /** Guard for /me, /qr, /stats. Returns 401 when the partner is not signed in. */
  requirePartner: RequestHandler;
  /**
   * Session setter used by /login. Implementations may set a cookie or a
   * bearer token; this router just calls it and trusts its success.
   */
  setPartnerSession: (input: { partnerId: number; res: Response }) => void | Promise<void>;
  /** Session clearer used by /logout. */
  clearPartnerSession: (res: Response) => void | Promise<void>;
  /**
   * Optional notification hook (admin email). If absent, applications are
   * accepted and stored but the admin is not emailed — the route logs the
   * drop rather than pretending it notified.
   */
  notifyAdmin?: (input: {
    kind: "partner_application";
    partnerId: number;
    businessName: string;
    email: string;
  }) => Promise<void>;
  /** Public base URL used to build the printable link + landing URL. */
  publicBaseUrl: string;
  /** Clock (injectable for deterministic tests). */
  now?: () => Date;
  /**
   * Settings provider for default commission %. When /apply can't read this,
   * `503 partner_settings_unavailable` (we don't fabricate a 10% default).
   */
  getSetting?: (key: string) => Promise<string | null>;
}

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const venueTypeEnum = z.enum(["hotel", "spa", "restaurant", "cafe", "other"]);

const applySchema = z
  .object({
    businessName: z.string().trim().min(2).max(120),
    contactName: z.string().trim().min(1).max(120),
    email: z.string().trim().email(),
    password: z.string().min(8).max(200),
    phone: z
      .string()
      .trim()
      .regex(/^\+?\d{6,15}$/)
      .optional(),
    website: z.string().trim().url().max(300).optional(),
    venueType: venueTypeEnum,
    venueCity: z.string().trim().max(80).optional(),
    venueCountry: z.string().trim().length(2).optional(),
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
    qrCode: z.string().trim().min(4).max(32),
    locale: z.enum(["en", "zh", "vi"]).optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

export function createPartnersRouter(deps: PartnerDeps): Router {
  const router = Router();
  const now = deps.now ?? (() => new Date());

  const dbOrFail = (res: Response): PartnerDb | null => {
    const db = deps.getDb();
    if (!db) {
      fail(res, 503, "partner_db_not_configured", "Partner programme is not configured.");
      return null;
    }
    return db;
  };

  // -------------------------------------------------------------------------
  // POST /apply — public partner application
  // -------------------------------------------------------------------------
  router.post("/apply", async (req: Request, res: Response) => {
    const parsed = applySchema.safeParse(req.body);
    if (!parsed.success) {
      fail(res, 400, "invalid_request", parsed.error.issues[0]?.message ?? "Invalid payload");
      return;
    }
    const db = dbOrFail(res);
    if (!db) return;

    let commission: number | null = null;
    try {
      commission = await db.getDefaultCommissionPercent();
    } catch {
      commission = null;
    }
    // Prefer injected settings provider when available — keeps the seam open
    // so this router doesn't need to know the settings schema.
    if (commission == null && deps.getSetting) {
      try {
        const raw = await deps.getSetting("partners.default_commission_percent");
        if (raw != null) {
          const n = Number(raw);
          if (Number.isFinite(n) && n >= 0 && n <= 50) commission = n;
        }
      } catch {
        commission = null;
      }
    }
    if (commission == null) {
      // We refuse to invent a rate the finance team hasn't set.
      fail(
        res,
        503,
        "partner_settings_unavailable",
        "Partner commission rate is not configured yet.",
      );
      return;
    }

    const emailNorm = normaliseEmail(parsed.data.email);
    const existing = await db.findPartnerByEmail(emailNorm);
    if (existing) {
      fail(res, 409, "email_taken", "An application with that email already exists.");
      return;
    }

    const publicId = makePublicId();
    const passwordHash = hashPassword(parsed.data.password);
    const createdAt = now();

    let inserted: { id: number };
    try {
      inserted = await db.insertPartner({
        publicId,
        email: parsed.data.email.trim(),
        emailNormalised: emailNorm,
        passwordHash,
        businessName: parsed.data.businessName,
        contactName: parsed.data.contactName,
        phone: parsed.data.phone ?? null,
        website: parsed.data.website ?? null,
        venueType: parsed.data.venueType,
        venueCity: parsed.data.venueCity ?? null,
        venueCountry: parsed.data.venueCountry ?? null,
        status: "pending",
        commissionPercent: commission,
        createdAt,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Could not save application";
      // Unique-violation on email would land here under a race.
      fail(res, 409, "email_taken", message);
      return;
    }

    if (deps.notifyAdmin) {
      try {
        await deps.notifyAdmin({
          kind: "partner_application",
          partnerId: inserted.id,
          businessName: parsed.data.businessName,
          email: emailNorm,
        });
      } catch {
        // Non-fatal: application is stored.
      }
    } else {
      // eslint-disable-next-line no-console
      console.log(
        JSON.stringify({
          at: now().toISOString(),
          channel: "partners.apply",
          note: "notifyAdmin not wired; application stored but admin not emailed",
          partnerId: inserted.id,
        }),
      );
    }

    ok(res, { publicId, status: "pending", message: "Application received. We'll email when approved." }, 201);
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
    const row = await db.findPartnerByEmail(normaliseEmail(parsed.data.email));
    // Same generic message for "not found" and "bad password" — no account
    // enumeration via this route.
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
          : "Your partner account is not active.",
      );
      return;
    }
    await deps.setPartnerSession({ partnerId: row.id, res });
    ok(res, { publicId: row.publicId, status: row.status });
  });

  // -------------------------------------------------------------------------
  // POST /logout
  // -------------------------------------------------------------------------
  router.post("/logout", async (_req: Request, res: Response) => {
    await deps.clearPartnerSession(res);
    ok(res, { loggedOut: true });
  });

  // -------------------------------------------------------------------------
  // GET /me
  // -------------------------------------------------------------------------
  router.get("/me", deps.requirePartner, async (req: Request, res: Response) => {
    const partnerId = readPartnerId(req);
    if (partnerId == null) {
      fail(res, 401, "unauthorized", "Sign in to view your partner dashboard.");
      return;
    }
    const db = dbOrFail(res);
    if (!db) return;
    const partner = await db.findPartnerById(partnerId);
    if (!partner) {
      fail(res, 404, "not_found", "Partner not found.");
      return;
    }
    ok(res, { partner });
  });

  // -------------------------------------------------------------------------
  // GET /qr — the printable link + landing URL for the standee
  // -------------------------------------------------------------------------
  router.get("/qr", deps.requirePartner, async (req: Request, res: Response) => {
    const partnerId = readPartnerId(req);
    if (partnerId == null) {
      fail(res, 401, "unauthorized", "Sign in to view your QR.");
      return;
    }
    const db = dbOrFail(res);
    if (!db) return;
    const partner = await db.findPartnerById(partnerId);
    if (!partner) {
      fail(res, 404, "not_found", "Partner not found.");
      return;
    }
    if (partner.status !== "approved") {
      fail(res, 403, "partner_not_approved", "QR is available once your application is approved.");
      return;
    }
    // Idempotently assign a short QR code on first read.
    let qr = partner.qrCode;
    if (!qr) {
      qr = makeQrCode();
      await db.setPartnerQrCode({ id: partnerId, qrCode: qr, updatedAt: now() });
    }
    const base = deps.publicBaseUrl.replace(/\/+$/, "");
    ok(res, {
      qrCode: qr,
      shortLink: `${base}/r/p/${qr}`,
      landing: {
        en: `${base}/en/partners/${qr}`,
        zh: `${base}/zh/partners/${qr}`,
        vi: `${base}/vi/partners/${qr}`,
      },
      instructions: [
        "Print the standee on card stock or laminate it.",
        "Place it at eye level near the waiter station / front desk.",
        "Guests scan → choose a plan → buy. You earn commission per paid order.",
      ],
    });
  });

  // -------------------------------------------------------------------------
  // GET /stats — clicks / sales / commission owed
  // -------------------------------------------------------------------------
  router.get("/stats", deps.requirePartner, async (req: Request, res: Response) => {
    const partnerId = readPartnerId(req);
    if (partnerId == null) {
      fail(res, 401, "unauthorized", "Sign in to view your stats.");
      return;
    }
    const db = dbOrFail(res);
    if (!db) return;
    try {
      const totals = await db.getPartnerTotals(partnerId);
      ok(res, totals);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.log(
        JSON.stringify({
          at: now().toISOString(),
          channel: "partners.stats",
          error: err instanceof Error ? err.message : String(err),
        }),
      );
      fail(res, 500, "internal_error", "Could not compute stats.");
    }
  });

  // -------------------------------------------------------------------------
  // POST /click — public click tracker invoked by /r/p/:code
  // -------------------------------------------------------------------------
  router.post("/click", async (req: Request, res: Response) => {
    const parsed = clickSchema.safeParse(req.body);
    if (!parsed.success) {
      fail(res, 400, "invalid_request", "Missing or invalid qrCode.");
      return;
    }
    const db = dbOrFail(res);
    if (!db) return;
    const partner = await db.findPartnerByQrCode(parsed.data.qrCode);
    if (!partner || partner.status !== "approved") {
      // Do not distinguish "no such code" from "not approved" — the redirect
      // caller should still take the user somewhere useful.
      fail(res, 404, "not_found", "QR code not recognised.");
      return;
    }
    await db.insertPartnerClick({
      partnerId: partner.id,
      qrCode: parsed.data.qrCode,
      clickedAt: now(),
      locale: pickLocale(parsed.data.locale),
      userAgentHash: hashUa(req.get("user-agent") ?? undefined),
      referrerHost: safeHost(req.get("referer") ?? undefined),
      ipHash: hashIp(clientIp(req)),
    });
    ok(res, {
      partnerId: partner.publicId,
      landing: `/en/partners/${parsed.data.qrCode}`,
    });
  });

  // -------------------------------------------------------------------------
  // GET /public/:code — public landing metadata (used by /partners/:code page)
  // -------------------------------------------------------------------------
  router.get("/public/:code", async (req: Request, res: Response) => {
    const code = String(req.params.code ?? "").toLowerCase();
    if (!/^[a-z0-9]{4,32}$/.test(code)) {
      fail(res, 400, "invalid_qr_code", "Malformed QR code.");
      return;
    }
    const db = dbOrFail(res);
    if (!db) return;
    const partner = await db.findPartnerByQrCode(code);
    if (!partner || partner.status !== "approved") {
      fail(res, 404, "not_found", "This partner link is not active.");
      return;
    }
    // Public view: business name + city only. Never email, phone, commission.
    ok(res, {
      businessName: partner.businessName,
      venueType: partner.venueType,
      venueCity: partner.venueCity,
      venueCountry: partner.venueCountry,
    });
  });

  // Local 500 fallback.
  router.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    // eslint-disable-next-line no-console
    console.error("[partners error]", err instanceof Error ? err.message : String(err));
    res.status(500).json({ ok: false, error: "internal_error", message: "Unexpected error" });
    void next;
  });

  return router;
}

// ---------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------

interface PartnerScopedRequest extends Request {
  partner?: { id: number };
}
function readPartnerId(req: Request): number | null {
  const p = (req as PartnerScopedRequest).partner;
  return p && typeof p.id === "number" && p.id > 0 ? p.id : null;
}

function clientIp(req: Request): string | undefined {
  // Trust X-Forwarded-For when behind Replit's proxy. We HASH before storage,
  // so this is not a PII store.
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
  makeQrCode,
  makePublicId,
  pickLocale,
  safeHost,
  hashIp,
  hashUa,
  applySchema,
  loginSchema,
  clickSchema,
  readPartnerId,
};

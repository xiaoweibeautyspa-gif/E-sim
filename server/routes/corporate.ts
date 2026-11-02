/**
 * Corporate accounts — company admin buys eSIMs and assigns them to staff,
 * sees staff usage, and gets a monthly invoice total.
 *
 * SCOPE (this batch)
 * ------------------
 *   POST   /api/corporate/apply                  Public corporate application.
 *   POST   /api/corporate/login                  Email + password login.
 *   POST   /api/corporate/logout                 Clear session.
 *   GET    /api/corporate/me                     Company profile + seat count.
 *   GET    /api/corporate/staff                  List staff (masked emails).
 *   POST   /api/corporate/staff                  Invite a staff member.
 *   DELETE /api/corporate/staff/:staffId         Remove (deactivate) a staff.
 *   GET    /api/corporate/esims                  List assigned eSIMs + usage.
 *   POST   /api/corporate/esims/assign           Assign a *purchased* eSIM to a staff.
 *   POST   /api/corporate/esims/unassign         Unassign an eSIM from a staff.
 *   GET    /api/corporate/invoices               Monthly invoice summaries.
 *
 * NOT IN THIS BATCH (see build report)
 *   - Actual Stripe invoicing / PDF generation (bookkeeping totals only, this
 *     router records what is owed — money movement is a later phase).
 *   - B2B agent tier pricing and bulk send (b2b.ts, earlier batch).
 *
 * DESIGN
 * ------
 *  - Same `Deps`-injection pattern as partners.ts / affiliates.ts so the
 *    router is testable without a real DB. The app wires real `getDb`,
 *    `requireCorporateAdmin`, `sendEmail` (when we have it), `now` in the
 *    next batch's `app.ts` diff.
 *  - Passwords are scrypt with the same wire format as partners/affiliates
 *    (`scrypt$salt$hash`). Kept local for the same reason: the canonical
 *    password helper is not part of the supplied files.
 *  - Every staff/usage response masks the staff email and does not return the
 *    eSIM LPA/QR — the corporate admin can see *that* an eSIM is assigned and
 *    its data usage, but not the install secret. That keeps seat assignment
 *    from leaking eSIM codes through a dashboard.
 *  - Monthly invoice totals come from `getInvoiceTotals()` on the injected db
 *    (a bookkeeping number). No currency conversion, no fake invoice IDs.
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
// Types
// ---------------------------------------------------------------------------

export type Currency = "SGD" | "USD" | "VND" | "CNY";

export interface CorporateAdmin {
  id: number;
  publicId: string;
  email: string;
  companyName: string;
  contactName: string;
  status: "pending" | "approved" | "suspended";
  invoiceEmail: string | null;
  seats: number;
  createdAt: string;
}

export interface StaffMember {
  id: number;
  publicId: string;
  name: string;
  /** Masked for admin view: "j****@acme.com". */
  emailMasked: string;
  role: string | null;
  status: "invited" | "active" | "removed";
  createdAt: string;
}

export interface AssignedEsim {
  esimId: number;
  esimTranNo: string | null;
  iccid: string | null;
  staffPublicId: string;
  staffName: string;
  country: string;
  planName: string;
  /** Installed / in-use / expired / unused — whatever the eSIM row carries. */
  status: string;
  totalBytes: number;
  usedBytes: number;
  usageUpdatedAt: string | null;
  expiresAt: string | null;
}

export interface InvoiceSummary {
  /** YYYY-MM, UTC. */
  period: string;
  currency: Currency;
  subtotalMinor: number;
  taxMinor: number;
  totalMinor: number;
  orderCount: number;
  status: "open" | "paid" | "overdue";
}

export interface CorporateDb {
  insertCorporateAdmin(input: {
    publicId: string;
    email: string;
    emailNormalised: string;
    passwordHash: string;
    companyName: string;
    contactName: string;
    invoiceEmail: string | null;
    status: "pending";
    createdAt: Date;
  }): Promise<{ id: number }>;

  findCorporateAdminByEmail(emailNormalised: string): Promise<
    | {
        id: number;
        publicId: string;
        email: string;
        passwordHash: string;
        status: "pending" | "approved" | "suspended";
      }
    | null
  >;

  findCorporateAdminById(id: number): Promise<CorporateAdmin | null>;

  countActiveStaff(corporateAdminId: number): Promise<number>;

  listStaff(corporateAdminId: number): Promise<StaffMember[]>;

  insertStaff(input: {
    publicId: string;
    corporateAdminId: number;
    name: string;
    email: string;
    emailNormalised: string;
    role: string | null;
    status: "invited";
    createdAt: Date;
  }): Promise<{ id: number; publicId: string }>;

  findStaff(corporateAdminId: number, staffId: number): Promise<
    | { id: number; publicId: string; status: "invited" | "active" | "removed" }
    | null
  >;

  setStaffStatus(input: {
    staffId: number;
    corporateAdminId: number;
    status: "removed";
    updatedAt: Date;
  }): Promise<void>;

  /**
   * Assign an existing eSIM (owned by the corporate admin's purchase chain)
   * to a staff member. The db layer is responsible for the "only allowed when
   * eSIM is unused" guard; this router surfaces the error it throws.
   */
  assignEsim(input: {
    corporateAdminId: number;
    esimId: number;
    staffId: number;
    assignedAt: Date;
  }): Promise<void>;

  unassignEsim(input: {
    corporateAdminId: number;
    esimId: number;
    updatedAt: Date;
  }): Promise<void>;

  listAssignedEsims(corporateAdminId: number): Promise<AssignedEsim[]>;

  /**
   * Monthly invoice totals from real orders in the corporate account. Returns
   * an empty list when no orders are in the window — never a fabricated row.
   */
  getInvoiceTotals(input: {
    corporateAdminId: number;
    fromMonth: string; // inclusive YYYY-MM
    toMonth: string;   // inclusive YYYY-MM
  }): Promise<InvoiceSummary[]>;
}

// ---------------------------------------------------------------------------
// Password hashing — same wire format as partners/affiliates.
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
function makePublicId(prefix: string): string {
  const bytes = randomBytes(8);
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  let out = "";
  for (const b of bytes) out += alphabet[b % 32];
  return `${prefix}_${out}`;
}
function maskEmail(raw: string): string {
  const [local, domain] = raw.split("@");
  if (!local || !domain) return "***";
  if (local.length <= 2) return `${local[0] ?? "*"}***@${domain}`;
  return `${local[0]}${"*".repeat(Math.min(local.length - 2, 4))}@${domain}`;
}
function nowMonth(now: Date): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}
function addMonths(month: string, delta: number): string {
  const [yStr, mStr] = month.split("-");
  const y = Number(yStr);
  const m = Number(mStr);
  if (!Number.isFinite(y) || !Number.isFinite(m)) return month;
  const total = y * 12 + (m - 1) + delta;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return `${ny}-${String(nm).padStart(2, "0")}`;
}
function hashIp(ip: string | undefined): string | null {
  if (!ip) return null;
  const salt = process.env.CORPORATE_IP_SALT ?? "unsalted-corporate";
  return createHash("sha256").update(`${salt}:${ip}`).digest("hex").slice(0, 32);
}
function clientIp(req: Request): string | undefined {
  const xff = req.get("x-forwarded-for");
  if (xff) return xff.split(",")[0]?.trim();
  return req.socket.remoteAddress;
}

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

export interface CorporateDeps {
  getDb: () => CorporateDb | null;
  /** Guard for /me, /staff*, /esims*, /invoices. */
  requireCorporateAdmin: RequestHandler;
  /** Session setter used by /login. */
  setCorporateSession: (input: {
    corporateAdminId: number;
    res: Response;
  }) => void | Promise<void>;
  /** Session clearer used by /logout. */
  clearCorporateSession: (res: Response) => void | Promise<void>;
  /**
   * Optional staff-invite email hook. When absent, the invite is stored and
   * the route logs the drop rather than pretending the email was sent.
   */
  sendStaffInvite?: (input: {
    corporateAdminId: number;
    staffId: number;
    staffEmail: string;
    staffName: string;
    companyName: string;
    inviteUrl: string;
  }) => Promise<void>;
  /** Optional admin-notification hook on new applications. */
  notifyAdmin?: (input: {
    kind: "corporate_application";
    corporateAdminId: number;
    companyName: string;
    email: string;
  }) => Promise<void>;
  /** Used to build staff invite URLs. */
  publicBaseUrl: string;
  /** Clock (injectable for deterministic tests). */
  now?: () => Date;
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const applySchema = z
  .object({
    companyName: z.string().trim().min(2).max(200),
    contactName: z.string().trim().min(1).max(120),
    email: z.string().trim().email(),
    password: z.string().min(8).max(200),
    invoiceEmail: z.string().trim().email().optional(),
  })
  .strict();

const loginSchema = z
  .object({
    email: z.string().trim().email(),
    password: z.string().min(1).max(200),
  })
  .strict();

const inviteSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    email: z.string().trim().email(),
    role: z.string().trim().max(80).optional(),
  })
  .strict();

const assignSchema = z
  .object({
    esimId: z.number().int().positive(),
    staffId: z.number().int().positive(),
  })
  .strict();

const unassignSchema = z
  .object({
    esimId: z.number().int().positive(),
  })
  .strict();

const invoicesQuerySchema = z
  .object({
    months: z
      .string()
      .trim()
      .regex(/^[1-9]\d{0,2}$/)
      .optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

export function createCorporateRouter(deps: CorporateDeps): Router {
  const router = Router();
  const now = deps.now ?? (() => new Date());

  const dbOrFail = (res: Response): CorporateDb | null => {
    const db = deps.getDb();
    if (!db) {
      fail(
        res,
        503,
        "corporate_db_not_configured",
        "Corporate accounts are not configured.",
      );
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
    const emailNorm = normaliseEmail(parsed.data.email);
    const existing = await db.findCorporateAdminByEmail(emailNorm);
    if (existing) {
      fail(res, 409, "email_taken", "An application with that email already exists.");
      return;
    }
    const publicId = makePublicId("corp");
    const passwordHash = hashPassword(parsed.data.password);
    const createdAt = now();

    let inserted: { id: number };
    try {
      inserted = await db.insertCorporateAdmin({
        publicId,
        email: parsed.data.email.trim(),
        emailNormalised: emailNorm,
        passwordHash,
        companyName: parsed.data.companyName,
        contactName: parsed.data.contactName,
        invoiceEmail: parsed.data.invoiceEmail ?? null,
        status: "pending",
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
          kind: "corporate_application",
          corporateAdminId: inserted.id,
          companyName: parsed.data.companyName,
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
          channel: "corporate.apply",
          note: "notifyAdmin not wired; application stored but admin not emailed",
          corporateAdminId: inserted.id,
        }),
      );
    }

    ok(
      res,
      {
        publicId,
        status: "pending",
        message: "Application received. We'll email once approved.",
      },
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
    const row = await db.findCorporateAdminByEmail(normaliseEmail(parsed.data.email));
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
          : "Your corporate account is not active.",
      );
      return;
    }
    await deps.setCorporateSession({ corporateAdminId: row.id, res });
    ok(res, { publicId: row.publicId, status: row.status });
  });

  // -------------------------------------------------------------------------
  // POST /logout
  // -------------------------------------------------------------------------
  router.post("/logout", async (_req: Request, res: Response) => {
    await deps.clearCorporateSession(res);
    ok(res, { loggedOut: true });
  });

  // -------------------------------------------------------------------------
  // GET /me
  // -------------------------------------------------------------------------
  router.get("/me", deps.requireCorporateAdmin, async (req: Request, res: Response) => {
    const corporateAdminId = readCorporateAdminId(req);
    if (corporateAdminId == null) {
      fail(res, 401, "unauthorized", "Sign in to view your corporate account.");
      return;
    }
    const db = dbOrFail(res);
    if (!db) return;
    const admin = await db.findCorporateAdminById(corporateAdminId);
    if (!admin) {
      fail(res, 404, "not_found", "Corporate account not found.");
      return;
    }
    let activeStaff = 0;
    try {
      activeStaff = await db.countActiveStaff(corporateAdminId);
    } catch {
      activeStaff = 0;
    }
    ok(res, { admin, activeStaff });
  });

  // -------------------------------------------------------------------------
  // Staff CRUD
  // -------------------------------------------------------------------------
  router.get(
    "/staff",
    deps.requireCorporateAdmin,
    async (req: Request, res: Response) => {
      const corporateAdminId = readCorporateAdminId(req);
      if (corporateAdminId == null) {
        fail(res, 401, "unauthorized", "Sign in to view staff.");
        return;
      }
      const db = dbOrFail(res);
      if (!db) return;
      const staff = await db.listStaff(corporateAdminId);
      // Mask email addresses in the response — the raw address only lives in
      // the outbound invite, not on the dashboard.
      const masked = staff.map((s) => ({ ...s, emailMasked: maskEmail(s.emailMasked) }));
      ok(res, { staff: masked });
    },
  );

  router.post(
    "/staff",
    deps.requireCorporateAdmin,
    async (req: Request, res: Response) => {
      const corporateAdminId = readCorporateAdminId(req);
      if (corporateAdminId == null) {
        fail(res, 401, "unauthorized", "Sign in to invite staff.");
        return;
      }
      const parsed = inviteSchema.safeParse(req.body);
      if (!parsed.success) {
        fail(
          res,
          400,
          "invalid_request",
          parsed.error.issues[0]?.message ?? "Invalid payload",
        );
        return;
      }
      const db = dbOrFail(res);
      if (!db) return;
      const admin = await db.findCorporateAdminById(corporateAdminId);
      if (!admin) {
        fail(res, 404, "not_found", "Corporate account not found.");
        return;
      }
      // Seat cap: refuse to exceed the approved seat count rather than
      // silently over-provisioning. `seats` is the plan allowance set by
      // admin when the corporate application is approved.
      if (admin.seats > 0) {
        const active = await db.countActiveStaff(corporateAdminId);
        if (active >= admin.seats) {
          fail(
            res,
            409,
            "seat_limit_reached",
            `This plan allows ${admin.seats} active staff. Remove one or upgrade to invite more.`,
          );
          return;
        }
      }
      const staffPublicId = makePublicId("stf");
      const staffEmailNorm = normaliseEmail(parsed.data.email);
      let inserted: { id: number; publicId: string };
      try {
        inserted = await db.insertStaff({
          publicId: staffPublicId,
          corporateAdminId,
          name: parsed.data.name,
          email: parsed.data.email.trim(),
          emailNormalised: staffEmailNorm,
          role: parsed.data.role ?? null,
          status: "invited",
          createdAt: now(),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Could not invite staff.";
        fail(res, 409, "email_taken", message);
        return;
      }

      const base = deps.publicBaseUrl.replace(/\/+$/, "");
      const inviteUrl = `${base}/corporate/invite/${inserted.publicId}`;
      if (deps.sendStaffInvite) {
        try {
          await deps.sendStaffInvite({
            corporateAdminId,
            staffId: inserted.id,
            staffEmail: parsed.data.email.trim(),
            staffName: parsed.data.name,
            companyName: admin.companyName,
            inviteUrl,
          });
        } catch {
          // Invite recorded; email drop logged elsewhere (emailSender).
        }
      } else {
        // eslint-disable-next-line no-console
        console.log(
          JSON.stringify({
            at: now().toISOString(),
            channel: "corporate.staff.invite",
            note: "sendStaffInvite not wired; invite stored but email not sent",
            staffId: inserted.id,
          }),
        );
      }

      ok(
        res,
        {
          staffPublicId: inserted.publicId,
          emailMasked: maskEmail(parsed.data.email),
          status: "invited",
        },
        201,
      );
    },
  );

  router.delete(
    "/staff/:staffId",
    deps.requireCorporateAdmin,
    async (req: Request, res: Response) => {
      const corporateAdminId = readCorporateAdminId(req);
      if (corporateAdminId == null) {
        fail(res, 401, "unauthorized", "Sign in to manage staff.");
        return;
      }
      const staffId = Number(req.params.staffId);
      if (!Number.isInteger(staffId) || staffId <= 0) {
        fail(res, 400, "invalid_staff_id", "Staff id must be a positive integer.");
        return;
      }
      const db = dbOrFail(res);
      if (!db) return;
      const row = await db.findStaff(corporateAdminId, staffId);
      if (!row) {
        fail(res, 404, "not_found", "Staff member not found.");
        return;
      }
      if (row.status === "removed") {
        ok(res, { staffId, status: "removed" });
        return;
      }
      await db.setStaffStatus({
        staffId,
        corporateAdminId,
        status: "removed",
        updatedAt: now(),
      });
      ok(res, { staffId, status: "removed" });
    },
  );

  // -------------------------------------------------------------------------
  // eSIM assignment
  // -------------------------------------------------------------------------
  router.get(
    "/esims",
    deps.requireCorporateAdmin,
    async (req: Request, res: Response) => {
      const corporateAdminId = readCorporateAdminId(req);
      if (corporateAdminId == null) {
        fail(res, 401, "unauthorized", "Sign in to view assigned eSIMs.");
        return;
      }
      const db = dbOrFail(res);
      if (!db) return;
      const esims = await db.listAssignedEsims(corporateAdminId);
      ok(res, { esims });
    },
  );

  router.post(
    "/esims/assign",
    deps.requireCorporateAdmin,
    async (req: Request, res: Response) => {
      const corporateAdminId = readCorporateAdminId(req);
      if (corporateAdminId == null) {
        fail(res, 401, "unauthorized", "Sign in to assign eSIMs.");
        return;
      }
      const parsed = assignSchema.safeParse(req.body);
      if (!parsed.success) {
        fail(
          res,
          400,
          "invalid_request",
          parsed.error.issues[0]?.message ?? "Invalid assignment payload.",
        );
        return;
      }
      const db = dbOrFail(res);
      if (!db) return;
      const staff = await db.findStaff(corporateAdminId, parsed.data.staffId);
      if (!staff || staff.status === "removed") {
        fail(res, 404, "not_found", "Staff member not found or removed.");
        return;
      }
      try {
        await db.assignEsim({
          corporateAdminId,
          esimId: parsed.data.esimId,
          staffId: parsed.data.staffId,
          assignedAt: now(),
        });
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Could not assign this eSIM.";
        fail(res, 409, "assignment_failed", message);
        return;
      }
      ok(res, { esimId: parsed.data.esimId, staffId: parsed.data.staffId });
    },
  );

  router.post(
    "/esims/unassign",
    deps.requireCorporateAdmin,
    async (req: Request, res: Response) => {
      const corporateAdminId = readCorporateAdminId(req);
      if (corporateAdminId == null) {
        fail(res, 401, "unauthorized", "Sign in to manage assignments.");
        return;
      }
      const parsed = unassignSchema.safeParse(req.body);
      if (!parsed.success) {
        fail(
          res,
          400,
          "invalid_request",
          parsed.error.issues[0]?.message ?? "Invalid unassign payload.",
        );
        return;
      }
      const db = dbOrFail(res);
      if (!db) return;
      try {
        await db.unassignEsim({
          corporateAdminId,
          esimId: parsed.data.esimId,
          updatedAt: now(),
        });
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Could not unassign this eSIM.";
        fail(res, 409, "unassign_failed", message);
        return;
      }
      ok(res, { esimId: parsed.data.esimId, assigned: false });
    },
  );

  // -------------------------------------------------------------------------
  // Monthly invoices
  // -------------------------------------------------------------------------
  router.get(
    "/invoices",
    deps.requireCorporateAdmin,
    async (req: Request, res: Response) => {
      const corporateAdminId = readCorporateAdminId(req);
      if (corporateAdminId == null) {
        fail(res, 401, "unauthorized", "Sign in to view invoices.");
        return;
      }
      const parsed = invoicesQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        fail(res, 400, "invalid_request", "months must be a positive integer.");
        return;
      }
      const months = Math.min(Number(parsed.data.months ?? 6) || 6, 24);
      const db = dbOrFail(res);
      if (!db) return;
      const t0 = now();
      const toMonth = nowMonth(t0);
      const fromMonth = addMonths(toMonth, -(months - 1));
      try {
        const invoices = await db.getInvoiceTotals({
          corporateAdminId,
          fromMonth,
          toMonth,
        });
        ok(res, { invoices, window: { fromMonth, toMonth } });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.log(
          JSON.stringify({
            at: t0.toISOString(),
            channel: "corporate.invoices",
            error: err instanceof Error ? err.message : String(err),
          }),
        );
        fail(res, 500, "internal_error", "Could not compute invoices.");
      }
    },
  );

  // Local 500 fallback.
  router.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    // eslint-disable-next-line no-console
    console.error("[corporate error]", err instanceof Error ? err.message : String(err));
    res.status(500).json({ ok: false, error: "internal_error", message: "Unexpected error" });
    void next;
  });

  // Kept for parity with partners/affiliates; hashed IPs are a future
  // bookkeeping detail, not used for corporate actions here.
  void hashIp;
  void clientIp;

  return router;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface CorporateScopedRequest extends Request {
  corporate?: { id: number };
}
function readCorporateAdminId(req: Request): number | null {
  const c = (req as CorporateScopedRequest).corporate;
  return c && typeof c.id === "number" && c.id > 0 ? c.id : null;
}

// ---------------------------------------------------------------------------
// Test surface
// ---------------------------------------------------------------------------

export const __test__ = {
  hashPassword,
  verifyPassword,
  normaliseEmail,
  makePublicId,
  maskEmail,
  nowMonth,
  addMonths,
  readCorporateAdminId,
  applySchema,
  loginSchema,
  inviteSchema,
  assignSchema,
  unassignSchema,
  invoicesQuerySchema,
};

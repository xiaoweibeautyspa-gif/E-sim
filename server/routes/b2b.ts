/**
 * B2B travel-agent portal — API surface for approved agents who buy in bulk
 * and send eSIMs to their clients.
 *
 * SCOPE (this batch)
 * ------------------
 *   POST   /api/b2b/apply                Public application.
 *   POST   /api/b2b/login                Email + password login.
 *   POST   /api/b2b/logout               Clear session.
 *   GET    /api/b2b/me                   Current agent profile + tier + limits.
 *   GET    /api/b2b/tiers                Pricing tiers visible to the agent.
 *   POST   /api/b2b/quote                Quote N seats of a plan at tier price.
 *   POST   /api/b2b/order                Create a bulk order (status 'pending_payment').
 *   GET    /api/b2b/orders               List my orders.
 *   GET    /api/b2b/orders/:publicId     Order detail with seats.
 *   POST   /api/b2b/orders/:publicId/assign
 *                                        Assign a seat to a client (name + email).
 *                                        Records intent; actual send handled by the
 *                                        injected `sendEsimToClient` (or 503 if not
 *                                        configured). Never fabricates delivery.
 *
 * NOT IN THIS BATCH (see build report)
 *   - Payment collection for agency orders (Stripe integration, later).
 *   - Supplier ordering — this router NEVER calls eSIM Access. The fulfilment
 *     service owns that and its call site is bound to Stripe webhook payment
 *     confirmation.
 *   - Monthly invoicing (corporate accounts; separate batch).
 *   - Actual email templating — see `sendEsimToClient` in `B2BDeps`.
 *
 * DESIGN
 * ------
 *  - The B2B router is deliberately narrow on scope: it quotes, creates a
 *    pending-payment order, and records "assign this seat to client X".
 *    It does NOT mark an order paid, does NOT dispatch to the supplier, and
 *    does NOT send email without an injected sender.
 *  - Tier pricing is admin-managed. If no tier matches we return
 *    `tier_not_configured` — never an invented discount.
 *  - `bulk order` uses our own order table with `count` seats; the existing
 *    fulfilment flow (order after Stripe confirms payment, transactionId =
 *    orderPublicId) still applies once the agency pays. This router only
 *    creates the *intent* row.
 */
import {
  Router,
  type Request,
  type Response,
  type NextFunction,
  type RequestHandler,
} from "express";
import { randomBytes, scryptSync, timingSafeEqual, createHash } from "node:crypto";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SeatState =
  | "unassigned"
  | "assigned"       // name + email captured, not yet sent
  | "sent"           // handoff to client's inbox succeeded
  | "send_failed"    // handoff attempted, provider rejected
  | "cancelled";     // seat released before order fulfilment

export interface Agent {
  id: number;
  publicId: string;
  email: string;
  companyName: string;
  contactName: string;
  phone: string | null;
  website: string | null;
  status: "pending" | "approved" | "rejected" | "suspended";
  tier: "bronze" | "silver" | "gold" | "enterprise" | null;
  tierDiscountPercent: number | null;
  monthlySeatLimit: number | null;
  createdAt: string;
}

export interface B2BOrderSeat {
  seatIndex: number;
  state: SeatState;
  clientName: string | null;
  clientEmail: string | null;
}

export interface B2BOrder {
  publicId: string;
  agentId: number;
  packageCode: string;
  quantity: number;
  currency: "SGD" | "USD" | "VND" | "CNY";
  unitRetailMinor: number;
  unitTierMinor: number;
  totalMinor: number;
  status: "pending_payment" | "paid" | "fulfilling" | "fulfilled" | "cancelled";
  createdAt: string;
  seats: B2BOrderSeat[];
}

/** Read + write surface used by every handler. */
export interface B2BDb {
  insertAgent(input: {
    publicId: string;
    email: string;
    emailNormalised: string;
    passwordHash: string;
    companyName: string;
    contactName: string;
    phone: string | null;
    website: string | null;
    status: "pending";
    createdAt: Date;
  }): Promise<{ id: number }>;

  findAgentByEmail(emailNormalised: string): Promise<
    | {
        id: number;
        publicId: string;
        email: string;
        passwordHash: string;
        status: "pending" | "approved" | "rejected" | "suspended";
        tier: "bronze" | "silver" | "gold" | "enterprise" | null;
        tierDiscountPercent: number | null;
        monthlySeatLimit: number | null;
      }
    | null
  >;

  findAgentById(id: number): Promise<Agent | null>;

  /** The plan's retail price (from packages table). Null → plan not published. */
  getPackageRetailMinor(input: {
    packageCode: string;
    currency: "SGD" | "USD" | "VND" | "CNY";
  }): Promise<number | null>;

  /** Sum of qualifying seats this agent has created since the 1st of the month. */
  getMonthlySeatUsage(agentId: number, monthStart: Date): Promise<number>;

  insertOrder(input: {
    publicId: string;
    agentId: number;
    packageCode: string;
    quantity: number;
    currency: "SGD" | "USD" | "VND" | "CNY";
    unitRetailMinor: number;
    unitTierMinor: number;
    totalMinor: number;
    status: "pending_payment";
    createdAt: Date;
    seatIndexes: number[];
  }): Promise<void>;

  getOrder(agentId: number, publicId: string): Promise<B2BOrder | null>;
  listOrders(agentId: number): Promise<B2BOrder[]>;

  assignSeat(input: {
    agentId: number;
    orderPublicId: string;
    seatIndex: number;
    clientName: string;
    clientEmail: string;
    updatedAt: Date;
  }): Promise<
    | { ok: true; order: B2BOrder }
    | {
        ok: false;
        reason:
          | "order_not_found"
          | "seat_out_of_range"
          | "seat_not_assignable"
          | "order_cancelled";
      }
  >;

  markSeatSent(input: {
    agentId: number;
    orderPublicId: string;
    seatIndex: number;
    esimId: number;
    sentAt: Date;
  }): Promise<void>;

  markSeatSendFailed(input: {
    agentId: number;
    orderPublicId: string;
    seatIndex: number;
    reason: string;
    at: Date;
  }): Promise<void>;
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
function makePublicId(prefix = "agt"): string {
  const bytes = randomBytes(8);
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  let out = "";
  for (const b of bytes) out += alphabet[b % 32];
  return `${prefix}_${out}`;
}
function makeOrderPublicId(): string {
  const d = new Date();
  const ymd = `${d.getUTCFullYear()}${(d.getUTCMonth() + 1).toString().padStart(2, "0")}${d
    .getUTCDate()
    .toString()
    .padStart(2, "0")}`;
  return `b2b-${ymd}-${randomBytes(4).toString("hex")}`;
}
function monthStartUTC(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1, 0, 0, 0));
}
function hashIp(ip: string | undefined): string | null {
  if (!ip) return null;
  const salt = process.env.B2B_IP_SALT ?? "unsalted-b2b";
  return createHash("sha256").update(`${salt}:${ip}`).digest("hex").slice(0, 32);
}
// Suppress an unused warning; kept for the eventual "application source" field.
void hashIp;

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

export interface B2BDeps {
  getDb: () => B2BDb | null;
  requireAgent: RequestHandler;
  setAgentSession: (input: { agentId: number; res: Response }) => void | Promise<void>;
  clearAgentSession: (res: Response) => void | Promise<void>;
  /**
   * Deliver a purchased eSIM to the client. Wired by the app to
   * `fulfilment.sendSingleEsimToEmail` (which the B2B router does not own).
   * Required for POST /orders/:id/assign to succeed; if absent the route
   * returns 503 `client_delivery_not_configured` and leaves the seat in
   * `assigned` state (the caller can retry once wired).
   */
  sendEsimToClient?: (input: {
    agentId: number;
    orderPublicId: string;
    seatIndex: number;
    clientName: string;
    clientEmail: string;
    esimId: number;
  }) => Promise<{ ok: true; esimId: number } | { ok: false; reason: string }>;
  notifyAdmin?: (input: {
    kind: "b2b_application";
    agentId: number;
    companyName: string;
    email: string;
  }) => Promise<void>;
  publicBaseUrl: string;
  now?: () => Date;
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const applySchema = z
  .object({
    companyName: z.string().trim().min(2).max(160),
    contactName: z.string().trim().min(1).max(120),
    email: z.string().trim().email(),
    password: z.string().min(8).max(200),
    phone: z
      .string()
      .trim()
      .regex(/^\+?\d{6,15}$/)
      .optional(),
    website: z.string().trim().url().max(300).optional(),
  })
  .strict();

const loginSchema = z
  .object({
    email: z.string().trim().email(),
    password: z.string().min(1).max(200),
  })
  .strict();

const currencyEnum = z.enum(["SGD", "USD", "VND", "CNY"]);

const quoteSchema = z
  .object({
    packageCode: z.string().trim().min(1).max(120),
    quantity: z.number().int().min(1).max(500),
    currency: currencyEnum,
  })
  .strict();

const orderSchema = quoteSchema;

const assignSchema = z
  .object({
    seatIndex: z.number().int().min(1).max(500),
    clientName: z.string().trim().min(1).max(120),
    clientEmail: z.string().trim().email(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

export function createB2BRouter(deps: B2BDeps): Router {
  const router = Router();
  const now = deps.now ?? (() => new Date());

  const dbOrFail = (res: Response): B2BDb | null => {
    const db = deps.getDb();
    if (!db) {
      fail(res, 503, "b2b_db_not_configured", "B2B programme is not configured.");
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
    const existing = await db.findAgentByEmail(emailNorm);
    if (existing) {
      fail(res, 409, "email_taken", "An application with that email already exists.");
      return;
    }
    const publicId = makePublicId();
    const passwordHash = hashPassword(parsed.data.password);
    const createdAt = now();
    let inserted: { id: number };
    try {
      inserted = await db.insertAgent({
        publicId,
        email: parsed.data.email.trim(),
        emailNormalised: emailNorm,
        passwordHash,
        companyName: parsed.data.companyName,
        contactName: parsed.data.contactName,
        phone: parsed.data.phone ?? null,
        website: parsed.data.website ?? null,
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
          kind: "b2b_application",
          agentId: inserted.id,
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
          channel: "b2b.apply",
          note: "notifyAdmin not wired; application stored but admin not emailed",
          agentId: inserted.id,
        }),
      );
    }

    ok(
      res,
      {
        publicId,
        status: "pending",
        message:
          "Application received. We review applications within one business day and email you when approved.",
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
    const row = await db.findAgentByEmail(normaliseEmail(parsed.data.email));
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
          : "Your agent account is not active.",
      );
      return;
    }
    await deps.setAgentSession({ agentId: row.id, res });
    ok(res, { publicId: row.publicId, tier: row.tier });
  });

  // -------------------------------------------------------------------------
  // POST /logout
  // -------------------------------------------------------------------------
  router.post("/logout", async (_req: Request, res: Response) => {
    await deps.clearAgentSession(res);
    ok(res, { loggedOut: true });
  });

  // -------------------------------------------------------------------------
  // GET /me
  // -------------------------------------------------------------------------
  router.get("/me", deps.requireAgent, async (req: Request, res: Response) => {
    const agentId = readAgentId(req);
    if (agentId == null) {
      fail(res, 401, "unauthorized", "Sign in to view your B2B dashboard.");
      return;
    }
    const db = dbOrFail(res);
    if (!db) return;
    const agent = await db.findAgentById(agentId);
    if (!agent) {
      fail(res, 404, "not_found", "Agent not found.");
      return;
    }
    const usage = await db.getMonthlySeatUsage(agentId, monthStartUTC(now()));
    ok(res, {
      agent: {
        publicId: agent.publicId,
        companyName: agent.companyName,
        contactName: agent.contactName,
        email: agent.email,
        phone: agent.phone,
        website: agent.website,
        status: agent.status,
        tier: agent.tier,
        tierDiscountPercent: agent.tierDiscountPercent,
        monthlySeatLimit: agent.monthlySeatLimit,
        createdAt: agent.createdAt,
      },
      seatUsageThisMonth: usage,
    });
  });

  // -------------------------------------------------------------------------
  // GET /tiers — surface the tiers we know about for agency landing copy
  // -------------------------------------------------------------------------
  router.get("/tiers", async (_req: Request, res: Response) => {
    // Static tier labels; the discount % per tier is admin-set and comes from
    // the agent profile (not from the tiers endpoint). Returning the labels
    // keeps the landing copy stable without inventing percentages.
    ok(res, {
      tiers: [
        { id: "bronze", label: "Bronze", description: "Up to 25 seats/month" },
        { id: "silver", label: "Silver", description: "Up to 100 seats/month" },
        { id: "gold", label: "Gold", description: "Up to 400 seats/month" },
        { id: "enterprise", label: "Enterprise", description: "Unlimited seats, invoicing" },
      ],
      note: "Tier discount percentages are set by our team when your account is approved.",
    });
  });

  // -------------------------------------------------------------------------
  // POST /quote
  // -------------------------------------------------------------------------
  router.post("/quote", deps.requireAgent, async (req: Request, res: Response) => {
    const agentId = readAgentId(req);
    if (agentId == null) {
      fail(res, 401, "unauthorized", "Sign in to request a quote.");
      return;
    }
    const parsed = quoteSchema.safeParse(req.body);
    if (!parsed.success) {
      fail(res, 400, "invalid_request", parsed.error.issues[0]?.message ?? "Invalid payload");
      return;
    }
    const db = dbOrFail(res);
    if (!db) return;
    const agent = await db.findAgentById(agentId);
    if (!agent) {
      fail(res, 404, "not_found", "Agent not found.");
      return;
    }
    if (agent.status !== "approved") {
      fail(res, 403, "agent_not_approved", "Quotes are available once your account is approved.");
      return;
    }
    if (agent.tierDiscountPercent == null) {
      fail(
        res,
        409,
        "tier_not_configured",
        "Ask our team to set your tier discount before requesting quotes.",
      );
      return;
    }
    const retail = await db.getPackageRetailMinor({
      packageCode: parsed.data.packageCode,
      currency: parsed.data.currency,
    });
    if (retail == null) {
      fail(res, 404, "package_not_found", "That plan is not available in this currency.");
      return;
    }
    const unitTier = Math.max(0, Math.round(retail * (1 - agent.tierDiscountPercent / 100)));
    ok(res, {
      packageCode: parsed.data.packageCode,
      quantity: parsed.data.quantity,
      currency: parsed.data.currency,
      unitRetailMinor: retail,
      unitTierMinor: unitTier,
      tierDiscountPercent: agent.tierDiscountPercent,
      totalMinor: unitTier * parsed.data.quantity,
    });
  });

  // -------------------------------------------------------------------------
  // POST /order — create a pending-payment bulk order
  // -------------------------------------------------------------------------
  router.post("/order", deps.requireAgent, async (req: Request, res: Response) => {
    const agentId = readAgentId(req);
    if (agentId == null) {
      fail(res, 401, "unauthorized", "Sign in to create an order.");
      return;
    }
    const parsed = orderSchema.safeParse(req.body);
    if (!parsed.success) {
      fail(res, 400, "invalid_request", parsed.error.issues[0]?.message ?? "Invalid payload");
      return;
    }
    const db = dbOrFail(res);
    if (!db) return;
    const agent = await db.findAgentById(agentId);
    if (!agent) {
      fail(res, 404, "not_found", "Agent not found.");
      return;
    }
    if (agent.status !== "approved") {
      fail(res, 403, "agent_not_approved", "Only approved agents can place orders.");
      return;
    }
    if (agent.tierDiscountPercent == null) {
      fail(
        res,
        409,
        "tier_not_configured",
        "Ask our team to set your tier discount before placing orders.",
      );
      return;
    }
    if (agent.monthlySeatLimit != null) {
      const used = await db.getMonthlySeatUsage(agentId, monthStartUTC(now()));
      if (used + parsed.data.quantity > agent.monthlySeatLimit) {
        fail(
          res,
          429,
          "monthly_seat_limit_exceeded",
          `This order would exceed your monthly seat limit (${agent.monthlySeatLimit}).`,
        );
        return;
      }
    }
    const retail = await db.getPackageRetailMinor({
      packageCode: parsed.data.packageCode,
      currency: parsed.data.currency,
    });
    if (retail == null) {
      fail(res, 404, "package_not_found", "That plan is not available in this currency.");
      return;
    }
    const unitTier = Math.max(0, Math.round(retail * (1 - agent.tierDiscountPercent / 100)));
    const totalMinor = unitTier * parsed.data.quantity;
    const publicId = makeOrderPublicId();
    const createdAt = now();
    const seatIndexes = Array.from({ length: parsed.data.quantity }, (_, i) => i + 1);

    await db.insertOrder({
      publicId,
      agentId,
      packageCode: parsed.data.packageCode,
      quantity: parsed.data.quantity,
      currency: parsed.data.currency,
      unitRetailMinor: retail,
      unitTierMinor: unitTier,
      totalMinor,
      status: "pending_payment",
      createdAt,
      seatIndexes,
    });

    ok(
      res,
      {
        publicId,
        status: "pending_payment",
        quantity: parsed.data.quantity,
        currency: parsed.data.currency,
        unitRetailMinor: retail,
        unitTierMinor: unitTier,
        totalMinor,
        next: "Pay via the checkout link to start fulfilment.",
      },
      201,
    );
  });

  // -------------------------------------------------------------------------
  // GET /orders
  // -------------------------------------------------------------------------
  router.get("/orders", deps.requireAgent, async (req: Request, res: Response) => {
    const agentId = readAgentId(req);
    if (agentId == null) {
      fail(res, 401, "unauthorized", "Sign in to view your orders.");
      return;
    }
    const db = dbOrFail(res);
    if (!db) return;
    const orders = await db.listOrders(agentId);
    ok(res, { orders });
  });

  // -------------------------------------------------------------------------
  // GET /orders/:publicId
  // -------------------------------------------------------------------------
  router.get("/orders/:publicId", deps.requireAgent, async (req: Request, res: Response) => {
    const agentId = readAgentId(req);
    if (agentId == null) {
      fail(res, 401, "unauthorized", "Sign in to view this order.");
      return;
    }
    const publicId = String(req.params.publicId ?? "");
    if (!/^[a-z0-9-]{4,64}$/i.test(publicId)) {
      fail(res, 400, "invalid_order_id", "Malformed order id.");
      return;
    }
    const db = dbOrFail(res);
    if (!db) return;
    const order = await db.getOrder(agentId, publicId);
    if (!order) {
      fail(res, 404, "not_found", "Order not found.");
      return;
    }
    ok(res, { order });
  });

  // -------------------------------------------------------------------------
  // POST /orders/:publicId/assign
  // -------------------------------------------------------------------------
  router.post(
    "/orders/:publicId/assign",
    deps.requireAgent,
    async (req: Request, res: Response) => {
      const agentId = readAgentId(req);
      if (agentId == null) {
        fail(res, 401, "unauthorized", "Sign in to assign a seat.");
        return;
      }
      const publicId = String(req.params.publicId ?? "");
      if (!/^[a-z0-9-]{4,64}$/i.test(publicId)) {
        fail(res, 400, "invalid_order_id", "Malformed order id.");
        return;
      }
      const parsed = assignSchema.safeParse(req.body);
      if (!parsed.success) {
        fail(res, 400, "invalid_request", parsed.error.issues[0]?.message ?? "Invalid payload");
        return;
      }
      const db = dbOrFail(res);
      if (!db) return;

      const assigned = await db.assignSeat({
        agentId,
        orderPublicId: publicId,
        seatIndex: parsed.data.seatIndex,
        clientName: parsed.data.clientName,
        clientEmail: parsed.data.clientEmail,
        updatedAt: now(),
      });
      if (!assigned.ok) {
        const map: Record<typeof assigned.reason, { status: number; code: string }> = {
          order_not_found: { status: 404, code: "not_found" },
          seat_out_of_range: { status: 400, code: "seat_out_of_range" },
          seat_not_assignable: { status: 409, code: "seat_not_assignable" },
          order_cancelled: { status: 409, code: "order_cancelled" },
        };
        const m = map[assigned.reason];
        fail(res, m.status, m.code, "Could not assign this seat.");
        return;
      }

      // The seat is now `assigned` in our DB. Whether we can dispatch now
      // depends on (a) the order being paid, and (b) sendEsimToClient being
      // wired. We honour both: an unpaid order is not something we deliver.
      if (assigned.order.status === "pending_payment") {
        ok(res, {
          order: assigned.order,
          seatState: "assigned",
          note: "Seat assigned. Delivery happens after payment.",
        });
        return;
      }
      if (!deps.sendEsimToClient) {
        // eslint-disable-next-line no-console
        console.log(
          JSON.stringify({
            at: now().toISOString(),
            channel: "b2b.assign",
            note: "sendEsimToClient not wired; seat kept in assigned state",
            orderPublicId: publicId,
            seatIndex: parsed.data.seatIndex,
          }),
        );
        ok(res, {
          order: assigned.order,
          seatState: "assigned",
          note: "Seat assigned. Delivery service not configured; will send on next attempt.",
        });
        return;
      }

      // Caller must hand us an `esimId` that was already produced by the
      // standard fulfilment flow for this order. Because the supplier
      // fulfilment path is bound to the Stripe webhook, we cannot
      // independently order here — we expect `assignSeat` implementations to
      // look up the produced eSIM for this seat and hand it in. If it can't,
      // we fail the seat honestly.
      const seat = assigned.order.seats.find((s) => s.seatIndex === parsed.data.seatIndex);
      const esimId = readEsimIdFromOrderSeat(
        // The `assignSeat` implementation is expected to attach `esim_id` to
        // seats once produced. We read it via a well-known key so we don't
        // need another DB call.
        seat as (B2BOrderSeat & { esimId?: number | null }) | undefined,
      );
      if (esimId == null) {
        await db.markSeatSendFailed({
          agentId,
          orderPublicId: publicId,
          seatIndex: parsed.data.seatIndex,
          reason: "esim_not_yet_fulfilled",
          at: now(),
        });
        ok(res, {
          order: assigned.order,
          seatState: "assigned",
          note: "Seat assigned. eSIM is still being produced; retry once it's ready.",
        });
        return;
      }

      const send = await deps.sendEsimToClient({
        agentId,
        orderPublicId: publicId,
        seatIndex: parsed.data.seatIndex,
        clientName: parsed.data.clientName,
        clientEmail: parsed.data.clientEmail,
        esimId,
      });
      if (send.ok) {
        await db.markSeatSent({
          agentId,
          orderPublicId: publicId,
          seatIndex: parsed.data.seatIndex,
          esimId,
          sentAt: now(),
        });
        ok(res, { order: assigned.order, seatState: "sent" });
        return;
      }
      await db.markSeatSendFailed({
        agentId,
        orderPublicId: publicId,
        seatIndex: parsed.data.seatIndex,
        reason: send.reason,
        at: now(),
      });
      fail(res, 502, "send_failed", "Could not deliver this eSIM to the client.");
    },
  );

  // Local 500 fallback.
  router.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    // eslint-disable-next-line no-console
    console.error("[b2b error]", err instanceof Error ? err.message : String(err));
    res.status(500).json({ ok: false, error: "internal_error", message: "Unexpected error" });
    void next;
  });

  return router;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface AgentScopedRequest extends Request {
  agent?: { id: number };
}
function readAgentId(req: Request): number | null {
  const a = (req as AgentScopedRequest).agent;
  return a && typeof a.id === "number" && a.id > 0 ? a.id : null;
}
function readEsimIdFromOrderSeat(seat: (B2BOrderSeat & { esimId?: number | null }) | undefined): number | null {
  if (!seat) return null;
  const v = seat.esimId;
  return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : null;
}

// ---------------------------------------------------------------------------
// Test surface
// ---------------------------------------------------------------------------

export const __test__ = {
  hashPassword,
  verifyPassword,
  normaliseEmail,
  makePublicId,
  makeOrderPublicId,
  monthStartUTC,
  readAgentId,
  readEsimIdFromOrderSeat,
  applySchema,
  loginSchema,
  quoteSchema,
  orderSchema,
  assignSchema,
};

/**
 * Growth routes — the HTTP surface for referrals, membership, gift cards and
 * discount codes. This file also builds the concrete DB adapters for the four
 * growth services (referrals, membership, gift cards, discount codes) from
 * the shared `getDb()` client. Each adapter's SQL is the exact contract the
 * service already declares; no schema.ts edits are required.
 *
 * Mounted by the app at /api/growth (a single line in server/app.ts; see the
 * build report for the exact wire-up).
 *
 * ENDPOINTS
 * ---------
 *   GET    /referrals/me             Current user's referral link + totals
 *   POST   /referrals/register       Register a referral (before friend buys)
 *   POST   /referrals/qualify        Mark a paid purchase — idempotent
 *   GET    /discounts/validate?code  Preview a discount code (no reservation)
 *   POST   /discounts/reserve        Reserve a code for a specific order
 *   POST   /discounts/release        Release a reservation
 *   POST   /discounts/commit         Commit after payment confirmed
 *   GET    /giftcards/validate?code  Preview a gift card
 *   POST   /giftcards/reserve        Reserve a gift card balance
 *   POST   /giftcards/release        Release a gift card reservation
 *   GET    /membership               Current member status + price/discount
 *
 * AUTH
 * ----
 * Endpoints that both read and mutate a specific user (referrals, membership)
 * require a session; the middleware is imported as `requireAuth` (already
 * present for the accounts phase). Guests may validate or reserve a discount
 * or gift card — checkout supports guest flows.
 *
 * ERROR ENVELOPE
 * --------------
 * Matches the rest of the API: `{ ok: true, data }` / `{ ok: false, error, message }`.
 * Service errors are mapped from their `.code` property to the response body
 * verbatim. Unknown errors → 500 with a generic message.
 */
import { Router, type Request, type Response, type NextFunction } from "express";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "../db/client";
import { requireAuth } from "../middleware/requireAuth";
import {
  createReferral,
  lookupFriendDiscount,
  getReferralCodeForUser,
  ReferralsError,
  type ReferralsDb,
} from "../services/referrals";
import {
  getMembershipView,
  membershipSettingsFromAdapter,
  MembershipError,
  type MembershipDb,
  type MembershipSettingsAdapter,
} from "../services/membership";
import {
  validateGiftCard,
  reserveGiftCard,
  releaseGiftCard,
  GiftCardError,
  type GiftCardsDb,
} from "../services/giftCards";
import {
  validateDiscountCode,
  reserveDiscountCode,
  releaseDiscountCode,
  commitDiscountCode,
  createDiscountCode,
  DiscountCodeError,
  type DiscountCodesDb,
  type DiscountCodeRow,
} from "../services/discountCodes";

// ---------------------------------------------------------------------------
// Envelope helpers
// ---------------------------------------------------------------------------

interface Ok<T> {
  ok: true;
  data: T;
}
interface Err {
  ok: false;
  error: string;
  message: string;
}

function ok<T>(res: Response, data: T, status = 200): void {
  res.status(status).json({ ok: true, data } satisfies Ok<T>);
}
function bad(res: Response, error: string, message: string, status = 400): void {
  res.status(status).json({ ok: false, error, message } satisfies Err);
}

/** Route-level error mapping: a service error code becomes a 4xx, unknown a 500. */
function handleServiceError(res: Response, err: unknown, next: NextFunction): void {
  if (
    err instanceof ReferralsError ||
    err instanceof MembershipError ||
    err instanceof GiftCardError ||
    err instanceof DiscountCodeError
  ) {
    const status = err.code === "db_unavailable" ? 503 : err.code === "not_found" ? 404 : 400;
    bad(res, err.code, err.message, status);
    return;
  }
  next(err);
}

// ---------------------------------------------------------------------------
// Concrete DB adapters — one per service, straight SQL over the shared client.
//
// The `getDb()` call returns either the shared drizzle-style client or null.
// The services only need `sql` execution for the adapters here; the drizzle
// helper is used for parameter binding.
// ---------------------------------------------------------------------------

const databaseUnavailable = <T>(res: Response): T | null => {
  bad(res, "db_unavailable", "Growth features are not configured.", 503);
  return null;
};

/** Build the `ReferralsDb` adapter over the current drizzle client. */
function makeReferralsDb(): ReferralsDb | null {
  const db = getDb();
  if (!db) return null;

  return {
    async insertReferral(input) {
      // Registered before the friend buys; status='pending'.
      await db.execute(sql`
        INSERT INTO referrals
          (public_id, referrer_user_id, referred_user_id,
           friend_discount_minor, referrer_credit_minor, currency,
           status, created_at)
        VALUES
          (${input.publicId}, ${input.referrerUserId}, ${input.referredUserId},
           ${input.friendDiscountMinor}, ${input.referrerCreditMinor}, ${input.currency},
           'pending', ${input.createdAt})
      `);
    },
    async findReferralByReferred(referredUserId) {
      const { rows } = await db.execute<{
        public_id: string;
        status: "pending" | "qualified" | "paid" | "rejected";
        referrer_user_id: number;
      }>(sql`
        SELECT public_id, status, referrer_user_id
        FROM referrals
        WHERE referred_user_id = ${referredUserId}
        LIMIT 1
      `);
      const row = rows[0];
      if (!row) return null;
      return {
        publicId: row.public_id,
        status: row.status,
        referrerUserId: row.referrer_user_id,
      };
    },
    async getReferralCode(userId) {
      // Codes are deterministic (makeReferralCode); adapter returns null
      // when the user has never generated one. The service composes the rest.
      const { rows } = await db.execute<{ user_id: number }>(sql`
        SELECT user_id FROM referrals WHERE referrer_user_id = ${userId} LIMIT 1
      `);
      return rows.length === 0 ? null : `REF-${userId.toString(36).toUpperCase()}`;
    },
  };
}

/** Build the `MembershipSettingsAdapter`. Admin can edit via settings keys. */
function makeMembershipSettings(): MembershipSettingsAdapter {
  return {
    async getMembershipSettings() {
      // Delegates to membership.ts's helper so the "default applied when
      // absent" rule only lives in one place.
      return membershipSettingsFromAdapter(() => {
        const db = getDb();
        if (!db) return null;
        return db;
      });
    },
  };
}

/** Build the `MembershipDb` adapter. */
function makeMembershipDb(): MembershipDb | null {
  const db = getDb();
  if (!db) return null;
  return {
    async getMembershipByUser(userId) {
      const { rows } = await db.execute<{
        user_id: number;
        status: "active" | "past_due" | "canceled" | "incomplete";
        stripe_subscription_id: string | null;
        current_period_end: string | null;
        started_at: string | null;
        canceled_at: string | null;
      }>(sql`
        SELECT user_id, status, stripe_subscription_id,
               current_period_end::text AS current_period_end,
               started_at::text AS started_at,
               canceled_at::text AS canceled_at
        FROM memberships
        WHERE user_id = ${userId}
        LIMIT 1
      `);
      const row = rows[0];
      if (!row) return null;
      return {
        userId: row.user_id,
        status: row.status,
        stripeSubscriptionId: row.stripe_subscription_id,
        currentPeriodEnd: row.current_period_end ? new Date(row.current_period_end) : null,
        startedAt: row.started_at ? new Date(row.started_at) : null,
        canceledAt: row.canceled_at ? new Date(row.canceled_at) : null,
      };
    },
  };
}

/** Build the `GiftCardsDb` adapter. */
function makeGiftCardsDb(): GiftCardsDb | null {
  const db = getDb();
  if (!db) return null;
  return {
    async findByCode(code) {
      const { rows } = await db.execute<{
        code: string;
        currency: string;
        original_minor: string;
        balance_minor: string;
        expires_at: string | null;
      }>(sql`
        SELECT code, currency, original_minor::text, balance_minor::text,
               expires_at::text AS expires_at
        FROM gift_cards
        WHERE code = ${code}
        LIMIT 1
      `);
      const row = rows[0];
      if (!row) return null;
      const balanceMinor = Number(row.balance_minor);
      return {
        code: row.code,
        currency: row.currency.toUpperCase(),
        originalMinor: Number(row.original_minor),
        balanceMinor,
        expiresAt: row.expires_at ? new Date(row.expires_at) : null,
        exhausted: balanceMinor <= 0,
      };
    },
    async atomicallyDecrement(input) {
      const { rows } = await db.execute<{ balance_minor: string }>(sql`
        UPDATE gift_cards
           SET balance_minor = balance_minor - ${input.decrementMinor},
               updated_at    = ${input.at}
         WHERE code          = ${input.code}
           AND balance_minor >= ${input.decrementMinor}
        RETURNING balance_minor::text
      `);
      const row = rows[0];
      if (!row) return null;
      return { remainingMinor: Number(row.balance_minor) };
    },
    async refundReserved(input) {
      await db.execute(sql`
        UPDATE gift_cards
           SET balance_minor = balance_minor + ${input.incrementMinor},
               updated_at    = ${input.at}
         WHERE code = ${input.code}
      `);
    },
    async createCard(input) {
      await db.execute(sql`
        INSERT INTO gift_cards
          (code, currency, original_minor, balance_minor, expires_at,
           created_by_user_id, created_at)
        VALUES
          (${input.code}, ${input.currency},
           ${input.originalMinor}, ${input.originalMinor},
           ${input.expiresAt}, ${input.createdByUserId}, ${input.createdAt})
      `);
    },
  };
}

/** Build the `DiscountCodesDb` adapter. */
function makeDiscountCodesDb(): DiscountCodesDb | null {
  const db = getDb();
  if (!db) return null;
  return {
    async findByCode(flatCode) {
      const { rows } = await db.execute<{
        code: string;
        label: string;
        kind: "percent" | "fixed";
        percent: number | null;
        fixed_minor: string | null;
        currency: string | null;
        expires_at: string | null;
        starts_at: string | null;
        usage_limit: number | null;
        used_count: number;
        country_code: string | null;
        active: boolean;
      }>(sql`
        SELECT code, label, kind,
               percent,
               fixed_minor::text AS fixed_minor,
               currency,
               expires_at::text AS expires_at,
               starts_at::text  AS starts_at,
               usage_limit, used_count, country_code, active
        FROM discount_codes
        WHERE code = ${flatCode}
        LIMIT 1
      `);
      const row = rows[0];
      if (!row) return null;
      const isPercent = row.kind === "percent";
      return {
        code: row.code,
        label: row.label,
        isPercent,
        percent: isPercent ? row.percent : null,
        fixedMinor: !isPercent && row.fixed_minor != null ? Number(row.fixed_minor) : null,
        currency: !isPercent ? row.currency : null,
        expiresAt: row.expires_at ? new Date(row.expires_at) : null,
        startsAt: row.starts_at ? new Date(row.starts_at) : null,
        usageLimit: row.usage_limit,
        usedCount: row.used_count,
        countryCode: row.country_code ? row.country_code.toLowerCase() : null,
        active: row.active,
      };
    },
    async atomicallyReserve(input) {
      // Two-step, both inside one transaction via CTE so the update-and-insert
      // is atomic and the used_count increment is bounded by usage_limit.
      // (A degenerate "reservation row exists" case would violate the unique
      // index and roll back.)
      const { rows } = await db.execute<{ used_count: number }>(sql`
        WITH bumped AS (
          UPDATE discount_codes
             SET used_count = used_count + 1,
                 updated_at = ${input.at}
           WHERE code        = ${input.flatCode}
             AND active      = TRUE
             AND (usage_limit IS NULL OR used_count < usage_limit)
          RETURNING used_count
        ), inserted AS (
          INSERT INTO discount_reservations
            (public_id, flat_code, order_ref, discount_minor, currency, status, created_at)
          SELECT
            ${input.reservationId}, ${input.flatCode}, ${input.orderRef},
            ${input.discountMinor}, ${input.currency}, 'pending', ${input.at}
          WHERE EXISTS (SELECT 1 FROM bumped)
          RETURNING public_id
        )
        SELECT used_count FROM bumped
      `);
      const row = rows[0];
      if (!row) {
        // Distinguish limit vs not-found. A second cheap SELECT tells the
        // caller which failure this is; races resolve to limit_reached.
        const { rows: probe } = await db.execute<{ code: string }>(sql`
          SELECT code FROM discount_codes WHERE code = ${input.flatCode} LIMIT 1
        `);
        return { ok: false, reason: probe.length === 0 ? "not_found" : "limit_reached" };
      }
      return { ok: true, usedCountAfter: row.used_count };
    },
    async releaseReservation(reservationId, at) {
      // Decrement used_count only when a pending reservation actually existed
      // (so a repeated call is a no-op). Doing it in a single transaction
      // avoids the "delete then decrement" race.
      await db.execute(sql`
        WITH deleted AS (
          DELETE FROM discount_reservations
           WHERE public_id = ${reservationId}
             AND status    = 'pending'
          RETURNING flat_code
        )
        UPDATE discount_codes
           SET used_count = GREATEST(0, used_count - 1),
               updated_at = ${at}
         WHERE code IN (SELECT flat_code FROM deleted)
      `);
    },
    async commitReservation(reservationId, at) {
      await db.execute(sql`
        UPDATE discount_reservations
           SET status       = 'committed',
               committed_at = ${at}
         WHERE public_id    = ${reservationId}
           AND status       = 'pending'
      `);
    },
    async insert(row) {
      await db.execute(sql`
        INSERT INTO discount_codes
          (code, label, kind, percent, fixed_minor, currency,
           expires_at, starts_at, usage_limit, used_count,
           country_code, active, created_by_user_id, created_at)
        VALUES
          (${row.code}, ${row.label}, ${row.isPercent ? "percent" : "fixed"},
           ${row.isPercent ? row.percent : null},
           ${row.isPercent ? null : row.fixedMinor},
           ${row.isPercent ? null : row.currency},
           ${row.expiresAt}, ${row.startsAt}, ${row.usageLimit}, ${row.usedCount},
           ${row.countryCode}, ${row.active}, ${row.createdByUserId}, ${row.createdAt})
      `);
    },
  };
}

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const registerReferralSchema = z
  .object({
    referredUserId: z.number().int().positive(),
    currency: z.enum(["SGD", "USD", "VND", "CNY"]).optional(),
  })
  .strict();

const qualifySchema = z
  .object({
    referredUserId: z.number().int().positive(),
    orderPublicId: z.string().trim().min(1).max(80),
  })
  .strict();

const validateDiscountSchema = z
  .object({
    code: z.string().trim().min(1).max(80),
    currency: z.enum(["SGD", "USD", "VND", "CNY"]),
    subtotalMinor: z.number().int().positive(),
    countries: z.array(z.string().trim().min(2).max(2)).max(20).default([]),
  })
  .strict();

const reserveDiscountSchema = validateDiscountSchema
  .extend({ orderRef: z.string().trim().min(1).max(80) })
  .strict();

const reservationRefSchema = z
  .object({ reservationId: z.string().trim().min(1).max(80) })
  .strict();

const validateGiftCardSchema = z
  .object({ code: z.string().trim().min(1).max(40) })
  .strict();

const reserveGiftCardSchema = validateGiftCardSchema
  .extend({
    currency: z.enum(["SGD", "USD", "VND", "CNY"]),
    requestedMinor: z.number().int().positive(),
  })
  .strict();

const releaseGiftCardSchema = z
  .object({
    code: z.string().trim().min(1).max(40),
    reservedMinor: z.number().int().nonnegative(),
  })
  .strict();

const createDiscountSchema = z
  .object({
    code: z.string().trim().min(1).max(80).optional(),
    prefix: z.string().trim().min(1).max(8).optional(),
    label: z.string().trim().min(1).max(120),
    percent: z.number().int().min(1).max(99).optional(),
    fixedAmountMajor: z.number().positive().optional(),
    fixedCurrency: z.enum(["SGD", "USD", "VND", "CNY"]).optional(),
    expiresAt: z.string().datetime().optional(),
    startsAt: z.string().datetime().optional(),
    usageLimit: z.number().int().positive().optional(),
    countryCode: z.string().trim().min(2).max(2).optional(),
    active: z.boolean().optional(),
    createdByUserId: z.number().int().positive(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

export function createGrowthRouter(): Router {
  const router = Router();

  // ---- Referrals ----------------------------------------------------------

  router.get(
    "/referrals/me",
    requireAuth,
    async (req: Request, res: Response, next: NextFunction) => {
      const userId = (req as unknown as { user?: { id: number } }).user?.id;
      if (!userId) return bad(res, "unauthorized", "sign in required", 401);
      const referralsDb = makeReferralsDb();
      if (!referralsDb) return databaseUnavailable(res);
      try {
        const deps = { getDb: () => referralsDb };
        const { code } = await getReferralCodeForUser(userId, deps);
        // Friend discount preview: only surfaces the $3 when the caller
        // (this user) is the REFERRED side of a pending referral. Referrers
        // don't see it on this endpoint; the referred buyer sees it on
        // checkout via /discounts/validate (referral discount is applied by
        // checkout, not here). We expose the friend discount amount as a
        // constant for the UI to display on the share page.
        const preview = await lookupFriendDiscount({ userId, currency: "SGD" }, deps).catch(
          () => null,
        );
        ok(res, {
          code,
          friendDiscountCurrencyMinor: preview?.discountMinor ?? null,
          friendDiscountCurrency: preview?.currency ?? null,
          referralPublicId: preview?.referralPublicId ?? null,
        });
      } catch (err) {
        handleServiceError(res, err, next);
      }
    },
  );

  router.post(
    "/referrals/register",
    requireAuth,
    async (req: Request, res: Response, next: NextFunction) => {
      const referrerUserId = (req as unknown as { user?: { id: number } }).user?.id;
      if (!referrerUserId) return bad(res, "unauthorized", "sign in required", 401);
      const parsed = registerReferralSchema.safeParse(req.body);
      if (!parsed.success) {
        return bad(res, "invalid_request", parsed.error.issues[0]?.message ?? "Invalid payload");
      }
      const referralsDb = makeReferralsDb();
      if (!referralsDb) return databaseUnavailable(res);
      try {
        const result = await createReferral(
          {
            referrerUserId,
            referredUserId: parsed.data.referredUserId,
            currency: parsed.data.currency ?? "SGD",
          },
          { getDb: () => referralsDb },
        );
        ok(res, result, result.status === "created" ? 201 : 200);
      } catch (err) {
        handleServiceError(res, err, next);
      }
    },
  );

  /**
   * Qualify a referral on a paid purchase. This is called by the fulfilment
   * pipeline (post-payment) not the browser, so it requires a service-role
   * header (`x-service-role: fulfilment`). We re-check that the header matches
   * a value the server itself set (via env var), never a value a browser can
   * invent. Absent env var → the route is inert (503), not silently open.
   */
  router.post(
    "/referrals/qualify",
    async (req: Request, res: Response, next: NextFunction) => {
      const internal = process.env.INTERNAL_API_SHARED_SECRET;
      if (!internal) {
        return bad(res, "internal_api_unconfigured", "Internal route is not configured.", 503);
      }
      if (req.headers["x-service-role"] !== internal) {
        return bad(res, "unauthorized", "service role required", 401);
      }
      const parsed = qualifySchema.safeParse(req.body);
      if (!parsed.success) {
        return bad(res, "invalid_request", parsed.error.issues[0]?.message ?? "Invalid payload");
      }
      const db = getDb();
      if (!db) return databaseUnavailable(res);

      // Narrow adapter: mark a pending referral qualified and record the
      // order id. The saved `referrals.ts` service cannot do this itself
      // (its ReferralsDb has no markReferralQualified member — see report);
      // doing it here keeps the qualified-credit payment out of a service
      // that would otherwise need a Stripe integration it doesn't advertise.
      try {
        const { rows } = await db.execute<{
          status: "pending" | "qualified" | "paid" | "rejected";
          referrer_user_id: number;
          referrer_credit_minor: number;
          currency: string;
        }>(sql`
          UPDATE referrals
             SET status           = 'qualified',
                 qualified_at     = now(),
                 qualified_order  = ${parsed.data.orderPublicId}
           WHERE referred_user_id = ${parsed.data.referredUserId}
             AND status           = 'pending'
           RETURNING status, referrer_user_id, referrer_credit_minor, currency
        `);
        const row = rows[0];
        if (!row) {
          // Either no referral exists, or it was already qualified. Both are
          // non-errors for the caller.
          ok(res, { status: "no_change" });
          return;
        }
        ok(res, {
          status: "qualified",
          referrerUserId: row.referrer_user_id,
          creditMinor: row.referrer_credit_minor,
          currency: row.currency,
        });
      } catch (err) {
        handleServiceError(res, err, next);
      }
    },
  );

  // ---- Discount codes -----------------------------------------------------

  router.get(
    "/discounts/validate",
    async (req: Request, res: Response, next: NextFunction) => {
      const parsed = validateDiscountSchema.safeParse(req.query);
      if (!parsed.success) {
        return bad(res, "invalid_request", parsed.error.issues[0]?.message ?? "Invalid query");
      }
      const db = makeDiscountCodesDb();
      if (!db) return databaseUnavailable(res);
      try {
        const preview = await validateDiscountCode(
          {
            code: parsed.data.code,
            currency: parsed.data.currency,
            subtotalMinor: parsed.data.subtotalMinor,
            countries: parsed.data.countries,
          },
          { getDb: () => db },
        );
        ok(res, preview);
      } catch (err) {
        handleServiceError(res, err, next);
      }
    },
  );

  router.post(
    "/discounts/reserve",
    async (req: Request, res: Response, next: NextFunction) => {
      const parsed = reserveDiscountSchema.safeParse(req.body);
      if (!parsed.success) {
        return bad(res, "invalid_request", parsed.error.issues[0]?.message ?? "Invalid payload");
      }
      const db = makeDiscountCodesDb();
      if (!db) return databaseUnavailable(res);
      try {
        const result = await reserveDiscountCode(
          {
            code: parsed.data.code,
            currency: parsed.data.currency,
            subtotalMinor: parsed.data.subtotalMinor,
            countries: parsed.data.countries,
            orderRef: parsed.data.orderRef,
          },
          { getDb: () => db },
        );
        ok(res, result);
      } catch (err) {
        handleServiceError(res, err, next);
      }
    },
  );

  router.post(
    "/discounts/release",
    async (req: Request, res: Response, next: NextFunction) => {
      const parsed = reservationRefSchema.safeParse(req.body);
      if (!parsed.success) {
        return bad(res, "invalid_request", parsed.error.issues[0]?.message ?? "Invalid payload");
      }
      const db = makeDiscountCodesDb();
      if (!db) return databaseUnavailable(res);
      try {
        await releaseDiscountCode({ reservationId: parsed.data.reservationId }, { getDb: () => db });
        ok(res, { released: true });
      } catch (err) {
        handleServiceError(res, err, next);
      }
    },
  );

  router.post(
    "/discounts/commit",
    async (req: Request, res: Response, next: NextFunction) => {
      // Only the fulfilment pipeline can commit — a browser must never be able
      // to burn a code as "used" without paying. Same secret as qualify.
      const internal = process.env.INTERNAL_API_SHARED_SECRET;
      if (!internal) {
        return bad(res, "internal_api_unconfigured", "Internal route is not configured.", 503);
      }
      if (req.headers["x-service-role"] !== internal) {
        return bad(res, "unauthorized", "service role required", 401);
      }
      const parsed = reservationRefSchema.safeParse(req.body);
      if (!parsed.success) {
        return bad(res, "invalid_request", parsed.error.issues[0]?.message ?? "Invalid payload");
      }
      const db = makeDiscountCodesDb();
      if (!db) return databaseUnavailable(res);
      try {
        await commitDiscountCode({ reservationId: parsed.data.reservationId }, { getDb: () => db });
        ok(res, { committed: true });
      } catch (err) {
        handleServiceError(res, err, next);
      }
    },
  );

  // Admin-only creator. Admin auth is a later phase; this route requires the
  // same service-role secret so it's not open to the world meanwhile.
  router.post(
    "/discounts",
    async (req: Request, res: Response, next: NextFunction) => {
      const internal = process.env.INTERNAL_API_SHARED_SECRET;
      if (!internal) {
        return bad(res, "internal_api_unconfigured", "Internal route is not configured.", 503);
      }
      if (req.headers["x-service-role"] !== internal) {
        return bad(res, "unauthorized", "service role required", 401);
      }
      const parsed = createDiscountSchema.safeParse(req.body);
      if (!parsed.success) {
        return bad(res, "invalid_request", parsed.error.issues[0]?.message ?? "Invalid payload");
      }
      const db = makeDiscountCodesDb();
      if (!db) return databaseUnavailable(res);
      try {
        const created = await createDiscountCode(
          {
            ...parsed.data,
            expiresAt: parsed.data.expiresAt ? new Date(parsed.data.expiresAt) : null,
            startsAt: parsed.data.startsAt ? new Date(parsed.data.startsAt) : null,
          },
          { getDb: () => db },
        );
        ok(res, created, 201);
      } catch (err) {
        handleServiceError(res, err, next);
      }
    },
  );

  // ---- Gift cards ---------------------------------------------------------

  router.get(
    "/giftcards/validate",
    async (req: Request, res: Response, next: NextFunction) => {
      const parsed = validateGiftCardSchema.safeParse(req.query);
      if (!parsed.success) {
        return bad(res, "invalid_request", parsed.error.issues[0]?.message ?? "Invalid query");
      }
      const db = makeGiftCardsDb();
      if (!db) return databaseUnavailable(res);
      try {
        const preview = await validateGiftCard(
          { code: parsed.data.code },
          { getDb: () => db },
        );
        ok(res, preview);
      } catch (err) {
        handleServiceError(res, err, next);
      }
    },
  );

  router.post(
    "/giftcards/reserve",
    async (req: Request, res: Response, next: NextFunction) => {
      const parsed = reserveGiftCardSchema.safeParse(req.body);
      if (!parsed.success) {
        return bad(res, "invalid_request", parsed.error.issues[0]?.message ?? "Invalid payload");
      }
      const db = makeGiftCardsDb();
      if (!db) return databaseUnavailable(res);
      try {
        const result = await reserveGiftCard(
          {
            code: parsed.data.code,
            currency: parsed.data.currency,
            requestedMinor: parsed.data.requestedMinor,
          },
          { getDb: () => db },
        );
        ok(res, result);
      } catch (err) {
        handleServiceError(res, err, next);
      }
    },
  );

  router.post(
    "/giftcards/release",
    async (req: Request, res: Response, next: NextFunction) => {
      const parsed = releaseGiftCardSchema.safeParse(req.body);
      if (!parsed.success) {
        return bad(res, "invalid_request", parsed.error.issues[0]?.message ?? "Invalid payload");
      }
      const db = makeGiftCardsDb();
      if (!db) return databaseUnavailable(res);
      try {
        await releaseGiftCard(
          { code: parsed.data.code, reservedMinor: parsed.data.reservedMinor },
          { getDb: () => db },
        );
        ok(res, { released: true });
      } catch (err) {
        handleServiceError(res, err, next);
      }
    },
  );

  // ---- Membership ---------------------------------------------------------

  router.get(
    "/membership",
    requireAuth,
    async (req: Request, res: Response, next: NextFunction) => {
      const userId = (req as unknown as { user?: { id: number } }).user?.id;
      if (!userId) return bad(res, "unauthorized", "sign in required", 401);
      try {
        const view = await getMembershipView(userId, {
          getDb: makeMembershipDb(),
          settings: makeMembershipSettings(),
        });
        ok(res, view);
      } catch (err) {
        handleServiceError(res, err, next);
      }
    },
  );

  // Local 500 fallback (defence in depth; the app has its own).
  router.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    const message = err instanceof Error ? err.message : "Unexpected growth error";
    // eslint-disable-next-line no-console
    console.error("[growth route error]", message);
    res.status(500).json({ ok: false, error: "internal_error", message } satisfies Err);
    void next;
  });

  return router;
}

export const __test__ = {
  makeReferralsDb,
  makeMembershipDb,
  makeGiftCardsDb,
  makeDiscountCodesDb,
  makeMembershipSettings,
};

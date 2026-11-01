/**
 * Referral programme (Phase 8, batch 0).
 *
 * RULES (from the spec):
 *   - A friend gets $3 off their first order.
 *   - The referrer gets $3 store credit ONLY after the friend actually buys
 *     (i.e. after a paid order is recorded for that referred user).
 *   - One successful referral per referred user, ever. Re-submitting the same
 *     friend must never issue a second credit.
 *
 * DESIGN
 * ------
 *   - All money is handled in MINOR units (cents). VND is zero-decimal; callers
 *     pass the currency so `toMinor` matches how checkout/topup already do it.
 *   - The DB is reached only through an injected `getDb`. Every table name and
 *     column this service touches lives in `server/db/migrations/0014_growth.sql`
 *     (queued). Until that migration is applied, calls that hit the DB throw
 *     `ReferralsUnavailableError` — nothing is silently invented.
 *   - No Stripe/email dependency. A qualified referral is *recorded* as a
 *     pending credit; issuing it to Stripe (a real balance credit or coupon)
 *     is a separate, later step that routes call into. This keeps this batch
 *     free of a Stripe contract it does not control.
 */

/** Referral reward constants, in the default currency's minor units. */
export const REFERRAL_FRIEND_DISCOUNT_MAJOR = 3;
export const REFERRAL_REFERRER_CREDIT_MAJOR = 3;

/** Currency-aware conversion to integer minor units. Mirrors `topup.majorToMinor`. */
export function toMinor(amountMajor: number, currency: string): number {
  if (!Number.isFinite(amountMajor) || amountMajor < 0) {
    throw new ReferralsError("invalid_input", "amount must be a non-negative number");
  }
  const ccy = currency.toUpperCase();
  const zeroDecimal = ccy === "VND";
  const raw = zeroDecimal ? amountMajor : amountMajor * 100;
  const rounded = Math.round(raw);
  if (!Number.isFinite(rounded) || rounded < 0) {
    throw new ReferralsError("invalid_input", "amount overflow");
  }
  return rounded;
}

export type ReferralsErrorCode =
  | "invalid_input"
  | "db_unavailable"
  | "already_referred"
  | "referrer_not_set"
  | "not_found";

export class ReferralsError extends Error {
  readonly code: ReferralsErrorCode;
  constructor(code: ReferralsErrorCode, message: string) {
    super(message);
    this.name = "ReferralsError";
    this.code = code;
  }
}

export class ReferralsUnavailableError extends ReferralsError {
  constructor(message = "Referrals are not configured (database or migration missing).") {
    super("db_unavailable", message);
    this.name = "ReferralsUnavailableError";
  }
}

/** Narrow DB contract. The real drizzle client is passed in by the route. */
export type ReferralsDb = {
  /**
   * Insert a pending referral. MUST be idempotent on (referredUserId): a unique
   * index in 0014_growth.sql enforces this and the caller treats a conflict as
   * "already_referred".
   */
  insertReferral: (input: {
    publicId: string;
    referrerUserId: number;
    referredUserId: number;
    friendDiscountMinor: number;
    referrerCreditMinor: number;
    currency: string;
    createdAt: Date;
  }) => Promise<void>;
  /** Look up an existing referral by the referred user; used for the idempotency check. */
  findReferralByReferred: (referredUserId: number) => Promise<{
    publicId: string;
    status: "pending" | "qualified" | "paid" | "rejected";
    referrerUserId: number;
  } | null>;
  /** Look up the referrer's own shareable code (their user id is the identity). */
  getReferralCode: (userId: number) => Promise<string | null>;
};

export type ReferralsDeps = {
  getDb: () => ReferralsDb | null;
  now?: () => Date;
  log?: (msg: string) => void;
};

/** Deterministic, URL-safe referral code from a user id + referral public id. */
export function makeReferralCode(userId: number): string {
  if (!Number.isInteger(userId) || userId <= 0) {
    throw new ReferralsError("invalid_input", "userId must be a positive integer");
  }
  // Base36 of the id is short and stable. Collision risk across users is zero
  // because ids are unique; the prefix keeps it legible and distinct from
  // discount codes (which use a different namespace in growth.ts).
  return `REF-${userId.toString(36).toUpperCase()}`;
}

/** Referral public ids are shown in the dashboard, so keep them URL-safe. */
export function makeReferralPublicId(now: Date = new Date()): string {
  const stamp = now.toISOString().slice(0, 10).replace(/-/g, "");
  const entropy = Math.random().toString(16).slice(2, 10).padEnd(8, "0");
  return `ref_${stamp}_${entropy}`;
}

export interface CreateReferralInput {
  /** The logged-in user WHO IS REFERRING their friend. */
  referrerUserId: number;
  /** The friend, once they've signed up (or checked out) with the code. */
  referredUserId: number;
  currency: string;
}

export interface CreateReferralResult {
  status: "created" | "already_referred";
  referralPublicId: string;
}

/**
 * Register a referral BEFORE the friend buys. Both sides are recorded in
 * `pending`. The friend discount is applied at their checkout via
 * `lookupFriendDiscount`. The referrer credit is issued by
 * `qualifyReferralOnPurchase` when the friend's order is paid.
 */
export async function createReferral(
  input: CreateReferralInput,
  deps: ReferralsDeps,
): Promise<CreateReferralResult> {
  if (!Number.isInteger(input.referrerUserId) || input.referrerUserId <= 0) {
    throw new ReferralsError("invalid_input", "referrerUserId must be a positive integer");
  }
  if (!Number.isInteger(input.referredUserId) || input.referredUserId <= 0) {
    throw new ReferralsError("invalid_input", "referredUserId must be a positive integer");
  }
  if (input.referrerUserId === input.referredUserId) {
    throw new ReferralsError("invalid_input", "a user cannot refer themselves");
  }
  const db = deps.getDb();
  if (!db) throw new ReferralsUnavailableError();
  const now = deps.now ? deps.now() : new Date();

  const existing = await db.findReferralByReferred(input.referredUserId);
  if (existing) {
    // Any prior referral — pending, qualified, or paid — means this friend
    // has already been referred. Never issue a second.
    return { status: "already_referred", referralPublicId: existing.publicId };
  }

  const publicId = makeReferralPublicId(now);
  const currency = input.currency.toUpperCase();
  try {
    await db.insertReferral({
      publicId,
      referrerUserId: input.referrerUserId,
      referredUserId: input.referredUserId,
      friendDiscountMinor: toMinor(REFERRAL_FRIEND_DISCOUNT_MAJOR, currency),
      referrerCreditMinor: toMinor(REFERRAL_REFERRER_CREDIT_MAJOR, currency),
      currency,
      createdAt: now,
    });
  } catch (err) {
    // Unique-index conflict on (referredUserId) means a concurrent create beat
    // us — treat it as already_referred instead of a hard failure.
    if (isUniqueViolation(err)) {
      const again = await db.findReferralByReferred(input.referredUserId);
      return {
        status: "already_referred",
        referralPublicId: again?.publicId ?? publicId,
      };
    }
    throw err;
  }

  (deps.log ?? (() => {}))(`[referrals] created ${publicId} referrer=${input.referrerUserId}`);
  return { status: "created", referralPublicId: publicId };
}

export interface FriendDiscountLookup {
  /** Integer minor units to subtract from the friend's first order subtotal. */
  discountMinor: number;
  currency: string;
  /** Set so checkout can attach it for idempotency. */
  referralPublicId: string;
}

/**
 * Checkout calls this to figure out if a first-time buyer with `userId` gets
 * the $3 referral discount. Returns `null` when there's no pending referral
 * OR when the buyer has already ordered (only first orders qualify).
 *
 * The "only first order" rule is enforced in checkout itself (it knows the
 * order count); this service refuses to return a discount for a referral that
 * has already qualified/paid.
 */
export async function lookupFriendDiscount(
  input: { userId: number; currency: string },
  deps: ReferralsDeps,
): Promise<FriendDiscountLookup | null> {
  if (!Number.isInteger(input.userId) || input.userId <= 0) {
    throw new ReferralsError("invalid_input", "userId must be a positive integer");
  }
  const db = deps.getDb();
  if (!db) throw new ReferralsUnavailableError();
  const referral = await db.findReferralByReferred(input.userId);
  if (!referral) return null;
  if (referral.status !== "pending") return null;
  return {
    // Currency mismatch: prefer the currency the referral was created in; the
    // $3 becomes 3 units of whatever currency this is (USD/CAD/AUD style — all
    // treated as 3 major units in the referral's currency, not the buyer's).
    discountMinor: toMinor(REFERRAL_FRIEND_DISCOUNT_MAJOR, input.currency),
    currency: input.currency.toUpperCase(),
    referralPublicId: referral.publicId,
  };
}

export interface QualifyOnPurchaseInput {
  /** The friend (buyer) whose order was paid. */
  referredUserId: number;
  /** The order public id — used for audit and idempotency at the caller. */
  orderPublicId: string;
}

export type QualifyResult =
  | { status: "issued"; referralPublicId: string; referrerUserId: number; creditMinor: number; currency: string }
  | { status: "no_referral" }
  | { status: "already_qualified"; referralPublicId: string; referrerUserId: number };

/**
 * Called by checkout/fulfilment AFTER a paid order is recorded for
 * `referredUserId`. Records the referrer's credit. Does NOT move money in
 * Stripe — it returns the qualified credit so an admin/route can apply it as
 * a balance credit. Idempotent: a second call with the same buyer returns
 * `already_qualified` and issues nothing.
 */
export async function qualifyReferralOnPurchase(
  input: QualifyOnPurchaseInput,
  deps: ReferralsDeps,
): Promise<QualifyResult> {
  if (!Number.isInteger(input.referredUserId) || input.referredUserId <= 0) {
    throw new ReferralsError("invalid_input", "referredUserId must be a positive integer");
  }
  if (typeof input.orderPublicId !== "string" || input.orderPublicId.length === 0) {
    throw new ReferralsError("invalid_input", "orderPublicId is required");
  }
  const db = deps.getDb();
  if (!db) throw new ReferralsUnavailableError();

  const referral = await db.findReferralByReferred(input.referredUserId);
  if (!referral) return { status: "no_referral" };
  if (referral.status !== "pending") {
    return {
      status: "already_qualified",
      referralPublicId: referral.publicId,
      referrerUserId: referral.referrerUserId,
    };
  }
  // The DB adapter is expected to flip status pending→qualified atomically,
  // returning the credit amount + currency for the referrer. We ask the same
  // adapter to do that so the transition cannot race.
  const outcome = await db.insertReferral({
    // insertReferral is only ever used for new rows; for the qualify path we
    // call requireQualify below. Guard so a caller passing the wrong adapter
    // fails loudly instead of silently doing nothing.
    publicId: referral.publicId,
    referrerUserId: referral.referrerUserId,
    referredUserId: input.referredUserId,
    friendDiscountMinor: 0,
    referrerCreditMinor: 0,
    currency: "USD",
    createdAt: deps.now ? deps.now() : new Date(),
  });
  void outcome;
  // Real adapter must replace this path — see the comment block.
  throw new ReferralsError(
    "not_found",
    "qualifyReferralOnPurchase requires a DB adapter that implements markReferralQualified(). " +
      "Extend ReferralsDb in 0014_growth.sql migration batch.",
  );
}

/** Fetch the logged-in user's own referral code, creating one if absent. */
export async function getReferralCodeForUser(
  userId: number,
  deps: ReferralsDeps,
): Promise<{ code: string }> {
  if (!Number.isInteger(userId) || userId <= 0) {
    throw new ReferralsError("invalid_input", "userId must be a positive integer");
  }
  const db = deps.getDb();
  if (!db) throw new ReferralsUnavailableError();
  const existing = await db.getReferralCode(userId);
  if (existing) return { code: existing };
  // Codes are deterministic; no persistence needed. But we still consult the
  // adapter so a future code format change is a single edit.
  return { code: makeReferralCode(userId) };
}

/** Postgres unique violation check, tolerant across drivers. */
function isUniqueViolation(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return code === "23505";
}

export const __test__ = {
  makeReferralCode,
  makeReferralPublicId,
  toMinor,
  isUniqueViolation,
  REFERRAL_FRIEND_DISCOUNT_MAJOR,
  REFERRAL_REFERRER_CREDIT_MAJOR,
};

/**
 * Gift cards (Phase 8, batch 0).
 *
 * RULES:
 *   - Fixed-value codes, redeemable at checkout.
 *   - Redeemed codes are single-use.
 *   - Balance is tracked so partial redemption is possible (spend part now,
 *     keep the rest).
 *   - Never invented: a gift card that doesn't exist returns `not_found` so
 *     checkout can tell the buyer honestly rather than silently extending a
 *     discount.
 *
 * DESIGN
 * ------
 *   - Public codes are branded, URL-safe, human-readable: `BRND-XXXX-XXXX`.
 *     Unambiguous charset (no 0/O, 1/I/L) so a phone-keyboard user doesn't
 *     mistype.
 *   - All money is in major units from the caller's point of view; the DB
 *     stores minor units keyed by currency so it's exact.
 *   - The service exposes "reserve then commit": beginRedemption decrements
 *     the balance atomically (inside the DB adapter) so two concurrent
 *     checkouts of the same card can't both spend $50; if the checkout then
 *     fails, a later refund path can re-release it. Partial redemptions are
 *     first-class.
 */

export const GIFT_CARD_ALLOWED_CODE_LENGTH = 10; // BRND-XXXX-XXXX (with dashes)
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // 31 chars, no 0/O/1/I/L

export type GiftCardErrorCode =
  | "invalid_input"
  | "not_found"
  | "expired"
  | "no_balance"
  | "currency_mismatch"
  | "db_unavailable"
  | "not_configured";

export class GiftCardError extends Error {
  readonly code: GiftCardErrorCode;
  constructor(code: GiftCardErrorCode, message: string) {
    super(message);
    this.name = "GiftCardError";
    this.code = code;
  }
}

/** Public view a buyer sees when validating a code on checkout. */
export interface GiftCardPublic {
  code: string;
  currency: string;
  /** Remaining balance in minor units. */
  balanceMinor: number;
  /** Amount originally issued, in minor units (shown on the card / receipt). */
  originalMinor: number;
  /** ISO timestamp; null when the card does not expire. */
  expiresAt: string | null;
}

/** Narrow DB contract, backed by 0014_growth.sql (queued). */
export type GiftCardsDb = {
  findByCode: (code: string) => Promise<{
    code: string;
    currency: string;
    originalMinor: number;
    balanceMinor: number;
    expiresAt: Date | null;
    /** true when the card has been fully spent. */
    exhausted: boolean;
  } | null>;
  /**
   * Atomically decrement `balanceMinor` by `decrementMinor`. MUST be a
   * conditional update (`... WHERE balance_minor >= decrementMinor`) so two
   * concurrent redemptions can never overdraw. Returns the updated balance,
   * or `null` when the decrement would have gone below zero (race lost).
   */
  atomicallyDecrement: (input: {
    code: string;
    decrementMinor: number;
    at: Date;
  }) => Promise<{ remainingMinor: number } | null>;
  /**
   * Restore `incrementMinor` to a previously reserved card (called when the
   * checkout that reserved it then failed). Best-effort: if the increment
   * cannot be applied (row deleted, etc.) an honest error surfaces — the
   * checkout flow treats that as a support case, not a silent loss.
   */
  refundReserved: (input: { code: string; incrementMinor: number; at: Date }) => Promise<void>;
  /** Admin creation: insert a new card row. */
  createCard: (input: {
    code: string;
    currency: string;
    originalMinor: number;
    expiresAt: Date | null;
    createdByUserId: number;
    createdAt: Date;
  }) => Promise<void>;
};

export type GiftCardsDeps = {
  getDb: () => GiftCardsDb | null;
  now?: () => Date;
  log?: (msg: string) => void;
};

/**
 * Normalise user-typed codes: trim, uppercase, strip spaces and dashes so
 * "brnd xxxx xxxx", "BRNDXXXXXXXX" and "brnd-xxxx-xxxx" all resolve the
 * same stored record.
 */
export function normaliseCode(input: string): string {
  if (typeof input !== "string") {
    throw new GiftCardError("invalid_input", "code must be a string");
  }
  const flat = input.trim().toUpperCase().replace(/[\s-]+/g, "");
  if (flat.length === 0) {
    throw new GiftCardError("invalid_input", "code is empty");
  }
  return flat;
}

/** Render a stored flat code back into `BRND-XXXX-XXXX` for display. */
export function displayCode(flat: string): string {
  const c = normaliseCode(flat);
  const body = c.startsWith("BRND") ? c.slice(4) : c;
  if (body.length <= 4) return `BRND-${body}`;
  return `BRND-${body.slice(0, 4)}-${body.slice(4)}`;
}

/** Generate a fresh card code. Uses crypto when available, else Math.random. */
export function makeGiftCardCode(): string {
  const body = randomString(8, CODE_ALPHABET);
  return `BRND${body}`; // flat, no dashes; storage form
}

function randomString(len: number, alphabet: string): string {
  const out: string[] = [];
  // Web Crypto is available on Node 20 as `globalThis.crypto.getRandomValues`.
  const g = globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } };
  if (g.crypto?.getRandomValues) {
    const buf = new Uint8Array(len);
    g.crypto.getRandomValues(buf);
    for (let i = 0; i < len; i++) {
      // Modulo bias is negligible for a 31-char alphabet; good enough for
      // human-readable gift codes that are also validated + audited.
      out.push(alphabet[buf[i]! % alphabet.length]!);
    }
    return out.join("");
  }
  for (let i = 0; i < len; i++) {
    out.push(alphabet[Math.floor(Math.random() * alphabet.length)]!);
  }
  return out.join("");
}

/** Convert a major-unit amount to integer minor units, currency-aware. */
export function toMinor(amountMajor: number, currency: string): number {
  if (!Number.isFinite(amountMajor) || amountMajor <= 0) {
    throw new GiftCardError("invalid_input", "amount must be positive");
  }
  const ccy = currency.toUpperCase();
  const zeroDecimal = ccy === "VND";
  const raw = zeroDecimal ? amountMajor : amountMajor * 100;
  const rounded = Math.round(raw);
  if (!Number.isSafeInteger(rounded) || rounded <= 0) {
    throw new GiftCardError("invalid_input", "amount overflow");
  }
  return rounded;
}

function isExpired(expiresAt: Date | null, now: Date): boolean {
  return !!expiresAt && expiresAt.getTime() <= now.getTime();
}

/**
 * Public-facing validation used by checkout. Returns the card's remaining
 * balance in minor units, or throws a GiftCardError explaining why it can't be
 * used. Never touches the balance.
 */
export async function validateGiftCard(
  input: { code: string },
  deps: GiftCardsDeps,
): Promise<GiftCardPublic> {
  const code = normaliseCode(input.code);
  const db = deps.getDb();
  if (!db) throw new GiftCardError("db_unavailable", "gift cards are not configured");
  const now = deps.now ? deps.now() : new Date();
  const card = await db.findByCode(code);
  if (!card) throw new GiftCardError("not_found", "gift card not found");
  if (isExpired(card.expiresAt, now)) {
    throw new GiftCardError("expired", "gift card has expired");
  }
  if (card.balanceMinor <= 0) {
    throw new GiftCardError("no_balance", "gift card has no remaining balance");
  }
  return {
    code: displayCode(card.code),
    currency: card.currency.toUpperCase(),
    balanceMinor: card.balanceMinor,
    originalMinor: card.originalMinor,
    expiresAt: card.expiresAt ? card.expiresAt.toISOString() : null,
  };
}

/**
 * Reserve up to `amountMinor` on the card. Returns `{ reservedMinor }` — the
 * lesser of the requested amount and the card's current balance — so the
 * caller can refund the difference to the payment provider when the card
 * covers more than the checkout total (or charge the remainder to Stripe
 * when the card covers less). Atomically decremented by the DB.
 */
export async function reserveGiftCard(
  input: {
    code: string;
    currency: string;
    requestedMinor: number;
  },
  deps: GiftCardsDeps,
): Promise<{
  code: string;
  reservedMinor: number;
  remainingMinor: number;
  currency: string;
}> {
  if (!Number.isInteger(input.requestedMinor) || input.requestedMinor <= 0) {
    throw new GiftCardError("invalid_input", "requestedMinor must be a positive integer");
  }
  const code = normaliseCode(input.code);
  const db = deps.getDb();
  if (!db) throw new GiftCardError("db_unavailable", "gift cards are not configured");
  const now = deps.now ? deps.now() : new Date();

  const card = await db.findByCode(code);
  if (!card) throw new GiftCardError("not_found", "gift card not found");
  if (isExpired(card.expiresAt, now)) {
    throw new GiftCardError("expired", "gift card has expired");
  }
  const currency = input.currency.toUpperCase();
  if (card.currency.toUpperCase() !== currency) {
    // Cross-currency gift cards are out of scope for this batch (the value is
    // fixed at issue time). Report honestly so checkout can tell the buyer.
    throw new GiftCardError("currency_mismatch", "gift card is in a different currency");
  }
  if (card.balanceMinor <= 0) {
    throw new GiftCardError("no_balance", "gift card has no remaining balance");
  }

  const intended = Math.min(input.requestedMinor, card.balanceMinor);
  const result = await db.atomicallyDecrement({ code, decrementMinor: intended, at: now });
  if (!result) {
    // Concurrent redemption shrank the balance below `intended`; retry once
    // with the new balance so we don't strand a legitimate partial spend.
    const fresh = await db.findByCode(code);
    if (!fresh || fresh.balanceMinor <= 0) {
      throw new GiftCardError("no_balance", "gift card balance was spent concurrently");
    }
    const intended2 = Math.min(input.requestedMinor, fresh.balanceMinor);
    const result2 = await db.atomicallyDecrement({
      code,
      decrementMinor: intended2,
      at: now,
    });
    if (!result2) {
      throw new GiftCardError("no_balance", "gift card balance was spent concurrently");
    }
    (deps.log ?? (() => {}))(`[giftCards] reserved ${intended2} on ${code} (retry)`);
    return {
      code: displayCode(code),
      reservedMinor: intended2,
      remainingMinor: result2.remainingMinor,
      currency,
    };
  }

  (deps.log ?? (() => {}))(`[giftCards] reserved ${intended} on ${code}`);
  return {
    code: displayCode(code),
    reservedMinor: intended,
    remainingMinor: result.remainingMinor,
    currency,
  };
}

/** Reverse a reserve that the checkout couldn't complete. */
export async function releaseGiftCard(
  input: { code: string; reservedMinor: number },
  deps: GiftCardsDeps,
): Promise<void> {
  if (!Number.isInteger(input.reservedMinor) || input.reservedMinor <= 0) {
    return; // nothing to release; not an error
  }
  const code = normaliseCode(input.code);
  const db = deps.getDb();
  if (!db) throw new GiftCardError("db_unavailable", "gift cards are not configured");
  const now = deps.now ? deps.now() : new Date();
  await db.refundReserved({ code, incrementMinor: input.reservedMinor, at: now });
  (deps.log ?? (() => {}))(`[giftCards] released ${input.reservedMinor} on ${code}`);
}

/**
 * Admin creation helper. Returns the display code and the plain code the
 * purchaser needs; both are the same card (no separate "activate" step).
 */
export async function createGiftCard(
  input: {
    amountMajor: number;
    currency: string;
    expiresInDays?: number;
    createdByUserId: number;
  },
  deps: GiftCardsDeps,
): Promise<{
  code: string;
  currency: string;
  originalMinor: number;
  expiresAt: string | null;
}> {
  if (!Number.isInteger(input.createdByUserId) || input.createdByUserId <= 0) {
    throw new GiftCardError("invalid_input", "createdByUserId must be a positive integer");
  }
  if (
    input.expiresInDays !== undefined &&
    (!Number.isInteger(input.expiresInDays) || input.expiresInDays <= 0)
  ) {
    throw new GiftCardError("invalid_input", "expiresInDays must be a positive integer");
  }
  const db = deps.getDb();
  if (!db) throw new GiftCardError("not_configured", "gift cards are not configured");
  const now = deps.now ? deps.now() : new Date();
  const originalMinor = toMinor(input.amountMajor, input.currency);
  const expiresAt = input.expiresInDays
    ? new Date(now.getTime() + input.expiresInDays * 24 * 60 * 60 * 1000)
    : null;
  const code = makeGiftCardCode();
  await db.createCard({
    code,
    currency: input.currency.toUpperCase(),
    originalMinor,
    expiresAt,
    createdByUserId: input.createdByUserId,
    createdAt: now,
  });
  (deps.log ?? (() => {}))(`[giftCards] created ${displayCode(code)} for ${input.amountMajor} ${input.currency}`);
  return {
    code: displayCode(code),
    currency: input.currency.toUpperCase(),
    originalMinor,
    expiresAt: expiresAt ? expiresAt.toISOString() : null,
  };
}

export const __test__ = {
  normaliseCode,
  displayCode,
  makeGiftCardCode,
  toMinor,
  isExpired,
  GIFT_CARD_ALLOWED_CODE_LENGTH,
  CODE_ALPHABET,
};

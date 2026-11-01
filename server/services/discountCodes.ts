/**
 * Discount codes (Phase 8, batch 1).
 *
 * RULES (from the spec):
 *   - Discount codes are percentage OR fixed-amount.
 *   - Codes can expire.
 *   - Codes can have a total usage limit (and we track usage count).
 *   - Codes can be restricted to a single country.
 *   - Codes are validated at checkout; the checkout route reduces the total.
 *
 * DESIGN
 * ------
 *   - Everything sits behind an injected `DiscountCodesDb` adapter so tests can
 *     exercise the full decision tree without a PostgreSQL server. The real
 *     adapter is built in `server/routes/growth.ts` from the shared
 *     `getDb()` client the rest of the app uses.
 *   - Money is handled in MINOR units from the caller's point of view. Fixed
 *     codes are stored in minor units keyed by currency so USD $5.00 = 500 and
 *     VND 50,000 = 50000 (VND is zero-decimal). Percentages are expressed as
 *     integers 1..100. Never mix the two: the DB CHECK constraint enforces that
 *     exactly one of percent / fixed is set.
 *   - Redemption is "reserve then commit": `reserveDiscountCode` atomically
 *     increments the used-count (bounded by usage_limit) and creates a
 *     reservation row; if the checkout then fails, `releaseDiscountCode`
 *     decrements. This means a flaky payment provider can't burn a limited
 *     code without a matching release path.
 *   - Country restriction compares ISO-3166 alpha-2 lowercase codes. If the
 *     code is restricted and the order contains ANY ineligible country, the
 *     code is refused outright (partial restriction is confusing and not in
 *     the spec). Callers pass the full set of countries in the order.
 *
 * GAPS documented honestly
 * ------------------------
 *   - Currency conversion: a fixed-amount code in SGD cannot be applied to a
 *     USD order. This is refused with `currency_mismatch`; converting at FX
 *     would be an admin-facing policy decision, not a bug.
 *   - The code this file writes (used_count, reservations) is the source of
 *     truth for usage limit enforcement. Admin tooling must not bypass it by
 *     editing `used_count` by hand.
 */

/** Length limit matches `discount_codes.code` in 0014_growth.sql. */
export const DISCOUNT_CODE_MAX_LENGTH = 64;

/**
 * Minimum configurable percentage so a rogue admin can't accidentally create
 * a coupon that lets a plan be bought for $0. Discounts of 100% are what gift
 * cards and referrals are for; discount codes go up to 99%.
 */
export const DISCOUNT_CODE_MAX_PERCENT = 99;

/** Unambiguous charset (no 0/O/1/I/L) reused for generated codes. */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export type DiscountCodeErrorCode =
  | "invalid_input"
  | "db_unavailable"
  | "not_found"
  | "inactive"
  | "expired"
  | "not_yet_active"
  | "usage_limit_reached"
  | "currency_mismatch"
  | "country_not_eligible"
  | "not_applicable";

export class DiscountCodeError extends Error {
  readonly code: DiscountCodeErrorCode;
  constructor(code: DiscountCodeErrorCode, message: string) {
    super(message);
    this.name = "DiscountCodeError";
    this.code = code;
  }
}

/** A stored discount code, as loaded from the DB. */
export interface DiscountCodeRow {
  /** Flat, uppercased code without dashes (matches `normaliseDiscountCode`). */
  code: string;
  /** Display label, e.g. "SG5-off". */
  label: string;
  /** true => `percent` is set; false => `fixedMinor` + `currency` are set. */
  isPercent: boolean;
  /** Percentage 1..100 when `isPercent`; ignored otherwise. */
  percent: number | null;
  /** Minor-unit fixed amount when `!isPercent`; ignored otherwise. */
  fixedMinor: number | null;
  /** Currency for `fixedMinor`; ignored for percent codes. */
  currency: string | null;
  /** ISO timestamp; null means no expiry. */
  expiresAt: Date | null;
  /** ISO timestamp for the start of validity; null means "always active so far". */
  startsAt: Date | null;
  /** Total allowed redemptions; null means unlimited. */
  usageLimit: number | null;
  /** Redemptions already counted against `usageLimit`. */
  usedCount: number;
  /** Lowercase ISO-3166 alpha-2; null means any country. */
  countryCode: string | null;
  /** Whether the admin has the code switched on. */
  active: boolean;
}

/** Public shape returned to the storefront preview once validated. */
export interface DiscountPreview {
  code: string;
  label: string;
  kind: "percent" | "fixed";
  /** Percentage (integer) when kind === "percent"; null otherwise. */
  percent: number | null;
  /** Minor units when kind === "fixed"; null otherwise. */
  fixedMinor: number | null;
  /** Currency when kind === "fixed"; null otherwise. */
  currency: string | null;
  /** Human summary, e.g. "10% off" or "S$5 off". */
  summary: string;
  /** ISO timestamp or null when there is no hard expiry. */
  expiresAt: string | null;
  /** Country restriction (lowercase ISO alpha-2) or null when global. */
  countryCode: string | null;
}

/** Inputs to reserve a discount on a specific order. */
export interface ReserveDiscountInput {
  code: string;
  /** Currency of the order, uppercase ISO-4217. */
  currency: string;
  /** Subtotal in minor units, used to cap percent discounts (never exceeds subtotal). */
  subtotalMinor: number;
  /** Set of lowercase ISO-3166 codes the order covers. Empty for digital bundles. */
  countries: readonly string[];
  /** Stable reference for the reservation (e.g. our order id). */
  orderRef: string;
}

/** Result of a successful reservation. */
export interface ReserveDiscountResult {
  code: string;
  /** Minor units to subtract from the subtotal (capped at subtotal). */
  discountMinor: number;
  /** Subtotal after discount, guaranteed >= 0. */
  netMinor: number;
  /** `discount_codes.used_count` after this reservation. */
  usedCountAfter: number;
  /** Reservation public id so the caller can release on failure. */
  reservationId: string;
  /** True when the discount was applied but limited to available balance. */
  cappedAtSubtotal: boolean;
}

/** Narrow DB contract; real implementation lives in `server/routes/growth.ts`. */
export interface DiscountCodesDb {
  /** Case-insensitive lookup on the flat code. */
  findByCode: (flatCode: string) => Promise<DiscountCodeRow | null>;

  /**
   * Atomically insert a reservation and increment `used_count` in ONE step,
   * bounded by the code's `usage_limit`. Returns:
   *   - { ok, usedCountAfter } on success
   *   - { ok: false, reason: "limit_reached" } if the increment would exceed
   *     `usage_limit` (or the code was revoked/deactivated in the meantime)
   *   - { ok: false, reason: "not_found" } if the code no longer exists
   *
   * MUST be safe under concurrent redemption (i.e. uses
   * `UPDATE ... WHERE used_count < usage_limit RETURNING used_count` or the
   * equivalent). A best-effort implementation that reads then writes will
   * over-issue limited codes; this contract exists to prevent that.
   */
  atomicallyReserve: (input: {
    flatCode: string;
    reservationId: string;
    orderRef: string;
    discountMinor: number;
    currency: string;
    at: Date;
  }) => Promise<
    | { ok: true; usedCountAfter: number }
    | { ok: false; reason: "limit_reached" | "not_found" }
  >;

  /**
   * Release a prior reservation. Decrements `used_count` back (bounded at 0)
   * and deletes the reservation row. Idempotent: calling twice must be a no-op
   * the second time.
   */
  releaseReservation: (reservationId: string, at: Date) => Promise<void>;

  /** Commit a reservation (called by checkout after the Stripe webhook succeeds). */
  commitReservation: (reservationId: string, at: Date) => Promise<void>;

  /** Admin creation. */
  insert: (row: DiscountCodeRow & { createdByUserId: number; createdAt: Date }) => Promise<void>;
}

export type DiscountCodesDeps = {
  getDb: () => DiscountCodesDb | null;
  now?: () => Date;
  log?: (msg: string) => void;
  /** Source of reservation ids. Defaults to a crypto-derived random. */
  makeReservationId?: () => string;
};

// ---------------------------------------------------------------------------
// Code normalisation (shared with tests + the admin route)
// ---------------------------------------------------------------------------

/**
 * Uppercase, strip spaces and dashes so "sg5-off", "SG5 OFF" and " SG5OFF "
 * all resolve to the same stored `SG5OFF`.
 */
export function normaliseDiscountCode(input: string): string {
  if (typeof input !== "string") {
    throw new DiscountCodeError("invalid_input", "code must be a string");
  }
  const flat = input.trim().toUpperCase().replace(/[\s-]+/g, "");
  if (flat.length === 0) {
    throw new DiscountCodeError("invalid_input", "code is empty");
  }
  if (flat.length > DISCOUNT_CODE_MAX_LENGTH) {
    throw new DiscountCodeError(
      "invalid_input",
      `code exceeds ${DISCOUNT_CODE_MAX_LENGTH} characters`,
    );
  }
  return flat;
}

/** Generate a fresh, human-typable admin code (no lookup collisions checked here). */
export function makeDiscountCode(prefix = "ZPY"): string {
  const body = randomString(8, CODE_ALPHABET);
  // Prefix + body joined by nothing (stored form has no dashes).
  return `${prefix.toUpperCase()}${body}`;
}

function randomString(len: number, alphabet: string): string {
  const buf = new Uint8Array(len);
  const g = globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } };
  if (g.crypto?.getRandomValues) {
    g.crypto.getRandomValues(buf);
  } else {
    for (let i = 0; i < len; i++) buf[i] = Math.floor(Math.random() * 256);
  }
  const out: string[] = [];
  for (let i = 0; i < len; i++) {
    out.push(alphabet[buf[i]! % alphabet.length]!);
  }
  return out.join("");
}

/** Currency-aware conversion from major units to integer minor units. */
export function toMinor(amountMajor: number, currency: string): number {
  if (!Number.isFinite(amountMajor) || amountMajor <= 0) {
    throw new DiscountCodeError("invalid_input", "amount must be positive");
  }
  const ccy = currency.toUpperCase();
  const zeroDecimal = ccy === "VND";
  const raw = zeroDecimal ? amountMajor : amountMajor * 100;
  const rounded = Math.round(raw);
  if (!Number.isSafeInteger(rounded) || rounded <= 0) {
    throw new DiscountCodeError("invalid_input", "amount overflow");
  }
  return rounded;
}

function makeReservationId(): string {
  const body = randomString(16, CODE_ALPHABET).toLowerCase();
  const stamp = Date.now().toString(36);
  return `dr_${stamp}_${body}`;
}

// ---------------------------------------------------------------------------
// Eligibility + preview
// ---------------------------------------------------------------------------

function isBeforeStartsAt(row: DiscountCodeRow, now: Date): boolean {
  return !!row.startsAt && row.startsAt.getTime() > now.getTime();
}

function isExpired(row: DiscountCodeRow, now: Date): boolean {
  return !!row.expiresAt && row.expiresAt.getTime() <= now.getTime();
}

function summarise(row: DiscountCodeRow): string {
  if (row.isPercent) {
    return `${row.percent ?? 0}% off`;
  }
  if (row.fixedMinor == null) return "discount";
  const ccy = (row.currency ?? "").toUpperCase();
  const amount = ccy === "VND" ? String(row.fixedMinor) : (row.fixedMinor / 100).toFixed(2);
  return `${ccy} ${amount} off`.trim();
}

/** Public display code (with dashes) from the flat stored code. */
export function displayDiscountCode(flat: string): string {
  return normaliseDiscountCode(flat);
}

/**
 * Validate a code against a set of order-side inputs WITHOUT touching the DB.
 * Throws a `DiscountCodeError` with a specific `code` when ineligible so the
 * checkout UI can show an honest message.
 */
export function evaluateDiscountCode(
  row: DiscountCodeRow,
  input: {
    currency: string;
    subtotalMinor: number;
    countries: readonly string[];
  },
  now: Date,
): { discountMinor: number; cappedAtSubtotal: boolean } {
  if (!row.active) {
    throw new DiscountCodeError("inactive", "discount code is disabled");
  }
  if (isBeforeStartsAt(row, now)) {
    throw new DiscountCodeError("not_yet_active", "discount code is not yet active");
  }
  if (isExpired(row, now)) {
    throw new DiscountCodeError("expired", "discount code has expired");
  }
  if (row.usageLimit != null && row.usedCount >= row.usageLimit) {
    throw new DiscountCodeError("usage_limit_reached", "discount code has reached its usage limit");
  }
  if (!Number.isInteger(input.subtotalMinor) || input.subtotalMinor <= 0) {
    throw new DiscountCodeError("invalid_input", "subtotalMinor must be a positive integer");
  }
  if (input.countries.length > 0 && row.countryCode) {
    const wanted = row.countryCode.toLowerCase();
    const eligible = input.countries.map((c) => c.toLowerCase()).every((c) => c === wanted);
    if (!eligible) {
      throw new DiscountCodeError(
        "country_not_eligible",
        `discount code only applies to orders in ${wanted.toUpperCase()}`,
      );
    }
  }
  if (row.isPercent) {
    if (row.percent == null || row.percent <= 0 || row.percent > 100) {
      throw new DiscountCodeError("not_applicable", "discount code has an invalid percentage");
    }
    // Round DOWN to be favourable to the buyer at the smallest unit; buyers
    // never see a "half cent" charge. (subtotal * percent / 100) rounded down.
    const rawDiscount = Math.floor((input.subtotalMinor * row.percent) / 100);
    const capped = Math.min(rawDiscount, input.subtotalMinor);
    return { discountMinor: capped, cappedAtSubtotal: capped < rawDiscount };
  }
  if (row.fixedMinor == null || row.fixedMinor <= 0) {
    throw new DiscountCodeError("not_applicable", "discount code has an invalid amount");
  }
  const orderCurrency = input.currency.toUpperCase();
  const codeCurrency = (row.currency ?? "").toUpperCase();
  if (!codeCurrency || codeCurrency !== orderCurrency) {
    throw new DiscountCodeError(
      "currency_mismatch",
      `discount code is issued in ${codeCurrency || "unknown currency"}, order pays in ${orderCurrency}`,
    );
  }
  const capped = Math.min(row.fixedMinor, input.subtotalMinor);
  return { discountMinor: capped, cappedAtSubtotal: capped < row.fixedMinor };
}

/**
 * Public validation used by checkout before reserving. Returns the preview
 * the buyer sees in the UI; does NOT change the code's usage count.
 */
export async function validateDiscountCode(
  input: {
    code: string;
    currency: string;
    subtotalMinor: number;
    countries: readonly string[];
  },
  deps: DiscountCodesDeps,
): Promise<DiscountPreview> {
  const flat = normaliseDiscountCode(input.code);
  const db = deps.getDb();
  if (!db) {
    throw new DiscountCodeError("db_unavailable", "discount codes are not configured");
  }
  const now = deps.now ? deps.now() : new Date();
  const row = await db.findByCode(flat);
  if (!row) throw new DiscountCodeError("not_found", "discount code not found");

  // Evaluate first — this throws the specific eligibility error.
  evaluateDiscountCode(row, input, now);

  return {
    code: displayDiscountCode(row.code),
    label: row.label,
    kind: row.isPercent ? "percent" : "fixed",
    percent: row.isPercent ? row.percent ?? 0 : null,
    fixedMinor: row.isPercent ? null : row.fixedMinor ?? 0,
    currency: row.isPercent ? null : (row.currency ?? "").toUpperCase() || null,
    summary: summarise(row),
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    countryCode: row.countryCode ? row.countryCode.toLowerCase() : null,
  };
}

// ---------------------------------------------------------------------------
// Reservation lifecycle
// ---------------------------------------------------------------------------

/**
 * Reserve: atomically increment `used_count` (bounded by `usage_limit`) and
 * create a reservation row. The caller (checkout) then applies `discountMinor`
 * to the total and, on payment success, calls `commitDiscountCode` — or on
 * failure, `releaseDiscountCode`.
 *
 * Re-checks eligibility first so an expired/inactive/wrong-country code isn't
 * reserved. The atomic increment is what enforces the usage limit under
 * concurrency (evaluating `usedCount < usageLimit` earlier is a best-effort
 * preview, not the enforcer).
 */
export async function reserveDiscountCode(
  input: ReserveDiscountInput,
  deps: DiscountCodesDeps,
): Promise<ReserveDiscountResult> {
  if (typeof input.orderRef !== "string" || input.orderRef.length === 0) {
    throw new DiscountCodeError("invalid_input", "orderRef is required");
  }
  const flat = normaliseDiscountCode(input.code);
  const db = deps.getDb();
  if (!db) throw new DiscountCodeError("db_unavailable", "discount codes are not configured");
  const now = deps.now ? deps.now() : new Date();
  const row = await db.findByCode(flat);
  if (!row) throw new DiscountCodeError("not_found", "discount code not found");

  const { discountMinor, cappedAtSubtotal } = evaluateDiscountCode(row, input, now);
  const reservationId = (deps.makeReservationId ?? makeReservationId)();

  const outcome = await db.atomicallyReserve({
    flatCode: flat,
    reservationId,
    orderRef: input.orderRef,
    discountMinor,
    currency: input.currency.toUpperCase(),
    at: now,
  });
  if (!outcome.ok) {
    if (outcome.reason === "limit_reached") {
      throw new DiscountCodeError("usage_limit_reached", "discount code has reached its usage limit");
    }
    throw new DiscountCodeError("not_found", "discount code disappeared during reservation");
  }

  (deps.log ?? (() => {}))(
    `[discountCodes] reserved ${flat} on ${input.orderRef} (minor=${discountMinor}, code=${reservationId})`,
  );
  return {
    code: displayDiscountCode(row.code),
    discountMinor,
    netMinor: Math.max(0, input.subtotalMinor - discountMinor),
    usedCountAfter: outcome.usedCountAfter,
    reservationId,
    cappedAtSubtotal,
  };
}

/**
 * Release a reservation when the payment provider fails or the buyer abandons
 * the checkout. Idempotent. The DB adapter is the source of truth for
 * "already released"; this function is safe to call twice.
 */
export async function releaseDiscountCode(
  input: { reservationId: string },
  deps: DiscountCodesDeps,
): Promise<void> {
  if (!input.reservationId) {
    throw new DiscountCodeError("invalid_input", "reservationId is required");
  }
  const db = deps.getDb();
  if (!db) throw new DiscountCodeError("db_unavailable", "discount codes are not configured");
  const now = deps.now ? deps.now() : new Date();
  await db.releaseReservation(input.reservationId, now);
  (deps.log ?? (() => {}))(`[discountCodes] released ${input.reservationId}`);
}

/**
 * Commit a reservation after the Stripe webhook confirms payment. The adapter
 * flips a `pending` reservation to `committed`; usage count stays incremented
 * (which is what the release path undoes).
 */
export async function commitDiscountCode(
  input: { reservationId: string },
  deps: DiscountCodesDeps,
): Promise<void> {
  if (!input.reservationId) {
    throw new DiscountCodeError("invalid_input", "reservationId is required");
  }
  const db = deps.getDb();
  if (!db) throw new DiscountCodeError("db_unavailable", "discount codes are not configured");
  const now = deps.now ? deps.now() : new Date();
  await db.commitReservation(input.reservationId, now);
  (deps.log ?? (() => {}))(`[discountCodes] committed ${input.reservationId}`);
}

/**
 * Admin creation helper. Enforces the "exactly one of percent / fixed" rule
 * here so an admin form bug can't create a both-empty code that discounts
 * silently to zero.
 */
export async function createDiscountCode(
  input: {
    code?: string;
    prefix?: string;
    label: string;
    percent?: number;
    fixedAmountMajor?: number;
    fixedCurrency?: string;
    expiresAt?: Date | null;
    startsAt?: Date | null;
    usageLimit?: number | null;
    countryCode?: string | null;
    active?: boolean;
    createdByUserId: number;
  },
  deps: DiscountCodesDeps,
): Promise<{ code: string; kind: "percent" | "fixed"; label: string }> {
  if (typeof input.label !== "string" || input.label.trim().length === 0) {
    throw new DiscountCodeError("invalid_input", "label is required");
  }
  if (!Number.isInteger(input.createdByUserId) || input.createdByUserId <= 0) {
    throw new DiscountCodeError("invalid_input", "createdByUserId must be a positive integer");
  }
  const hasPercent = input.percent != null;
  const hasFixed = input.fixedAmountMajor != null || input.fixedCurrency != null;
  if (hasPercent === hasFixed) {
    throw new DiscountCodeError(
      "invalid_input",
      "exactly one of percent or fixedAmountMajor must be set",
    );
  }
  if (input.usageLimit != null && (!Number.isInteger(input.usageLimit) || input.usageLimit <= 0)) {
    throw new DiscountCodeError("invalid_input", "usageLimit must be a positive integer");
  }
  if (
    input.countryCode != null &&
    !/^[a-z]{2}$/i.test(input.countryCode)
  ) {
    throw new DiscountCodeError("invalid_input", "countryCode must be an ISO-3166 alpha-2");
  }

  const flat = input.code
    ? normaliseDiscountCode(input.code)
    : makeDiscountCode(input.prefix ?? "ZPY");

  let isPercent: boolean;
  let percent: number | null = null;
  let fixedMinor: number | null = null;
  let currency: string | null = null;

  if (hasPercent) {
    const p = input.percent!;
    if (!Number.isInteger(p) || p <= 0 || p > DISCOUNT_CODE_MAX_PERCENT) {
      throw new DiscountCodeError(
        "invalid_input",
        `percent must be an integer between 1 and ${DISCOUNT_CODE_MAX_PERCENT}`,
      );
    }
    isPercent = true;
    percent = p;
  } else {
    if (!input.fixedCurrency) {
      throw new DiscountCodeError("invalid_input", "fixedCurrency is required for a fixed code");
    }
    isPercent = false;
    fixedMinor = toMinor(input.fixedAmountMajor!, input.fixedCurrency);
    currency = input.fixedCurrency.toUpperCase();
  }

  const db = deps.getDb();
  if (!db) throw new DiscountCodeError("db_unavailable", "discount codes are not configured");
  const now = deps.now ? deps.now() : new Date();

  await db.insert({
    code: flat,
    label: input.label.trim(),
    isPercent,
    percent,
    fixedMinor,
    currency,
    expiresAt: input.expiresAt ?? null,
    startsAt: input.startsAt ?? null,
    usageLimit: input.usageLimit ?? null,
    usedCount: 0,
    countryCode: input.countryCode ? input.countryCode.toLowerCase() : null,
    active: input.active !== false,
    createdByUserId: input.createdByUserId,
    createdAt: now,
  });

  (deps.log ?? (() => {}))(`[discountCodes] created ${flat} (${isPercent ? `${percent}%` : `fixed ${fixedMinor} ${currency}`})`);
  return { code: flat, kind: isPercent ? "percent" : "fixed", label: input.label.trim() };
}

export const __test__ = {
  normaliseDiscountCode,
  displayDiscountCode,
  makeDiscountCode,
  toMinor,
  summarise,
  isBeforeStartsAt,
  isExpired,
  DISCOUNT_CODE_MAX_LENGTH,
  DISCOUNT_CODE_MAX_PERCENT,
};

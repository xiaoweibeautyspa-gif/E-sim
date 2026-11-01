/**
 * Source tests for the growth services (Phase 8):
 *   - `server/services/referrals.ts`     — friend $3 off, referrer $3 credit
 *   - `server/services/giftCards.ts`     — fixed-value codes, partial redemption
 *   - `server/services/discountCodes.ts` — percent/fixed, expiry, usage limit,
 *                                          per country
 *
 * IMPORTANT — WHAT THESE TESTS COVER AND WHAT THEY CANNOT
 * -------------------------------------------------------
 * These drive the services' own decision trees through the injected `getDb`
 * adapters (no network, no Postgres, no Stripe, no secrets). They prove:
 *   • eligibility & money math (currency-aware minor units, VND zero-decimal)
 *   • every error code a checkout needs to render (expired, quota, country,
 *     currency mismatch, not_found, db_unavailable)
 *   • idempotency-friendly outcomes (already_referred, usage limit → error)
 *   • the reserve/release/commit lifecycle calls the correct adapter methods
 *
 * They DO NOT prove:
 *   • the Traveler Pass subscription (its service, `membership.ts`, was not
 *     supplied with this request); the page contract is asserted separately
 *     in `src/pages/TravelerPass.test.tsx` once that service is wired.
 *   • Postgres-level concurrency. The atomicity of `atomicallyReserve`
 *     (`UPDATE ... WHERE used_count < usage_limit`) and
 *     `atomicallyDecrement` (`WHERE balance >= n`) is a DB-adapter contract,
 *     asserted here only at the "limits are respected" level with a fake.
 *
 * Run with `npm test` (`node --test --import tsx "server/**\/*.test.ts"`).
 * These are SOURCE ONLY — not executed by this response.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createReferral,
  lookupFriendDiscount,
  getReferralCodeForUser,
  makeReferralCode,
  toMinor as referralToMinor,
  REFERRAL_FRIEND_DISCOUNT_MAJOR,
  REFERRAL_REFERRER_CREDIT_MAJOR,
  ReferralsError,
  ReferralsUnavailableError,
  type ReferralsDb,
} from "./referrals";

import {
  validateGiftCard,
  reserveGiftCard,
  releaseGiftCard,
  createGiftCard,
  normaliseCode,
  displayCode,
  makeGiftCardCode,
  toMinor as giftToMinor,
  GiftCardError,
  type GiftCardsDb,
} from "./giftCards";

import {
  validateDiscountCode,
  reserveDiscountCode,
  releaseDiscountCode,
  commitDiscountCode,
  createDiscountCode,
  evaluateDiscountCode,
  normaliseDiscountCode,
  makeDiscountCode,
  toMinor as discountToMinor,
  DISCOUNT_CODE_MAX_PERCENT,
  DiscountCodeError,
  type DiscountCodeRow,
  type DiscountCodesDb,
} from "./discountCodes";

// Fixed "now" for determinism.
const NOW = () => new Date("2024-06-15T12:00:00Z");

// ===========================================================================
// REFERRALS
// ===========================================================================

function makeReferralsDb(opts: {
  existing?: Map<number, { publicId: string; status: "pending" | "qualified" | "paid" | "rejected"; referrerUserId: number }>;
  codeByUser?: Map<number, string>;
  uniqueOnInsert?: boolean;
} = {}): ReferralsDb & { inserted: Array<Record<string, unknown>> } {
  const existing = opts.existing ?? new Map();
  const codeByUser = opts.codeByUser ?? new Map();
  const inserted: Array<Record<string, unknown>> = [];
  return {
    inserted,
    async insertReferral(input) {
      if (opts.uniqueOnInsert) {
        const err = new Error("duplicate key value violates unique constraint");
        (err as { code?: string }).code = "23505";
        throw err;
      }
      inserted.push(input as unknown as Record<string, unknown>);
      existing.set(input.referredUserId, {
        publicId: input.publicId,
        status: "pending",
        referrerUserId: input.referrerUserId,
      });
    },
    async findReferralByReferred(userId) {
      return existing.get(userId) ?? null;
    },
    async getReferralCode(userId) {
      return codeByUser.get(userId) ?? null;
    },
  };
}

const refDeps = (db: ReferralsDb | null) => ({ getDb: () => db, now: NOW, log: () => {} });

test("referral: friend discount and referrer credit are 3 major units in the chosen currency", () => {
  assert.equal(REFERRAL_FRIEND_DISCOUNT_MAJOR, 3);
  assert.equal(REFERRAL_REFERRER_CREDIT_MAJOR, 3);
  assert.equal(referralToMinor(3, "USD"), 300);
  assert.equal(referralToMinor(3, "SGD"), 300);
  assert.equal(referralToMinor(3, "CNY"), 300);
  // VND is zero-decimal: 3 major units = 3 minor units.
  assert.equal(referralToMinor(3, "VND"), 3);
});

test("referral: makeReferralCode is deterministic and rejects invalid ids", () => {
  assert.equal(makeReferralCode(42), "REF-" + (42).toString(36).toUpperCase());
  assert.throws(() => makeReferralCode(0), ReferralsError);
  assert.throws(() => makeReferralCode(-1), ReferralsError);
});

test("referral: createReferral inserts a pending row and returns the public id", async () => {
  const db = makeReferralsDb();
  const result = await createReferral(
    { referrerUserId: 1, referredUserId: 2, currency: "USD" },
    refDeps(db),
  );
  assert.equal(result.status, "created");
  assert.equal(db.inserted.length, 1);
  const row = db.inserted[0]!;
  assert.equal(row.referrerUserId, 1);
  assert.equal(row.referredUserId, 2);
  assert.equal(row.friendDiscountMinor, 300);
  assert.equal(row.referrerCreditMinor, 300);
  assert.equal(row.currency, "USD");
});

test("referral: creating the same referred user again returns already_referred (never a second credit)", async () => {
  const db = makeReferralsDb({
    existing: new Map([[2, { publicId: "ref_x", status: "qualified", referrerUserId: 1 }]]),
  });
  const result = await createReferral(
    { referrerUserId: 1, referredUserId: 2, currency: "USD" },
    refDeps(db),
  );
  assert.equal(result.status, "already_referred");
  assert.equal(db.inserted.length, 0);
});

test("referral: a user cannot refer themselves", async () => {
  await assert.rejects(
    () => createReferral({ referrerUserId: 5, referredUserId: 5, currency: "USD" }, refDeps(makeReferralsDb())),
    (e) => e instanceof ReferralsError && e.code === "invalid_input",
  );
});

test("referral: unique-violation on insert falls back to already_referred", async () => {
  const db = makeReferralsDb({ uniqueOnInsert: true });
  // Simulate the concurrent create landing the row: seed it after the first findReferralByReferred miss.
  let firstLookup = true;
  const orig = db.findReferralByReferred;
  db.findReferralByReferred = async (id) => {
    if (firstLookup) {
      firstLookup = false;
      return null;
    }
    return { publicId: "ref_winner", status: "pending", referrerUserId: 1 };
  };
  void orig;
  const result = await createReferral(
    { referrerUserId: 1, referredUserId: 9, currency: "USD" },
    refDeps(db),
  );
  assert.equal(result.status, "already_referred");
  assert.equal(result.referralPublicId, "ref_winner");
});

test("referral: lookupFriendDiscount returns null without a pending referral", async () => {
  const db = makeReferralsDb();
  const res = await lookupFriendDiscount({ userId: 7, currency: "USD" }, refDeps(db));
  assert.equal(res, null);
});

test("referral: lookupFriendDiscount returns 300 minor units for a pending referred user", async () => {
  const db = makeReferralsDb({
    existing: new Map([[7, { publicId: "ref_pending", status: "pending", referrerUserId: 1 }]]),
  });
  const res = await lookupFriendDiscount({ userId: 7, currency: "USD" }, refDeps(db));
  assert.ok(res);
  assert.equal(res!.discountMinor, 300);
  assert.equal(res!.currency, "USD");
  assert.equal(res!.referralPublicId, "ref_pending");
});

test("referral: lookupFriendDiscount returns null once the referral has qualified", async () => {
  const db = makeReferralsDb({
    existing: new Map([[7, { publicId: "ref_q", status: "qualified", referrerUserId: 1 }]]),
  });
  const res = await lookupFriendDiscount({ userId: 7, currency: "USD" }, refDeps(db));
  assert.equal(res, null);
});

test("referral: getReferralCodeForUser returns the existing code or the deterministic default", async () => {
  const withExisting = makeReferralsDb({ codeByUser: new Map([[42, "REF-CUSTOM"]]) });
  assert.deepEqual(await getReferralCodeForUser(42, refDeps(withExisting)), { code: "REF-CUSTOM" });
  const without = makeReferralsDb();
  assert.deepEqual(await getReferralCodeForUser(42, refDeps(without)), { code: makeReferralCode(42) });
});

test("referral: no DB throws ReferralsUnavailableError, never a silent success", async () => {
  await assert.rejects(
    () => createReferral({ referrerUserId: 1, referredUserId: 2, currency: "USD" }, refDeps(null)),
    (e) => e instanceof ReferralsUnavailableError,
  );
});

// ===========================================================================
// GIFT CARDS
// ===========================================================================

/** Fake gift card adapter with an honest balance ledger. */
function makeGiftDb(seed?: {
  code: string;
  currency: string;
  originalMinor: number;
  balanceMinor: number;
  expiresAt?: Date | null;
}): GiftCardsDb & {
  cards: Map<string, { currency: string; originalMinor: number; balanceMinor: number; expiresAt: Date | null }>;
  created: Array<Record<string, unknown>>;
  refunded: Array<{ code: string; incrementMinor: number }>;
} {
  const cards = new Map<
    string,
    { currency: string; originalMinor: number; balanceMinor: number; expiresAt: Date | null }
  >();
  if (seed) {
    cards.set(normaliseCode(seed.code), {
      currency: seed.currency.toUpperCase(),
      originalMinor: seed.originalMinor,
      balanceMinor: seed.balanceMinor,
      expiresAt: seed.expiresAt ?? null,
    });
  }
  const created: Array<Record<string, unknown>> = [];
  const refunded: Array<{ code: string; incrementMinor: number }> = [];
  return {
    cards,
    created,
    refunded,
    async findByCode(code) {
      const flat = normaliseCode(code);
      const c = cards.get(flat);
      if (!c) return null;
      return {
        code: flat,
        currency: c.currency,
        originalMinor: c.originalMinor,
        balanceMinor: c.balanceMinor,
        expiresAt: c.expiresAt,
        exhausted: c.balanceMinor <= 0,
      };
    },
    async atomicallyDecrement({ code, decrementMinor }) {
      const flat = normaliseCode(code);
      const c = cards.get(flat);
      if (!c || c.balanceMinor < decrementMinor) return null;
      c.balanceMinor -= decrementMinor;
      return { remainingMinor: c.balanceMinor };
    },
    async refundReserved({ code, incrementMinor }) {
      const flat = normaliseCode(code);
      const c = cards.get(flat);
      if (!c) throw new GiftCardError("not_found", "gift card disappeared during release");
      c.balanceMinor += incrementMinor;
      refunded.push({ code: flat, incrementMinor });
    },
    async createCard(input) {
      cards.set(input.code, {
        currency: input.currency.toUpperCase(),
        originalMinor: input.originalMinor,
        balanceMinor: input.originalMinor,
        expiresAt: input.expiresAt,
      });
      created.push(input as unknown as Record<string, unknown>);
    },
  };
}

const giftDeps = (db: GiftCardsDb | null, now: () => Date = NOW) => ({
  getDb: () => db,
  now,
  log: () => {},
});

test("gift card: codes normalise across case/spaces/dashes and format back to BRND-XXXX-XXXX", () => {
  assert.equal(normaliseCode("brnd xxxx yyyy"), "BRNDXXXXYYYY");
  assert.equal(normaliseCode("brnd-xxxx-yyyy"), "BRNDXXXXYYYY");
  assert.equal(displayCode("BRNDABCD2345"), "BRND-ABCD-2345");
  assert.equal(displayCode("ABCD2345"), "BRND-ABCD-2345"); // no BRND prefix tolerated
});

test("gift card: generated codes use the unambiguous alphabet and are BRND-prefixed", () => {
  for (let i = 0; i < 20; i++) {
    const c = makeGiftCardCode();
    assert.match(c, /^BRND[A-Z2-9]{8}$/);
    assert.doesNotMatch(c, /[01OIL]/);
  }
});

test("gift card: minor-unit conversion is currency-aware (VND zero-decimal)", () => {
  assert.equal(giftToMinor(5, "USD"), 500);
  assert.equal(giftToMinor(5, "SGD"), 500);
  assert.equal(giftToMinor(50000, "VND"), 50000);
  assert.throws(() => giftToMinor(0, "USD"), GiftCardError);
  assert.throws(() => giftToMinor(-1, "USD"), GiftCardError);
});

test("gift card: validateGiftCard returns the public balance when present", async () => {
  const db = makeGiftDb({ code: "BRNDABCD2345", currency: "USD", originalMinor: 5000, balanceMinor: 5000 });
  const res = await validateGiftCard({ code: "brnd-abcd-2345" }, giftDeps(db));
  assert.equal(res.code, "BRND-ABCD-2345");
  assert.equal(res.currency, "USD");
  assert.equal(res.balanceMinor, 5000);
  assert.equal(res.originalMinor, 5000);
  assert.equal(res.expiresAt, null);
});

test("gift card: validateGiftCard refuses an unknown code with not_found", async () => {
  await assert.rejects(
    () => validateGiftCard({ code: "BRNDZZZZZZZZ" }, giftDeps(makeGiftDb())),
    (e) => e instanceof GiftCardError && e.code === "not_found",
  );
});

test("gift card: an expired card is refused", async () => {
  const db = makeGiftDb({
    code: "BRNDABCD2345",
    currency: "USD",
    originalMinor: 5000,
    balanceMinor: 5000,
    expiresAt: new Date("2024-06-01T00:00:00Z"),
  });
  await assert.rejects(
    () => validateGiftCard({ code: "BRNDABCD2345" }, giftDeps(db)),
    (e) => e instanceof GiftCardError && e.code === "expired",
  );
});

test("gift card: a fully spent card is refused with no_balance", async () => {
  const db = makeGiftDb({ code: "BRNDABCD2345", currency: "USD", originalMinor: 5000, balanceMinor: 0 });
  await assert.rejects(
    () => validateGiftCard({ code: "BRNDABCD2345" }, giftDeps(db)),
    (e) => e instanceof GiftCardError && e.code === "no_balance",
  );
});

test("gift card: reserveGiftCard caps the reservation to the remaining balance and returns what it took", async () => {
  const db = makeGiftDb({ code: "BRNDABCD2345", currency: "USD", originalMinor: 5000, balanceMinor: 1500 });
  const res = await reserveGiftCard(
    { code: "BRNDABCD2345", currency: "USD", requestedMinor: 5000 },
    giftDeps(db),
  );
  assert.equal(res.reservedMinor, 1500);
  assert.equal(res.remainingMinor, 0);
  assert.equal(db.cards.get("BRNDABCD2345")!.balanceMinor, 0);
});

test("gift card: reserveGiftCard rejects a currency mismatch (no silent FX)", async () => {
  const db = makeGiftDb({ code: "BRNDABCD2345", currency: "SGD", originalMinor: 5000, balanceMinor: 5000 });
  await assert.rejects(
    () => reserveGiftCard({ code: "BRNDABCD2345", currency: "USD", requestedMinor: 500 }, giftDeps(db)),
    (e) => e instanceof GiftCardError && e.code === "currency_mismatch",
  );
  // Balance untouched.
  assert.equal(db.cards.get("BRNDABCD2345")!.balanceMinor, 5000);
});

test("gift card: releaseGiftCard restores the reserved amount on the card", async () => {
  const db = makeGiftDb({ code: "BRNDABCD2345", currency: "USD", originalMinor: 5000, balanceMinor: 5000 });
  await reserveGiftCard({ code: "BRNDABCD2345", currency: "USD", requestedMinor: 2000 }, giftDeps(db));
  assert.equal(db.cards.get("BRNDABCD2345")!.balanceMinor, 3000);
  await releaseGiftCard({ code: "BRNDABCD2345", reservedMinor: 2000 }, giftDeps(db));
  assert.equal(db.cards.get("BRNDABCD2345")!.balanceMinor, 5000);
  assert.equal(db.refunded.length, 1);
});

test("gift card: releaseGiftCard with zero reserved is a no-op (never a spurious refund)", async () => {
  const db = makeGiftDb({ code: "BRNDABCD2345", currency: "USD", originalMinor: 5000, balanceMinor: 5000 });
  await releaseGiftCard({ code: "BRNDABCD2345", reservedMinor: 0 }, giftDeps(db));
  assert.equal(db.refunded.length, 0);
});

test("gift card: createGiftCard stores the requested amount in minor units and returns the display code", async () => {
  const db = makeGiftDb();
  const res = await createGiftCard(
    { amountMajor: 50, currency: "USD", expiresInDays: 365, createdByUserId: 1 },
    giftDeps(db),
  );
  assert.match(res.code, /^BRND-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.equal(res.currency, "USD");
  assert.equal(res.originalMinor, 5000);
  assert.ok(res.expiresAt, "expiry is set when expiresInDays is provided");
  const stored = db.cards.get(normaliseCode(res.code))!;
  assert.equal(stored.originalMinor, 5000);
  assert.equal(stored.balanceMinor, 5000);
});

test("gift card: no DB throws db_unavailable", async () => {
  await assert.rejects(
    () => validateGiftCard({ code: "BRNDABCD2345" }, giftDeps(null)),
    (e) => e instanceof GiftCardError && e.code === "db_unavailable",
  );
});

// ===========================================================================
// DISCOUNT CODES
// ===========================================================================

/** Build a valid discount code row for tests. */
function codeRow(over: Partial<DiscountCodeRow> & Pick<DiscountCodeRow, "code" | "label">): DiscountCodeRow {
  return {
    isPercent: true,
    percent: 10,
    fixedMinor: null,
    currency: null,
    expiresAt: null,
    startsAt: null,
    usageLimit: null,
    usedCount: 0,
    countryCode: null,
    active: true,
    ...over,
  };
}

/**
 * Fake discount code adapter with a mutable used_count so we can assert
 * reservation/commit/release behaviour end to end at the service layer.
 */
function makeDiscountDb(seed: DiscountCodeRow[] = []): DiscountCodesDb & {
  rows: Map<string, DiscountCodeRow>;
  reservations: Map<string, { code: string; status: "pending" | "committed" | "released"; discountMinor: number }>;
  inserted: Array<Record<string, unknown>>;
} {
  const rows = new Map<string, DiscountCodeRow>();
  for (const r of seed) rows.set(r.code, { ...r });
  const reservations = new Map<
    string,
    { code: string; status: "pending" | "committed" | "released"; discountMinor: number }
  >();
  const inserted: Array<Record<string, unknown>> = [];
  return {
    rows,
    reservations,
    inserted,
    async findByCode(flat) {
      const r = rows.get(flat);
      return r ? { ...r } : null;
    },
    async atomicallyReserve({ flatCode, reservationId, discountMinor }) {
      const r = rows.get(flatCode);
      if (!r) return { ok: false, reason: "not_found" };
      if (!r.active) return { ok: false, reason: "limit_reached" };
      if (r.usageLimit != null && r.usedCount >= r.usageLimit) {
        return { ok: false, reason: "limit_reached" };
      }
      r.usedCount += 1;
      reservations.set(reservationId, { code: flatCode, status: "pending", discountMinor });
      return { ok: true, usedCountAfter: r.usedCount };
    },
    async releaseReservation(reservationId) {
      const res = reservations.get(reservationId);
      if (!res || res.status === "released") return;
      const r = rows.get(res.code);
      if (r) r.usedCount = Math.max(0, r.usedCount - 1);
      res.status = "released";
    },
    async commitReservation(reservationId) {
      const res = reservations.get(reservationId);
      if (res) res.status = "committed";
    },
    async insert(row) {
      rows.set(row.code, { ...row });
      inserted.push(row as unknown as Record<string, unknown>);
    },
  };
}

const dcDeps = (db: DiscountCodesDb | null, now: () => Date = NOW) => ({
  getDb: () => db,
  now,
  log: () => {},
  makeReservationId: (() => {
    let i = 0;
    return () => `dr_test_${++i}`;
  })(),
});

test("discount: code normalisation is case/space/dash insensitive", () => {
  assert.equal(normaliseDiscountCode("sg5-off"), "SG5OFF");
  assert.equal(normaliseDiscountCode(" SG5 OFF "), "SG5OFF");
  assert.throws(() => normaliseDiscountCode(""), DiscountCodeError);
});

test("discount: makeDiscountCode uses the unambiguous alphabet with the prefix", () => {
  const c = makeDiscountCode("TEST");
  assert.match(c, /^TEST[A-Z2-9]{8}$/);
  assert.doesNotMatch(c, /[01OIL]/);
});

test("discount: percent code computes a floored discount in minor units", async () => {
  const row = codeRow({ code: "P10", label: "10% off", percent: 10 });
  const { discountMinor } = evaluateDiscountCode(row, { currency: "USD", subtotalMinor: 1234, countries: [] }, NOW());
  // 1234 * 0.1 = 123.4 → floored to 123.
  assert.equal(discountMinor, 123);
});

test("discount: fixed code with matching currency subtracts exactly its amount", async () => {
  const row = codeRow({
    code: "SG500",
    label: "S$5 off",
    isPercent: false,
    percent: null,
    fixedMinor: 500,
    currency: "SGD",
  });
  const { discountMinor } = evaluateDiscountCode(row, { currency: "SGD", subtotalMinor: 1200, countries: [] }, NOW());
  assert.equal(discountMinor, 500);
});

test("discount: fixed code with a different currency refuses with currency_mismatch", () => {
  const row = codeRow({
    code: "USD5",
    label: "$5 off",
    isPercent: false,
    percent: null,
    fixedMinor: 500,
    currency: "USD",
  });
  assert.throws(
    () => evaluateDiscountCode(row, { currency: "SGD", subtotalMinor: 1200, countries: [] }, NOW()),
    (e) => e instanceof DiscountCodeError && e.code === "currency_mismatch",
  );
});

test("discount: expired code refuses with 'expired'", () => {
  const row = codeRow({
    code: "OLD",
    label: "old",
    expiresAt: new Date("2024-06-01T00:00:00Z"),
  });
  assert.throws(
    () => evaluateDiscountCode(row, { currency: "USD", subtotalMinor: 500, countries: [] }, NOW()),
    (e) => e instanceof DiscountCodeError && e.code === "expired",
  );
});

test("discount: not-yet-active code refuses with 'not_yet_active'", () => {
  const row = codeRow({
    code: "FUTURE",
    label: "future",
    startsAt: new Date("2024-12-01T00:00:00Z"),
  });
  assert.throws(
    () => evaluateDiscountCode(row, { currency: "USD", subtotalMinor: 500, countries: [] }, NOW()),
    (e) => e instanceof DiscountCodeError && e.code === "not_yet_active",
  );
});

test("discount: usage limit is enforced by the evaluator and again by the adapter", async () => {
  const row = codeRow({ code: "CAP1", label: "one-off", usageLimit: 1, usedCount: 1 });
  assert.throws(
    () => evaluateDiscountCode(row, { currency: "USD", subtotalMinor: 500, countries: [] }, NOW()),
    (e) => e instanceof DiscountCodeError && e.code === "usage_limit_reached",
  );
  // Adapter check: even if the evaluator didn't catch it, atomicallyReserve refuses.
  const db = makeDiscountDb([row]);
  await assert.rejects(
    () =>
      reserveDiscountCode(
        { code: "CAP1", currency: "USD", subtotalMinor: 500, countries: [], orderRef: "ORD-1" },
        dcDeps(db),
      ),
    (e) => e instanceof DiscountCodeError && e.code === "usage_limit_reached",
  );
});

test("discount: country restriction refuses an order for another country", () => {
  const row = codeRow({ code: "SGONLY", label: "SG only", countryCode: "sg" });
  assert.throws(
    () => evaluateDiscountCode(row, { currency: "USD", subtotalMinor: 500, countries: ["jp"] }, NOW()),
    (e) => e instanceof DiscountCodeError && e.code === "country_not_eligible",
  );
  // And allows an order entirely within SG.
  const ok = evaluateDiscountCode(row, { currency: "USD", subtotalMinor: 500, countries: ["sg"] }, NOW());
  assert.equal(ok.discountMinor, 50);
});

test("discount: reserveDiscountCode creates a reservation and increments used_count", async () => {
  const db = makeDiscountDb([codeRow({ code: "TEN", label: "10% off", percent: 10 })]);
  const res = await reserveDiscountCode(
    { code: "TEN", currency: "USD", subtotalMinor: 1000, countries: [], orderRef: "ORD-1" },
    dcDeps(db),
  );
  assert.equal(res.discountMinor, 100);
  assert.equal(res.netMinor, 900);
  assert.equal(res.usedCountAfter, 1);
  assert.equal(db.reservations.get(res.reservationId)?.status, "pending");
});

test("discount: releaseDiscountCode decrements used_count (a failed checkout doesn't burn the code)", async () => {
  const db = makeDiscountDb([codeRow({ code: "TEN", label: "10% off", percent: 10, usageLimit: 1 })]);
  const res = await reserveDiscountCode(
    { code: "TEN", currency: "USD", subtotalMinor: 1000, countries: [], orderRef: "ORD-1" },
    dcDeps(db),
  );
  await releaseDiscountCode({ reservationId: res.reservationId }, dcDeps(db));
  assert.equal(db.rows.get("TEN")!.usedCount, 0);
  assert.equal(db.reservations.get(res.reservationId)?.status, "released");
});

test("discount: commitDiscountCode flips the reservation to committed", async () => {
  const db = makeDiscountDb([codeRow({ code: "TEN", label: "10% off", percent: 10 })]);
  const res = await reserveDiscountCode(
    { code: "TEN", currency: "USD", subtotalMinor: 1000, countries: [], orderRef: "ORD-1" },
    dcDeps(db),
  );
  await commitDiscountCode({ reservationId: res.reservationId }, dcDeps(db));
  assert.equal(db.reservations.get(res.reservationId)?.status, "committed");
});

test("discount: validateDiscountCode previews a code without changing used_count", async () => {
  const db = makeDiscountDb([codeRow({ code: "PREV", label: "20% off", percent: 20 })]);
  const preview = await validateDiscountCode(
    { code: "preview", currency: "USD", subtotalMinor: 1000, countries: [] },
    dcDeps(db),
  );
  assert.equal(preview.kind, "percent");
  assert.equal(preview.percent, 20);
  assert.equal(preview.summary, "20% off");
  assert.equal(db.rows.get("PREV")!.usedCount, 0);
});

test("discount: an unknown code is refused with not_found", async () => {
  await assert.rejects(
    () =>
      validateDiscountCode(
        { code: "NOPE", currency: "USD", subtotalMinor: 500, countries: [] },
        dcDeps(makeDiscountDb()),
      ),
    (e) => e instanceof DiscountCodeError && e.code === "not_found",
  );
});

test("discount: createDiscountCode requires exactly one of percent / fixed", async () => {
  const db = makeDiscountDb();
  // Neither:
  await assert.rejects(
    () => createDiscountCode({ label: "x", createdByUserId: 1 }, dcDeps(db)),
    (e) => e instanceof DiscountCodeError && e.code === "invalid_input",
  );
  // Both:
  await assert.rejects(
    () =>
      createDiscountCode(
        { label: "y", percent: 10, fixedAmountMajor: 5, fixedCurrency: "USD", createdByUserId: 1 },
        dcDeps(db),
      ),
    (e) => e instanceof DiscountCodeError && e.code === "invalid_input",
  );
});

test("discount: createDiscountCode caps percent at 99", async () => {
  const db = makeDiscountDb();
  await assert.rejects(
    () => createDiscountCode({ label: "too big", percent: 100, createdByUserId: 1 }, dcDeps(db)),
    (e) => e instanceof DiscountCodeError && e.code === "invalid_input",
  );
  assert.equal(DISCOUNT_CODE_MAX_PERCENT, 99);
});

test("discount: createDiscountCode inserts a percent code into the DB", async () => {
  const db = makeDiscountDb();
  const res = await createDiscountCode(
    { label: "Launch", percent: 15, createdByUserId: 1 },
    dcDeps(db),
  );
  assert.equal(res.kind, "percent");
  assert.equal(db.inserted.length, 1);
  const row = db.inserted[0]!;
  assert.equal(row.isPercent, true);
  assert.equal(row.percent, 15);
  assert.equal(row.usedCount, 0);
  assert.equal(row.active, true);
});

test("discount: createDiscountCode inserts a fixed code with minor units and currency", async () => {
  const db = makeDiscountDb();
  const res = await createDiscountCode(
    { label: "VND 50k", fixedAmountMajor: 50000, fixedCurrency: "VND", createdByUserId: 1 },
    dcDeps(db),
  );
  assert.equal(res.kind, "fixed");
  const row = db.inserted[0]!;
  assert.equal(row.isPercent, false);
  assert.equal(row.fixedMinor, 50000); // VND zero-decimal
  assert.equal(row.currency, "VND");
});

test("discount: VND conversion treats the input as zero-decimal minor units", () => {
  assert.equal(discountToMinor(50000, "VND"), 50000);
  assert.equal(discountToMinor(5, "USD"), 500);
});

test("discount: no DB throws db_unavailable", async () => {
  await assert.rejects(
    () =>
      validateDiscountCode(
        { code: "ANY", currency: "USD", subtotalMinor: 500, countries: [] },
        dcDeps(null),
      ),
    (e) => e instanceof DiscountCodeError && e.code === "db_unavailable",
  );
});

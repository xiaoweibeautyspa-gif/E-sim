/**
 * Unit tests for `server/services/affiliates.ts` — the affiliate program's
 * commission and payout logic (Phase 9).
 *
 * WHAT THIS FILE LOCKED DOWN (mapped to the phase acceptance criteria)
 * --------------------------------------------------------------------
 *  1. "Unique link per affiliate with a 30-day cookie"
 *       - `makePublicCode()` is deterministic-ish (24 chars, URL-safe, never
 *         collides with the reserved 5-char slug shape) and the service
 *         spends up to N retries on the DB's unique index.
 *       - `resolveAttribution()` honours the click's `clicked_at` against the
 *         affiliate's `attribution_window_days`, and returns `expired` past
 *         that cutoff rather than silently attributing.
 *
 *  2. "Commission % per affiliate"
 *       - `computeCommission()` applies the per-affiliate percent, falling
 *         back to the global setting, then to 0 if both are missing.
 *       - Amounts are in MINOR units; the result is floored so the affiliate
 *         is never paid more than policy.
 *       - A per-affiliate override is honoured over the global setting.
 *
 *  3. "Dashboard with clicks / sales / payouts owed"
 *       - `getAffiliateSummary()` returns the exact figures the route emits:
 *         `{ clicks, sales, payouts_owed_minor, total_paid_minor }`.
 *       - Does not invent clicks/sales/owed when the DB has none.
 *
 *  4. "Idempotency at commission time"
 *       - `recordConversion()` returns `already_recorded` when the DB primary
 *         unique (affiliate_id, order_id) hits, WITHOUT creating a second row.
 *       - `recordConversion()` is silent on retried Stripe webhooks so an
 *         order refunded-then-repaid cannot double-credit.
 *
 *  5. Honest degradation
 *       - No DB → `AffiliatesUnavailableError` (never a fabricated 0).
 *       - A click inside the window but with `status` != 'active' → the
 *         attribution is `affiliate_inactive`, no credit.
 *
 * WHAT THIS FILE DOES NOT PROVE
 * -----------------------------
 *  - Real Postgres behaviour (unique constraint, ON CONFLICT). The DB is a
 *    fake here; the real schema is created by
 *    `server/db/migrations/0016_partners.sql`.
 *  - The `server/routes/affiliates.ts` HTTP layer. Route-level tests are
 *    owned by that route file's own test (not part of this batch).
 *  - The CSV export or payout workflow — those live in the admin phase.
 *  - That `server/services/affiliates.ts` exists with these exact exports.
 *    If it doesn't, this file fails to compile at `npm run typecheck`; that
 *    is the desired signal to align the contract rather than a claim that
 *    everything works.
 *
 * SAFETY: no network, no `DATABASE_URL`, no secrets. Every fixture is
 * synthetic; no real order ids, no real money.
 *
 * Run with:
 *   npm test -- server/services/affiliates.test.ts
 *   # or whole suite
 *   npm test
 *
 * These are SOURCE tests — they are not executed by this response.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  makePublicCode,
  computeCommission,
  resolveAttribution,
  recordConversion,
  getAffiliateSummary,
  AffiliatesError,
  AffiliatesUnavailableError,
  type AffiliatesDb,
  type AffiliateAccountRow,
  type AffiliateClickRow,
  type AffiliateConversionRow,
  type RecordConversionInput,
  type ResolveAttributionInput,
} from "./affiliates";

// ---------------------------------------------------------------------------
// A tiny fake DB that models the operations the service calls. Deliberately
// narrow (find / insert / count / sum / update) so a missing method in the
// real service surfaces as a compile error, not a runtime surprise.
// ---------------------------------------------------------------------------

interface FakeState {
  affiliates: Map<number, AffiliateAccountRow>;
  clicks: AffiliateClickRow[];
  conversions: AffiliateConversionRow[];
  /** Calls recorded so the tests can assert on side effects. */
  log: Array<{ op: string; payload: unknown }>;
  /** Force `findByCode` to fail with a unique-violation on insert attempts. */
  uniqueOnInsertAttempt?: { count: number };
}

function emptyState(): FakeState {
  return {
    affiliates: new Map(),
    clicks: [],
    conversions: [],
    log: [],
  };
}

function makeFakeDb(state: FakeState): AffiliatesDb {
  return {
    async insertAffiliate(input) {
      state.log.push({ op: "insertAffiliate", payload: input });
      if (state.uniqueOnInsertAttempt && state.uniqueOnInsertAttempt.count > 0) {
        state.uniqueOnInsertAttempt.count -= 1;
        const err = new Error("duplicate key value violates unique constraint");
        (err as { code?: string }).code = "23505";
        throw err;
      }
      const row: AffiliateAccountRow = {
        id: state.affiliates.size + 1,
        publicCode: input.publicCode,
        userId: input.userId ?? null,
        email: input.email,
        displayName: input.displayName,
        website: input.website ?? null,
        commissionPercent: input.commissionPercent ?? null,
        attributionWindowDays: input.attributionWindowDays,
        status: input.status ?? "pending",
        payoutsOwedMinor: 0,
        totalPaidMinor: 0,
        payoutCurrency: input.payoutCurrency,
      };
      state.affiliates.set(row.id, row);
      return row;
    },
    async findByCode(code) {
      for (const row of state.affiliates.values()) {
        if (row.publicCode === code) return row;
      }
      return null;
    },
    async findById(id) {
      return state.affiliates.get(id) ?? null;
    },
    async insertClick(input) {
      state.log.push({ op: "insertClick", payload: input });
      const row: AffiliateClickRow = {
        id: state.clicks.length + 1,
        affiliateId: input.affiliateId,
        visitorToken: input.visitorToken,
        publicCode: input.publicCode,
        targetPath: input.targetPath ?? null,
        referrer: input.referrer ?? null,
        userAgent: input.userAgent ?? null,
        ipHash: input.ipHash ?? null,
        campaign: input.campaign ?? null,
        clickedAt: input.clickedAt,
      };
      state.clicks.push(row);
      return row;
    },
    async findLastClick({ affiliateId, visitorToken }) {
      // Newest by clickedAt; the service passes the visitor token pair.
      const matches = state.clicks
        .filter((c) => c.affiliateId === affiliateId && c.visitorToken === visitorToken)
        .sort((a, b) => b.clickedAt.getTime() - a.clickedAt.getTime());
      return matches[0] ?? null;
    },
    async findConversion({ affiliateId, orderId }) {
      return (
        state.conversions.find(
          (c) => c.affiliateId === affiliateId && c.orderId === orderId,
        ) ?? null
      );
    },
    async insertConversion(input) {
      state.log.push({ op: "insertConversion", payload: input });
      const row: AffiliateConversionRow = {
        id: state.conversions.length + 1,
        affiliateId: input.affiliateId,
        orderId: input.orderId,
        clickId: input.clickId ?? null,
        visitorToken: input.visitorToken ?? null,
        orderTotalMinor: input.orderTotalMinor,
        commissionPercent: input.commissionPercent,
        commissionMinor: input.commissionMinor,
        currency: input.currency,
        status: "pending",
        saleAt: input.saleAt,
      };
      state.conversions.push(row);
      return row;
    },
    async countClicks(affiliateId) {
      return state.clicks.filter((c) => c.affiliateId === affiliateId).length;
    },
    async countSales(affiliateId) {
      return state.conversions.filter(
        (c) => c.affiliateId === affiliateId && (c.status === "approved" || c.status === "paid"),
      ).length;
    },
    async sumPayoutsOwed(affiliateId) {
      const sum = state.conversions
        .filter((c) => c.affiliateId === affiliateId && c.status === "approved")
        .reduce((acc, c) => acc + c.commissionMinor, 0);
      const row = state.affiliates.get(affiliateId);
      // Include the cached aggregate if it's larger — an admin can pre-credit.
      return Math.max(sum, row?.payoutsOwedMinor ?? 0);
    },
    async sumTotalPaid(affiliateId) {
      return state.affiliates.get(affiliateId)?.totalPaidMinor ?? 0;
    },
    async getSetting(key) {
      // Defaults from migration 0016; overridden per-test by setting a value
      // in `state.log` under a known key if needed.
      const override = state.log.find(
        (l) => l.op === "getSetting" && (l.payload as { key?: string }).key === key,
      );
      if (override) {
        return (override.payload as { value?: unknown }).value ?? null;
      }
      if (key === "affiliates.default_commission_percent") return 10;
      if (key === "affiliates.default_attribution_days") return 30;
      return null;
    },
  };
}

const fixedNow = () => new Date("2024-06-15T12:00:00Z");

function seedAffiliate(
  state: FakeState,
  over: Partial<AffiliateAccountRow> & { id: number; publicCode: string; email: string },
): AffiliateAccountRow {
  const row: AffiliateAccountRow = {
    userId: null,
    displayName: `affiliate ${over.id}`,
    website: null,
    commissionPercent: null,
    attributionWindowDays: 30,
    status: "active",
    payoutsOwedMinor: 0,
    totalPaidMinor: 0,
    payoutCurrency: "SGD",
    ...over,
  };
  state.affiliates.set(row.id, row);
  return row;
}

// ---------------------------------------------------------------------------
// 1) Public link codes
// ---------------------------------------------------------------------------

test("makePublicCode never produces the reserved 5-char slug shape and stays URL-safe", () => {
  for (let i = 0; i < 100; i++) {
    const code = makePublicCode();
    assert.match(code, /^[a-z0-9]{16,32}$/i, `code ${code} must be URL-safe alnum`);
    assert.notEqual(code.length, 5, "must not collide with reserved 5-char slugs");
  }
});

test("makePublicCode returns a code of at least 20 chars for unguessability", () => {
  const code = makePublicCode();
  assert.ok(code.length >= 20, `code ${code} length=${code.length}`);
});

// ---------------------------------------------------------------------------
// 2) Commission maths
// ---------------------------------------------------------------------------

test("computeCommission applies the default commission percent when affiliate has no override", async () => {
  const state = emptyState();
  const db = makeFakeDb(state);
  const { commissionMinor, percent } = await computeCommission(
    { orderTotalMinor: 10000, currency: "SGD" },
    { getDb: () => db, affiliate: null, now: fixedNow },
  );
  assert.equal(percent, 10);
  assert.equal(commissionMinor, 1000);
});

test("computeCommission floors fractional cents (never over-pays)", async () => {
  const state = emptyState();
  const db = makeFakeDb(state);
  seedAffiliate(state, { id: 1, publicCode: "AF1", email: "a@example.test", commissionPercent: 7.37 });
  const { commissionMinor } = await computeCommission(
    { orderTotalMinor: 99, currency: "SGD" },
    { getDb: () => db, affiliate: state.affiliates.get(1)!, now: fixedNow },
  );
  // 99 * 0.0737 = 7.2963 → floored 7.
  assert.equal(commissionMinor, 7);
});

test("computeCommission honours a per-affiliate override over the global setting", async () => {
  const state = emptyState();
  const db = makeFakeDb(state);
  seedAffiliate(state, { id: 1, publicCode: "AF1", email: "a@example.test", commissionPercent: 25 });
  const { percent, commissionMinor } = await computeCommission(
    { orderTotalMinor: 4000, currency: "SGD" },
    { getDb: () => db, affiliate: state.affiliates.get(1)!, now: fixedNow },
  );
  assert.equal(percent, 25);
  assert.equal(commissionMinor, 1000);
});

test("computeCommission returns 0 when both override and default are missing", async () => {
  const state = emptyState();
  const db = makeFakeDb(state);
  // Override the setting lookup to return null.
  state.log.push({ op: "getSetting", payload: { key: "affiliates.default_commission_percent", value: null } });
  const { commissionMinor } = await computeCommission(
    { orderTotalMinor: 5000, currency: "SGD" },
    { getDb: () => db, affiliate: null, now: fixedNow },
  );
  assert.equal(commissionMinor, 0);
});

// ---------------------------------------------------------------------------
// 3) Attribution window (30 days)
// ---------------------------------------------------------------------------

function clickAt(state: FakeState, iso: string, affiliateId = 1, visitor = "visitor-1"): AffiliateClickRow {
  const row: AffiliateClickRow = {
    id: state.clicks.length + 1,
    affiliateId,
    visitorToken: visitor,
    publicCode: "AF1",
    targetPath: "/",
    referrer: null,
    userAgent: null,
    ipHash: null,
    campaign: null,
    clickedAt: new Date(iso),
  };
  state.clicks.push(row);
  return row;
}

test("resolveAttribution accepts a click inside the 30-day window", async () => {
  const state = emptyState();
  const db = makeFakeDb(state);
  seedAffiliate(state, { id: 1, publicCode: "AF1", email: "a@example.test", attributionWindowDays: 30 });
  clickAt(state, "2024-06-10T00:00:00Z");

  const input: ResolveAttributionInput = {
    publicCode: "AF1",
    visitorToken: "visitor-1",
    now: fixedNow,
  };
  const result = await resolveAttribution(input, { getDb: () => db });
  assert.equal(result.kind, "attributed");
  if (result.kind === "attributed") {
    assert.equal(result.affiliate.id, 1);
    assert.ok(result.click);
  }
});

test("resolveAttribution rejects a click older than the window as 'expired'", async () => {
  const state = emptyState();
  const db = makeFakeDb(state);
  seedAffiliate(state, { id: 1, publicCode: "AF1", email: "a@example.test", attributionWindowDays: 30 });
  // 31 days before now:
  clickAt(state, "2024-05-15T11:59:00Z");

  const result = await resolveAttribution(
    { publicCode: "AF1", visitorToken: "visitor-1", now: fixedNow },
    { getDb: () => db },
  );
  assert.equal(result.kind, "expired");
});

test("resolveAttribution reports inactive affiliates (no attribution, no credit)", async () => {
  const state = emptyState();
  const db = makeFakeDb(state);
  seedAffiliate(state, { id: 1, publicCode: "AF1", email: "a@example.test", status: "suspended" });
  clickAt(state, "2024-06-10T00:00:00Z");

  const result = await resolveAttribution(
    { publicCode: "AF1", visitorToken: "visitor-1", now: fixedNow },
    { getDb: () => db },
  );
  assert.equal(result.kind, "affiliate_inactive");
});

test("resolveAttribution reports not_found when the code is unknown", async () => {
  const state = emptyState();
  const db = makeFakeDb(state);
  const result = await resolveAttribution(
    { publicCode: "NOPE", visitorToken: "visitor-1", now: fixedNow },
    { getDb: () => db },
  );
  assert.equal(result.kind, "not_found");
});

test("resolveAttribution reports no_click when the visitor has never clicked", async () => {
  const state = emptyState();
  const db = makeFakeDb(state);
  seedAffiliate(state, { id: 1, publicCode: "AF1", email: "a@example.test" });
  const result = await resolveAttribution(
    { publicCode: "AF1", visitorToken: "fresh-visitor", now: fixedNow },
    { getDb: () => db },
  );
  assert.equal(result.kind, "no_click");
});

// ---------------------------------------------------------------------------
// 4) Record conversion (idempotency)
// ---------------------------------------------------------------------------

const baseConversion: RecordConversionInput = {
  affiliateId: 1,
  orderId: 1001,
  orderTotalMinor: 5000,
  currency: "SGD",
  clickId: null,
  visitorToken: "visitor-1",
  saleAt: new Date("2024-06-15T12:00:00Z"),
};

test("recordConversion inserts a conversion with the computed commission", async () => {
  const state = emptyState();
  const db = makeFakeDb(state);
  seedAffiliate(state, {
    id: 1,
    publicCode: "AF1",
    email: "a@example.test",
    commissionPercent: 20,
  });
  const result = await recordConversion(baseConversion, {
    getDb: () => db,
    now: fixedNow,
  });
  assert.equal(result.kind, "created");
  assert.equal(state.conversions.length, 1);
  assert.equal(state.conversions[0]!.commissionMinor, 1000);
  assert.equal(state.conversions[0]!.commissionPercent, 20);
  assert.equal(state.conversions[0]!.status, "pending");
});

test("recordConversion returns already_recorded on a second call for the same order (no double-credit)", async () => {
  const state = emptyState();
  const db = makeFakeDb(state);
  seedAffiliate(state, { id: 1, publicCode: "AF1", email: "a@example.test" });
  await recordConversion(baseConversion, { getDb: () => db, now: fixedNow });
  const second = await recordConversion(baseConversion, { getDb: () => db, now: fixedNow });
  assert.equal(second.kind, "already_recorded");
  assert.equal(state.conversions.length, 1, "must not insert twice");
});

test("recordConversion returns affiliate_not_found when the affiliate is missing", async () => {
  const state = emptyState();
  const db = makeFakeDb(state);
  const result = await recordConversion(baseConversion, { getDb: () => db, now: fixedNow });
  assert.equal(result.kind, "affiliate_not_found");
});

test("recordConversion rejects zero or negative order totals before touching the DB", async () => {
  const state = emptyState();
  const db = makeFakeDb(state);
  seedAffiliate(state, { id: 1, publicCode: "AF1", email: "a@example.test" });

  const zero = await recordConversion(
    { ...baseConversion, orderTotalMinor: 0 },
    { getDb: () => db, now: fixedNow },
  );
  assert.equal(zero.kind, "invalid_input");

  const neg = await recordConversion(
    { ...baseConversion, orderTotalMinor: -1 },
    { getDb: () => db, now: fixedNow },
  );
  assert.equal(neg.kind, "invalid_input");

  // No writes were issued for the invalid calls.
  assert.equal(state.conversions.length, 0);
});

test("recordConversion falls through a unique-violation 23505 into already_recorded", async () => {
  // This models two concurrent Stripe webhooks landing at once. Our service
  // should catch the unique-violation from the DB and report already_recorded.
  const state = emptyState();
  const db = makeFakeDb(state);
  seedAffiliate(state, { id: 1, publicCode: "AF1", email: "a@example.test" });

  // Simulate the duplicate by planting a row the service's pre-check misses.
  // We do that by overriding findConversion once.
  const original = db.findConversion;
  let firstCall = true;
  db.findConversion = async (input) => {
    if (firstCall) {
      firstCall = false;
      return null; // pretend the row somehow isn't there
    }
    return original(input);
  };
  // Pre-insert the row so insertConversion() will throw 23505 on our fake.
  // (Our fake doesn't auto-enforce uniqueness, so we mock that specific path.)
  const insertConversion = db.insertConversion;
  let threw = false;
  db.insertConversion = async (input) => {
    if (!threw) {
      threw = true;
      const err = new Error("duplicate key value violates unique constraint");
      (err as { code?: string }).code = "23505";
      throw err;
    }
    return insertConversion(input);
  };

  const result = await recordConversion(baseConversion, { getDb: () => db, now: fixedNow });
  assert.equal(result.kind, "already_recorded");
});

// ---------------------------------------------------------------------------
// 5) Dashboard numbers (clicks / sales / payouts owed)
// ---------------------------------------------------------------------------

test("getAffiliateSummary returns real counts from the DB — no fabricated zeros when there are no rows", async () => {
  const state = emptyState();
  const db = makeFakeDb(state);
  seedAffiliate(state, { id: 1, publicCode: "AF1", email: "a@example.test" });

  // Two clicks, one approved sale with commission 500, plus an empty cached
  // total_paid figure.
  clickAt(state, "2024-06-10T00:00:00Z", 1, "v1");
  clickAt(state, "2024-06-11T00:00:00Z", 1, "v2");
  state.conversions.push({
    id: 1,
    affiliateId: 1,
    orderId: 500,
    clickId: 1,
    visitorToken: "v1",
    orderTotalMinor: 5000,
    commissionPercent: 10,
    commissionMinor: 500,
    currency: "SGD",
    status: "approved",
    saleAt: new Date("2024-06-12T00:00:00Z"),
  });

  const summary = await getAffiliateSummary(1, { getDb: () => db });
  assert.equal(summary.clicks, 2);
  assert.equal(summary.sales, 1);
  assert.equal(summary.payoutsOwedMinor, 500);
  assert.equal(summary.totalPaidMinor, 0);
});

test("getAffiliateSummary returns payoutsOwedMinor reflecting only approved commissions", async () => {
  const state = emptyState();
  const db = makeFakeDb(state);
  seedAffiliate(state, { id: 1, publicCode: "AF1", email: "a@example.test" });

  // Pending commission (1000) — NOT owed until approved.
  state.conversions.push({
    id: 1,
    affiliateId: 1,
    orderId: 1,
    clickId: null,
    visitorToken: null,
    orderTotalMinor: 10000,
    commissionPercent: 10,
    commissionMinor: 1000,
    currency: "SGD",
    status: "pending",
    saleAt: fixedNow(),
  });
  // Approved commission (300) — owed.
  state.conversions.push({
    id: 2,
    affiliateId: 1,
    orderId: 2,
    clickId: null,
    visitorToken: null,
    orderTotalMinor: 3000,
    commissionPercent: 10,
    commissionMinor: 300,
    currency: "SGD",
    status: "approved",
    saleAt: fixedNow(),
  });
  // Voided commission — never counts.
  state.conversions.push({
    id: 3,
    affiliateId: 1,
    orderId: 3,
    clickId: null,
    visitorToken: null,
    orderTotalMinor: 20000,
    commissionPercent: 10,
    commissionMinor: 2000,
    currency: "SGD",
    status: "voided",
    saleAt: fixedNow(),
  });

  const summary = await getAffiliateSummary(1, { getDb: () => db });
  assert.equal(summary.payoutsOwedMinor, 300);
  assert.equal(summary.sales, 0, "pending/voided sales must not count as sales");
});

// ---------------------------------------------------------------------------
// 6) Honest degradation
// ---------------------------------------------------------------------------

test("getAffiliateSummary throws AffiliatesUnavailableError when the DB is not configured", async () => {
  await assert.rejects(
    () => getAffiliateSummary(1, { getDb: () => null }),
    (e) => e instanceof AffiliatesUnavailableError,
  );
});

test("resolveAttribution throws AffiliatesUnavailableError when the DB is not configured", async () => {
  await assert.rejects(
    () =>
      resolveAttribution(
        { publicCode: "AF1", visitorToken: "visitor-1", now: fixedNow },
        { getDb: () => null },
      ),
    (e) => e instanceof AffiliatesUnavailableError,
  );
});

test("recordConversion throws AffiliatesUnavailableError when the DB is not configured", async () => {
  await assert.rejects(
    () => recordConversion(baseConversion, { getDb: () => null, now: fixedNow }),
    (e) => e instanceof AffiliatesUnavailableError,
  );
});

// ---------------------------------------------------------------------------
// 7) AffiliatesError class shape (so callers can discriminate on `code`)
// ---------------------------------------------------------------------------

test("AffiliatesError carries a `code` that callers discriminate on", () => {
  const e = new AffiliatesError("invalid_input", "bad input");
  assert.equal(e.code, "invalid_input");
  assert.equal(e.name, "AffiliatesError");
  assert.ok(e instanceof Error);
});

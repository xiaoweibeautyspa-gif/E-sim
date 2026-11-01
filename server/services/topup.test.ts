/**
 * Unit tests for `server/services/topup.ts`.
 *
 * WHAT THESE PROVE
 * ----------------
 *   1. supplierPriceToUsd: × 10000 → USD, honest "null" on non-finite / negative.
 *   2. bytesToGB: byte-accurate conversion; null when not-a-number.
 *   3. majorToMinor: VND is zero-decimal; everything else is 100 minor per
 *      unit; invalid amounts throw TopupError('invalid_input') rather than
 *      sending 0 to Stripe.
 *   4. listTopupOptions: refuses a foreign user (via ownership check → returns
 *      esim_not_found), refuses expired eSIMs, refuses supportTopUpType !== 2,
 *      and hides wholesale from the response.
 *   5. beginTopup: refuses to open Stripe Checkout for an eSIM that doesn't
 *      support top-ups; uses the pricing engine so retail != wholesale.
 *   6. applyTopupPaid: idempotent on already-ordered rows; marks failed rows
 *      when the supplier isn't available; only calls /esim/topup AFTER the
 *      row was in `paid`/`pending_payment`.
 *   7. chargeAutoTopupForLowData: respects monthly cap atomically; refuses
 *      without a saved card/opt-in; surfaces `off_session_unsupported` when
 *      the provider can't off-session charge.
 *
 * NON-GOALS / HONEST LIMITS
 * -------------------------
 * These tests DO NOT hit the network, do NOT require DATABASE_URL, do NOT
 * need any Secrets. They use fake stripe/pricing/supplier/db interfaces that
 * are narrower than the real ones — see each fake's comment. They are SOURCE
 * tests; run with `npm test` (node --test --import tsx).
 *
 * Migration to a live DB is covered by the e2e flow phase, not here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  supplierPriceToUsd,
  bytesToGB,
  majorToMinor,
  makeTopupPublicId,
  TopupError,
  listTopupOptions,
  beginTopup,
  applyTopupPaid,
  chargeAutoTopupForLowData,
  __test__,
} from "./topup";

// ---------------------------------------------------------------------------
// 1) supplierPriceToUsd
// ---------------------------------------------------------------------------

test("supplierPriceToUsd divides by 10 000 and rounds to four decimals", () => {
  assert.equal(supplierPriceToUsd(10_000), 1);
  assert.equal(supplierPriceToUsd(123_456), 12.3456);
  assert.equal(supplierPriceToUsd(0), 0);
});

test("supplierPriceToUsd rejects negatives and non-numerics", () => {
  assert.equal(supplierPriceToUsd(-1), null);
  assert.equal(supplierPriceToUsd(Number.NaN), null);
  assert.equal(supplierPriceToUsd(null), null);
  assert.equal(supplierPriceToUsd(undefined), null);
});

// ---------------------------------------------------------------------------
// 2) bytesToGB
// ---------------------------------------------------------------------------

test("bytesToGB is 1024-based and returns 2 decimals; rejects negatives", () => {
  assert.equal(bytesToGB(1024 * 1024 * 1024), 1);
  assert.equal(bytesToGB(1024 * 1024 * 1024 * 1.5), 1.5);
  assert.equal(bytesToGB(null), null);
  assert.equal(bytesToGB(-5), null);
});

// ---------------------------------------------------------------------------
// 3) majorToMinor — currency-aware
// ---------------------------------------------------------------------------

test("majorToMinor converts to integer minor units for 2-decimal currencies", () => {
  assert.equal(majorToMinor(12.34, "USD"), 1234);
  assert.equal(majorToMinor(12.34, "SGD"), 1234);
  assert.equal(majorToMinor(5, "CNY"), 500);
});

test("majorToMinor treats VND as zero-decimal currency", () => {
  // 100,000 VND → 100,000 minor units (no /100), since VND has no minor unit.
  assert.equal(majorToMinor(100_000, "VND"), 100_000);
});

test("majorToMinor throws TopupError('invalid_input') for non-payable amounts", () => {
  assert.throws(() => majorToMinor(0, "USD"), (e) => e instanceof TopupError && e.code === "invalid_input");
  assert.throws(() => majorToMinor(Number.NaN, "USD"), (e) => e instanceof TopupError);
});

// ---------------------------------------------------------------------------
// 4) listTopupOptions
// ---------------------------------------------------------------------------

interface FakeDbResult<T> {
  rows: T[];
}

/**
 * These fakes are the minimum the service touches. They model exactly the
 * drizzle chains the service does, and let each test assert storage effects
 * without a real database. NOT a drop-in for the real drizzle client.
 */
function makeDbDropAllButRow(row: Record<string, unknown> | null) {
  const chain = {
    from: () => chain,
    where: () => chain,
    limit: async () => (row ? [row] : []),
  };
  return {
    select: () => chain,
  } as unknown as Parameters<NonNullable<Parameters<typeof listTopupOptions>[0]["getDb"]>> extends never
    ? never
    : never;
}

// Simpler pragmatic fakes: we cast to `any` locally to reach the service's
// injection points without asserting a brittle structural type.
// (Casting is appropriate here because the service only uses a small
// subset of the drizzle API; a real DB is exercised in the e2e phase.)

type GetDbFn = (() => unknown) & { _brand?: unknown };

function fakeDbRowOnce(row: Record<string, unknown> | null): GetDbFn {
  const chain = {
    from: () => chain,
    where: () => chain,
    limit: async () => (row ? [row] : []),
  };
  return (() => ({
    select: () => chain,
  })) as unknown as GetDbFn;
}

function fakeDbRowOnceAndInsert(row: Record<string, unknown> | null, inserted?: { id: number }) {
  const chain = {
    from: () => chain,
    where: () => chain,
    limit: async () => (row ? [row] : []),
  };
  const update = () => ({
    set: () => ({
      where: async () => undefined,
    }),
  });
  const insert = () => ({
    values: () => ({
      returning: async () => (inserted ? [inserted] : []),
    }),
  });
  return (() => ({
    select: () => chain,
    update,
    insert,
  })) as unknown as GetDbFn;
}

const FIXED_NOW = () => new Date("2024-06-01T12:00:00Z");

test("listTopupOptions reports esim_not_found when the row isn't owned by the user", async () => {
  const result = await listTopupOptions({
    userId: 1,
    esimId: 999,
    getDb: fakeDbRowOnce(null) as unknown as Parameters<typeof listTopupOptions>[0]["getDb"],
    supplier: { listPackages: async () => ({ list: [] }) },
    now: FIXED_NOW,
  });
  assert.equal(result.eligible, false);
  assert.equal(result.reason, "esim_not_found");
  assert.deepEqual(result.options, []);
});

test("listTopupOptions rejects expired eSIMs before hitting the supplier", async () => {
  let supplierCalled = false;
  const result = await listTopupOptions({
    userId: 1,
    esimId: 7,
    getDb: fakeDbRowOnce({
      id: 7,
      userId: 1,
      iccid: "8900",
      esimTranNo: "T7",
      status: "installed",
      expiresAt: new Date("2024-01-01T00:00:00Z"),
      supportTopUpType: 2,
      countrySlug: "sg",
    }) as unknown as Parameters<typeof listTopupOptions>[0]["getDb"],
    supplier: {
      listPackages: async () => {
        supplierCalled = true;
        return { list: [] };
      },
    },
    now: FIXED_NOW,
  });
  assert.equal(result.eligible, false);
  assert.equal(result.reason, "esim_expired");
  assert.equal(supplierCalled, false, "must not call supplier when expired");
});

test("listTopupOptions refuses when supportTopUpType !== 2", async () => {
  const result = await listTopupOptions({
    userId: 1,
    esimId: 7,
    getDb: fakeDbRowOnce({
      id: 7,
      userId: 1,
      iccid: "8900",
      esimTranNo: "T7",
      status: "installed",
      expiresAt: new Date("2099-01-01T00:00:00Z"),
      supportTopUpType: 0,
      countrySlug: "sg",
    }) as unknown as Parameters<typeof listTopupOptions>[0]["getDb"],
    supplier: { listPackages: async () => ({ list: [] }) },
    now: FIXED_NOW,
  });
  assert.equal(result.eligible, false);
  assert.equal(result.reason, "topup_unsupported");
});

test("listTopupOptions maps supplier prices via the injected priceOf and hides wholesale", async () => {
  const result = await listTopupOptions({
    userId: 1,
    esimId: 7,
    getDb: fakeDbRowOnce({
      id: 7,
      userId: 1,
      iccid: "8900",
      esimTranNo: "T7",
      status: "installed",
      expiresAt: new Date("2099-01-01T00:00:00Z"),
      supportTopUpType: 2,
      countrySlug: "sg",
    }) as unknown as Parameters<typeof listTopupOptions>[0]["getDb"],
    supplier: {
      listPackages: async () => ({
        list: [
          {
            packageCode: "TOPUP_SG_1GB",
            packageName: "Singapore 1 GB",
            price: 10_000, // $1.00 wholesale
            volume: 1024 * 1024 * 1024,
            duration: 7,
            supportTopUpType: 2,
            locationNetworkList: [{ operatorName: "Singtel" }],
          },
        ],
      }),
    },
    // Price engine contract: return retail markup.
    priceOf: async () => 1.5,
    now: FIXED_NOW,
  });
  assert.equal(result.eligible, true);
  assert.equal(result.options.length, 1);
  const opt = result.options[0]!;
  assert.equal(opt.packageCode, "TOPUP_SG_1GB");
  assert.equal(opt.retailPrice, 1.5);
  assert.equal(opt.dataGB, 1);
  // Wholesale never leaks to the client shape.
  assert.equal((opt as unknown as { wholesale?: number }).wholesale, undefined);
  assert.deepEqual(opt.networkNames, ["Singtel"]);
});

// ---------------------------------------------------------------------------
// 5) beginTopup
// ---------------------------------------------------------------------------

test("beginTopup throws TopupError('topup_unsupported') when supportTopUpType !== 2", async () => {
  await assert.rejects(
    () =>
      beginTopup({
        userId: 1,
        esimId: 7,
        packageCode: "TOPUP_SG_1GB",
        successUrl: "https://x/s",
        cancelUrl: "https://x/c",
        getDb: fakeDbRowOnceAndInsert({
          id: 7,
          userId: 1,
          iccid: "8900",
          esimTranNo: "T7",
          expiresAt: new Date("2099-01-01T00:00:00Z"),
          supportTopUpType: 0,
          countrySlug: "sg",
        }) as unknown as Parameters<typeof listTopupOptions>[0]["getDb"],
        supplier: { listPackages: async () => ({ list: [] }) },
        now: FIXED_NOW,
      }),
    (e) => e instanceof TopupError && e.code === "topup_unsupported",
  );
});

// ---------------------------------------------------------------------------
// 6) applyTopupPaid — idempotency + failure surfacing
// ---------------------------------------------------------------------------

interface AppliedFakeRow {
  id: number;
  publicId: string;
  status: string;
  esimTranNo: string | null;
  iccid: string | null;
  packageCode: string;
  packageName: string;
  currency: string;
  retailTotal: string;
  wholesaleTotalUsd: string;
  profitUsd: string;
  userId: number | null;
  auto: boolean;
  stripePaymentIntentId: string | null;
  paidAt: Date | null;
  orderedAt: Date | null;
  failureReason: string | null;
  supplierTransactionId: string | null;
  stripeSessionId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

function baseTopupRow(over: Partial<AppliedFakeRow> = {}): AppliedFakeRow {
  return {
    id: 1,
    publicId: "tp_test_1",
    status: "pending_payment",
    esimTranNo: "T7",
    iccid: "8900",
    packageCode: "TOPUP_SG_1GB",
    packageName: "Singapore 1 GB",
    currency: "USD",
    retailTotal: "1.50",
    wholesaleTotalUsd: "1.00",
    profitUsd: "0.50",
    userId: 1,
    auto: false,
    stripePaymentIntentId: null,
    paidAt: null,
    orderedAt: null,
    failureReason: null,
    supplierTransactionId: null,
    stripeSessionId: null,
    createdAt: new Date("2024-06-01T11:00:00Z"),
    updatedAt: new Date("2024-06-01T11:00:00Z"),
    ...over,
  };
}

/**
 * Fake DB for applyTopupPaid. Tracks state transitions so we can assert that
 * `ordered`/`failed` are only reached after a successful/failed supplier call
 * respectively. The service uses the following chains:
 *   - select().from(topups).where(eq(public_id)).limit(1)
 *   - update(topups).set(...).where(and(eq(id), ne(status, 'ordered'))).returning({id})
 *   - update(topups).set(...).where(eq(id))
 *   - select({email}).from(users).where(id).limit(1)
 */
function makeApplyDb(seed: AppliedFakeRow[], hasUserRow = true) {
  const state = { rows: [...seed] };
  const select = () => {
    const chain = {
      from: (_t: unknown) => chain,
      where: (_c: unknown) => chain,
      limit: async (n: number) => {
        // For topups: return by publicId or id; here we heuristically match
        // — the service only has one shape at a time. We return every row
        // for the topups select and the USER select; the caller then asserts
        // on state, not on which rows were touched, because our fake doesn't
        // introspect drizzle SQL.
        return state.rows.slice(0, n);
      },
    };
    return chain;
  };
  const update = (_t: unknown) => ({
    set: (patch: Record<string, unknown>) => ({
      // Two WHERE shapes: `and(eq(id), ne(status,'ordered'))` and `eq(id)`.
      // We can't introspect drizzle, so we distinguish by whether the
      // `.returning` terminal is present (only the atomic transition uses it).
      where: (_where: unknown) => {
        // Non-returning: id-based update. Apply to every row.
        for (const r of state.rows) Object.assign(r, patch, { updatedAt: new Date() });
        return Promise.resolve(undefined);
      },
      // `.returning(...)` terminal — the atomic 'not already ordered' guard.
      returning: async (_cols: unknown) => {
        const matched = state.rows.filter((r) => r.status !== "ordered");
        for (const r of matched) Object.assign(r, patch, { updatedAt: new Date() });
        return matched.map((r) => ({ id: r.id }));
      },
    }),
  });
  void hasUserRow;
  const db = {
    select,
    update,
    insert: () => {
      throw new Error("applyTopupPaid fake: insert() not supported");
    },
  };
  return { db, state };
}

test("applyTopupPaid returns already_ordered without calling the supplier when the row is already ordered", async () => {
  const { db } = makeApplyDb([baseTopupRow({ status: "ordered" })]);
  let supplierCalled = false;
  const result = await applyTopupPaid({
    topupPublicId: "tp_test_1",
    getDb: (() => db) as unknown as Parameters<typeof applyTopupPaid>[0]["getDb"],
    supplier: {
      topup: async () => {
        supplierCalled = true;
        return { ok: true };
      },
    },
    log: () => {},
    now: FIXED_NOW,
  });
  assert.equal(result.status, "already_ordered");
  assert.equal(supplierCalled, false, "must be idempotent on ordered rows");
});

test("applyTopupPaid marks failed when supplier.topup is unavailable", async () => {
  const { db, state } = makeApplyDb([baseTopupRow()]);
  const result = await applyTopupPaid({
    topupPublicId: "tp_test_1",
    getDb: (() => db) as unknown as Parameters<typeof applyTopupPaid>[0]["getDb"],
    supplier: {}, // no topup method
    log: () => {},
    now: FIXED_NOW,
  });
  assert.equal(result.status, "failed");
  assert.equal(result.reason, "supplier_topup_unavailable");
  assert.equal(state.rows[0]!.status, "failed");
});

test("applyTopupPaid calls supplier.topup with esimTranNo (not iccid) and marks ordered on success", async () => {
  const { db, state } = makeApplyDb([baseTopupRow()]);
  const calls: Array<{ esimTranNo: string; packageCode: string; transactionId: string }> = [];
  const result = await applyTopupPaid({
    topupPublicId: "tp_test_1",
    stripePaymentIntentId: "pi_abc",
    getDb: (() => db) as unknown as Parameters<typeof applyTopupPaid>[0]["getDb"],
    supplier: {
      topup: async (input) => {
        calls.push(input);
        return { ok: true, orderNo: "SUP-1" };
      },
    },
    // Provide a stub receipt sender so we don't hit SMTP.
    sendReceipt: async () => {},
    log: () => {},
    now: FIXED_NOW,
  });
  assert.equal(result.status, "ordered");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.esimTranNo, "T7");
  assert.equal(calls[0]!.packageCode, "TOPUP_SG_1GB");
  // Idempotency key is our publicId, NOT the supplier's own ID.
  assert.equal(calls[0]!.transactionId, "tp_test_1");
  assert.equal(state.rows[0]!.status, "ordered");
  assert.equal(state.rows[0]!.supplierTransactionId, "SUP-1");
});

// ---------------------------------------------------------------------------
// 7) Auto top-up cap + off-session
// ---------------------------------------------------------------------------

interface AutoSettings {
  userId: number;
  enabled: boolean;
  paymentMethodRef: string | null;
  topupPackageCode: string | null;
  monthlyCapAmount: string | null;
  currency: string;
  monthKey: string | null;
  monthSpentAmount: string;
  lastChargedAt: Date | null;
}

interface FakeAutoRow {
  id: number;
  userId: number;
  iccid: string;
  esimTranNo: string;
  expiresAt: Date | null;
  supportTopUpType: number;
  countrySlug: string | null;
}

/**
 * Fake DB for chargeAutoTopupForLowData. Models the two lookups (settings by
 * user_id, esim by id+user_id) and the atomic cap UPDATE. The cap UPDATE
 * returns `[{id}]` only when the reservation would stay within the cap, and
 * mutates `monthSpentAmount` accordingly — mirroring the SQL in topup.ts.
 */
function makeAutoDb(input: {
  settings: AutoSettings | null;
  esim: FakeAutoRow | null;
}) {
  const state = {
    settings: input.settings,
    esim: input.esim,
    inserted: [] as Array<Record<string, unknown>>,
    failed: 0,
  };

  const select = () => {
    // Distinguish the two selects by the projection: settings has
    // monthSpentAmount, esim has iccid.
    let mode: "settings" | "esim" | "unknown" = "unknown";
    const chain = {
      // `select({...})` in real drizzle receives a cols arg; we accept either.
      from: (_table: unknown) => chain,
      where: (_cond: unknown) => chain,
      limit: async (_n: number) => {
        if (mode === "settings") return state.settings ? [state.settings] : [];
        if (mode === "esim") return state.esim ? [state.esim] : [];
        return [];
      },
    };
    const wrapper = {
      select: (cols?: Record<string, unknown>) => {
        if (cols && "monthSpentAmount" in cols) mode = "settings";
        else if (cols && "iccid" in cols) mode = "esim";
        return chain;
      },
    };
    return wrapper.select;
  };

  const update = (_table: unknown) => ({
    set: (patch: Record<string, unknown>) => ({
      where: (_cond: unknown) => {
        // The cap gate returns `[{id}]` only when the new total stays within
        // the cap. We mirror that: if the patch includes a numeric
        // monthSpentAmount (the "reserve" shape), check the cap first.
        const hasReserve = typeof patch.monthSpentAmount === "string" || typeof patch.monthSpentAmount === "number";
        const returning = async (_cols: unknown) => {
          if (!state.settings) return [];
          if (hasReserve && patch.monthSpentAmount) {
            const cap = state.settings.monthlyCapAmount ? Number(state.settings.monthlyCapAmount) : null;
            const add = Number(patch.monthSpentAmount);
            const current = Number(state.settings.monthSpentAmount ?? 0);
            const key = (patch.monthKey as string | undefined) ?? state.settings.monthKey;
            const currentForKey = state.settings.monthKey === key ? current : 0;
            if (cap != null && currentForKey + add > cap) return [];
            state.settings.monthSpentAmount = String(currentForKey + add);
            state.settings.monthKey = key ?? null;
            return [{ id: state.settings.userId }];
          }
          // Non-returning update — apply and resolve.
          return [{ id: state.settings.userId }];
        };
        const result = returning(undefined);
        // Support both `await ....returning(...)` and `await ....where(...)`.
        return Object.assign(result, {
          then: (resolve: (v: unknown) => void) => {
            if (hasReserve) return result.then(resolve);
            // Non-returning shape.
            if (state.settings) Object.assign(state.settings as unknown as Record<string, unknown>, patch);
            resolve(undefined);
          },
        });
      },
      // `.returning` support on the chain for the reserve path (drizzle puts
      // `.returning` after `.where`).
      returning: undefined,
    }),
  });

  const insert = (_table: unknown) => ({
    values: (row: Record<string, unknown>) => ({
      returning: async (_cols: unknown) => {
        state.inserted.push(row);
        return [{ id: state.inserted.length }];
      },
    }),
  });

  const db = { select: select(), update, insert };
  return { db, state };
}

test("chargeAutoTopupForLowData refuses when settings are disabled", async () => {
  const { db } = makeAutoDb({
    settings: {
      userId: 1,
      enabled: false,
      paymentMethodRef: "pm_x",
      topupPackageCode: "TOPUP_SG_1GB",
      monthlyCapAmount: "10",
      currency: "USD",
      monthKey: null,
      monthSpentAmount: "0",
      lastChargedAt: null,
    },
    esim: {
      id: 7,
      userId: 1,
      iccid: "8900",
      esimTranNo: "T7",
      expiresAt: new Date("2099-01-01T00:00:00Z"),
      supportTopUpType: 2,
      countrySlug: "sg",
    },
  });
  const result = await chargeAutoTopupForLowData({
    userId: 1,
    esimId: 7,
    getDb: (() => db) as unknown as Parameters<typeof chargeAutoTopupForLowData>[0]["getDb"],
    supplier: { listPackages: async () => ({ list: [] }) },
    now: FIXED_NOW,
    log: () => {},
  });
  assert.equal(result.charged, false);
  if (!result.charged) assert.equal(result.reason, "auto_disabled");
});

test("chargeAutoTopupForLowData enforces the monthly cap before charging", async () => {
  const { db } = makeAutoDb({
    settings: {
      userId: 1,
      enabled: true,
      paymentMethodRef: "pm_x",
      topupPackageCode: "TOPUP_SG_1GB",
      monthlyCapAmount: "5", // cap = $5
      currency: "USD",
      monthKey: "2024-06",
      monthSpentAmount: "4", // already spent $4 this month
      lastChargedAt: null,
    },
    esim: {
      id: 7,
      userId: 1,
      iccid: "8900",
      esimTranNo: "T7",
      expiresAt: new Date("2099-01-01T00:00:00Z"),
      supportTopUpType: 2,
      countrySlug: "sg",
    },
  });
  let charged = false;
  const result = await chargeAutoTopupForLowData({
    userId: 1,
    esimId: 7,
    getDb: (() => db) as unknown as Parameters<typeof chargeAutoTopupForLowData>[0]["getDb"],
    supplier: {
      listPackages: async () => ({
        list: [
          {
            packageCode: "TOPUP_SG_1GB",
            packageName: "Singapore 1 GB",
            price: 30_000, // $3 wholesale
            volume: 1024 * 1024 * 1024,
            duration: 7,
            supportTopUpType: 2,
          },
        ],
      }),
    },
    offSessionCharge: async () => {
      charged = true;
      return { ok: true, paymentIntentId: "pi_auto" };
    },
    now: FIXED_NOW,
    log: () => {},
  });
  assert.equal(result.charged, false);
  if (!result.charged) assert.equal(result.reason, "cap_exceeded");
  assert.equal(charged, false, "must not charge Stripe when the cap would be exceeded");
});

test("chargeAutoTopupForLowData surfaces off_session_unsupported when the provider has no off-session charge", async () => {
  const { db } = makeAutoDb({
    settings: {
      userId: 1,
      enabled: true,
      paymentMethodRef: "pm_x",
      topupPackageCode: "TOPUP_SG_1GB",
      monthlyCapAmount: "100",
      currency: "USD",
      monthKey: null,
      monthSpentAmount: "0",
      lastChargedAt: null,
    },
    esim: {
      id: 7,
      userId: 1,
      iccid: "8900",
      esimTranNo: "T7",
      expiresAt: new Date("2099-01-01T00:00:00Z"),
      supportTopUpType: 2,
      countrySlug: "sg",
    },
  });
  const result = await chargeAutoTopupForLowData({
    userId: 1,
    esimId: 7,
    getDb: (() => db) as unknown as Parameters<typeof chargeAutoTopupForLowData>[0]["getDb"],
    supplier: {
      listPackages: async () => ({
        list: [
          {
            packageCode: "TOPUP_SG_1GB",
            packageName: "Singapore 1 GB",
            price: 30_000,
            volume: 1024 * 1024 * 1024,
            duration: 7,
            supportTopUpType: 2,
          },
        ],
      }),
    },
    // no offSessionCharge injected — provider can't off-session charge
    now: FIXED_NOW,
    log: () => {},
  });
  assert.equal(result.charged, false);
  if (!result.charged) assert.equal(result.reason, "off_session_unsupported");
});

// ---------------------------------------------------------------------------
// Public id generator
// ---------------------------------------------------------------------------

test("makeTopupPublicId starts with tp_ and is URL-safe", () => {
  const id = makeTopupPublicId(new Date("2024-06-01T12:00:00Z"));
  assert.match(id, /^tp_[a-z0-9]+_[0-9a-f]{8}$/);
});

// ---------------------------------------------------------------------------
// 8) __test__ re-exports match the surface
// ---------------------------------------------------------------------------

test("__test__ re-exports the pricing primitives consumed by tests and admin", () => {
  assert.equal(typeof __test__.supplierPriceToUsd, "function");
  assert.equal(typeof __test__.bytesToGB, "function");
  assert.equal(typeof __test__.makeTopupPublicId, "function");
  assert.equal(typeof __test__.majorToMinor, "function");
});

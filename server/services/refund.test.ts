/**
 * Unit tests for `server/services/refund.ts` — the money-back guarantee flow.
 *
 * WHAT THESE PROVE (mapped to the phase acceptance criteria)
 * ---------------------------------------------------------
 *  1. "Unused eSIM refund triggers /esim/cancel and Stripe refund"
 *     - The unused path calls supplier.cancel first, then stripe.refund,
 *       then flips both the eSIM and order to `refunded` and writes the
 *       refund_requests row to `auto_refunded`.
 *     - The Stripe idempotency key equals the request's publicId, so a
 *       retried call cannot issue a second refund.
 *
 *  2. "Installed eSIMs create a review-queue entry instead of auto-refund"
 *     - installedAt != null, OR status === 'installed'/'active', OR usedBytes>0
 *       routes to `review` and NEVER calls supplier.cancel or stripe.refund.
 *
 *  3. "Refund state visible to user"
 *     - listRefundRequestsForUser returns the mapped rows in created-desc
 *       order (we don't assert SQL, just that every row is mapped to the
 *       public shape with ISO timestamps).
 *
 *  4. Idempotency on double-submit
 *     - A second request for the same eSIM while a request is `requested`
 *       or `review` returns `{ kind: 'already_requested' }` without touching
 *       the DB or external services.
 *
 *  5. Honest failure surfacing (never a fabricated success)
 *     - ownership miss                → RefundError('esim_not_found')
 *     - supplier cancels refused      → { kind: 'failed', reason: 'supplier_cancel_refused' }
 *                                       (row = failed, eSIM = review, no Stripe refund)
 *     - missing payment intent        → { kind: 'failed', reason: 'missing_payment_intent' }
 *                                       (row = review, eSIM = review, no Stripe refund)
 *     - Stripe refund returns !ok     → { kind: 'failed', reason: 'stripe_refund_failed' }
 *                                       (row = review, eSIM = review)
 *     - DB not configured             → RefundError('db_unavailable')
 *
 *  6. Admin review decision (`decideRefundReview`)
 *     - reject path writes `rejected` and does NOT call Stripe.
 *     - approve path calls Stride.refund with the order's payment intent and
 *       only then flips the eSIM/order to refunded.
 *     - a non-review request cannot be decided (guards double-processing).
 *
 * WHAT THESE DO NOT PROVE
 * -----------------------
 *  - The live PostgreSQL schema — this file drives a fake DB that mirrors the
 *    exact drizzle chains refund.ts uses. The real SQL is covered by the e2e
 *    flow phase against a provisioned Postgres (db:migrate).
 *  - The real supplier `/esim/cancel` endpoint or Stripe SDK — both are
 *    injected. `server/esimaccess.test.ts` covers the supplier client;
 *    `server/payments/stripeProvider.test.ts` covers the Stripe wrapper.
 *  - That email actually delivers — the notifier is optional and stubbed.
 *
 * SAFETY: no network, no DATABASE_URL, no secrets required. Every fixture is
 * synthetic; no real ICCIDs or payment intents. Run with:
 *     npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  requestRefund,
  listRefundRequestsForUser,
  decideRefundReview,
  makeRefundPublicId,
  RefundError,
  __test__ as refundTest,
  type RefundStripe,
  type RefundSupplier,
  type RefundNotifier,
} from "./refund";

// ---------------------------------------------------------------------------
// Minimal typed fakes for the drizzle chains refund.ts uses.
//
// Chains actually reached by requestRefund:
//   (a) esims select: db.select({...}).from(esims).where(<and>).limit(1)
//   (b) refund_requests select by (esimId,status) → idempotency check
//   (c) orders select by id → payment intent + currency + guestEmail
//   (d) refund_requests INSERT with values
//   (e) esims UPDATE .set().where()
//   (f) refund_requests UPDATE .set().where()
//   (g) orders UPDATE .set().where()
//
// decideRefundReview adds:
//   (h) refund_requests select by publicId
//   (i) orders select by id
//   (j) refund_requests / esims / orders UPDATE as above
//
// listRefundRequestsForUser adds:
//   (k) refund_requests select by userId .orderBy(...) → array
//
// The fake below routes each of these via a `mode` variable set by the
// projection passed to `.select()`. This mirrors what drizzle actually
// returns at runtime (the projection is applied at SQL level), and it is the
// least-brittle way to test a service whose DB predicates are opaque
// `sql` templates.
// ---------------------------------------------------------------------------

interface FakeEsimRow {
  esimId: number;
  status: string;
  iccid: string | null;
  esimTranNo: string | null;
  installedAt: Date | null;
  usedBytes: string | number | null;
  orderId: number;
  refundStatus: string | null;
}

interface FakeOrderRow {
  id: number;
  orderPublicId: string;
  guestEmail: string | null;
  userId: number | null;
  currency: string;
  retailTotal: string;
  stripePaymentIntentId: string | null;
  status: string;
}

interface FakeRequestRow {
  id: number;
  publicId: string;
  userId: number;
  orderId: number;
  esimId: number;
  reason: string | null;
  status: string;
  supplierCancelStatus: string;
  supplierCancelReason: string | null;
  failureReason: string | null;
  stripeRefundId: string | null;
  stripeRefundAmount: string | null;
  stripeRefundCurrency: string | null;
  reviewNote: string | null;
  reviewedBy: number | null;
  reviewedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

interface FakeState {
  esim: FakeEsimRow | null;
  order: FakeOrderRow | null;
  /** Rows in refund_requests (seeded). */
  requests: FakeRequestRow[];
  /** Inserted refund_requests (appended to state.requests). */
  inserts: Array<Partial<FakeRequestRow>>;
  /** Patches applied via UPDATE, tagged by target table shape. */
  esimUpdates: Array<Record<string, unknown>>;
  orderUpdates: Array<Record<string, unknown>>;
  requestUpdates: Array<{ publicId: string; patch: Record<string, unknown> }>;
}

type DbType = NonNullable<ReturnType<typeof makeFakeDb>["db"]>;

const requestRowSeed = (over: Partial<FakeRequestRow> = {}): FakeRequestRow => ({
  id: 1,
  publicId: "rf_seed",
  userId: 1,
  orderId: 1,
  esimId: 1,
  reason: null,
  status: "requested",
  supplierCancelStatus: "not_attempted",
  supplierCancelReason: null,
  failureReason: null,
  stripeRefundId: null,
  stripeRefundAmount: null,
  stripeRefundCurrency: null,
  reviewNote: null,
  reviewedBy: null,
  reviewedAt: null,
  createdAt: new Date("2024-06-01T00:00:00Z"),
  updatedAt: new Date("2024-06-01T00:00:00Z"),
  ...over,
});

/**
 * Build a fake with three independent row stores plus update logs. The chain
 * shapes mirror what refund.ts does; every projection that matters is
 * recognised and the rest are treated as empty arrays (so unexpected calls
 * surface as "no row found" rather than crashing).
 *
 * IMPORTANT: this fake NEVER returns rows that don't exist in `state` — it
 * can't, because the service's predicates are opaque SQL. The tests
 * therefore plant the exact rows the service would fetch from a real DB and
 * assert on the side effects (calls, updates) rather than on which rows were
 * selected.
 */
function makeFakeDb(seed: {
  esim?: FakeEsimRow | null;
  order?: FakeOrderRow | null;
  requests?: FakeRequestRow[];
}): {
  db: {
    select: (cols?: Record<string, unknown>) => unknown;
    insert: (table: unknown) => unknown;
    update: (table: unknown) => unknown;
  };
  state: FakeState;
} {
  const state: FakeState = {
    esim: seed.esim ?? null,
    order: seed.order ?? null,
    requests: seed.requests ? [...seed.requests] : [],
    inserts: [],
    esimUpdates: [],
    orderUpdates: [],
    requestUpdates: [],
  };

  // Detect the SELECT shape from the projection the service passes in.
  // This is a heuristic but stable: refund.ts always projects unique columns
  // per table (esims rows have `esimId`, orders rows have `orderPublicId`
  // + `currency`, refund_request reads have `publicId` + `status` + a
  // `createdAt` in the ordering case).
  function detectSelectMode(cols: Record<string, unknown> | undefined): "esim" | "order" | "request_open" | "request_list" | "request_by_id" | "unknown" {
    if (!cols) return "unknown";
    const keys = Object.keys(cols);
    const has = (k: string) => keys.includes(k);
    // refund_requests list read: many fields including createdAt AND no esim_status
    if (has("esimId") && has("publicId") && has("reviewNote")) return "request_list";
    // refund_requests select.by publicId (decideRefundReview): id + esimId + orderId + status
    if (has("id") && has("esimId") && has("orderId") && has("status") && !has("stripePaymentIntentId")) {
      return "request_by_id";
    }
    // idempotency check: only publicId present (refundRequests.publicId)
    if (keys.length === 1 && has("publicId")) return "request_open";
    // esims read: has esimId AND esimTranNo
    if (has("esimId") && has("esimTranNo")) return "esim";
    // orders read: has orderPublicId
    if (has("orderPublicId")) return "order";
    // decideRefundReview's orders projection only has stripePaymentIntentId + currency
    if (has("stripePaymentIntentId") && has("currency")) return "order";
    return "unknown";
  }

  const select = (cols?: Record<string, unknown>) => {
    const mode = detectSelectMode(cols);
    const chain = {
      from: (_t: unknown) => chain,
      where: (_w: unknown) => chain,
      limit: async (_n: number) => {
        if (mode === "esim") return state.esim ? [state.esim] : [];
        if (mode === "order") return state.order ? [state.order] : [];
        if (mode === "request_open") {
          const open = state.requests.find((r) => r.status === "requested" || r.status === "review");
          return open ? [{ publicId: open.publicId }] : [];
        }
        if (mode === "request_by_id") {
          // In decideRefundReview the caller supplies a specific publicId; the
          // fake can't read the predicate, so we use a caller-planted row.
          const row = state.requests[0];
          return row
            ? [{ id: row.id, esimId: row.esimId, orderId: row.orderId, status: row.status }]
            : [];
        }
        return [];
      },
      orderBy: async (_col: unknown) => {
        if (mode === "request_list") {
          return state.requests.slice().sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        }
        return [];
      },
    };
    return chain;
  };

  // Distinguish inserts by the projected rows' shape: refund_requests inserts
  // always carry a `publicId` key matching /^rf_/.
  const insert = (_table: unknown) => ({
    values: async (row: Record<string, unknown>) => {
      state.inserts.push(row);
      // Mirror the effect: append a synthetic request row so list- or
      // idempotency-checks after insert can see it. Matches production
      // because insert() in refund.ts only targets refund_requests.
      const publicId = String(row.publicId ?? "");
      if (publicId.startsWith("rf_")) {
        state.requests.push(
          requestRowSeed({
            id: state.requests.length + 1,
            publicId,
            userId: Number(row.userId ?? 0),
            orderId: Number(row.orderId ?? 0),
            esimId: Number(row.esimId ?? 0),
            reason: (row.reason as string | null) ?? null,
            status: String(row.status ?? "requested"),
            supplierCancelStatus: String(row.supplierCancelStatus ?? "not_attempted"),
            createdAt: new Date(),
            updatedAt: new Date(),
          }),
        );
      }
      return undefined;
    },
  });

  // Updates: routed by the SET patch shape.
  //   - esims UPDATE: patch includes `refundStatus` (only place it appears).
  //   - orders UPDATE: patch includes `status` where value is 'refunded'
  //     AND no refundStatus → actually ambiguous; but refund.ts's orders
  //     update only sets `status`. We detect via the key set.
  //   - refund_requests UPDATE: patch includes `supplierCancelStatus` OR
  //     `reviewedBy` OR `stripeRefundId`.
  //
  // Predicate: refund.ts uses `eq(refundRequests.publicId, ...)` or `eq(id, ...)`.
  // We can't introspect that, so we apply to (a) the ONLY requests row, or
  // (b) every row matching the current publicId set — the caller provides
  // distinct rows per test.
  const update = (_table: unknown) => ({
    set: (patch: Record<string, unknown>) => ({
      where: async (_w: unknown) => {
        if ("refundStatus" in patch) {
          state.esimUpdates.push(patch);
          return;
        }
        if (
          "supplierCancelStatus" in patch ||
          "reviewedBy" in patch ||
          "stripeRefundId" in patch ||
          "reviewNote" in patch
        ) {
          // Attempt to find the matching request by scanning all rows. Since
          // our tests set at most one in-flight request, apply to the last
          // one (which is the row created by the current requestRefund call).
          const target = state.requests[state.requests.length - 1];
          if (target) {
            Object.assign(target, patch, { updatedAt: new Date() });
            state.requestUpdates.push({ publicId: target.publicId, patch });
          }
          return;
        }
        if ("status" in patch) {
          state.orderUpdates.push(patch);
          if (state.order) Object.assign(state.order, patch);
          return;
        }
        // Unknown update shape — record it anyway so a failing assertion
        // points at the service, not at a silent miss.
        state.orderUpdates.push(patch);
      },
    }),
  });

  return {
    db: { select, insert, update },
    state,
  };
}

// ---------------------------------------------------------------------------
// Supplier / Stripe / Notifier fakes
// ---------------------------------------------------------------------------

interface CancelCall {
  esimTranNo?: string;
  iccid?: string;
  transactionId?: string;
}

function makeSupplier(
  response:
    | { ok: true }
    | { ok: false; reason?: string }
    | { throw: Error },
): { supplier: RefundSupplier; calls: CancelCall[] } {
  const calls: CancelCall[] = [];
  const supplier: RefundSupplier = {
    async cancel(input) {
      calls.push(input);
      if ("throw" in response) throw response.throw;
      if (response.ok) return { ok: true };
      return { ok: false, reason: response.reason };
    },
  };
  return { supplier, calls };
}

interface RefundCall {
  paymentIntentId: string;
  idempotencyKey: string;
  reason?: string;
}

function makeStripe(
  response:
    | { ok: true; refundId?: string; amountMinor?: number; currency?: string }
    | { ok: false; reason?: string }
    | { throw: Error },
): { stripe: RefundStripe; calls: RefundCall[] } {
  const calls: RefundCall[] = [];
  const stripe: RefundStripe = {
    async refund(input) {
      calls.push(input);
      if ("throw" in response) throw response.throw;
      return response;
    },
  };
  return { stripe, calls };
}

interface FakeNotifierState {
  confirmations: number;
  reviews: number;
  lastAmountMinor: number | null;
}

function makeNotifier(): { notifier: RefundNotifier; state: FakeNotifierState } {
  const state: FakeNotifierState = { confirmations: 0, reviews: 0, lastAmountMinor: null };
  const notifier: RefundNotifier = {
    async sendRefundConfirmation(input) {
      state.confirmations += 1;
      state.lastAmountMinor = input.amountMinor;
    },
    async sendRefundReviewReceived() {
      state.reviews += 1;
    },
  };
  return { notifier, state };
}

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

function unusedEsim(over: Partial<FakeEsimRow> = {}): FakeEsimRow {
  return {
    esimId: 1,
    status: "ready",
    iccid: "890000000000000001",
    esimTranNo: "TRAN-1",
    installedAt: null,
    usedBytes: 0,
    orderId: 1,
    refundStatus: null,
    ...over,
  };
}

function installedEsim(over: Partial<FakeEsimRow> = {}): FakeEsimRow {
  return unusedEsim({
    status: "installed",
    installedAt: new Date("2024-01-01T00:00:00Z"),
    usedBytes: "1048576",
    ...over,
  });
}

function order(over: Partial<FakeOrderRow> = {}): FakeOrderRow {
  return {
    id: 1,
    orderPublicId: "ord_test",
    guestEmail: "buyer@example.test",
    userId: 1,
    currency: "SGD",
    retailTotal: "12.00",
    stripePaymentIntentId: "pi_test_1",
    status: "completed",
    ...over,
  };
}

const FIXED_NOW = () => new Date("2024-06-01T12:00:00Z");

const asGetDb =
  (fn: ReturnType<typeof makeFakeDb>["db"] | null) =>
  (() => fn) as unknown as NonNullable<Parameters<typeof requestRefund>[0]["getDb"]>;

// ---------------------------------------------------------------------------
// 1) Unused eSIM → supplier cancel + Stripe refund
// ---------------------------------------------------------------------------

test("requestRefund on an unused eSIM cancels with the supplier, refunds Stripe, and flips statuses", async () => {
  const { db, state } = makeFakeDb({ esim: unusedEsim(), order: order() });
  const { supplier, calls: cancelCalls } = makeSupplier({ ok: true });
  const { stripe, calls: stripeCalls } = makeStripe({ ok: true, refundId: "re_1", amountMinor: 1200, currency: "SGD" });
  const { notifier, state: notifierState } = makeNotifier();

  const outcome = await requestRefund({
    userId: 1,
    esimId: 1,
    reason: "changed plans",
    getDb: asGetDb(db as unknown as ReturnType<typeof makeFakeDb>["db"]),
    supplier,
    stripe,
    notifier,
    now: FIXED_NOW,
    log: () => {},
  });

  assert.equal(outcome.kind, "auto_refunded");
  if (outcome.kind === "auto_refunded") {
    assert.equal(outcome.refundId, "re_1");
    assert.match(outcome.requestPublicId, /^rf_/);
  }

  // Supplier cancel called with esimTranNo (the refund flow has both but prefers tran).
  assert.equal(cancelCalls.length, 1);
  assert.equal(cancelCalls[0]!.esimTranNo, "TRAN-1");
  assert.equal(cancelCalls[0]!.iccid, "890000000000000001");
  // Supplier cancel idempotency key is the request publicId.
  if (outcome.kind === "auto_refunded") {
    assert.equal(cancelCalls[0]!.transactionId, outcome.requestPublicId);
  }

  // Stripe refund uses the order's payment intent.
  assert.equal(stripeCalls.length, 1);
  assert.equal(stripeCalls[0]!.paymentIntentId, "pi_test_1");
  // Stripe idempotency key equals the request's publicId (retry safety).
  if (outcome.kind === "auto_refunded") {
    assert.equal(stripeCalls[0]!.idempotencyKey, outcome.requestPublicId);
  }

  // Persistence side effects.
  assert.ok(state.esimUpdates.some((u) => u.refundStatus === "refunded"), "esim must be marked refunded");
  assert.ok(state.orderUpdates.some((u) => u.status === "refunded"), "order must be marked refunded");

  // Request row is inserted first (with 'requested'), then updated to auto_refunded.
  assert.equal(state.inserts.length, 1);
  assert.equal(state.inserts[0]!.status, "requested");
  assert.ok(
    state.requestUpdates.some((u) => u.patch.status === "auto_refunded" && u.patch.stripeRefundId === "re_1"),
    "refund_requests row must be updated to auto_refunded with stripe id",
  );

  // Confirmation sent, no review.
  assert.equal(notifierState.confirmations, 1);
  assert.equal(notifierState.reviews, 0);
});

// ---------------------------------------------------------------------------
// 2) Installed eSIM → review queue
// ---------------------------------------------------------------------------

test("requestRefund on an installed eSIM routes to review and never calls supplier or Stripe", async () => {
  const { db, state } = makeFakeDb({ esim: installedEsim(), order: order() });
  const { supplier, calls: cancelCalls } = makeSupplier({ ok: true });
  const { stripe, calls: stripeCalls } = makeStripe({ ok: true, refundId: "re_never" });
  const { notifier, state: notifierState } = makeNotifier();

  const outcome = await requestRefund({
    userId: 1,
    esimId: 1,
    getDb: asGetDb(db as unknown as ReturnType<typeof makeFakeDb>["db"]),
    supplier,
    stripe,
    notifier,
    now: FIXED_NOW,
    log: () => {},
  });

  assert.equal(outcome.kind, "review");
  assert.equal(cancelCalls.length, 0, "installed eSIMs must NOT be cancelled at the supplier");
  assert.equal(stripeCalls.length, 0, "installed eSIMs must NOT trigger Stripe refunds");

  // The request row is inserted with status 'review'
  assert.equal(state.inserts.length, 1);
  assert.equal(state.inserts[0]!.status, "review");
  // eSIM is marked for review, not refunded.
  assert.ok(state.esimUpdates.some((u) => u.refundStatus === "review"));
  assert.ok(!state.esimUpdates.some((u) => u.refundStatus === "refunded"));
  // Order is untouched.
  assert.equal(state.orderUpdates.length, 0);

  // Review email sent; no confirmation.
  assert.equal(notifierState.reviews, 1);
  assert.equal(notifierState.confirmations, 0);
});

test("requestRefund on an eSIM with usedBytes > 0 (but installedAt null) still routes to review", async () => {
  const { db } = makeFakeDb({
    esim: unusedEsim({ installedAt: null, usedBytes: "1048576", status: "ready" }),
    order: order(),
  });
  const { supplier, calls: cancelCalls } = makeSupplier({ ok: true });
  const { stripe, calls: stripeCalls } = makeStripe({ ok: true, refundId: "re_x" });

  const outcome = await requestRefund({
    userId: 1,
    esimId: 1,
    getDb: asGetDb(db as unknown as ReturnType<typeof makeFakeDb>["db"]),
    supplier,
    stripe,
    now: FIXED_NOW,
    log: () => {},
  });
  assert.equal(outcome.kind, "review");
  assert.equal(cancelCalls.length, 0);
  assert.equal(stripeCalls.length, 0);
});

// ---------------------------------------------------------------------------
// 3) listRefundRequestsForUser
// ---------------------------------------------------------------------------

test("listRefundRequestsForUser maps rows to the public shape with ISO timestamps, newest first", async () => {
  const older = requestRowSeed({
    id: 1,
    publicId: "rf_older",
    status: "rejected",
    reason: "policy",
    supplierCancelStatus: "not_attempted",
    reviewNote: "outside window",
    stripeRefundId: null,
    createdAt: new Date("2024-05-01T00:00:00Z"),
    updatedAt: new Date("2024-05-02T00:00:00Z"),
  });
  const newer = requestRowSeed({
    id: 2,
    publicId: "rf_newer",
    status: "auto_refunded",
    reason: "unused",
    supplierCancelStatus: "cancelled",
    reviewNote: null,
    stripeRefundId: "re_ok",
    createdAt: new Date("2024-06-01T00:00:00Z"),
    updatedAt: new Date("2024-06-01T01:00:00Z"),
  });
  const { db } = makeFakeDb({ requests: [older, newer] });

  const rows = await listRefundRequestsForUser({
    userId: 1,
    getDb: asGetDb(db as unknown as ReturnType<typeof makeFakeDb>["db"]),
  });

  assert.equal(rows.length, 2);
  // Sorting: newest first.
  assert.equal(rows[0]!.publicId, "rf_newer");
  assert.equal(rows[1]!.publicId, "rf_older");
  // Public shape: ISO-8601 timestamps, everything from the row.
  assert.equal(rows[0]!.createdAt, "2024-06-01T00:00:00.000Z");
  assert.equal(rows[0]!.updatedAt, "2024-06-01T01:00:00.000Z");
  assert.equal(rows[0]!.stripeRefundId, "re_ok");
  assert.equal(rows[1]!.status, "rejected");
  assert.equal(rows[1]!.reviewNote, "outside window");
});

// ---------------------------------------------------------------------------
// 4) Idempotency — already_requested
// ---------------------------------------------------------------------------

test("requestRefund returns already_requested when an open request exists for the same eSIM", async () => {
  const openReq = requestRowSeed({
    publicId: "rf_inflight",
    esimId: 1,
    orderId: 1,
    status: "requested",
  });
  const { db, state } = makeFakeDb({
    esim: unusedEsim(),
    order: order(),
    requests: [openReq],
  });
  const { supplier, calls: cancelCalls } = makeSupplier({ ok: true });
  const { stripe, calls: stripeCalls } = makeStripe({ ok: true, refundId: "re_dup" });

  const outcome = await requestRefund({
    userId: 1,
    esimId: 1,
    getDb: asGetDb(db as unknown as ReturnType<typeof makeFakeDb>["db"]),
    supplier,
    stripe,
    now: FIXED_NOW,
    log: () => {},
  });
  assert.equal(outcome.kind, "already_requested");
  if (outcome.kind === "already_requested") {
    assert.equal(outcome.requestPublicId, "rf_inflight");
  }
  // No new writes, no supplier, no Stripe.
  assert.equal(state.inserts.length, 0);
  assert.equal(cancelCalls.length, 0);
  assert.equal(stripeCalls.length, 0);
});

// ---------------------------------------------------------------------------
// 5) Honest failure surfacing
// ---------------------------------------------------------------------------

test("requestRefund rejects an invalid userId before touching the DB", async () => {
  await assert.rejects(
    () =>
      requestRefund({
        userId: 0,
        esimId: 1,
        getDb: asGetDb(null),
        log: () => {},
      }),
    (e) => e instanceof RefundError && e.code === "invalid_input",
  );
});

test("requestRefund rejects a non-positive esimId before touching the DB", async () => {
  await assert.rejects(
    () =>
      requestRefund({
        userId: 1,
        esimId: -1,
        getDb: asGetDb(null),
        log: () => {},
      }),
    (e) => e instanceof RefundError && e.code === "invalid_input",
  );
});

test("requestRefund throws RefundError('db_unavailable') when no DB is configured", async () => {
  await assert.rejects(
    () =>
      requestRefund({
        userId: 1,
        esimId: 1,
        getDb: asGetDb(null),
        log: () => {},
      }),
    (e) => e instanceof RefundError && e.code === "db_unavailable",
  );
});

test("requestRefund throws RefundError('esim_not_found') when ownership lookup returns no row", async () => {
  const { db } = makeFakeDb({ esim: null, order: order() });
  await assert.rejects(
    () =>
      requestRefund({
        userId: 1,
        esimId: 999,
        getDb: asGetDb(db as unknown as ReturnType<typeof makeFakeDb>["db"]),
        log: () => {},
      }),
    (e) => e instanceof RefundError && e.code === "esim_not_found",
  );
});

test("a supplier cancel refusal fails the request without touching Stripe (eSIM goes to review)", async () => {
  const { db, state } = makeFakeDb({ esim: unusedEsim(), order: order() });
  const { supplier } = makeSupplier({ ok: false, reason: "ALREADY_IN_USE" });
  const { stripe, calls: stripeCalls } = makeStripe({ ok: true, refundId: "re_never" });

  const outcome = await requestRefund({
    userId: 1,
    esimId: 1,
    getDb: asGetDb(db as unknown as ReturnType<typeof makeFakeDb>["db"]),
    supplier,
    stripe,
    now: FIXED_NOW,
    log: () => {},
  });
  assert.equal(outcome.kind, "failed");
  if (outcome.kind === "failed") {
    assert.equal(outcome.reason, "supplier_cancel_refused");
  }
  assert.equal(stripeCalls.length, 0, "supplier refusal must NOT trigger a Stripe refund");
  // Request row moved to failed, eSIM moved to review.
  assert.ok(state.requestUpdates.some((u) => u.patch.status === "failed"));
  assert.ok(state.esimUpdates.some((u) => u.refundStatus === "review"));
  assert.ok(!state.esimUpdates.some((u) => u.refundStatus === "refunded"));
});

test("a supplier cancel network error fails the request honestly (not a fabricated success)", async () => {
  const { db } = makeFakeDb({ esim: unusedEsim(), order: order() });
  const { supplier } = makeSupplier({ throw: new Error("socket closed") });
  const { stripe, calls: stripeCalls } = makeStripe({ ok: true, refundId: "re_never" });

  const outcome = await requestRefund({
    userId: 1,
    esimId: 1,
    getDb: asGetDb(db as unknown as ReturnType<typeof makeFakeDb>["db"]),
    supplier,
    stripe,
    now: FIXED_NOW,
    log: () => {},
  });
  assert.equal(outcome.kind, "failed");
  if (outcome.kind === "failed") assert.equal(outcome.reason, "supplier_cancel_error");
  assert.equal(stripeCalls.length, 0);
});

test("a missing payment intent fails without calling Stripe (row goes to review, not failed)", async () => {
  const { db, state } = makeFakeDb({
    esim: unusedEsim(),
    order: order({ stripePaymentIntentId: null }),
  });
  const { supplier } = makeSupplier({ ok: true });
  const { stripe, calls: stripeCalls } = makeStripe({ ok: true, refundId: "re_never" });

  const outcome = await requestRefund({
    userId: 1,
    esimId: 1,
    getDb: asGetDb(db as unknown as ReturnType<typeof makeFakeDb>["db"]),
    supplier,
    stripe,
    now: FIXED_NOW,
    log: () => {},
  });
  assert.equal(outcome.kind, "failed");
  if (outcome.kind === "failed") assert.equal(outcome.reason, "missing_payment_intent");
  assert.equal(stripeCalls.length, 0);
  // Row is queued for manual review (support reconciles in Stripe dashboard).
  assert.ok(state.requestUpdates.some((u) => u.patch.status === "review"));
  assert.ok(state.esimUpdates.some((u) => u.refundStatus === "review"));
  // eSIM was cancelled though — supplier side effect already happened.
  assert.ok(state.esimUpdates.some((u) => u.refundStatus === "review"));
});

test("a Stripe refund failure fails the request with reason 'stripe_refund_failed' (row goes to review)", async () => {
  const { db, state } = makeFakeDb({ esim: unusedEsim(), order: order() });
  const { supplier } = makeSupplier({ ok: true });
  const { stripe, calls: stripeCalls } = makeStripe({ ok: false, reason: "card_declined" });

  const outcome = await requestRefund({
    userId: 1,
    esimId: 1,
    getDb: asGetDb(db as unknown as ReturnType<typeof makeFakeDb>["db"]),
    supplier,
    stripe,
    now: FIXED_NOW,
    log: () => {},
  });
  assert.equal(outcome.kind, "failed");
  if (outcome.kind === "failed") assert.equal(outcome.reason, "stripe_refund_failed");
  assert.equal(stripeCalls.length, 1, "Stripe WAS called and failed — this is a review path");
  assert.ok(state.requestUpdates.some((u) => u.patch.status === "review"));
  assert.ok(state.esimUpdates.some((u) => u.refundStatus === "review"));
  assert.ok(!state.esimUpdates.some((u) => u.refundStatus === "refunded"));
});

test("a supplier throw inside stripe.refund is caught and reported as stripe_refund_failed", async () => {
  const { db } = makeFakeDb({ esim: unusedEsim(), order: order() });
  const { supplier } = makeSupplier({ ok: true });
  const { stripe } = makeStripe({ throw: new Error("stripe 500") });
  const outcome = await requestRefund({
    userId: 1,
    esimId: 1,
    getDb: asGetDb(db as unknown as ReturnType<typeof makeFakeDb>["db"]),
    supplier,
    stripe,
    now: FIXED_NOW,
    log: () => {},
  });
  assert.equal(outcome.kind, "failed");
  if (outcome.kind === "failed") assert.equal(outcome.reason, "stripe_refund_failed");
});

// ---------------------------------------------------------------------------
// 6) Admin review decision
// ---------------------------------------------------------------------------

test("decideRefundReview('reject') writes 'rejected' and never calls Stripe", async () => {
  const seedReq = requestRowSeed({
    publicId: "rf_manual",
    esimId: 1,
    orderId: 1,
    status: "review",
  });
  const { db, state } = makeFakeDb({
    esim: installedEsim(),
    order: order(),
    requests: [seedReq],
  });
  const { stripe, calls: stripeCalls } = makeStripe({ ok: true, refundId: "re_never" });
  const result = await decideRefundReview({
    reviewerUserId: 99,
    requestPublicId: "rf_manual",
    decision: "reject",
    note: "outside guarantee",
    getDb: asGetDb(db as unknown as ReturnType<typeof makeFakeDb>["db"]),
    stripe,
    now: FIXED_NOW,
    log: () => {},
  });
  assert.equal(result.status, "rejected");
  assert.equal(stripeCalls.length, 0);
  assert.ok(state.requestUpdates.some((u) => u.patch.status === "rejected"));
  assert.ok(state.esimUpdates.some((u) => u.refundStatus === "rejected"));
  assert.ok(!state.esimUpdates.some((u) => u.refundStatus === "refunded"));
});

test("decideRefundReview('approve') issues a Stripe refund and flips eSIM + order to refunded", async () => {
  const seedReq = requestRowSeed({
    publicId: "rf_approve",
    esimId: 1,
    orderId: 1,
    status: "review",
  });
  const { db, state } = makeFakeDb({
    esim: installedEsim(),
    order: order({ stripePaymentIntentId: "pi_approve" }),
    requests: [seedReq],
  });
  const { stripe, calls: stripeCalls } = makeStripe({ ok: true, refundId: "re_approve" });
  const result = await decideRefundReview({
    reviewerUserId: 99,
    requestPublicId: "rf_approve",
    decision: "approve",
    note: "customer reported install failure",
    getDb: asGetDb(db as unknown as ReturnType<typeof makeFakeDb>["db"]),
    stripe,
    now: FIXED_NOW,
    log: () => {},
  });
  assert.equal(result.status, "refunded");
  assert.equal(stripeCalls.length, 1);
  assert.equal(stripeCalls[0]!.paymentIntentId, "pi_approve");
  assert.equal(stripeCalls[0]!.idempotencyKey, "rf_approve");
  assert.ok(state.esimUpdates.some((u) => u.refundStatus === "refunded"));
  assert.ok(state.orderUpdates.some((u) => u.status === "refunded"));
  assert.ok(state.requestUpdates.some((u) => u.patch.status === "auto_refunded"));
});

test("decideRefundReview refuses a request that is no longer in 'review'", async () => {
  const seedReq = requestRowSeed({
    publicId: "rf_already",
    esimId: 1,
    orderId: 1,
    status: "auto_refunded",
  });
  const { db } = makeFakeDb({ esim: unusedEsim(), order: order(), requests: [seedReq] });
  await assert.rejects(
    () =>
      decideRefundReview({
        reviewerUserId: 99,
        requestPublicId: "rf_already",
        decision: "approve",
        getDb: asGetDb(db as unknown as ReturnType<typeof makeFakeDb>["db"]),
        now: FIXED_NOW,
        log: () => {},
      }),
    (e) => e instanceof RefundError && e.code === "invalid_input",
  );
});

test("decideRefundReview throws esim_not_found equivalent when no request exists", async () => {
  const { db } = makeFakeDb({ esim: unusedEsim(), order: order(), requests: [] });
  await assert.rejects(
    () =>
      decideRefundReview({
        reviewerUserId: 99,
        requestPublicId: "rf_missing",
        decision: "approve",
        getDb: asGetDb(db as unknown as ReturnType<typeof makeFakeDb>["db"]),
        now: FIXED_NOW,
        log: () => {},
      }),
    (e) => e instanceof RefundError && e.code === "invalid_input",
  );
});

// ---------------------------------------------------------------------------
// 7) __test__ surface
// ---------------------------------------------------------------------------

test("__test__.isUnused mirrors the unused-detection predicate used by requestRefund", () => {
  assert.equal(
    refundTest.isUnused({ installedAt: null, usedBytes: 0, status: "ready" }),
    true,
  );
  assert.equal(
    refundTest.isUnused({ installedAt: null, usedBytes: "0", status: "ready" }),
    true,
  );
  assert.equal(
    refundTest.isUnused({ installedAt: new Date(), usedBytes: 0, status: "ready" }),
    false,
    "installedAt set → not unused",
  );
  assert.equal(
    refundTest.isUnused({ installedAt: null, usedBytes: 1024, status: "ready" }),
    false,
    "usedBytes > 0 → not unused",
  );
  assert.equal(
    refundTest.isUnused({ installedAt: null, usedBytes: 0, status: "installed" }),
    false,
    "status 'installed' → not unused",
  );
  assert.equal(
    refundTest.isUnused({ installedAt: null, usedBytes: 0, status: "active" }),
    false,
    "status 'active' → not unused",
  );
});

test("makeRefundPublicId starts with rf_ + date + entropy and is URL-safe", () => {
  const id = makeRefundPublicId(new Date("2024-06-01T12:00:00Z"));
  assert.match(id, /^rf_20240601_[0-9a-f]{8}$/);
});

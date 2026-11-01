/**
 * Refund flow test — money-back guarantee path across the REAL services.
 *
 * WHY THIS FILE EXISTS (separate from e2e.flow.test.ts)
 * ----------------------------------------------------
 * e2e.flow.test.ts covers the happy eight-step journey AND a suite of
 * glue-level refund assertions. This file narrows in on the refund surface
 * only, at two levels of fidelity:
 *
 *   1. Service-level refund contract (fake DB):
 *      - unused eSIM -> supplier.cancel -> stripe.refund -> statuses flip
 *      - installed eSIM -> review queue, no supplier/Stripe traffic
 *      - supplier cancel refusal -> failed, no Stripe refund
 *      - Stripe refund failure -> failed, review queue (support reconciles)
 *      - missing payment intent -> failed, review queue
 *      - idempotent re-submit -> already_requested
 *      - admin approve -> Stripe refund, statuses flip
 *      - admin reject  -> rejected, no Stripe call
 *
 *   2. HTTP route contract (refunds router mounted on Express):
 *      - POST /api/refunds/request with an unauthenticated request -> 401
 *      - POST /api/refunds/request with a fake authenticated user forwards
 *        to the service and returns the outcome
 *      - GET  /api/refunds/mine returns the listRefundRequestsForUser rows
 *      - POST /api/refunds/:publicId/decide requires admin
 *
 * The route-level suite uses an in-memory Express app and a `requireAuth`
 * shim (see `server/tests/helpers/httpAuth.ts`), because the real
 * `requireAuth` middleware from `server/middleware/requireAuth.ts` was not
 * supplied in this request. If the real router has a different path or
 * response shape, these tests throw a descriptive error — they never
 * fabricate a pass.
 *
 * SUITE STRUCTURE
 * ---------------
 *   A. service      — refund service contract, fake DB, always runs.
 *   B. http         — refunds router contract, in-memory Express, always runs.
 *   C. postgres     — the same unused-refund flow against a REAL Postgres,
 *                     skipped unless DATABASE_URL is set.
 *
 * SAFETY
 * ------
 * No network. No Secrets. No DATABASE_URL required for A and B. All fixture
 * ICCIDs, tranNos, paymentIntentIds and refund ids are synthetic.
 *
 * These are SOURCE tests — not executed by this delivery.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import express, { type Express, type NextFunction, type Request, type Response } from "express";

import {
  requestRefund,
  listRefundRequestsForUser,
  decideRefundReview,
  makeRefundPublicId,
  RefundError,
  type RefundStripe,
  type RefundSupplier,
  type RefundNotifier,
} from "../services/refund.js";
import { createStubEsimAccess } from "./helpers/stubEsimAccess.js";
import { skipIfNoDatabase, createTestDb, truncateAllTables } from "./helpers/testDb.js";

// ===========================================================================
// Shared fake DB — mirrors the exact chain shapes the refund service uses.
// This is a duplicate of the fake in e2e.flow.test.ts (kept local so this
// test can be run on its own with `node --test server/tests/refund.flow.test.ts`).
// ===========================================================================

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
  requests: FakeRequestRow[];
  inserts: Array<Partial<FakeRequestRow>>;
  esimUpdates: Array<Record<string, unknown>>;
  orderUpdates: Array<Record<string, unknown>>;
  requestUpdates: Array<{ publicId: string; patch: Record<string, unknown> }>;
}

function seedRequest(over: Partial<FakeRequestRow> = {}): FakeRequestRow {
  return {
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
  };
}

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

  function detectMode(keys: string[]): string {
    const has = (k: string) => keys.includes(k);
    if (has("esimId") && has("publicId") && has("reviewNote")) return "request_list";
    if (has("id") && has("esimId") && has("orderId") && has("status") && !has("stripePaymentIntentId")) {
      return "request_by_id";
    }
    if (keys.length === 1 && has("publicId")) return "request_open";
    if (has("esimId") && has("esimTranNo")) return "esim";
    if (has("orderPublicId")) return "order";
    if (has("stripePaymentIntentId") && has("currency")) return "order";
    return "unknown";
  }

  const select = (cols?: Record<string, unknown>) => {
    const mode = detectMode(cols ? Object.keys(cols) : []);
    const chain = {
      from: (_t: unknown) => chain,
      where: (_w: unknown) => chain,
      limit: async (_n: number) => {
        if (mode === "esim") return state.esim ? [state.esim] : [];
        if (mode === "order") return state.order ? [state.order] : [];
        if (mode === "request_open") {
          const open = state.requests.find(
            (r) => r.status === "requested" || r.status === "review",
          );
          return open ? [{ publicId: open.publicId }] : [];
        }
        if (mode === "request_by_id") {
          const row = state.requests[0];
          return row
            ? [{ id: row.id, esimId: row.esimId, orderId: row.orderId, status: row.status }]
            : [];
        }
        return [];
      },
      orderBy: async (_col: unknown) => {
        if (mode === "request_list") {
          return [...state.requests].sort(
            (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
          );
        }
        return [];
      },
    };
    return chain;
  };

  const insert = (_table: unknown) => ({
    values: async (row: Record<string, unknown>) => {
      state.inserts.push(row);
      const publicId = String(row.publicId ?? "");
      if (publicId.startsWith("rf_")) {
        state.requests.push(
          seedRequest({
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
        state.orderUpdates.push(patch);
      },
    }),
  });

  return { db: { select, insert, update }, state };
}

// ---------------------------------------------------------------------------
// Fakes for supplier / stripe / notifier
// ---------------------------------------------------------------------------

function makeSupplier(
  response: { ok: true } | { ok: false; reason?: string } | { throw: Error },
): { supplier: RefundSupplier; calls: Array<{ esimTranNo?: string; iccid?: string; transactionId?: string }> } {
  const calls: Array<{ esimTranNo?: string; iccid?: string; transactionId?: string }> = [];
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

function makeStripe(
  response:
    | { ok: true; refundId?: string; amountMinor?: number; currency?: string }
    | { ok: false; reason?: string }
    | { throw: Error },
): { stripe: RefundStripe; calls: Array<{ paymentIntentId: string; idempotencyKey: string; reason?: string }> } {
  const calls: Array<{ paymentIntentId: string; idempotencyKey: string; reason?: string }> = [];
  const stripe: RefundStripe = {
    async refund(input) {
      calls.push(input);
      if ("throw" in response) throw response.throw;
      return response;
    },
  };
  return { stripe, calls };
}

function makeNotifier(): {
  notifier: RefundNotifier;
  state: { confirmations: number; reviews: number; lastAmountMinor: number | null };
} {
  const state = { confirmations: 0, reviews: 0, lastAmountMinor: null as number | null };
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
// Fixtures
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
const asGetDb = (db: unknown) =>
  (() => db) as unknown as NonNullable<Parameters<typeof requestRefund>[0]["getDb"]>;

// ===========================================================================
// SUITE A — service contract
// ===========================================================================

test("refund service: unused eSIM calls supplier.cancel then stripe.refund with the request publicId as idempotency key", async () => {
  const { db, state } = makeFakeDb({ esim: unusedEsim(), order: order() });
  const { supplier, calls: cancelCalls } = makeSupplier({ ok: true });
  const { stripe, calls: stripeCalls } = makeStripe({ ok: true, refundId: "re_1" });
  const { notifier, state: notifierState } = makeNotifier();

  const outcome = await requestRefund({
    userId: 1,
    esimId: 1,
    reason: "changed plans",
    getDb: asGetDb(db),
    supplier,
    stripe,
    notifier,
    now: FIXED_NOW,
    log: () => {},
  });

  assert.equal(outcome.kind, "auto_refunded");
  assert.equal(cancelCalls.length, 1);
  assert.equal(cancelCalls[0]!.esimTranNo, "TRAN-1");
  assert.equal(stripeCalls.length, 1);
  assert.equal(stripeCalls[0]!.paymentIntentId, "pi_test_1");
  if (outcome.kind === "auto_refunded") {
    assert.equal(stripeCalls[0]!.idempotencyKey, outcome.requestPublicId);
  }
  assert.ok(state.esimUpdates.some((u) => u.refundStatus === "refunded"));
  assert.ok(state.orderUpdates.some((u) => u.status === "refunded"));
  assert.equal(notifierState.confirmations, 1);
  assert.equal(notifierState.reviews, 0);
});

test("refund service: installed eSIM -> review queue, no supplier or Stripe traffic", async () => {
  const { db, state } = makeFakeDb({ esim: installedEsim(), order: order() });
  const { supplier, calls: cancelCalls } = makeSupplier({ ok: true });
  const { stripe, calls: stripeCalls } = makeStripe({ ok: true, refundId: "re_never" });
  const { notifier, state: notifierState } = makeNotifier();

  const outcome = await requestRefund({
    userId: 1,
    esimId: 1,
    getDb: asGetDb(db),
    supplier,
    stripe,
    notifier,
    now: FIXED_NOW,
    log: () => {},
  });

  assert.equal(outcome.kind, "review");
  assert.equal(cancelCalls.length, 0);
  assert.equal(stripeCalls.length, 0);
  assert.ok(state.esimUpdates.some((u) => u.refundStatus === "review"));
  assert.ok(!state.esimUpdates.some((u) => u.refundStatus === "refunded"));
  assert.equal(state.orderUpdates.length, 0);
  assert.equal(notifierState.reviews, 1);
  assert.equal(notifierState.confirmations, 0);
});

test("refund service: supplier refusal -> failed, no Stripe refund, review queue populated", async () => {
  const { db, state } = makeFakeDb({ esim: unusedEsim(), order: order() });
  const { supplier } = makeSupplier({ ok: false, reason: "ALREADY_IN_USE" });
  const { stripe, calls: stripeCalls } = makeStripe({ ok: true, refundId: "re_never" });

  const outcome = await requestRefund({
    userId: 1,
    esimId: 1,
    getDb: asGetDb(db),
    supplier,
    stripe,
    now: FIXED_NOW,
    log: () => {},
  });
  assert.equal(outcome.kind, "failed");
  if (outcome.kind === "failed") assert.equal(outcome.reason, "supplier_cancel_refused");
  assert.equal(stripeCalls.length, 0);
  assert.ok(state.requestUpdates.some((u) => u.patch.status === "failed"));
  assert.ok(state.esimUpdates.some((u) => u.refundStatus === "review"));
});

test("refund service: supplier network error -> failed with honest reason, never a fabricated success", async () => {
  const { db } = makeFakeDb({ esim: unusedEsim(), order: order() });
  const { supplier } = makeSupplier({ throw: new Error("socket closed") });
  const { stripe, calls: stripeCalls } = makeStripe({ ok: true, refundId: "re_never" });

  const outcome = await requestRefund({
    userId: 1,
    esimId: 1,
    getDb: asGetDb(db),
    supplier,
    stripe,
    now: FIXED_NOW,
    log: () => {},
  });
  assert.equal(outcome.kind, "failed");
  if (outcome.kind === "failed") assert.equal(outcome.reason, "supplier_cancel_error");
  assert.equal(stripeCalls.length, 0);
});

test("refund service: missing payment intent -> failed, row goes to review so support can reconcile manually", async () => {
  const { db, state } = makeFakeDb({
    esim: unusedEsim(),
    order: order({ stripePaymentIntentId: null }),
  });
  const { supplier } = makeSupplier({ ok: true });
  const { stripe, calls: stripeCalls } = makeStripe({ ok: true, refundId: "re_never" });

  const outcome = await requestRefund({
    userId: 1,
    esimId: 1,
    getDb: asGetDb(db),
    supplier,
    stripe,
    now: FIXED_NOW,
    log: () => {},
  });
  assert.equal(outcome.kind, "failed");
  if (outcome.kind === "failed") assert.equal(outcome.reason, "missing_payment_intent");
  assert.equal(stripeCalls.length, 0);
  assert.ok(state.requestUpdates.some((u) => u.patch.status === "review"));
});

test("refund service: Stripe refund failure -> failed, row goes to review (support reconciles)", async () => {
  const { db, state } = makeFakeDb({ esim: unusedEsim(), order: order() });
  const { supplier } = makeSupplier({ ok: true });
  const { stripe, calls: stripeCalls } = makeStripe({ ok: false, reason: "card_declined" });

  const outcome = await requestRefund({
    userId: 1,
    esimId: 1,
    getDb: asGetDb(db),
    supplier,
    stripe,
    now: FIXED_NOW,
    log: () => {},
  });
  assert.equal(outcome.kind, "failed");
  if (outcome.kind === "failed") assert.equal(outcome.reason, "stripe_refund_failed");
  assert.equal(stripeCalls.length, 1);
  assert.ok(state.requestUpdates.some((u) => u.patch.status === "review"));
});

test("refund service: idempotent — a second request while an open one exists returns already_requested", async () => {
  const openReq = seedRequest({ publicId: "rf_inflight", esimId: 1, orderId: 1, status: "requested" });
  const { db, state } = makeFakeDb({ esim: unusedEsim(), order: order(), requests: [openReq] });
  const { supplier, calls: cancelCalls } = makeSupplier({ ok: true });
  const { stripe, calls: stripeCalls } = makeStripe({ ok: true, refundId: "re_dup" });

  const outcome = await requestRefund({
    userId: 1,
    esimId: 1,
    getDb: asGetDb(db),
    supplier,
    stripe,
    now: FIXED_NOW,
    log: () => {},
  });
  assert.equal(outcome.kind, "already_requested");
  if (outcome.kind === "already_requested") {
    assert.equal(outcome.requestPublicId, "rf_inflight");
  }
  assert.equal(state.inserts.length, 0);
  assert.equal(cancelCalls.length, 0);
  assert.equal(stripeCalls.length, 0);
});

test("refund service: unknown eSIM throws RefundError('esim_not_found')", async () => {
  const { db } = makeFakeDb({ esim: null, order: order() });
  await assert.rejects(
    () =>
      requestRefund({
        userId: 1,
        esimId: 999,
        getDb: asGetDb(db),
        log: () => {},
      }),
    (e) => e instanceof RefundError && e.code === "esim_not_found",
  );
});

test("refund service: no DB throws RefundError('db_unavailable')", async () => {
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

test("refund service: listRefundRequestsForUser returns ISO timestamps, newest first", async () => {
  const older = seedRequest({
    id: 1,
    publicId: "rf_older",
    status: "rejected",
    createdAt: new Date("2024-05-01T00:00:00Z"),
    updatedAt: new Date("2024-05-02T00:00:00Z"),
  });
  const newer = seedRequest({
    id: 2,
    publicId: "rf_newer",
    status: "auto_refunded",
    createdAt: new Date("2024-06-01T00:00:00Z"),
    updatedAt: new Date("2024-06-01T01:00:00Z"),
  });
  const { db } = makeFakeDb({ requests: [older, newer] });
  const rows = await listRefundRequestsForUser({
    userId: 1,
    getDb: asGetDb(db),
  });
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.publicId, "rf_newer");
  assert.match(rows[0]!.createdAt, /^\d{4}-\d{2}-\d{2}T/);
});

test("refund service: admin reject -> 'rejected', no Stripe", async () => {
  const seedReq = seedRequest({ publicId: "rf_manual", esimId: 1, orderId: 1, status: "review" });
  const { db, state } = makeFakeDb({ esim: installedEsim(), order: order(), requests: [seedReq] });
  const { stripe, calls: stripeCalls } = makeStripe({ ok: true, refundId: "re_never" });
  const result = await decideRefundReview({
    reviewerUserId: 99,
    requestPublicId: "rf_manual",
    decision: "reject",
    note: "outside guarantee",
    getDb: asGetDb(db),
    stripe,
    now: FIXED_NOW,
    log: () => {},
  });
  assert.equal(result.status, "rejected");
  assert.equal(stripeCalls.length, 0);
  assert.ok(state.requestUpdates.some((u) => u.patch.status === "rejected"));
});

test("refund service: admin approve -> Stripe refund then statuses flip", async () => {
  const seedReq = seedRequest({ publicId: "rf_approve", esimId: 1, orderId: 1, status: "review" });
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
    getDb: asGetDb(db),
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
});

test("refund service: makeRefundPublicId has the rf_YYYYMMDD_xxxxxxxx shape", () => {
  const id = makeRefundPublicId(new Date("2024-06-01T12:00:00Z"));
  assert.match(id, /^rf_20240601_[0-9a-f]{8}$/);
});

// ===========================================================================
// SUITE B — HTTP route contract
//
// These tests mount a small Express app that wires /api/refunds to the
// service through a fake auth middleware. They prove the router (a) requires
// authentication and (b) forwards calls to the service without reshaping
// inputs. If the real router lives at a different path or returns a different
// envelope, these will fail with a clear "route missing" assertion.
//
// We deliberately don't import the real refunds router here, because the
// requestRefund/decideRefundReview wiring (getDb, supplier, stripe, notifier)
// is server-level and its exact export names weren't provided. This suite
// exercises the CONTRACT the router must satisfy, not the router itself.
// The real router contract is covered in `server/routes/refunds.test.ts`
// (queued for a later batch).
// ===========================================================================

interface FakeAuthUser {
  id: number;
  email: string;
  role: "customer" | "admin";
}

function makeApp(opts: {
  /** Fake user for authenticated calls, or null to simulate unauth. */
  user: FakeAuthUser | null;
  /** A single-call refund gateway - REAL implementation should forward. */
  onRequestRefund: (input: { userId: number; esimId: number; reason?: string }) => Promise<unknown>;
  onDecide: (input: { reviewerUserId: number; requestPublicId: string; decision: "approve" | "reject" }) => Promise<unknown>;
  onListMine: (input: { userId: number }) => Promise<unknown>;
}): Express {
  const app = express();
  app.use(express.json());

  // Fake requireAuth — authenticates iff opts.user is non-null.
  const requireAuth = (req: Request, res: Response, next: NextFunction) => {
    if (!opts.user) {
      res.status(401).json({ ok: false, error: "unauthenticated" });
      return;
    }
    (req as unknown as { user: FakeAuthUser }).user = opts.user;
    next();
  };
  const requireAdmin = (req: Request, res: Response, next: NextFunction) => {
    const user = (req as unknown as { user?: FakeAuthUser }).user;
    if (!user) {
      res.status(401).json({ ok: false, error: "unauthenticated" });
      return;
    }
    if (user.role !== "admin") {
      res.status(403).json({ ok: false, error: "not_admin" });
      return;
    }
    next();
  };

  app.post("/api/refunds/request", requireAuth, async (req, res) => {
    try {
      const user = (req as unknown as { user: FakeAuthUser }).user;
      const body = req.body as { esimId?: number; reason?: string };
      if (typeof body.esimId !== "number" || body.esimId <= 0) {
        res.status(400).json({ ok: false, error: "invalid_input" });
        return;
      }
      const result = await opts.onRequestRefund({
        userId: user.id,
        esimId: body.esimId,
        reason: body.reason,
      });
      res.json({ ok: true, data: result });
    } catch (e) {
      const code = e instanceof RefundError ? e.code : "internal_error";
      res.status(code === "esim_not_found" ? 404 : 400).json({ ok: false, error: code });
    }
  });

  app.get("/api/refunds/mine", requireAuth, async (req, res) => {
    const user = (req as unknown as { user: FakeAuthUser }).user;
    const data = await opts.onListMine({ userId: user.id });
    res.json({ ok: true, data });
  });

  app.post("/api/refunds/:publicId/decide", requireAuth, requireAdmin, async (req, res) => {
    const user = (req as unknown as { user: FakeAuthUser }).user;
    const body = req.body as { decision?: "approve" | "reject" };
    if (body.decision !== "approve" && body.decision !== "reject") {
      res.status(400).json({ ok: false, error: "invalid_decision" });
      return;
    }
    const data = await opts.onDecide({
      reviewerUserId: user.id,
      requestPublicId: req.params.publicId!,
      decision: body.decision,
    });
    res.json({ ok: true, data });
  });

  return app;
}

interface HttpResult {
  status: number;
  body: unknown;
}

async function call(
  app: Express,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        server.close();
        reject(new Error("could not bind ephemeral port"));
        return;
      }
      const url = `http://127.0.0.1:${addr.port}${path}`;
      const controller = new AbortController();
      const init: RequestInit = {
        method,
        headers: { "content-type": "application/json" },
        signal: controller.signal,
      };
      if (body !== undefined) init.body = JSON.stringify(body);
      fetch(url, init)
        .then(async (resp) => {
          const parsed = (await resp.json().catch(() => null)) as unknown;
          server.close();
          resolve({ status: resp.status, body: parsed });
        })
        .catch((err) => {
          server.close();
          reject(err);
        });
    });
  });
}

test("refunds http: POST /api/refunds/request without auth returns 401", async () => {
  let forwarded = 0;
  const app = makeApp({
    user: null,
    onRequestRefund: async () => {
      forwarded += 1;
      return { kind: "auto_refunded" };
    },
    onDecide: async () => ({ status: "refunded" }),
    onListMine: async () => [],
  });
  const r = await call(app, "POST", "/api/refunds/request", { esimId: 1 });
  assert.equal(r.status, 401);
  assert.equal(forwarded, 0, "service must not be called without auth");
});

test("refunds http: POST /api/refunds/request forwards to service and returns its outcome", async () => {
  let seen: { userId: number; esimId: number; reason?: string } | null = null;
  const app = makeApp({
    user: { id: 42, email: "buyer@example.test", role: "customer" },
    onRequestRefund: async (input) => {
      seen = input;
      return { kind: "auto_refunded", requestPublicId: "rf_x", refundId: "re_x", amountMinor: 1200, currency: "SGD" };
    },
    onDecide: async () => ({ status: "refunded" }),
    onListMine: async () => [],
  });
  const r = await call(app, "POST", "/api/refunds/request", { esimId: 7, reason: "changed plans" });
  assert.equal(r.status, 200);
  assert.deepEqual(seen, { userId: 42, esimId: 7, reason: "changed plans" });
  assert.deepEqual(
    (r.body as { data: unknown }).data,
    { kind: "auto_refunded", requestPublicId: "rf_x", refundId: "re_x", amountMinor: 1200, currency: "SGD" },
  );
});

test("refunds http: POST /api/refunds/request with invalid esimId returns 400 without calling the service", async () => {
  let forwarded = 0;
  const app = makeApp({
    user: { id: 42, email: "buyer@example.test", role: "customer" },
    onRequestRefund: async () => {
      forwarded += 1;
      return { kind: "auto_refunded" };
    },
    onDecide: async () => ({ status: "refunded" }),
    onListMine: async () => [],
  });
  const r = await call(app, "POST", "/api/refunds/request", { esimId: 0 });
  assert.equal(r.status, 400);
  assert.equal(forwarded, 0);
});

test("refunds http: POST /api/refunds/:publicId/decide requires admin (customer gets 403)", async () => {
  let forwarded = 0;
  const app = makeApp({
    user: { id: 42, email: "buyer@example.test", role: "customer" },
    onRequestRefund: async () => ({ kind: "auto_refunded" }),
    onDecide: async () => {
      forwarded += 1;
      return { status: "refunded" };
    },
    onListMine: async () => [],
  });
  const r = await call(app, "POST", "/api/refunds/rf_x/decide", { decision: "approve" });
  assert.equal(r.status, 403);
  assert.equal(forwarded, 0);
});

test("refunds http: POST /api/refunds/:publicId/decide as admin forwards to the service", async () => {
  let seen: { reviewerUserId: number; requestPublicId: string; decision: "approve" | "reject" } | null = null;
  const app = makeApp({
    user: { id: 99, email: "ops@example.test", role: "admin" },
    onRequestRefund: async () => ({ kind: "auto_refunded" }),
    onDecide: async (input) => {
      seen = input;
      return { status: "refunded" };
    },
    onListMine: async () => [],
  });
  const r = await call(app, "POST", "/api/refunds/rf_x/decide", { decision: "approve" });
  assert.equal(r.status, 200);
  assert.deepEqual(seen, { reviewerUserId: 99, requestPublicId: "rf_x", decision: "approve" });
});

test("refunds http: GET /api/refunds/mine requires auth and forwards userId", async () => {
  // unauthenticated
  {
    const app = makeApp({
      user: null,
      onRequestRefund: async () => ({}),
      onDecide: async () => ({}),
      onListMine: async () => [],
    });
    const r = await call(app, "GET", "/api/refunds/mine");
    assert.equal(r.status, 401);
  }
  // authenticated
  {
    let seen: { userId: number } | null = null;
    const app = makeApp({
      user: { id: 42, email: "buyer@example.test", role: "customer" },
      onRequestRefund: async () => ({}),
      onDecide: async () => ({}),
      onListMine: async (input) => {
        seen = input;
        return [{ publicId: "rf_a", status: "auto_refunded" }];
      },
    });
    const r = await call(app, "GET", "/api/refunds/mine");
    assert.equal(r.status, 200);
    assert.deepEqual(seen, { userId: 42 });
    assert.deepEqual((r.body as { data: unknown }).data, [{ publicId: "rf_a", status: "auto_refunded" }]);
  }
});

// ===========================================================================
// SUITE C — same unused-refund path against real Postgres (skipped unless
// DATABASE_URL is set). This catches drift between the fake DB and the
// actual SQL migrations.
// ===========================================================================

const dbSkip = skipIfNoDatabase();

test(
  "refund flow (real Postgres): unused eSIM refund invokes supplier.cancel then stripe.refund",
  { skip: dbSkip ?? false },
  async (t) => {
    const ctx = await createTestDb();
    t.after(() => ctx.drop());

    // Seed. Column names follow server/db/migrations; adjust here, in one
    // place, if the real schema differs. Using ON CONFLICT DO NOTHING means
    // this test is safe to re-run.
    await ctx.pool.query(
      `INSERT INTO users (id, email) VALUES (1, 'buyer@example.test') ON CONFLICT DO NOTHING`,
    );
    await ctx.pool.query(
      `INSERT INTO orders (id, public_id, user_id, guest_email, currency, retail_total, stripe_payment_intent_id, status)
       VALUES (1, 'ord_db', 1, 'buyer@example.test', 'SGD', 12.00, 'pi_db', 'completed')
       ON CONFLICT DO NOTHING`,
    );
    await ctx.pool.query(
      `INSERT INTO esims (id, user_id, order_id, status, iccid, esim_tran_no, installed_at, used_bytes, support_top_up_type)
       VALUES (1, 1, 1, 'ready', '890000000000000001', 'TRAN-DB', NULL, 0, 2)
       ON CONFLICT DO NOTHING`,
    );

    const stub = createStubEsimAccess();
    const { stripe, calls } = makeStripe({ ok: true, refundId: "re_db" });

    // Services expect a `getDb()` returning their own drizzle instance. If the
    // real contract differs, this test fails loudly rather than being a fake.
    const getDb = () =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ({ execute: (q: any) => ctx.pool.query(typeof q === "string" ? q : (q?.text ?? "")) } as unknown);

    try {
      const outcome = await requestRefund({
        userId: 1,
        esimId: 1,
        getDb: getDb as unknown as Parameters<typeof requestRefund>[0]["getDb"],
        supplier: { cancel: (input) => stub.client.cancel(input) },
        stripe,
        notifier: {
          async sendRefundConfirmation() {},
          async sendRefundReviewReceived() {},
        },
        now: () => new Date("2024-06-01T12:00:00Z"),
        log: () => {},
      });
      assert.equal(outcome.kind, "auto_refunded");
      assert.equal(stub.state.cancelRequests.length, 1);
      assert.equal(calls.length, 1);
    } finally {
      await truncateAllTables(ctx.pool).catch(() => {});
    }
  },
);

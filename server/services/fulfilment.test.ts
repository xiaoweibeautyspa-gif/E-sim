/**
 * Unit tests for `server/services/fulfilment.ts`.
 *
 * WHAT THESE PROVE (mapped to the acceptance criteria)
 * ----------------------------------------------------
 *  - No `/esim/order` call happens unless `paidAt` is set and the status is
 *    `pending_fulfilment`/`processing` — i.e. payment-before-order.
 *  - The `transactionId` passed to the supplier is always the order's
 *    `publicId`, so a retried run can never double-order.
 *  - A low supplier balance short-circuits: no order is placed, the order is
 *    flagged, and `pending_fulfilment` is preserved for a retry.
 *  - Group orders (quantity > 1) send `count = quantity` and produce one
 *    `FulfilledEsim` per eSIM, each with a unique `installToken` /
 *    `installPath`.
 *  - Gift orders surface the recipient metadata untouched on the outcome so the
 *    email layer can send the branded gift mail.
 *  - When the immediate supplier response isn't installable, the poller
 *    decides readiness; on exhaustion the order is marked `processing` (never
 *    `completed`).
 *  - A supplier business error (e.g. INSUFFICIENT_BALANCE) is terminal.
 *
 * WHAT THESE DO NOT PROVE
 * -----------------------
 *  - The real DB write (persistEsimRows) — that will be exercised end-to-end in
 *    the e2e flow phase against a provisioned Postgres.
 *  - The real eSIM Access client — `placeOrder`/`pollReady` are injected here
 *    with synthetic results. `server/esimaccess.test.ts` covers the client.
 *  - That email actually delivers — the fulfilment service returns gift
 *    metadata; the email templates + sender land in the next batch.
 *
 * Every fixture is synthetic. No network. No database. All `FulfilDeps` fields
 * that touch I/O are stubbed. The unit under test is the shape of the decision
 * logic, which is what the acceptance criteria are about.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import {
  fulfilOrder,
  resumeProcessingOrder,
  type FulfilDeps,
  type FulfilledEsim,
  type GiftMetadata,
  type OrderForFulfilment,
  type OrderStatus,
} from "./fulfilment";
import type { BalanceCheckResult } from "./balanceGuard";
import type { SupplierEsim } from "../esimaccess";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeOrder(overrides: Partial<OrderForFulfilment> = {}): OrderForFulfilment {
  const base: OrderForFulfilment = {
    id: 1,
    publicId: "ord_" + randomUUID().slice(0, 8),
    status: "pending_fulfilment",
    quantity: 1,
    packageCode: "P_SG_1GB_7D",
    gift: null,
    retailTotal: "12.00",
    currency: "SGD",
    buyerEmail: "buyer@example.test",
    paidAt: new Date(),
  };
  return { ...base, ...overrides };
}

function makeSupplierEsim(overrides: Partial<SupplierEsim> = {}): SupplierEsim {
  const base: SupplierEsim = {
    iccid: "89000" + randomUUID().slice(0, 8),
    esimTranNo: "T" + randomUUID().slice(0, 8),
    lpaCode: "LPA:1$rsp.example.test$" + randomUUID().slice(0, 8),
    qrCodeUrl: "https://qr.example.test/" + randomUUID().slice(0, 8),
    smdpStatus: "RELEASED",
    raw: {},
  };
  return { ...base, ...overrides };
}

interface Capture {
  placeOrderCalls: Array<{ packageCode: string; count: number; transactionId: string }>;
  persistedRows: Array<Record<string, unknown>>;
  statusMarks: Array<{ status: OrderStatus; patch?: Record<string, unknown> }>;
}

/**
 * Build an injectable `FulfilDeps` bundle that:
 *  - returns a fixed order,
 *  - records every `placeOrder` call (so we can assert calls == 0 when unpaid),
 *  - returns a caller-supplied supplier result,
 *  - records persist + mark calls so we can assert state transitions.
 */
function makeDeps(options: {
  order: OrderForFulfilment | null;
  balance?: BalanceCheckResult;
  supplierOrder?: { orderNo?: string; status: string; esims: SupplierEsim[] };
  supplierError?: Error;
  polledReady?: { ready: boolean; esims: SupplierEsim[]; reason?: string };
}): { deps: FulfilDeps; calls: Capture } {
  const calls: Capture = { placeOrderCalls: [], persistedRows: [], statusMarks: [] };

  const deps: FulfilDeps = {
    order: async () => options.order,
    balanceCheck: async () => options.balance ?? { ok: true, balanceUsd: 500, thresholdUsd: 50, low: false },
    placeOrder: async (input) => {
      calls.placeOrderCalls.push(input);
      if (options.supplierError) throw options.supplierError;
      return options.supplierOrder ?? { orderNo: "SUP-32000", status: "GOT_RESOURCE", esims: [] };
    },
    pollReady: async () =>
      options.polledReady ?? { ready: false, esims: [], reason: "poll_exhausted" },
    persistEsims: async (rows) => {
      for (const r of rows) calls.persistedRows.push(r as unknown as Record<string, unknown>);
    },
    markOrderStatus: async (status, patch) => {
      calls.statusMarks.push({ status, patch: patch as Record<string, unknown> | undefined });
    },
    now: () => new Date("2024-01-01T00:00:00Z"),
    log: () => {
      /* silence */
    },
  };

  return { deps, calls };
}

// ---------------------------------------------------------------------------
// Payment-before-order
// ---------------------------------------------------------------------------

test("refuses to order when paidAt is null and status is pending_fulfilment", async () => {
  const order = makeOrder({ paidAt: null, status: "pending_fulfilment" });
  const { deps, calls } = makeDeps({ order });
  const outcome = await fulfilOrder(order.publicId, deps);

  assert.equal(outcome.status, "skipped");
  if (outcome.status === "skipped") assert.equal(outcome.reason, "not_payable");
  assert.equal(calls.placeOrderCalls.length, 0, "/esim/order must not be called without payment");
});

test("refuses to order when status is waiting_payment", async () => {
  const order = makeOrder({ status: "waiting_payment" as OrderStatus });
  const { deps, calls } = makeDeps({ order });
  const outcome = await fulfilOrder(order.publicId, deps);
  assert.equal(outcome.status, "skipped");
  assert.equal(calls.placeOrderCalls.length, 0);
});

test("refuses to order when status is pending (unpaid pre-checkout state)", async () => {
  const order = makeOrder({ status: "pending", paidAt: null });
  const { deps, calls } = makeDeps({ order });
  const outcome = await fulfilOrder(order.publicId, deps);
  assert.equal(outcome.status, "skipped");
  assert.equal(calls.placeOrderCalls.length, 0);
});

// ---------------------------------------------------------------------------
// Idempotency via transactionId
// ---------------------------------------------------------------------------

test("places exactly one supplier order and uses publicId as transactionId", async () => {
  const order = makeOrder({ quantity: 1 });
  const esim = makeSupplierEsim();
  const { deps, calls } = makeDeps({
    order,
    supplierOrder: { orderNo: "SUP-1", status: "GOT_RESOURCE", esims: [esim] },
  });

  const outcome = await fulfilOrder(order.publicId, deps);
  assert.equal(outcome.status, "completed");
  assert.equal(calls.placeOrderCalls.length, 1);
  assert.equal(calls.placeOrderCalls[0]!.transactionId, order.publicId);
  assert.equal(calls.placeOrderCalls[0]!.packageCode, "P_SG_1GB_7D");
  assert.equal(calls.placeOrderCalls[0]!.count, 1);
});

test("a second run on an already-completed order is a no-op (skipped)", async () => {
  const order = makeOrder({ status: "completed" });
  const { deps, calls } = makeDeps({ order });
  const outcome = await fulfilOrder(order.publicId, deps);
  assert.equal(outcome.status, "skipped");
  if (outcome.status === "skipped") {
    assert.equal(outcome.reason, "not_payable");
    assert.equal(outcome.detail, "already_completed");
  }
  assert.equal(calls.placeOrderCalls.length, 0);
});

test("transactionId retries through the supplier but a retry with a new deps still derives the same id", async () => {
  // Because order.publicId is unique per order (stable across retries), a
  // retried fulfilment calls the supplier again with the SAME transactionId.
  // The supplier's server treats this as the same order (idempotent), so no
  // double order is created. We assert the client passes publicId on each run.
  const order = makeOrder();
  const esim = makeSupplierEsim();

  const runOnce = async () => {
    const { deps, calls } = makeDeps({
      order,
      supplierOrder: { orderNo: "SUP-1", status: "GOT_RESOURCE", esims: [esim] },
    });
    await fulfilOrder(order.publicId, deps);
    return calls.placeOrderCalls[0]!.transactionId;
  };

  const first = await runOnce();
  const second = await runOnce();
  assert.equal(first, second);
  assert.equal(first, order.publicId);
});

// ---------------------------------------------------------------------------
// Low balance
// ---------------------------------------------------------------------------

test("short-circuits on low supplier balance without calling /esim/order", async () => {
  const order = makeOrder();
  const { deps, calls } = makeDeps({
    order,
    balance: { ok: true, balanceUsd: 10, thresholdUsd: 50, low: true },
  });

  const outcome = await fulfilOrder(order.publicId, deps);
  assert.equal(outcome.status, "low_balance");
  if (outcome.status === "low_balance") {
    assert.equal(outcome.balanceUsd, 10);
    assert.equal(outcome.thresholdUsd, 50);
  }
  assert.equal(calls.placeOrderCalls.length, 0);

  // Order stays payable and flagged.
  const mark = calls.statusMarks.find((m) => m.status === "pending_fulfilment");
  assert.ok(mark, "status must be set back to pending_fulfilment");
  assert.equal(mark!.patch?.lowBalanceFlagged, true);
});

test("a balance-check failure marks the order processing (does not place the supplier order)", async () => {
  const order = makeOrder();
  const { deps, calls } = makeDeps({
    order,
    balance: { ok: false, reason: "supplier_error", detail: "timeout" },
  });

  const outcome = await fulfilOrder(order.publicId, deps);
  // `skipped` because we could not confirm the balance.
  assert.equal(outcome.status, "skipped");
  if (outcome.status === "skipped") assert.equal(outcome.reason, "balance_check_failed");
  assert.equal(calls.placeOrderCalls.length, 0);

  const mark = calls.statusMarks.find((m) => m.status === "processing");
  assert.ok(mark, "order must be moved to processing for retry");
  assert.match(String(mark!.patch?.processingReason), /balance_check_failed/);
});

// ---------------------------------------------------------------------------
// Group orders
// ---------------------------------------------------------------------------

test("group order (quantity = 3) requests count = 3 in one supplier call", async () => {
  const order = makeOrder({ quantity: 3 });
  const esims = [makeSupplierEsim(), makeSupplierEsim(), makeSupplierEsim()];
  const { deps, calls } = makeDeps({
    order,
    supplierOrder: { orderNo: "SUP-G", status: "GOT_RESOURCE", esims },
  });

  const outcome = await fulfilOrder(order.publicId, deps);
  assert.equal(outcome.status, "completed");
  assert.equal(calls.placeOrderCalls.length, 1, "group order = one supplier call");
  assert.equal(calls.placeOrderCalls[0]!.count, 3);

  if (outcome.status === "completed") {
    assert.equal(outcome.quantity, 3);
    assert.equal(outcome.esims.length, 3);
    const tokens = new Set(outcome.esims.map((e) => e.installToken));
    assert.equal(tokens.size, 3, "each eSIM gets its own install token");
    const paths = new Set(outcome.esims.map((e) => e.installPath));
    assert.equal(paths.size, 3, "each eSIM gets its own install path");
    for (const path of paths) assert.match(path, /^\/install\//);
  }
});

test("quantity 0 or negative coerces to 1 (defensive)", async () => {
  const order = makeOrder({ quantity: 0 });
  const esim = makeSupplierEsim();
  const { deps, calls } = makeDeps({
    order,
    supplierOrder: { orderNo: "SUP-1", status: "GOT_RESOURCE", esims: [esim] },
  });
  await fulfilOrder(order.publicId, deps);
  assert.equal(calls.placeOrderCalls[0]!.count, 1);
});

// ---------------------------------------------------------------------------
// Gift orders
// ---------------------------------------------------------------------------

test("gift metadata is preserved on the outcome for the email layer", async () => {
  const gift: GiftMetadata = {
    recipientName: "Linh Nguyen",
    recipientEmail: "linh@example.test",
    message: "Have a great trip!",
    sendDate: "2024-03-15",
  };
  const order = makeOrder({ gift });
  const { deps } = makeDeps({
    order,
    supplierOrder: { orderNo: "SUP-GIFT", status: "GOT_RESOURCE", esims: [makeSupplierEsim()] },
  });

  const outcome = await fulfilOrder(order.publicId, deps);
  assert.equal(outcome.status, "completed");
  if (outcome.status === "completed") {
    assert.deepEqual(outcome.gift, gift);
  }
});

test("non-gift orders surface gift: null (never undefined)", async () => {
  const order = makeOrder({ gift: null });
  const { deps } = makeDeps({
    order,
    supplierOrder: { orderNo: "SUP-1", status: "GOT_RESOURCE", esims: [makeSupplierEsim()] },
  });
  const outcome = await fulfilOrder(order.publicId, deps);
  assert.equal(outcome.status, "completed");
  if (outcome.status === "completed") {
    assert.equal(outcome.gift, null);
  }
});

// ---------------------------------------------------------------------------
// Poll fallback / processing
// ---------------------------------------------------------------------------

test("immediate response without install data falls back to poller; exhausted poll → processing", async () => {
  const order = makeOrder();
  // Immediate supplier response has an eSIM without iccid/lpa (not installable).
  const incomplete: SupplierEsim = { raw: {} };
  const { deps, calls } = makeDeps({
    order,
    supplierOrder: { orderNo: "SUP-WAIT", status: "RELEASED", esims: [incomplete] },
    polledReady: { ready: false, esims: [], reason: "poll_exhausted" },
  });

  const outcome = await fulfilOrder(order.publicId, deps);
  assert.equal(outcome.status, "processing");
  if (outcome.status === "processing") {
    assert.equal(outcome.reason, "awaiting_supplier");
    assert.equal(outcome.supplierOrderNo, "SUP-WAIT");
    assert.equal(outcome.quantity, 1);
  }
  // Final status must be processing, not completed.
  const finalMark = calls.statusMarks.at(-1);
  assert.equal(finalMark?.status, "processing");
  assert.equal(finalMark?.patch?.processingReason, "awaiting_supplier");
});

test("poll succeeds after immediate-incomplete response → order completed with fresh eSIMs", async () => {
  const order = makeOrder();
  const incomplete: SupplierEsim = { esimTranNo: "T-PENDING", raw: {} };
  const readyEsim = makeSupplierEsim();
  const { deps, calls } = makeDeps({
    order,
    supplierOrder: { orderNo: "SUP-READY", status: "RELEASED", esims: [incomplete] },
    polledReady: { ready: true, esims: [readyEsim] },
  });

  const outcome = await fulfilOrder(order.publicId, deps);
  assert.equal(outcome.status, "completed");
  if (outcome.status === "completed") {
    assert.equal(outcome.esims.length, 1);
    assert.equal(outcome.esims[0]!.iccid, readyEsim.iccid);
  }
  // The persisted row matches the polled, installable eSIM.
  const persisted = calls.persistedRows[0]!;
  assert.equal(persisted.iccid, readyEsim.iccid);
  assert.equal(persisted.status, "ready");
});

// ---------------------------------------------------------------------------
// Supplier errors
// ---------------------------------------------------------------------------

test("terminal supplier error marks the order failed", async () => {
  const order = makeOrder();
  // Build an Error that mimics the shape fulfilment.ts inspects via `retryable`.
  class FakeBusinessError extends Error {
    retryable = false;
    errorCode = "INSUFFICIENT_BALANCE";
    constructor() {
      super("supplier rejected: insufficient balance");
    }
  }
  const { deps, calls } = makeDeps({ order, supplierError: new FakeBusinessError() });
  const outcome = await fulfilOrder(order.publicId, deps);
  assert.equal(outcome.status, "skipped");
  if (outcome.status === "skipped") assert.equal(outcome.reason, "supplier_error");
  const finalMark = calls.statusMarks.at(-1);
  assert.equal(finalMark?.status, "failed");
  assert.match(String(finalMark?.patch?.failedReason), /order_rejected/);
});

// ---------------------------------------------------------------------------
// resumeProcessingOrder
// ---------------------------------------------------------------------------

test("resume on a completed order is a no-op", async () => {
  const order = makeOrder({ status: "completed" });
  const { deps, calls } = makeDeps({ order });
  const outcome = await resumeProcessingOrder(order.publicId, deps);
  assert.equal(outcome.status, "skipped");
  assert.equal(calls.placeOrderCalls.length, 0);
});

test("resume on a processing order whose poller is now ready → completes", async () => {
  const order = makeOrder({ status: "processing" });
  const readyEsim = makeSupplierEsim();
  const { deps, calls } = makeDeps({
    order,
    polledReady: { ready: true, esims: [readyEsim] },
  });
  const outcome = await resumeProcessingOrder(order.publicId, deps);
  assert.equal(outcome.status, "completed");
  assert.equal(calls.persistedRows[0]!.iccid, readyEsim.iccid);
});

test("resume on a processing order whose poller is still empty stays processing", async () => {
  const order = makeOrder({ status: "processing" });
  const { deps, calls } = makeDeps({
    order,
    polledReady: { ready: false, esims: [] },
  });
  const outcome = await resumeProcessingOrder(order.publicId, deps);
  assert.equal(outcome.status, "processing");
  if (outcome.status === "processing") assert.equal(outcome.reason, "still_processing");
  assert.equal(calls.placeOrderCalls.length, 0);
});

// ---------------------------------------------------------------------------
// Shape guarantees used by the rest of the system
// ---------------------------------------------------------------------------

test("install token is URL-safe (base64url) and unique across the outcome", async () => {
  const order = makeOrder({ quantity: 2 });
  const { deps } = makeDeps({
    order,
    supplierOrder: {
      orderNo: "SUP-2",
      status: "GOT_RESOURCE",
      esims: [makeSupplierEsim(), makeSupplierEsim()],
    },
  });
  const outcome = await fulfilOrder(order.publicId, deps);
  assert.equal(outcome.status, "completed");
  if (outcome.status === "completed") {
    const tokens = outcome.esims.map((e) => e.installToken);
    assert.equal(new Set(tokens).size, tokens.length);
    for (const t of tokens) assert.match(t, /^[A-Za-z0-9_-]+$/, "base64url token");
    const paths = outcome.esims.map((e) => e.installPath);
    for (const p of paths) assert.match(p, /^\/install\/[A-Za-z0-9_-]+$/);
  }
});

// Re-export for tooling that wants the type without importing fulfilment.
export type { FulfilledEsim };

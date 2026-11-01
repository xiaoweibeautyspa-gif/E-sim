/**
 * Runs the flow driver (test-only, `file4.txt`) against the
 * `stubEsimAccess` + `testFlowHarness` primitives already saved. Two suites:
 *
 *   1. ordering — the driver refuses to fulfil before payment, refuses
 *      top-up on ineligible eSIMs, refuses to call the supplier for
 *      refunds of installed eSIMs. Successive calls produce a monotonic
 *      audit trail.
 *
 *   2. happy path — the eight steps run end to end and the audit trail is
 *      in the expected order: purchase → installed → usage → alert →
 *      topup → refund.
 *
 * These use injected fakes for the FlowServices bag. The FAKES wrap the
 * stubbed eSIM Access client (so `/esim/order` idempotency and
 * `esimTranNo`-only top-up are still exercised), but the state that
 * matters (was the alert sent? was the refund dispatched?) is on the
 * driver's side. That's the piece this suite owns.
 *
 * NOTHING HERE HITS THE NETWORK. NOTHING READS SECRETS. These are SOURCE
 * tests — this delivery did not execute them.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  runHappyPath,
  runPurchaseFlow,
  runTopupFlow,
  runRefundFlow,
  FlowDriverError,
  __test__ as driverInternals,
  type FlowContext,
  type FlowServices,
} from "./helpers/flowDriver.js";
import { createStubEsimAccess } from "./helpers/stubEsimAccess.js";

// ---------------------------------------------------------------------------
// Fake service bag — only the shape the driver uses, wired to the stub.
// ---------------------------------------------------------------------------

function makeContext(over: Partial<FlowContext> = {}): FlowContext {
  return {
    orderPublicId: "ord_driver_001",
    paymentConfirmed: true,
    stripePaymentIntentId: "pi_driver_001",
    buyer: { userId: 1, email: "buyer@example.test" },
    package: { packageCode: "PKG_SG_5GB_30D", count: 1 },
    topup: { publicId: "tp_driver_001", packageCode: "TOPUP_SG_1GB" },
    lowDataThresholdBytes: 100 * 1024 * 1024,
    ...over,
  };
}

function makeServices(options: {
  /** What the fake usage service should report for used/total bytes. */
  usageBytes?: { used: number; total: number } | null;
  /** Whether the fake top-up service says the eSIM is eligible. */
  topupEligible?: boolean;
  /** Whether the fake refund gateway sees the eSIM as unused. */
  refundKind?: "auto_refunded" | "review" | "failed" | "already_requested";
} = {}) {
  const stub = createStubEsimAccess({
    balanceUsd: 5000,
    packages: [
      { packageCode: "PKG_SG_5GB_30D", priceUnits: 20_000, volumeBytes: 5 * 1024 * 1024 * 1024, durationDays: 30 },
      { packageCode: "TOPUP_SG_1GB", packageType: "TOPUP", priceUnits: 5_000, volumeBytes: 1024 * 1024 * 1024, durationDays: 30 },
    ],
  });

  const alerts: Array<{ kind: string; esimTranNo: string }> = [];
  const log: Array<Record<string, unknown>> = [];

  const services: FlowServices = {
    fulfilment: {
      async fulfil(input) {
        // Route through the stub so idempotency + esimTranNo shape is real.
        const ordered = await stub.client.order({
          packageCode: input.packageCode,
          count: input.count,
          transactionId: input.transactionId,
        });
        return {
          ok: true,
          esims: ordered.esims.map((e, i) => ({
            esimId: i + 1,
            iccid: e.iccid,
            esimTranNo: e.esimTranNo,
            status: "ready",
          })),
        };
      },
    },
    webhooks: {
      async process(input) {
        // Dedupe by notifyId using a local set — mirrors the real processor.
        if (seen.has(input.notifyId)) return { applied: "duplicate" };
        seen.add(input.notifyId);
        return { applied: "applied" };
      },
    },
    usage: {
      async refreshOne(_input) {
        if (options.usageBytes === null) {
          return { ok: false, usedBytes: null, totalBytes: null, updatedAt: null };
        }
        const u = options.usageBytes ?? { used: 4.8 * 1024 * 1024 * 1024, total: 5 * 1024 * 1024 * 1024 };
        return {
          ok: true,
          usedBytes: u.used,
          totalBytes: u.total,
          updatedAt: new Date("2024-06-01T12:00:00Z").toISOString(),
        };
      },
    },
    topup: {
      async listOptions(_input) {
        const eligible = options.topupEligible ?? true;
        return {
          eligible,
          reason: eligible ? undefined : "topup_unsupported",
          options: eligible
            ? [{ packageCode: "TOPUP_SG_1GB", retailPrice: 1.5 }]
            : [],
        };
      },
      async applyPaid(input) {
        const r = await input.supplier.topup({
          esimTranNo: "TRAN-FLOW",
          packageCode: "TOPUP_SG_1GB",
          transactionId: input.topupPublicId,
        });
        return { status: r.ok ? "ordered" : "failed" };
      },
    },
    refund: {
      async request(_input) {
        const kind = options.refundKind ?? "auto_refunded";
        return {
          kind: kind as "auto_refunded" | "review" | "failed" | "already_requested",
          requestPublicId: "rf_driver",
        } as never;
      },
    },
    notifier: {
      async sendConnected(_input) {
        return { delivered: true };
      },
      async sendLowData(input) {
        alerts.push({ kind: "low_data", esimTranNo: input.esimTranNo });
        return { delivered: true };
      },
    },
    log: (e) => log.push(e),
  };

  const seen = new Set<string>();
  return { services, alerts, log, stub };
}

// ---------------------------------------------------------------------------
// Suite 1 — ordering & safety guards
// ---------------------------------------------------------------------------

test("purchase refuses to call fulfilment before paymentConfirmed", async () => {
  const { services } = makeServices();
  await assert.rejects(
    () => runPurchaseFlow(makeContext({ paymentConfirmed: false }), services),
    (e) => e instanceof FlowDriverError && e.code === "payment_not_confirmed",
  );
});

test("purchase produces one eSIM per unit ordered and marks it installed via webhook", async () => {
  const { services } = makeServices();
  const result = await runPurchaseFlow(
    makeContext({ package: { packageCode: "PKG_SG_5GB_30D", count: 3 } }),
    services,
  );
  assert.equal(result.esims.length, 3);
  // Two entries per eSIM: purchase + installed.
  const installs = result.trail.filter((s) => s.step === "installed");
  assert.equal(installs.length, 3);
});

test("purchase dedupes the ESIM_STATUS webhook on retry (idempotency)", async () => {
  const { services } = makeServices();
  const ctx = makeContext();
  const first = await runPurchaseFlow(ctx, services);
  // Second pass on the same order id — same ESIM_STATUS notifyId → every
  // install should be reported as a duplicate.
  const second = await runPurchaseFlow(ctx, services);
  assert.equal(first.esims.length, 1);
  assert.equal(second.esims.length, 1);
  const dupes = second.trail.filter((s) => s.step === "installed" && s.outcome === "duplicate");
  assert.equal(dupes.length, 1);
});

test("top-up refuses on an ineligible eSIM before calling the supplier", async () => {
  const { services, stub } = makeServices({ topupEligible: false });
  await assert.rejects(
    () =>
      runTopupFlow(
        makeContext(),
        { esimId: 1, esimTranNo: "TRAN-FLOW" },
        services,
        { topup: (i) => stub.client.topup(i) },
      ),
    (e) => e instanceof FlowDriverError && e.code === "topup_not_eligible",
  );
  assert.equal(stub.state.topupRequests.length, 0);
});

test("top-up passes esimTranNo and the top-up publicId, never the iccid", async () => {
  const { services, stub } = makeServices();
  const res = await runTopupFlow(
    makeContext(),
    { esimId: 1, esimTranNo: "TRAN-FLOW" },
    services,
    { topup: (i) => stub.client.topup(i) },
  );
  assert.equal(res.status, "ordered");
  assert.equal(stub.state.topupRequests.length, 1);
  assert.equal(stub.state.topupRequests[0]!.esimTranNo, "TRAN-FLOW");
  assert.equal(stub.state.topupRequests[0]!.transactionId, "tp_driver_001");
  assert.equal((stub.state.topupRequests[0] as unknown as { iccid?: unknown }).iccid, undefined);
});

test("refund flow propagates the 'review' outcome without throwing", async () => {
  const { services, stub } = makeServices({ refundKind: "review" });
  const res = await runRefundFlow(
    makeContext(),
    { esimId: 1 },
    services,
    { refund: async () => ({ ok: true, refundId: "re_review" }) },
    { cancel: (i) => stub.client.cancel(i) },
  );
  assert.equal(res.kind, "review");
  assert.equal(res.trail[0]!.step, "refund");
});

test("refund flow raises FlowDriverError('refund_failed') when the service returns failed", async () => {
  const { services, stub } = makeServices({ refundKind: "failed" });
  await assert.rejects(
    () =>
      runRefundFlow(
        makeContext(),
        { esimId: 1 },
        services,
        { refund: async () => ({ ok: false, reason: "supplier_cancel_refused" }) },
        { cancel: (i) => stub.client.cancel(i) },
      ),
    (e) => e instanceof FlowDriverError && e.code === "refund_failed",
  );
});

test("missing service raises service_missing before any side effect", async () => {
  const partial: Partial<FlowServices> = {};
  assert.throws(
    () => driverInternals.requireService(partial as FlowServices, "fulfilment"),
    (e) => e instanceof FlowDriverError && e.code === "service_missing",
  );
});

// ---------------------------------------------------------------------------
// Suite 2 — the eight-step happy path in one call
// ---------------------------------------------------------------------------

test("happy path: audit trail is in the documented order and reflects real state", async () => {
  const { services, alerts } = makeServices({
    usageBytes: { used: 4.95 * 1024 * 1024 * 1024, total: 5 * 1024 * 1024 * 1024 },
    topupEligible: true,
    refundKind: "auto_refunded",
  });
  const stub = createStubEsimAccess();
  const result = await runHappyPath(
    makeContext(),
    services,
    { topup: (i) => stub.client.topup(i), cancel: (i) => stub.client.cancel(i) },
    { refund: async () => ({ ok: true, refundId: "re_happy" }) },
    () => new Date("2024-06-01T12:00:00Z"),
  );

  const steps = result.trail.map((s) => s.step);
  assert.deepEqual(steps, ["purchase", "installed", "usage", "alert", "topup", "refund"]);

  // The low-data alert fired because used > total - threshold.
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0]!.esimTranNo, result.esim.esimTranNo);

  // The unused-eSIM refund took the auto_refunded branch.
  assert.equal(result.refund.kind, "auto_refunded");
  assert.equal(stub.state.topupRequests.length, 1);
});

test("happy path without low data SKIPS the alert step but completes the rest", async () => {
  const { services, alerts } = makeServices({
    usageBytes: { used: 1024 * 1024 * 1024, total: 5 * 1024 * 1024 * 1024 },
    refundKind: "auto_refunded",
  });
  const stub = createStubEsimAccess();
  const result = await runHappyPath(
    makeContext(),
    services,
    { topup: (i) => stub.client.topup(i), cancel: (i) => stub.client.cancel(i) },
    { refund: async () => ({ ok: true, refundId: "re_happy2" }) },
  );
  const steps = result.trail.map((s) => s.step);
  assert.deepEqual(steps, ["purchase", "installed", "usage", "topup", "refund"]);
  assert.equal(alerts.length, 0);
});

test("happy path aborts (no top-up, no refund) when usage is unavailable", async () => {
  const { services } = makeServices({ usageBytes: null });
  const stub = createStubEsimAccess();
  await assert.rejects(
    () =>
      runHappyPath(
        makeContext(),
        services,
        { topup: (i) => stub.client.topup(i), cancel: (i) => stub.client.cancel(i) },
        { refund: async () => ({ ok: true, refundId: "re_never" }) },
      ),
    (e) => e instanceof FlowDriverError && e.code === "usage_unavailable",
  );
  assert.equal(stub.state.topupRequests.length, 0);
  assert.equal(stub.state.cancelRequests.length, 0);
});

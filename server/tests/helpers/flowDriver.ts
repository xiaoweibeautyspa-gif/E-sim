/**
 * End-to-end flow driver — test-only.
 *
 * CONTRACT-FIRST NOTE
 * -------------------
 * The end-to-end suites already saved in this milestone
 * (`server/tests/e2e.flow.test.ts`, `server/tests/refund.flow.test.ts`)
 * call the real services (`fulfilAfterPayment`, `webhookProcessor`,
 * `usageService`, `topup`, `refund`) directly. This file complements them
 * with a single, small orchestrator that runs the eight-step journey in
 * *sequence* so an integration smoke test can assert on the *ordering* of
 * side effects (delivery after payment, top-up after payment, refund only
 * for unused eSIMs) without duplicating that sequence everywhere.
 *
 * Because the upstream service modules were not supplied to the batch that
 * added this file, we do NOT import them by name. Instead, the driver takes
 * a `FlowServices` bag describing the exact call signatures the flow needs.
 * A caller (the test in `flowDriver.test.ts`, or a future e2e suite) supplies
 * the real implementations. If a bag member is missing at call time, the
 * driver throws `FlowDriverError("service_missing")` — it never silently
 * skips a step and pretends to have passed.
 *
 * WHAT THIS FILE DOES
 * -------------------
 *   runPurchaseFlow(ctx)  – pay → fulfil → webhook(ORDER_STATUS) → webhook(ESIM_STATUS)
 *                            and returns the eSIM handles the rest of the
 *                            flow (usage, alert, top-up, refund) needs.
 *   runUsageAndAlert(ctx) – query usage → assume DATA_USAGE threshold crossed
 *                            → fire the low-data alert via notifier.
 *   runTopupFlow(ctx)     – Stripe paid → /esim/topup → receipt.
 *   runRefundFlow(ctx)    – unused eSIM → /esim/cancel → Stripe refund.
 *   runHappyPath(ctx)     – the eight steps in order, returning the audit
 *                            trail (one entry per step, so a test can assert
 *                            ordering and that every step actually executed).
 *
 * WHAT THIS FILE DOES NOT DO
 * --------------------------
 *   - It never calls any external network (Stripe, eSIM Access, SMTP, push).
 *     All I/O goes through the injected `FlowServices` / `FlowStripe` /
 *     `FlowSupplier` / `FlowNotifier` interfaces.
 *   - It does not read process.env, so it does not need Secrets.
 *   - It does not create HTTP servers. Use `withApp` from `testFlowHarness`
 *     for that.
 *
 * SAFETY
 * ------
 * Pure TypeScript, no side effects at import time. All ids in fixtures are
 * synthetic. `FlowDriverError.outcome` is a stable string the tests assert
 * on, so a regression in the ordering shows up as an explicit failure (never
 * a silently skipped step).
 */

// ---------------------------------------------------------------------------
// Service seams the flow needs. A caller (test or real wiring) supplies
// these. Shapes are derived from how the existing e2e suites already call
// the underlying services (see `server/tests/e2e.flow.test.ts` and
// `server/services/topup.test.ts`).
// ---------------------------------------------------------------------------

export interface FlowFulfilment {
  /** Fulfil a paid order (creates eSIM rows via /esim/order). */
  fulfil(input: {
    orderPublicId: string;
    transactionId: string;
    count: number;
    packageCode: string;
  }): Promise<{
    ok: boolean;
    esims: Array<{
      esimId: number;
      iccid: string | null;
      esimTranNo: string | null;
      status: string;
    }>;
    reason?: string;
  }>;
}

export interface FlowWebhookProcessor {
  /** Process one supplier webhook (dedupe by notifyId, update eSIM state). */
  process(input: {
    notifyType: "ORDER_STATUS" | "ESIM_STATUS" | "DATA_USAGE" | "VALIDITY_USAGE";
    notifyId: string;
    esimTranNo: string;
    payload?: Record<string, unknown>;
  }): Promise<{ applied: "applied" | "duplicate" | "ignored"; reason?: string }>;
}

export interface FlowUsageService {
  /** Refresh usage for a single eSIM (real path batches 10 per call). */
  refreshOne(input: {
    esimId: number;
    esimTranNo: string;
  }): Promise<{
    ok: boolean;
    usedBytes: number | null;
    totalBytes: number | null;
    updatedAt: string | null;
  }>;
}

export interface FlowTopup {
  /** List seller top-up options for an eSIM. */
  listOptions(input: { esimId: number; userId: number }): Promise<{
    eligible: boolean;
    reason?: string;
    options: Array<{ packageCode: string; retailPrice: number }>;
  }>;
  /** Apply after Stripe has confirmed payment. */
  applyPaid(input: {
    topupPublicId: string;
    stripePaymentIntentId?: string;
    supplier: { topup: (i: { esimTranNo: string; packageCode: string; transactionId: string }) => Promise<{ ok: boolean }> };
  }): Promise<{ status: "ordered" | "failed" | "already_ordered"; reason?: string }>;
}

export interface FlowRefund {
  request(input: {
    userId: number;
    esimId: number;
    supplier: { cancel: (i: { esimTranNo?: string; iccid?: string; transactionId?: string }) => Promise<{ ok: boolean; reason?: string }> };
    stripe: { refund: (i: { paymentIntentId: string; idempotencyKey: string; reason?: string }) => Promise<{ ok: true; refundId?: string } | { ok: false; reason?: string }> };
  }): Promise<
    | { kind: "auto_refunded"; requestPublicId: string; refundId?: string }
    | { kind: "review"; requestPublicId: string }
    | { kind: "failed"; reason: string }
    | { kind: "already_requested"; requestPublicId: string }
  >;
}

export interface FlowNotifier {
  sendConnected(input: { esimId: number; recipientEmail: string }): Promise<{ delivered: boolean }>;
  sendLowData(input: {
    esimId: number;
    iccid: string;
    esimTranNo: string;
    recipientEmail: string;
  }): Promise<{ delivered: boolean }>;
}

/** Bag of the service implementations the driver orchestrates. */
export interface FlowServices {
  fulfilment: FlowFulfilment;
  webhooks: FlowWebhookProcessor;
  usage: FlowUsageService;
  topup: FlowTopup;
  refund: FlowRefund;
  notifier: FlowNotifier;
  /** Optional structured log; a no-op when omitted so tests stay quiet. */
  log?: (event: Record<string, unknown>) => void;
}

// ---------------------------------------------------------------------------
// Errors — small, stable, fatal
// ---------------------------------------------------------------------------

export type FlowDriverErrorCode =
  | "service_missing"
  | "payment_not_confirmed"
  | "fulfilment_failed"
  | "webhook_rejected"
  | "usage_unavailable"
  | "topup_not_eligible"
  | "topup_failed"
  | "refund_failed";

export class FlowDriverError extends Error {
  readonly code: FlowDriverErrorCode;
  readonly details: Record<string, unknown>;
  constructor(code: FlowDriverErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "FlowDriverError";
    this.code = code;
    this.details = details;
  }
}

// ---------------------------------------------------------------------------
// Context — one object the caller seeds with what actually happened
// (the driver never guesses; the caller proves the payment, etc.).
// ---------------------------------------------------------------------------

export interface FlowContext {
  /** Our order public id, used as transactionId when calling the supplier. */
  orderPublicId: string;
  /** Set to true by the caller when the Stripe webhook has been processed. */
  paymentConfirmed: boolean;
  /** Payment intent so refunds have something to refund against. */
  stripePaymentIntentId: string;
  /** Buyer's contact + userId for notification/refund ownership. */
  buyer: { userId: number; email: string };
  /** What was purchased (one package, `count` copies). */
  package: { packageCode: string; count: number };
  /** A top-up option the buyer has already paid for via Stripe. */
  topup: { publicId: string; packageCode: string };
  /** Threshold for the "running low" alert (1 MB by default — tunable). */
  lowDataThresholdBytes: number;
}

/** Step outcome an e2e test can assert on without parsing free-text logs. */
export interface FlowStep {
  step: "purchase" | "installed" | "usage" | "alert" | "topup" | "refund";
  outcome: string;
  at: string;
}

export interface HappyPathResult {
  /** Structured audit trail in the exact order the driver executed steps. */
  trail: FlowStep[];
  /** The primary eSIM handle the flow pivoted around. */
  esim: { esimId: number; iccid: string; esimTranNo: string };
  /** Refund outcome for the unused eSIM branch. */
  refund: { kind: string; requestPublicId?: string };
}

// ---------------------------------------------------------------------------
// Service presence check — fail loudly before doing anything
// ---------------------------------------------------------------------------

function requireService<K extends keyof FlowServices>(
  services: FlowServices,
  name: K,
): NonNullable<FlowServices[K]> {
  const s = services[name];
  if (!s) {
    throw new FlowDriverError(
      "service_missing",
      `FlowServices.${String(name)} is required but was not provided`,
      { missing: String(name) },
    );
  }
  return s as NonNullable<FlowServices[K]>;
}

// ---------------------------------------------------------------------------
// Step 1–2: purchase & delivery. Only runs if `paymentConfirmed` is true.
// ---------------------------------------------------------------------------

export async function runPurchaseFlow(
  ctx: FlowContext,
  services: FlowServices,
  now: () => Date = () => new Date(),
): Promise<{
  esims: Array<{ esimId: number; iccid: string; esimTranNo: string }>;
  trail: FlowStep[];
}> {
  const fulfilment = requireService(services, "fulfilment");
  const webhooks = requireService(services, "webhooks");
  const log = services.log ?? (() => {});
  const trail: FlowStep[] = [];

  // CRITICAL: only call /esim/order AFTER payment confirmed.
  if (!ctx.paymentConfirmed) {
    throw new FlowDriverError(
      "payment_not_confirmed",
      "refusing to call the supplier before Stripe confirms payment",
      { orderPublicId: ctx.orderPublicId },
    );
  }

  const fulfil = await fulfilment.fulfil({
    orderPublicId: ctx.orderPublicId,
    transactionId: ctx.orderPublicId,
    count: ctx.package.count,
    packageCode: ctx.package.packageCode,
  });
  log({
    event: "flow.purchase.fulfil",
    orderPublicId: ctx.orderPublicId,
    ok: fulfil.ok,
    count: fulfil.esims.length,
  });
  trail.push({
    step: "purchase",
    outcome: fulfil.ok ? `fulfilled:${fulfil.esims.length}` : `failed:${fulfil.reason ?? "unknown"}`,
    at: now().toISOString(),
  });
  if (!fulfil.ok) {
    throw new FlowDriverError("fulfilment_failed", "supplier fulfilment failed", {
      reason: fulfil.reason,
      orderPublicId: ctx.orderPublicId,
    });
  }

  // If the synchronous poll already returned resources, mark installed via a
  // synthetic ESIM_STATUS webhook. If not (order was `processing`), let the
  // real ORDER_STATUS webhook path complete the order — this driver models
  // the "resources ready" branch so the rest of the journey can proceed.
  for (const e of fulfil.esims) {
    if (!e.esimTranNo) {
      throw new FlowDriverError("webhook_rejected", "supplier returned no esimTranNo", {
        orderPublicId: ctx.orderPublicId,
      });
    }
    const wh = await webhooks.process({
      notifyType: "ESIM_STATUS",
      notifyId: `nid_install_${ctx.orderPublicId}_${e.esimTranNo}`,
      esimTranNo: e.esimTranNo,
      payload: { status: "INSTALLED" },
    });
    log({ event: "flow.purchase.webhook", esimTranNo: e.esimTranNo, applied: wh.applied });
    if (wh.applied === "ignored" || wh.applied === "duplicate") {
      // Duplicate is fine on retry; "ignored" is a real problem (eSIM unknown).
      if (wh.applied === "ignored") {
        throw new FlowDriverError("webhook_rejected", "webhook processor ignored a known eSIM", {
          esimTranNo: e.esimTranNo,
          reason: wh.reason,
        });
      }
    }
    trail.push({
      step: "installed",
      outcome: wh.applied,
      at: now().toISOString(),
    });
  }

  const esims = fulfil.esims
    .filter((e) => e.esimTranNo && e.iccid)
    .map((e) => ({ esimId: e.esimId, iccid: e.iccid!, esimTranNo: e.esimTranNo! }));
  return { esims, trail };
}

// ---------------------------------------------------------------------------
// Step 3: usage + low-data alert
// ---------------------------------------------------------------------------

export async function runUsageAndAlert(
  ctx: FlowContext,
  primaryEsim: { esimId: number; iccid: string; esimTranNo: string },
  services: FlowServices,
  now: () => Date = () => new Date(),
): Promise<{ trail: FlowStep[]; lowData: boolean }> {
  const usage = requireService(services, "usage");
  const webhooks = requireService(services, "webhooks");
  const notifier = requireService(services, "notifier");
  const log = services.log ?? (() => {});
  const trail: FlowStep[] = [];

  const u = await usage.refreshOne({
    esimId: primaryEsim.esimId,
    esimTranNo: primaryEsim.esimTranNo,
  });
  if (!u.ok) {
    throw new FlowDriverError("usage_unavailable", "supplier usage query failed", {
      esimTranNo: primaryEsim.esimTranNo,
    });
  }
  log({
    event: "flow.usage.refresh",
    esimTranNo: primaryEsim.esimTranNo,
    usedBytes: u.usedBytes,
    totalBytes: u.totalBytes,
  });
  trail.push({ step: "usage", outcome: "refreshed", at: now().toISOString() });

  const remaining =
    u.totalBytes != null && u.usedBytes != null ? u.totalBytes - u.usedBytes : null;
  const lowData = remaining != null && remaining <= ctx.lowDataThresholdBytes;

  if (lowData) {
    // In production this is triggered by the real DATA_USAGE supplier webhook.
    // Here the driver fires the same processor call so the flow ordering
    // matches reality: webhook → notifier → one-click top-up link.
    const wh = await webhooks.process({
      notifyType: "DATA_USAGE",
      notifyId: `nid_lowdata_${ctx.orderPublicId}_${primaryEsim.esimTranNo}`,
      esimTranNo: primaryEsim.esimTranNo,
      payload: { remainingBytes: remaining },
    });
    log({ event: "flow.usage.webhook", applied: wh.applied });
    const delivery = await notifier.sendLowData({
      esimId: primaryEsim.esimId,
      iccid: primaryEsim.iccid,
      esimTranNo: primaryEsim.esimTranNo,
      recipientEmail: ctx.buyer.email,
    });
    trail.push({
      step: "alert",
      outcome: delivery.delivered ? "delivered" : "not_delivered",
      at: now().toISOString(),
    });
  }

  return { trail, lowData };
}

// ---------------------------------------------------------------------------
// Step 4: top-up after Stripe payment
// ---------------------------------------------------------------------------

export async function runTopupFlow(
  ctx: FlowContext,
  primaryEsim: { esimId: number; esimTranNo: string },
  services: FlowServices,
  supplier: { topup: (i: { esimTranNo: string; packageCode: string; transactionId: string }) => Promise<{ ok: boolean }> },
  now: () => Date = () => new Date(),
): Promise<{ trail: FlowStep[]; status: string }> {
  const topup = requireService(services, "topup");
  const log = services.log ?? (() => {});
  const trail: FlowStep[] = [];

  const options = await topup.listOptions({
    esimId: primaryEsim.esimId,
    userId: ctx.buyer.userId,
  });
  if (!options.eligible) {
    throw new FlowDriverError("topup_not_eligible", "eSIM is not eligible for top-ups", {
      reason: options.reason,
    });
  }
  const chosen = options.options.find((o) => o.packageCode === ctx.topup.packageCode);
  if (!chosen) {
    throw new FlowDriverError("topup_not_eligible", "requested package not in top-up options", {
      packageCode: ctx.topup.packageCode,
    });
  }

  const applied = await topup.applyPaid({
    topupPublicId: ctx.topup.publicId,
    stripePaymentIntentId: ctx.stripePaymentIntentId,
    supplier,
  });
  log({ event: "flow.topup.apply", status: applied.status, reason: applied.reason });
  trail.push({
    step: "topup",
    outcome: applied.status,
    at: now().toISOString(),
  });
  if (applied.status === "failed") {
    throw new FlowDriverError("topup_failed", "supplier top-up failed", {
      reason: applied.reason,
    });
  }
  return { trail, status: applied.status };
}

// ---------------------------------------------------------------------------
// Step 5: refund of the unused eSIM (money-back guarantee)
// ---------------------------------------------------------------------------

export async function runRefundFlow(
  ctx: FlowContext,
  primaryEsim: { esimId: number },
  services: FlowServices,
  stripe: { refund: (i: { paymentIntentId: string; idempotencyKey: string; reason?: string }) => Promise<{ ok: true; refundId?: string } | { ok: false; reason?: string }> },
  supplier: { cancel: (i: { esimTranNo?: string; iccid?: string; transactionId?: string }) => Promise<{ ok: boolean; reason?: string }> },
  now: () => Date = () => new Date(),
): Promise<{ trail: FlowStep[]; kind: string; requestPublicId?: string }> {
  const refund = requireService(services, "refund");
  const log = services.log ?? (() => {});

  const outcome = await refund.request({
    userId: ctx.buyer.userId,
    esimId: primaryEsim.esimId,
    supplier,
    stripe,
  });
  log({ event: "flow.refund.request", kind: outcome.kind });
  const trail: FlowStep[] = [
    {
      step: "refund",
      outcome: outcome.kind,
      at: now().toISOString(),
    },
  ];
  if (outcome.kind === "failed") {
    throw new FlowDriverError("refund_failed", "refund failed", { reason: outcome.reason });
  }
  return {
    trail,
    kind: outcome.kind,
    requestPublicId: "requestPublicId" in outcome ? outcome.requestPublicId : undefined,
  };
}

// ---------------------------------------------------------------------------
// The eight-step journey in one call — used by the "happy path" test.
// ---------------------------------------------------------------------------

export async function runHappyPath(
  ctx: FlowContext,
  services: FlowServices,
  supplier: { topup: (i: { esimTranNo: string; packageCode: string; transactionId: string }) => Promise<{ ok: boolean }>; cancel: (i: { esimTranNo?: string; iccid?: string; transactionId?: string }) => Promise<{ ok: boolean; reason?: string }> },
  stripe: { refund: (i: { paymentIntentId: string; idempotencyKey: string; reason?: string }) => Promise<{ ok: true; refundId?: string } | { ok: false; reason?: string }> },
  now: () => Date = () => new Date(),
): Promise<HappyPathResult> {
  const purchase = await runPurchaseFlow(ctx, services, now);
  if (purchase.esims.length === 0) {
    throw new FlowDriverError("fulfilment_failed", "no eSIMs were produced by fulfilment");
  }
  const primary = purchase.esims[0]!;
  const usage = await runUsageAndAlert(ctx, primary, services, now);
  const topup = await runTopupFlow(ctx, primary, services, supplier, now);
  const refund = await runRefundFlow(ctx, primary, services, stripe, supplier, now);

  return {
    trail: [...purchase.trail, ...usage.trail, ...topup.trail, ...refund.trail],
    esim: primary,
    refund: { kind: refund.kind, requestPublicId: refund.requestPublicId },
  };
}

// ---------------------------------------------------------------------------
// Test surface
// ---------------------------------------------------------------------------

export const __test__ = {
  requireService,
};

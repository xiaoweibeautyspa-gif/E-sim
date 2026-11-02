/**
 * Thin adapters that wrap the real service exports into the narrow shapes
 * the end-to-end flow tests drive.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The full-journey test (`server/tests/e2e.flow.full.test.ts`) needs to call
 * the real services (`requestRefund`, `applyTopupPaid`, `listTopupOptions`,
 * `fulfilAfterPayment`, `processSupplierEvent`, `refreshUsage`, `sendConnected`,
 * `sendLowData`). Each service accepts slightly different injected
 * dependencies (getDb, supplier, stripe, notifier, now, log, sendEmail, ...).
 *
 * Rather than duplicate that wiring in every test case, this module exposes
 * ONE `buildAdapters(...)` factory that the flow test calls once per
 * scenario. The factory takes the concrete fakes (`ctx.db`, `ctx.stub`,
 * `ctx.stripe`, `ctx.notifier`, `ctx.clock`) and returns a small, typed bag
 * the flow test can call step-by-step.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * --------------------------------
 *  - It does NOT re-implement any business rule. All rules live in the
 *    services. This module only adapts arguments.
 *  - It does NOT import the services by name. Instead it accepts them as
 *    constructor args (`services`) so the flow test — which does import the
 *    services — is the single place that pins the real signature. This keeps
 *    compile errors attributed to the flow test, not to this helper.
 *  - It does NOT fabricate a passing result. If a service returns an
 *    unexpected shape the flow test's `assert` fails; the helper never wraps
 *    a failure in a fake success.
 *
 * SAFETY
 * ------
 * Pure functions. No I/O. No `process.env`. No network. No DB access except
 * through the injected `getDb()`.
 *
 * USAGE
 * -----
 *   const adapters = buildAdapters({
 *     services: { refund: { requestRefund }, topup: { applyTopupPaid, listTopupOptions }, ... },
 *     deps: { getDb, supplier, stripe, notifier, now, log },
 *   });
 *   const result = await adapters.refundUnused({ userId: 1, esimId: 1 });
 *
 * These are SOURCE adapters — this delivery did not execute them.
 */

import type { FakeDb, FakeDbSeed } from "./testFlowHarness.js";
import type { StubEsimAccess } from "./stubEsimAccess.js";

// ---------------------------------------------------------------------------
// Minimal required service surface. Consumers (the flow test) supply real
// implementations. Signatures are liberal (`unknown`) so a drift in the
// service's typed args fails at the call site, not here.
// ---------------------------------------------------------------------------

export interface RawRefundService {
  requestRefund: (input: {
    userId: number;
    esimId: number;
    reason?: string;
    getDb: () => unknown;
    supplier: {
      cancel: (input: {
        esimTranNo?: string;
        iccid?: string;
        transactionId?: string;
      }) => Promise<{ ok: true } | { ok: false; reason?: string }>;
    };
    stripe: {
      refund: (input: {
        paymentIntentId: string;
        idempotencyKey: string;
        reason?: string;
      }) => Promise<
        | { ok: true; refundId?: string; amountMinor?: number; currency?: string }
        | { ok: false; reason?: string }
      >;
    };
    notifier?: {
      sendRefundConfirmation?: (input: {
        requestPublicId: string;
        amountMinor: number;
        currency: string;
      }) => Promise<void>;
      sendRefundReviewReceived?: (input: { requestPublicId: string }) => Promise<void>;
    };
    now?: () => Date;
    log?: (e: Record<string, unknown>) => void;
  }) => Promise<
    | { kind: "auto_refunded"; requestPublicId: string; refundId?: string; amountMinor?: number; currency?: string }
    | { kind: "review"; requestPublicId: string }
    | { kind: "failed"; reason: string; requestPublicId?: string }
    | { kind: "already_requested"; requestPublicId: string }
  >;
}

export interface RawTopupService {
  applyTopupPaid: (input: {
    topupPublicId: string;
    getDb: () => unknown;
    supplier: {
      topup?: (input: {
        esimTranNo: string;
        packageCode: string;
        transactionId: string;
      }) => Promise<{ ok: boolean }>;
    };
    sendReceipt?: (input: unknown) => Promise<void>;
    now?: () => Date;
    log?: (e: Record<string, unknown>) => void;
  }) => Promise<{ status: "ordered" | "failed" | "already_ordered"; reason?: string }>;

  listTopupOptions: (input: {
    userId: number;
    esimId: number;
    getDb: () => unknown;
    supplier: { listPackages: () => Promise<unknown> };
    now?: () => Date;
    log?: (e: Record<string, unknown>) => void;
  }) => Promise<{
    eligible: boolean;
    reason?: string;
    options: Array<{ packageCode: string; retailPrice: number; name?: string }>;
  }>;
}

export interface RawFulfilmentService {
  fulfilAfterPayment: (input: {
    orderPublicId: string;
    transactionId: string;
    count: number;
    packageCode: string;
    getDb?: () => unknown;
    supplier?: unknown;
    log?: (e: Record<string, unknown>) => void;
  }) => Promise<{
    ok: boolean;
    status: "ready" | "processing" | "failed";
    esims: Array<{
      esimId: number;
      iccid: string | null;
      esimTranNo: string | null;
      status: string;
    }>;
    reason?: string;
  }>;
}

export interface RawWebhookService {
  processSupplierEvent: (input: {
    notifyType: "ORDER_STATUS" | "ESIM_STATUS" | "DATA_USAGE" | "VALIDITY_USAGE";
    notifyId: string;
    esimTranNo?: string;
    payload?: Record<string, unknown>;
    getDb?: () => unknown;
    log?: (e: Record<string, unknown>) => void;
  }) => Promise<{ applied: "applied" | "duplicate" | "ignored"; reason?: string }>;
}

export interface RawUsageService {
  refreshUsage: (input: {
    esimId: number;
    esimTranNo: string;
    getDb?: () => unknown;
    supplier?: unknown;
    now?: () => Date;
  }) => Promise<{
    ok: boolean;
    usedBytes: number | null;
    totalBytes: number | null;
    updatedAt: string | null;
  }>;
}

export interface RawNotifierService {
  sendConnected: (input: {
    esimId: number;
    recipientEmail: string;
    orderId?: number;
    iccid?: string;
  }) => Promise<{ delivered: boolean; reason?: string }>;

  sendLowData: (input: {
    esimId: number;
    orderId: number;
    iccid: string;
    esimTranNo: string;
    installPath: string | null;
    recipientEmail: string;
  }) => Promise<{ delivered: boolean; reason?: string }>;
}

/** The bag of real services the flow test wires together. */
export interface FlowServices {
  refund: RawRefundService;
  topup: RawTopupService;
  fulfilment: RawFulfilmentService;
  webhooks: RawWebhookService;
  usage: RawUsageService;
  notifier: RawNotifierService;
}

/** The concrete deps the flow test supplies (fake DB, stub supplier, etc.). */
export interface FlowDeps {
  /** The fake Drizzle-like client. Wrapped in `() => db` at each call. */
  db: FakeDb;
  /** The stubbed eSIM Access. */
  stub: StubEsimAccess;
  /** Stripe refund fake with a `calls` log the test can assert on. */
  stripe: {
    refund: (input: {
      paymentIntentId: string;
      idempotencyKey: string;
      reason?: string;
    }) => Promise<
      | { ok: true; refundId?: string; amountMinor?: number; currency?: string }
      | { ok: false; reason?: string }
    >;
  };
  /** Notifier stub. Tests can wrap the real `makeNotifier` if they want. */
  notifier: RawNotifierService;
  /** Clock. */
  now: () => Date;
  /** Structured log the test captures when needed. */
  log?: (e: Record<string, unknown>) => void;
}

// ---------------------------------------------------------------------------
// Adapter output the flow test consumes. Methods are intention-revealing so
// the test body reads as a paragraph of the journey, not a pile of options.
// ---------------------------------------------------------------------------

export interface FlowAdapters {
  /** Pay + fulfil (via `/esim/order`). Refuses to run unless `paid: true`. */
  purchase(input: {
    orderPublicId: string;
    packageCode: string;
    count: number;
    paid: boolean;
  }): Promise<{
    ok: boolean;
    status: "ready" | "processing" | "failed";
    esims: Array<{ esimId: number; iccid: string; esimTranNo: string }>;
    reason?: string;
  }>;

  /** Process an ESIM_STATUS webhook for `esimTranNo` and mark it installed. */
  markInstalled(input: {
    orderPublicId: string;
    esimTranNo: string;
    recipientEmail: string;
  }): Promise<{ applied: "applied" | "duplicate" | "ignored" }>;

  /** Refresh usage for one eSIM and return bytes + updatedAt. */
  readUsage(input: {
    esimId: number;
    esimTranNo: string;
  }): Promise<{ usedBytes: number | null; totalBytes: number | null; updatedAt: string | null }>;

  /** Fire the low-data alert if remaining ≤ the threshold. Returns whether
   *  the alert was triggered and whether it delivered. */
  maybeSendLowDataAlert(input: {
    esimId: number;
    orderId: number;
    iccid: string;
    esimTranNo: string;
    recipientEmail: string;
    remainingBytes: number | null;
    thresholdBytes: number;
  }): Promise<{ triggered: boolean; delivered: boolean }>;

  /** Submit the top-up (assumes `paid: true` — the caller has confirmed Stripe). */
  applyTopup(input: {
    topupPublicId: string;
    paid: boolean;
  }): Promise<{ status: "ordered" | "failed" | "already_ordered"; reason?: string }>;

  /** List top-up options for an eSIM, honouring the supplier's eligibility rules. */
  listTopupOptions(input: {
    userId: number;
    esimId: number;
  }): Promise<{ eligible: boolean; reason?: string; options: Array<{ packageCode: string; retailPrice: number }> }>;

  /** Request a refund for `esimId`. Only auto-refunds unused eSIMs. */
  requestRefund(input: {
    userId: number;
    esimId: number;
    reason?: string;
  }): Promise<Awaited<ReturnType<RawRefundService["requestRefund"]>>>;
}

// ---------------------------------------------------------------------------
// The factory
// ---------------------------------------------------------------------------

export function buildAdapters(services: FlowServices, deps: FlowDeps): FlowAdapters {
  const getDb = () => deps.db as unknown;
  const log = deps.log ?? (() => {});
  const now = deps.now;

  return {
    async purchase({ orderPublicId, packageCode, count, paid }) {
      if (!paid) {
        // CRITICAL contract: never call /esim/order before Stripe confirms.
        return { ok: false, status: "failed", esims: [], reason: "payment_not_confirmed" };
      }
      const res = await services.fulfilment.fulfilAfterPayment({
        orderPublicId,
        transactionId: orderPublicId,
        count,
        packageCode,
        getDb,
        supplier: deps.stub.client,
        log,
      });
      const esims = res.esims
        .filter((e) => e.iccid && e.esimTranNo)
        .map((e) => ({ esimId: e.esimId, iccid: e.iccid!, esimTranNo: e.esimTranNo! }));
      return { ok: res.ok, status: res.status, esims, reason: res.reason };
    },

    async markInstalled({ orderPublicId, esimTranNo, recipientEmail }) {
      const notifyId = `nid_install_${orderPublicId}_${esimTranNo}`;
      const res = await services.webhooks.processSupplierEvent({
        notifyType: "ESIM_STATUS",
        notifyId,
        esimTranNo,
        payload: { status: "INSTALLED" },
        getDb,
        log,
      });
      if (res.applied === "applied") {
        // Send the "You're connected" email via the notifier. If the email
        // fails we still consider the webhook applied — email is not the
        // source of truth for install state.
        try {
          await services.notifier.sendConnected({
            esimId: 0,
            recipientEmail,
          });
        } catch (e) {
          log({ event: "flow.markInstalled.notifier_error", message: String(e) });
        }
      }
      return { applied: res.applied };
    },

    async readUsage({ esimId, esimTranNo }) {
      const u = await services.usage.refreshUsage({
        esimId,
        esimTranNo,
        getDb,
        supplier: deps.stub.client,
        now,
      });
      return { usedBytes: u.usedBytes, totalBytes: u.totalBytes, updatedAt: u.updatedAt };
    },

    async maybeSendLowDataAlert({
      esimId,
      orderId,
      iccid,
      esimTranNo,
      recipientEmail,
      remainingBytes,
      thresholdBytes,
    }) {
      if (remainingBytes == null || remainingBytes > thresholdBytes) {
        return { triggered: false, delivered: false };
      }
      const delivery = await services.notifier.sendLowData({
        esimId,
        orderId,
        iccid,
        esimTranNo,
        installPath: null,
        recipientEmail,
      });
      return { triggered: true, delivered: delivery.delivered };
    },

    async applyTopup({ topupPublicId, paid }) {
      if (!paid) {
        // Contract: never call supplier.topup before Stripe confirms payment.
        return { status: "failed", reason: "payment_not_confirmed" };
      }
      return services.topup.applyTopupPaid({
        topupPublicId,
        getDb,
        supplier: { topup: (i) => deps.stub.client.topup(i) },
        now,
        log,
      });
    },

    async listTopupOptions({ userId, esimId }) {
      return services.topup.listTopupOptions({
        userId,
        esimId,
        getDb,
        supplier: { listPackages: () => deps.stub.client.listPackages({}) },
        now,
        log,
      });
    },

    async requestRefund({ userId, esimId, reason }) {
      return services.refund.requestRefund({
        userId,
        esimId,
        reason,
        getDb,
        supplier: { cancel: (i) => deps.stub.client.cancel(i) },
        stripe: deps.stripe,
        notifier: {
          async sendRefundConfirmation() {},
          async sendRefundReviewReceived() {},
        },
        now,
        log,
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Assertions helper — pull a required eSIM handle from a purchase result or
// fail with an explicit message. Keeps the flow test body linear.
// ---------------------------------------------------------------------------

export function requireFirstEsim(
  purchase: Awaited<ReturnType<FlowAdapters["purchase"]>>,
): { esimId: number; iccid: string; esimTranNo: string } {
  const first = purchase.esims[0];
  if (!first) {
    throw new Error(
      `purchase produced no eSIMs (status=${purchase.status}, reason=${purchase.reason ?? "n/a"})`,
    );
  }
  return first;
}

/** Convenience: what a scenario seed looks like. Exported so tests that build
 *  seeds programmatically can type them. */
export type { FakeDbSeed };

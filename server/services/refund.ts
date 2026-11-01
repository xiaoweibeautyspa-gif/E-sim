/**
 * Refund service — money-back guarantee for unused eSIMs.
 *
 * Rules (spec phase 3, refunds section + supplier rules):
 *  - An eSIM is "unused" if it has never been installed (installed_at is null)
 *    and, defensively, if used_bytes is 0. Both are required.
 *  - Unused eSIMs: call supplier /esim/cancel (only legal while the supplier
 *    still sees it as RELEASED / GOT_RESOURCE), then refund Stripe. If the
 *    supplier refuses, we do NOT refund Stripe — the customer gets their
 *    eSIM and keeps the guarantee mis-fire logged for the admin.
 *  - Installed/activated eSIMs: never auto-refunded. Route to manual support
 *    review (refund_requests.status = 'review').
 *  - Every decision is written to `refund_requests` for the admin queue.
 *
 * Honest limitations
 * ------------------
 * - We cannot verify "has never been installed" beyond the supplier's own
 *   status transition (ESIM_STATUS webhook / ORDER_STATUS). If a customer
 *   installed and quickly uninstalled, our `installed_at` is still set, so
 *   they land in manual review — which is the correct conservative behaviour.
 * - The supplier's /esim/cancel is only valid for a short window. After
 *   activation the call fails; that failure is stored, never fabricated as
 *   success.
 * - Stripe refunds can only succeed against the original payment intent. If
 *   that link is missing (order paid before the current checkout flow), we
 *   record `failed` with `reason: "missing_payment_intent"` and let support
 *   reconcile in the Stripe dashboard.
 *
 * Test seams
 * ----------
 * Every outbound dependency is injected: `getDb`, `supplier`, `stripe`,
 * `notifier`, `now`, `log`. That is what `server/services/refund.test.ts`
 * drives (queued in the next batch).
 */
import { and, eq, sql } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { getDb } from "../db/client";
import { esims, orders, refundRequests } from "../db/schema";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type RefundErrorCode =
  | "invalid_input"
  | "esim_not_found"
  | "no_payment_intent"
  | "supplier_cancel_refused"
  | "stripe_refund_failed"
  | "db_unavailable"
  | "unsupported_currency"
  | "already_requested";

export class RefundError extends Error {
  readonly code: RefundErrorCode;
  constructor(code: RefundErrorCode, message: string) {
    super(message);
    this.name = "RefundError";
    this.code = code;
  }
}

/** Shape of the supplier client subset the refund service touches. */
export interface RefundSupplier {
  cancel?: (input: { esimTranNo?: string; iccid?: string; transactionId?: string }) => Promise<{
    ok: boolean;
    reason?: string;
  }>;
}

/** Shape of the Stripe provider subset the refund service touches. */
export interface RefundStripe {
  refund?: (input: {
    paymentIntentId: string;
    amountMinor?: number;
    reason?: string;
    /** Idempotency key — the same request must reuse this. */
    idempotencyKey: string;
  }) => Promise<{
    ok: boolean;
    refundId?: string;
    reason?: string;
    amountMinor?: number;
    currency?: string;
  }>;
}

/** Notifier subset — optional, so the service works without notifications. */
export interface RefundNotifier {
  sendRefundConfirmation?: (input: {
    email: string | null;
    esimId: number;
    orderPublicId: string;
    amountMinor: number | null;
    currency: string | null;
  }) => Promise<void>;
  sendRefundReviewReceived?: (input: {
    email: string | null;
    esimId: number;
    orderPublicId: string;
  }) => Promise<void>;
}

export type RefundOutcome =
  | { kind: "auto_refunded"; requestPublicId: string; refundId: string | null }
  | { kind: "review"; requestPublicId: string }
  | { kind: "failed"; requestPublicId: string; reason: string }
  | { kind: "already_requested"; requestPublicId: string };

// ---------------------------------------------------------------------------
// Public id generator (idempotency key for Stripe; unique per request)
// ---------------------------------------------------------------------------

export function makeRefundPublicId(now: Date = new Date()): string {
  const day = now.toISOString().slice(0, 10).replace(/-/g, "");
  const rand = randomBytes(4).toString("hex");
  return `rf_${day}_${rand}`;
}

// ---------------------------------------------------------------------------
// Request a refund
// ---------------------------------------------------------------------------

export interface RequestRefundInput {
  userId: number;
  esimId: number;
  reason?: string;
  /** Injectable seams (tests pass fakes; production defaults kick in). */
  getDb?: typeof getDb;
  supplier?: RefundSupplier;
  stripe?: RefundStripe;
  notifier?: RefundNotifier;
  now?: () => Date;
  log?: (line: string) => void;
}

export async function requestRefund(input: RequestRefundInput): Promise<RefundOutcome> {
  if (!Number.isInteger(input.userId) || input.userId <= 0) {
    throw new RefundError("invalid_input", "Sign in to request a refund.");
  }
  if (!Number.isInteger(input.esimId) || input.esimId <= 0) {
    throw new RefundError("invalid_input", "eSIM id is invalid.");
  }

  const dbAccessor = input.getDb ?? getDb;
  const db = dbAccessor();
  if (!db) throw new RefundError("db_unavailable", "Refund store is not configured.");

  const now = input.now ?? (() => new Date());
  const log = input.log ?? ((line: string) => {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ at: new Date().toISOString(), channel: "refund", line }));
  });

  // Load the owned eSIM row with the fields we need for the decision.
  const [row] = await db
    .select({
      esimId: esims.id,
      status: esims.status,
      iccid: esims.iccid,
      esimTranNo: esims.esimTranNo,
      installedAt: esims.installedAt,
      usedBytes: esims.usedBytes,
      orderId: esims.orderId,
      refundStatus: esims.refundStatus,
    })
    .from(esims)
    .where(and(eq(esims.id, input.esimId), eq(esims.orderId, sql`EXISTS (
      SELECT 1 FROM orders o WHERE o.id = ${esims.orderId} AND (o.user_id = ${input.userId} OR o.guest_email IS NOT NULL)
    )`)))
    .limit(1);

  if (!row) {
    // Ownership miss is a not-found, not a forbidden — never confirm an id
    // exists to an unauthorised caller.
    throw new RefundError("esim_not_found", "We couldn't find that eSIM on your account.");
  }

  // A live refund request already exists — return it rather than creating a
  // duplicate. This is the idempotent path a double-submit will hit.
  const [openReq] = await db
    .select({ publicId: refundRequests.publicId })
    .from(refundRequests)
    .where(
      and(
        eq(refundRequests.esimId, row.esimId),
        sql`${refundRequests.status} IN ('requested','review')`,
      ),
    )
    .limit(1);
  if (openReq) {
    return { kind: "already_requested", requestPublicId: openReq.publicId };
  }

  const isUnused =
    row.installedAt == null &&
    (row.usedBytes == null || Number(row.usedBytes) === 0) &&
    row.status !== "installed" &&
    row.status !== "active";

  const [order] = await db
    .select({
      orderPublicId: orders.publicId,
      guestEmail: orders.guestEmail,
      userId: orders.userId,
      currency: orders.currency,
      retailTotal: orders.retailTotal,
      stripePaymentIntentId: orders.stripePaymentIntentId,
    })
    .from(orders)
    .where(eq(orders.id, row.orderId))
    .limit(1);

  const requestPublicId = makeRefundPublicId(now());
  const recipientEmail = order?.guestEmail ?? null;

  if (!isUnused) {
    // Manual review path.
    await db.insert(refundRequests).values({
      publicId: requestPublicId,
      userId: input.userId,
      orderId: row.orderId,
      esimId: row.esimId,
      reason: input.reason?.slice(0, 2000) ?? null,
      status: "review",
      supplierCancelStatus: "not_attempted",
    });
    await db
      .update(esims)
      .set({ refundStatus: "review", refundReviewNote: "queued_for_support", updatedAt: now() })
      .where(eq(esims.id, row.esimId));
    log(`review esim=${row.esimId} reason=installed_or_used`);
    try {
      await input.notifier?.sendRefundReviewReceived?.({
        email: recipientEmail,
        esimId: row.esimId,
        orderPublicId: order?.orderPublicId ?? "",
      });
    } catch (e) {
      log(`notifier_failed email=review error=${e instanceof Error ? e.message : String(e)}`);
    }
    return { kind: "review", requestPublicId };
  }

  // Insert the request row BEFORE calling external services so a crashed call
  // is still visible in the admin queue.
  await db.insert(refundRequests).values({
    publicId: requestPublicId,
    userId: input.userId,
    orderId: row.orderId,
    esimId: row.esimId,
    reason: input.reason?.slice(0, 2000) ?? null,
    status: "requested",
    supplierCancelStatus: "not_attempted",
  });

  // 1) Supplier cancel. If we can't reach the supplier, we do NOT refund
  //    Stripe: refunding would leave us holding an active eSIM we can't revoke.
  let cancelStatus: "cancelled" | "refused" | "error" = "error";
  let cancelReason = "supplier_not_configured";
  if (input.supplier?.cancel && (row.esimTranNo || row.iccid)) {
    try {
      const result = await input.supplier.cancel({
        esimTranNo: row.esimTranNo ?? undefined,
        iccid: row.iccid ?? undefined,
        transactionId: requestPublicId,
      });
      if (result.ok) {
        cancelStatus = "cancelled";
        cancelReason = "ok";
      } else {
        cancelStatus = "refused";
        cancelReason = result.reason ?? "supplier_refused";
      }
    } catch (e) {
      cancelStatus = "error";
      cancelReason = e instanceof Error ? e.message : String(e);
    }
  }

  if (cancelStatus !== "cancelled") {
    await db
      .update(refundRequests)
      .set({
        status: "failed",
        supplierCancelStatus: cancelStatus,
        supplierCancelReason: cancelReason,
        failureReason: `supplier_cancel_${cancelStatus}`,
        updatedAt: now(),
      })
      .where(eq(refundRequests.publicId, requestPublicId));
    await db
      .update(esims)
      .set({ refundStatus: "review", refundReviewNote: cancelReason, updatedAt: now() })
      .where(eq(esims.id, row.esimId));
    log(`supplier_cancel_failed esim=${row.esimId} status=${cancelStatus} reason=${cancelReason}`);
    return { kind: "failed", requestPublicId, reason: `supplier_cancel_${cancelStatus}` };
  }

  // 2) Stripe refund. Idempotency key is our public id so a retry hitting the
  //    same request cannot issue a second refund.
  const paymentIntentId = order?.stripePaymentIntentId ?? null;
  if (!paymentIntentId) {
    await db
      .update(refundRequests)
      .set({
        status: "review",
        supplierCancelStatus: "cancelled",
        failureReason: "missing_payment_intent",
        updatedAt: now(),
      })
      .where(eq(refundRequests.publicId, requestPublicId));
    await db
      .update(esims)
      .set({ refundStatus: "review", refundReviewNote: "missing_payment_intent", updatedAt: now() })
      .where(eq(esims.id, row.esimId));
    log(`stripe_missing_intent esim=${row.esimId}`);
    return { kind: "failed", requestPublicId, reason: "missing_payment_intent" };
  }

  if (!input.stripe?.refund) {
    await db
      .update(refundRequests)
      .set({
        status: "failed",
        supplierCancelStatus: "cancelled",
        failureReason: "stripe_not_configured",
        updatedAt: now(),
      })
      .where(eq(refundRequests.publicId, requestPublicId));
    log(`stripe_not_configured esim=${row.esimId}`);
    return { kind: "failed", requestPublicId, reason: "stripe_not_configured" };
  }

  let refundResult: Awaited<ReturnType<NonNullable<RefundStripe["refund"]>>>;
  try {
    refundResult = await input.stripe.refund({
      paymentIntentId,
      reason: input.reason?.slice(0, 500),
      idempotencyKey: requestPublicId,
    });
  } catch (e) {
    refundResult = { ok: false, reason: e instanceof Error ? e.message : "stripe_threw" };
  }

  if (!refundResult.ok) {
    await db
      .update(refundRequests)
      .set({
        status: "review",
        supplierCancelStatus: "cancelled",
        failureReason: `stripe_refund_failed: ${refundResult.reason ?? "unknown"}`,
        updatedAt: now(),
      })
      .where(eq(refundRequests.publicId, requestPublicId));
    await db
      .update(esims)
      .set({ refundStatus: "review", refundReviewNote: "stripe_refund_failed", updatedAt: now() })
      .where(eq(esims.id, row.esimId));
    log(`stripe_refund_failed esim=${row.esimId} reason=${refundResult.reason ?? "unknown"}`);
    return { kind: "failed", requestPublicId, reason: "stripe_refund_failed" };
  }

  // 3) Success — persist both sides.
  const refundedAmount = refundResult.amountMinor != null
    ? refundResult.amountMinor / (order?.currency === "VND" ? 1 : 100)
    : null;
  await db
    .update(refundRequests)
    .set({
      status: "auto_refunded",
      supplierCancelStatus: "cancelled",
      stripeRefundId: refundResult.refundId ?? null,
      stripeRefundAmount: refundedAmount != null ? refundedAmount.toFixed(4) : null,
      stripeRefundCurrency: refundResult.currency ?? order?.currency ?? null,
      updatedAt: now(),
    })
    .where(eq(refundRequests.publicId, requestPublicId));
  await db
    .update(esims)
    .set({ refundStatus: "refunded", updatedAt: now() })
    .where(eq(esims.id, row.esimId));
  await db
    .update(orders)
    .set({ status: "refunded", updatedAt: now() })
    .where(eq(orders.id, row.orderId));
  log(`auto_refunded esim=${row.esimId} refundId=${refundResult.refundId ?? "?"}`);
  try {
    await input.notifier?.sendRefundConfirmation?.({
      email: recipientEmail,
      esimId: row.esimId,
      orderPublicId: order?.orderPublicId ?? "",
      amountMinor: refundResult.amountMinor ?? null,
      currency: refundResult.currency ?? order?.currency ?? null,
    });
  } catch (e) {
    log(`notifier_failed email=refund_confirmation error=${e instanceof Error ? e.message : String(e)}`);
  }
  return { kind: "auto_refunded", requestPublicId, refundId: refundResult.refundId ?? null };
}

// ---------------------------------------------------------------------------
// Read the customer's refund requests (satisfies "refund state visible to user")
// ---------------------------------------------------------------------------

export interface RefundRequestRow {
  publicId: string;
  esimId: number;
  status: string;
  reason: string | null;
  supplierCancelStatus: string;
  reviewNote: string | null;
  stripeRefundId: string | null;
  createdAt: string;
  updatedAt: string;
}

export async function listRefundRequestsForUser(input: {
  userId: number;
  getDb?: typeof getDb;
}): Promise<RefundRequestRow[]> {
  const db = (input.getDb ?? getDb)();
  if (!db) throw new RefundError("db_unavailable", "Refund store is not configured.");
  const rows = await db
    .select({
      publicId: refundRequests.publicId,
      esimId: refundRequests.esimId,
      status: refundRequests.status,
      reason: refundRequests.reason,
      supplierCancelStatus: refundRequests.supplierCancelStatus,
      reviewNote: refundRequests.reviewNote,
      stripeRefundId: refundRequests.stripeRefundId,
      createdAt: refundRequests.createdAt,
      updatedAt: refundRequests.updatedAt,
    })
    .from(refundRequests)
    .where(eq(refundRequests.userId, input.userId))
    .orderBy(sql`${refundRequests.createdAt} DESC`);
  return rows.map((r) => ({
    publicId: r.publicId,
    esimId: r.esimId,
    status: r.status,
    reason: r.reason,
    supplierCancelStatus: r.supplierCancelStatus,
    reviewNote: r.reviewNote,
    stripeRefundId: r.stripeRefundId,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  }));
}

// ---------------------------------------------------------------------------
// Manual review decision (used by the admin server route)
// ---------------------------------------------------------------------------

export type ReviewDecision = "approve" | "reject";

export interface DecideReviewInput {
  reviewerUserId: number;
  requestPublicId: string;
  decision: ReviewDecision;
  note?: string;
  getDb?: typeof getDb;
  stripe?: RefundStripe;
  now?: () => Date;
  log?: (line: string) => void;
}

export async function decideRefundReview(input: DecideReviewInput): Promise<{
  status: "refunded" | "rejected" | "failed";
  reason?: string;
}> {
  const db = (input.getDb ?? getDb)();
  if (!db) throw new RefundError("db_unavailable", "Refund store is not configured.");
  const now = input.now ?? (() => new Date());
  const log = input.log ?? ((line: string) => {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ at: new Date().toISOString(), channel: "refund-review", line }));
  });

  const [row] = await db
    .select({
      id: refundRequests.id,
      esimId: refundRequests.esimId,
      orderId: refundRequests.orderId,
      status: refundRequests.status,
    })
    .from(refundRequests)
    .where(eq(refundRequests.publicId, input.requestPublicId))
    .limit(1);
  if (!row) throw new RefundError("invalid_input", "Refund request not found.");
  if (row.status !== "review") {
    throw new RefundError("invalid_input", `Refund request is already '${row.status}'.`);
  }

  if (input.decision === "reject") {
    await db
      .update(refundRequests)
      .set({
        status: "rejected",
        reviewedBy: input.reviewerUserId,
        reviewedAt: now(),
        reviewNote: input.note?.slice(0, 2000) ?? null,
        updatedAt: now(),
      })
      .where(eq(refundRequests.id, row.id));
    await db
      .update(esims)
      .set({ refundStatus: "rejected", updatedAt: now() })
      .where(eq(esims.id, row.esimId));
    log(`rejected request=${input.requestPublicId}`);
    return { status: "rejected" };
  }

  // Approve → issue the Stripe refund.
  const [order] = await db
    .select({ stripePaymentIntentId: orders.stripePaymentIntentId, currency: orders.currency })
    .from(orders)
    .where(eq(orders.id, row.orderId))
    .limit(1);
  if (!order?.stripePaymentIntentId) {
    await db
      .update(refundRequests)
      .set({
        status: "failed",
        reviewedBy: input.reviewerUserId,
        reviewedAt: now(),
        reviewNote: input.note?.slice(0, 2000) ?? null,
        failureReason: "missing_payment_intent",
        updatedAt: now(),
      })
      .where(eq(refundRequests.id, row.id));
    return { status: "failed", reason: "missing_payment_intent" };
  }
  if (!input.stripe?.refund) {
    return { status: "failed", reason: "stripe_not_configured" };
  }
  let res: Awaited<ReturnType<NonNullable<RefundStripe["refund"]>>>;
  try {
    res = await input.stripe.refund({
      paymentIntentId: order.stripePaymentIntentId,
      reason: input.note?.slice(0, 500),
      idempotencyKey: input.requestPublicId,
    });
  } catch (e) {
    res = { ok: false, reason: e instanceof Error ? e.message : "stripe_threw" };
  }
  if (!res.ok) {
    await db
      .update(refundRequests)
      .set({
        status: "failed",
        reviewedBy: input.reviewerUserId,
        reviewedAt: now(),
        reviewNote: input.note?.slice(0, 2000) ?? null,
        failureReason: `stripe_refund_failed: ${res.reason ?? "unknown"}`,
        updatedAt: now(),
      })
      .where(eq(refundRequests.id, row.id));
    return { status: "failed", reason: "stripe_refund_failed" };
  }
  await db
    .update(refundRequests)
    .set({
      status: "auto_refunded",
      reviewedBy: input.reviewerUserId,
      reviewedAt: now(),
      reviewNote: input.note?.slice(0, 2000) ?? null,
      stripeRefundId: res.refundId ?? null,
      updatedAt: now(),
    })
    .where(eq(refundRequests.id, row.id));
  await db
    .update(esims)
    .set({ refundStatus: "refunded", updatedAt: now() })
    .where(eq(esims.id, row.esimId));
  await db
    .update(orders)
    .set({ status: "refunded", updatedAt: now() })
    .where(eq(orders.id, row.orderId));
  log(`approved request=${input.requestPublicId} refundId=${res.refundId ?? "?"}`);
  return { status: "refunded" };
}

// ---------------------------------------------------------------------------
// Test surface
// ---------------------------------------------------------------------------

export const __test__ = {
  makeRefundPublicId,
  isUnused: (row: {
    installedAt: Date | null;
    usedBytes: string | number | null;
    status: string;
  }): boolean =>
    row.installedAt == null &&
    (row.usedBytes == null || Number(row.usedBytes) === 0) &&
    row.status !== "installed" &&
    row.status !== "active",
};

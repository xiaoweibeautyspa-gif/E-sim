/**
 * Order fulfilment service — turns a PAID order into delivered eSIMs.
 *
 * This is the heart of the "order only after payment" rule. Nothing here runs
 * until the Stripe webhook has marked the order `pending_fulfilment`. The
 * service is idempotent: it is keyed on our own order id, which is passed to
 * the supplier as `transactionId`, so a duplicate run (retry, webhook replay,
 * job restart) can never create a second supplier order.
 *
 * Flow (`fulfilOrder`):
 *   1. Load the order. Only proceed if status is `pending_fulfilment` (or
 *      `processing` when re-driving a stuck order — see `resumeOrder`).
 *   2. Group expansion: the order carries `quantity` (count > 1 for group
 *      orders). We order `quantity` eSIMs in ONE supplier call so they share a
 *      transaction, but each eSIM gets its own shareable install link/token.
 *      (`quantity` is read from the order row; see `readOrderQuantity`.)
 *   3. Supplier balance precheck via `checkSupplierBalance`. If the balance is
 *      low, the order is saved + flagged for admin and we STOP before ordering.
 *   4. Call `/esim/order` with `transactionId = order.publicId`, `count =
 *      quantity`. Persist the returned eSIMs (iccid, esimTranNo, LPA, QR).
 *   5. If the supplier returns ready eSIMs, mark the order `completed`. If not,
 *      mark `processing` and let the poller / ORDER_STATUS webhook finish it.
 *
 * Persistence: this service writes eSIM rows into the `esims` table. That table
 * is created in the 0005 migration (next batch) — the insert uses a column set
 * that must match `server/db/schema.ts`'s `esims` definition. Because that
 * schema file was not in the supplied source, the column names below follow the
 * shapes already visible in the migration history (iccid, esimTranNo, lpaCode,
 * qrCodeUrl, orderId, status, ...) and MUST be reconciled with the real schema
 * in the migration batch. If a column differs, adjust the insert mapping here.
 *
 * Gift handling: gift metadata (recipient name/email/message/send date) is read
 * from the order row (persisted from Stripe metadata by the checkout/webhook
 * phase) and returned on the fulfilment result so the email layer (next batch)
 * can send the branded recipient email. This service does NOT send email — that
 * is the `server/email/*` batch's job — so a missing email provider cannot make
 * fulfilment partially "succeed" while silently dropping the recipient.
 */
import { eq } from "drizzle-orm";
import { esimAccess, EsimAccessError, type SupplierEsim } from "../esimaccess";
import { getDb } from "../db/client";
import { orders, esims } from "../db/schema";
import { checkSupplierBalance, type BalanceCheckResult } from "./balanceGuard";
import { pollForOrderReady } from "../jobs/orderPoller.job";
import { randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Gift metadata attached to an order (persisted from Stripe metadata). */
export interface GiftMetadata {
  recipientName: string;
  recipientEmail: string;
  message?: string;
  /** ISO date string; the recipient email is scheduled for on/after this. */
  sendDate?: string;
}

/** A single fulfilled eSIM as returned to the caller / persisted. */
export interface FulfilledEsim {
  iccid: string | null;
  esimTranNo: string | null;
  lpaCode: string | null;
  qrCodeUrl: string | null;
  smdpStatus: string | null;
  /** Opaque, unguessable token for the shareable install link. */
  installToken: string;
  /** Absolute-path install link (host prefix added by the email/UI layer). */
  installPath: string;
}

export type FulfilOutcome =
  | {
      status: "completed";
      orderId: string;
      supplierOrderNo: string | null;
      esims: FulfilledEsim[];
      gift: GiftMetadata | null;
      quantity: number;
    }
  | {
      status: "processing";
      orderId: string;
      supplierOrderNo: string | null;
      esims: FulfilledEsim[];
      /** Why it isn't ready yet (e.g. supplier still allocating). */
      reason: string;
      gift: GiftMetadata | null;
      quantity: number;
    }
  | {
      status: "low_balance";
      orderId: string;
      balanceUsd: number;
      thresholdUsd: number;
      gift: GiftMetadata | null;
      quantity: number;
    }
  | {
      status: "skipped";
      orderId: string;
      reason:
        | "not_found"
        | "not_payable"
        | "db_unavailable"
        | "supplier_not_configured"
        | "supplier_error"
        | "balance_check_failed";
      detail?: string;
    };

/** Injectable seams for tests — production uses the real client, DB and poller. */
export interface FulfilDeps {
  getDb?: typeof getDb;
  order?: () => Promise<OrderForFulfilment | null>;
  placeOrder?: (input: {
    packageCode: string;
    count: number;
    transactionId: string;
  }) => Promise<{ orderNo?: string; status: string; esims: SupplierEsim[] }>;
  balanceCheck?: () => Promise<BalanceCheckResult>;
  pollReady?: (input: {
    orderNo: string | null;
    transactionId: string;
  }) => Promise<{ ready: boolean; esims: SupplierEsim[]; reason?: string }>;
  persistEsims?: (rows: PersistEsimRow[]) => Promise<void>;
  markOrderStatus?: (status: OrderStatus, patch?: Partial<OrderPatch>) => Promise<void>;
  now?: () => Date;
  log?: (msg: string) => void;
}

/** The subset of the order row this service needs. */
export interface OrderForFulfilment {
  id: number;
  publicId: string;
  status: OrderStatus;
  quantity: number;
  packageCode: string | null;
  gift: GiftMetadata | null;
  retailTotal: string | null;
  currency: string | null;
  buyerEmail: string | null;
  /** Whether the order is paid (webhook flipped it) — must be true to proceed. */
  paidAt: Date | null;
}

export type OrderStatus =
  | "pending"
  | "pending_fulfilment"
  | "paid"
  | "processing"
  | "completed"
  | "failed"
  | "expired"
  | "refunded"
  | "cancelled";

interface OrderPatch {
  supplierOrderNo?: string | null;
  lowBalanceFlagged?: boolean;
  processingReason?: string | null;
  failedReason?: string | null;
  updatedAt?: Date;
}

interface PersistEsimRow {
  orderId: number;
  iccid: string | null;
  esimTranNo: string | null;
  lpaCode: string | null;
  qrCodeUrl: string | null;
  smdpStatus: string | null;
  installToken: string;
  status: string;
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/**
 * Fulfil a single order. Safe to call repeatedly for the same order.
 *
 * Callers: the fulfilment job (drains `pending_fulfilment` orders) and the
 * Stripe webhook (fire-and-forget after responding). We deliberately do NOT
 * throw on supplier/DB errors — we return a `skipped`/`low_balance` outcome so
 * the caller's queue logic can decide to retry or flag.
 */
export async function fulfilOrder(
  orderPublicId: string,
  deps: FulfilDeps = {},
): Promise<FulfilOutcome> {
  const log = deps.log ?? ((m: string) => console.log(m));
  const now = deps.now ?? (() => new Date());

  // 1. Load order.
  const loadOrder = deps.order ?? (() => loadOrderByPublicId(orderPublicId));
  const order = await loadOrder();
  if (!order) {
    return { status: "skipped", orderId: orderPublicId, reason: "not_found" };
  }

  // 2. Guard: must be paid + in a payable-to-fulfil state. A duplicate call on
  //    a completed order is a no-op "skipped" (not an error) — the fulfilment
  //    job may race with itself.
  if (order.status === "completed") {
    return { status: "skipped", orderId: order.publicId, reason: "not_payable", detail: "already_completed" };
  }
  if (order.status !== "pending_fulfilment" && order.status !== "processing") {
    return {
      status: "skipped",
      orderId: order.publicId,
      reason: "not_payable",
      detail: `status=${order.status}`,
    };
  }
  if (!order.paidAt && order.status === "pending_fulfilment") {
    // Safety net: never order without a payment confirmation. The Stripe
    // webhook sets paidAt; if it's missing something went wrong upstream.
    return { status: "skipped", orderId: order.publicId, reason: "not_payable", detail: "not_paid" };
  }
  if (!order.packageCode) {
    return { status: "skipped", orderId: order.publicId, reason: "not_payable", detail: "missing_package_code" };
  }

  const quantity = Math.max(1, Math.trunc(order.quantity || 1));

  // 3. Supplier configured?
  if (!esimAccess.isConfigured) {
    await safeMark(deps, order.id, "failed", {
      failedReason: "supplier_not_configured",
      updatedAt: now(),
    }, log);
    return { status: "skipped", orderId: order.publicId, reason: "supplier_not_configured" };
  }

  // 4. Balance precheck.
  const balanceCheck = deps.balanceCheck ?? (() => checkSupplierBalance());
  const balance = await balanceCheck();
  if (!balance.ok) {
    // Cannot confirm the balance → do not order. Flag for review, keep the
    // order saveable. We mark `processing` (not failed) so admin can retry once
    // balance is confirmed, and record why.
    await safeMark(deps, order.id, "processing", {
      processingReason: `balance_check_failed: ${balance.detail}`,
      updatedAt: now(),
    }, log);
    return {
      status: "skipped",
      orderId: order.publicId,
      reason: balance.reason === "not_configured" ? "supplier_not_configured" : "balance_check_failed",
      detail: balance.detail,
    };
  }
  if (balance.low) {
    // Save the order, flag it in admin, stop. The alert email is fired inside
    // checkSupplierBalance (rate-limited).
    await safeMark(deps, order.id, "pending_fulfilment", {
      lowBalanceFlagged: true,
      updatedAt: now(),
    }, log);
    log(
      `[fulfilment] order ${order.publicId} flagged low_balance ` +
        `(balance $${balance.balanceUsd.toFixed(2)} < $${balance.thresholdUsd.toFixed(2)})`,
    );
    return {
      status: "low_balance",
      orderId: order.publicId,
      balanceUsd: balance.balanceUsd,
      thresholdUsd: balance.thresholdUsd,
      gift: order.gift,
      quantity,
    };
  }

  // 5. Place supplier order. transactionId = our order id → idempotent.
  const placeOrder =
    deps.placeOrder ??
    ((input) => esimAccess.order(input).then((r) => ({ orderNo: r.orderNo, status: r.status, esims: r.esims })));

  let supplierResult: { orderNo?: string; status: string; esims: SupplierEsim[] };
  try {
    supplierResult = await placeOrder({
      packageCode: order.packageCode,
      count: quantity,
      transactionId: order.publicId,
    });
  } catch (err) {
    const e = err as EsimAccessError;
    const message = err instanceof Error ? err.message : String(err);
    // Business errors (e.g. INSUFFICIENT_BALANCE) are terminal for this
    // attempt; transient errors leave the order eligible for retry.
    const transient = e instanceof EsimAccessError ? e.retryable === true : true;
    if (transient) {
      await safeMark(deps, order.id, "processing", {
        processingReason: `order_error: ${message}`,
        updatedAt: now(),
      }, log);
      return {
        status: "processing",
        orderId: order.publicId,
        supplierOrderNo: null,
        esims: [],
        reason: message,
        gift: order.gift,
        quantity,
      };
    }
    await safeMark(deps, order.id, "failed", {
      failedReason: `order_rejected: ${message}`,
      updatedAt: now(),
    }, log);
    return {
      status: "skipped",
      orderId: order.publicId,
      reason: "supplier_error",
      detail: message,
    };
  }

  // 6. Poll for readiness if the immediate response didn't return full data.
  const immediate = supplierResult.esims.filter(hasInstallData);
  let finalEsims = supplierResult.esims;
  let ready = immediate.length === supplierResult.esims.length && supplierResult.esims.length > 0;

  if (!ready) {
    const pollReady =
      deps.pollReady ??
      ((input) =>
        pollForOrderReady({
          orderNo: input.orderNo,
          transactionId: input.transactionId,
          log,
        }));
    try {
      const polled = await pollReady({
        orderNo: supplierResult.orderNo ?? null,
        transactionId: order.publicId,
      });
      if (polled.ready) {
        finalEsims = polled.esims;
        ready = true;
      }
    } catch (err) {
      log(`[fulfilment] poll threw for ${order.publicId}: ${err instanceof Error ? err.message : String(err)}`);
      // Not fatal: the ORDER_STATUS webhook will complete it. Fall through to
      // "processing".
    }
  }

  // 7. Persist eSIM rows (each with its own shareable install token).
  const persisted: FulfilledEsim[] = finalEsims.map((e) => toFulfilledEsim(e));
  const persist =
    deps.persistEsims ??
    ((rows) => persistEsimRows(rows));
  if (persisted.length > 0) {
    try {
      await persist(
        persisted.map((f) => ({
          orderId: order.id,
          iccid: f.iccid,
          esimTranNo: f.esimTranNo,
          lpaCode: f.lpaCode,
          qrCodeUrl: f.qrCodeUrl,
          smdpStatus: f.smdpStatus,
          installToken: f.installToken,
          status: ready ? "ready" : "processing",
        })),
      );
    } catch (err) {
      log(
        `[fulfilment] failed to persist eSIMs for ${order.publicId}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
      // Don't lose the supplier order — leave it processing so a retry can
      // re-read from the supplier (transactionId guarantees no double order).
      await safeMark(deps, order.id, "processing", {
        supplierOrderNo: supplierResult.orderNo ?? null,
        processingReason: "persist_failed",
        updatedAt: now(),
      }, log);
      return {
        status: "processing",
        orderId: order.publicId,
        supplierOrderNo: supplierResult.orderNo ?? null,
        esims: persisted,
        reason: "persist_failed",
        gift: order.gift,
        quantity,
      };
    }
  }

  // 8. Mark final status.
  if (ready && persisted.length > 0) {
    await safeMark(deps, order.id, "completed", {
      supplierOrderNo: supplierResult.orderNo ?? null,
      updatedAt: now(),
    }, log);
    return {
      status: "completed",
      orderId: order.publicId,
      supplierOrderNo: supplierResult.orderNo ?? null,
      esims: persisted,
      gift: order.gift,
      quantity,
    };
  }

  // Not ready → processing; the ORDER_STATUS webhook (next batch) or the
  // poller finishes it.
  await safeMark(deps, order.id, "processing", {
    supplierOrderNo: supplierResult.orderNo ?? null,
    processingReason: "awaiting_supplier",
    updatedAt: now(),
  }, log);
  return {
    status: "processing",
    orderId: order.publicId,
    supplierOrderNo: supplierResult.orderNo ?? null,
    esims: persisted,
    reason: "awaiting_supplier",
    gift: order.gift,
    quantity,
  };
}

/**
 * Re-drive a stuck `processing` order once readiness should be checkable
 * (called by the poller or the ORDER_STATUS webhook). Reads current supplier
 * state via `/esim/query` and, if ready, persists + completes.
 *
 * Returns the resulting status so callers can decide what to do next.
 */
export async function resumeProcessingOrder(
  orderPublicId: string,
  deps: FulfilDeps = {},
): Promise<FulfilOutcome> {
  const log = deps.log ?? ((m: string) => console.log(m));
  const now = deps.now ?? (() => new Date());
  const loadOrder = deps.order ?? (() => loadOrderByPublicId(orderPublicId));
  const order = await loadOrder();
  if (!order) return { status: "skipped", orderId: orderPublicId, reason: "not_found" };
  if (order.status === "completed") {
    return { status: "skipped", orderId: order.publicId, reason: "not_payable", detail: "already_completed" };
  }
  if (order.status !== "processing" && order.status !== "pending_fulfilment") {
    return { status: "skipped", orderId: order.publicId, reason: "not_payable", detail: `status=${order.status}` };
  }
  // A pending/processing order with no supplier order number yet is not
  // "in flight"; re-run the full flow so the supplier order gets placed.
  if (!orderHasSupplierOrder(order)) {
    return fulfilOrder(orderPublicId, deps);
  }

  const pollReady =
    deps.pollReady ??
    ((input) =>
      pollForOrderReady({ orderNo: input.orderNo, transactionId: input.transactionId, log }));

  let polled: { ready: boolean; esims: SupplierEsim[] };
  try {
    polled = await pollReady({ orderNo: null, transactionId: order.publicId });
  } catch (err) {
    return {
      status: "processing",
      orderId: order.publicId,
      supplierOrderNo: null,
      esims: [],
      reason: err instanceof Error ? err.message : "poll_failed",
      gift: order.gift,
      quantity: Math.max(1, order.quantity || 1),
    };
  }

  if (!polled.ready || polled.esims.length === 0) {
    return {
      status: "processing",
      orderId: order.publicId,
      supplierOrderNo: null,
      esims: [],
      reason: "still_processing",
      gift: order.gift,
      quantity: Math.max(1, order.quantity || 1),
    };
  }

  const persisted = polled.esims.map(toFulfilledEsim);
  const persist = deps.persistEsims ?? ((rows) => persistEsimRows(rows));
  await persist(
    persisted.map((f) => ({
      orderId: order.id,
      iccid: f.iccid,
      esimTranNo: f.esimTranNo,
      lpaCode: f.lpaCode,
      qrCodeUrl: f.qrCodeUrl,
      smdpStatus: f.smdpStatus,
      installToken: f.installToken,
      status: "ready",
    })),
  );
  await safeMark(deps, order.id, "completed", { updatedAt: now() }, log);
  return {
    status: "completed",
    orderId: order.publicId,
    supplierOrderNo: null,
    esims: persisted,
    gift: order.gift,
    quantity: Math.max(1, order.quantity || 1),
  };
}

// ---------------------------------------------------------------------------
// DB access (real implementation)
// ---------------------------------------------------------------------------

/**
 * Load an order by its public id. Returns the subset this service needs.
 * Returns null when the DB is unavailable OR the order is not found — callers
 * treat both as "not_found" for queue purposes.
 */
async function loadOrderByPublicId(publicId: string): Promise<OrderForFulfilment | null> {
  const db = getDb();
  if (!db) return null;
  // Column set matches the shapes used by stripeWebhook.ts + the 0004 migration.
  // `gift` and `packageCode` are read from the order row; if your schema stores
  // gift metadata under a jsonb column named differently, adjust the select.
  const [row] = await db
    .select({
      id: orders.id,
      publicId: orders.publicId,
      status: orders.status,
      quantity: orders.quantity,
      // These two columns must exist on `orders` (see schema). If the naming
      // differs, update here.
      gift: (orders as unknown as { giftJson: unknown }).giftJson,
      packageCode: (orders as unknown as { packageCode: unknown }).packageCode,
      retailTotal: orders.retailTotal,
      currency: orders.currency,
      buyerEmail: (orders as unknown as { buyerEmail: unknown }).buyerEmail,
      paidAt: orders.paidAt,
    })
    .from(orders)
    .where(eq(orders.publicId, publicId))
    .limit(1);

  if (!row) return null;
  return {
    id: row.id,
    publicId: row.publicId,
    status: row.status as OrderStatus,
    quantity: typeof row.quantity === "number" ? row.quantity : 1,
    packageCode: typeof row.packageCode === "string" ? row.packageCode : null,
    gift: normaliseGift(row.gift),
    retailTotal: row.retailTotal ?? null,
    currency: row.currency ?? null,
    buyerEmail: typeof row.buyerEmail === "string" ? row.buyerEmail : null,
    paidAt: row.paidAt ?? null,
  };
}

/** `orderHasSupplierOrder` is a soft check used by resumeProcessingOrder. */
function orderHasSupplierOrder(_order: OrderForFulfilment): boolean {
  // We don't carry supplierOrderNo on the loaded shape; treat a `processing`
  // order as already placed (resume path) and a `pending_fulfilment` one as
  // not-yet-placed (full path). This is a coarse but safe split: a
  // pending_fulfilment order that actually got placed will be caught by the
  // idempotent transactionId on the retry.
  return _order.status === "processing";
}

async function persistEsimRows(rows: PersistEsimRow[]): Promise<void> {
  const db = getDb();
  if (!db) throw new Error("Database not configured; cannot persist eSIMs.");
  if (rows.length === 0) return;
  // Column names must match `esims` in server/db/schema.ts. Reconciled in the
  // 0005 migration batch; adjust here if the schema uses different names.
  await db.insert(esims).values(
    rows.map((r) => ({
      orderId: r.orderId,
      iccid: r.iccid,
      esimTranNo: r.esimTranNo,
      lpaCode: r.lpaCode,
      qrCodeUrl: r.qrCodeUrl,
      smdpStatus: r.smdpStatus,
      installToken: r.installToken,
      status: r.status,
    })) as unknown as typeof esims.$inferInsert[],
  );
}

// ---------------------------------------------------------------------------
// mapping helpers
// ---------------------------------------------------------------------------

/** True when a supplier eSIM already carries the data needed to install. */
function hasInstallData(e: SupplierEsim): boolean {
  return Boolean(e.iccid && (e.lpaCode || e.qrCodeUrl));
}

function toFulfilledEsim(e: SupplierEsim): FulfilledEsim {
  const installToken = randomBytes(18).toString("base64url");
  return {
    iccid: e.iccid ?? null,
    esimTranNo: e.esimTranNo ?? null,
    lpaCode: e.lpaCode ?? null,
    qrCodeUrl: e.qrCodeUrl ?? null,
    smdpStatus: e.smdpStatus ?? null,
    installToken,
    installPath: `/install/${installToken}`,
  };
}

function normaliseGift(raw: unknown): GiftMetadata | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const recipientName = typeof obj.recipientName === "string" ? obj.recipientName : null;
  const recipientEmail = typeof obj.recipientEmail === "string" ? obj.recipientEmail : null;
  if (!recipientName || !recipientEmail) return null;
  return {
    recipientName,
    recipientEmail,
    message: typeof obj.message === "string" ? obj.message : undefined,
    sendDate: typeof obj.sendDate === "string" ? obj.sendDate : undefined,
  };
}

async function safeMark(
  deps: FulfilDeps,
  orderRowId: number,
  status: OrderStatus,
  patch: OrderPatch,
  log: (m: string) => void,
): Promise<void> {
  const mark =
    deps.markOrderStatus ??
    ((s: OrderStatus, p?: Partial<OrderPatch>) => markOrderStatus(orderRowId, s, p));
  try {
    await mark(status, patch);
  } catch (err) {
    log(
      `[fulfilment] failed to set order ${orderRowId} status=${status}: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function markOrderStatus(
  orderRowId: number,
  status: OrderStatus,
  patch: Partial<OrderPatch> = {},
): Promise<void> {
  const db = getDb();
  if (!db) throw new Error("Database not configured; cannot update order status.");
  // Only set the optional flag columns when the caller asked for them, so we
  // don't clobber an existing flag. The specific column names beyond the ones
  // used by stripeWebhook.ts must exist on `orders`; see schema reconciliation.
  const set: Record<string, unknown> = {
    status,
    updatedAt: patch.updatedAt ?? new Date(),
  };
  if (patch.supplierOrderNo !== undefined) set.supplierOrderNo = patch.supplierOrderNo;
  if (patch.processingReason !== undefined) set.processingReason = patch.processingReason;
  if (patch.failedReason !== undefined) set.failedReason = patch.failedReason;
  if (patch.lowBalanceFlagged !== undefined) set.lowBalanceFlagged = patch.lowBalanceFlagged;

  await db
    .update(orders)
    .set(set as never)
    .where(eq(orders.id, orderRowId));
}

// ---------------------------------------------------------------------------
// Test-only surface
// ---------------------------------------------------------------------------

export const __test__ = {
  hasInstallData,
  toFulfilledEsim,
  normaliseGift,
  orderHasSupplierOrder,
};

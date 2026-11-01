/**
 * Stripe webhook receiver: turns a confirmed payment into a paid order.
 *
 * Mounted at POST /api/webhooks/stripe by the app (see server/app.ts — mount
 * with `express.raw({ type: "application/json" })` so the raw body reaches
 * the signature check). This route is the ONLY place an order becomes paid;
 * the fulfilment phase listens for orders in `pending_fulfilment` and does
 * the supplier call.
 *
 * Guarantees we implement here:
 *  - Signature verified via the existing `StripeProvider.verifyWebhook`
 *    (constant-time HMAC-SHA256 against the raw body). Missing webhook
 *    secret → 400 with `reason`, never a 200 pretending success.
 *  - Idempotent: Stripe retries. We key on the orderId from metadata
 *    (which equals our staged order id / Stripe client_reference_id).
 *    A retry after paid is a no-op returning 200. A duplicate notify of an
 *    already-`paid` order does not re-flip status or re-mark paid_at.
 *  - Order creation: if the pre-checkout row exists it is loaded; if not
 *    (Stripe-only flow before our staging step is wired) we insert a
 *    provisional order using the totals Stripe charged. Amount is not
 *    recomputed here — Stripe's `amount_total`/`currency` are the source
 *    of truth for what the buyer actually paid. Retail totals in USD are
 *    left for the fulfilment phase to reconcile from the package snapshots
 *    it looks up; we only store what the buyer was charged in the currency
 *    they paid.
 *  - The route does NOT call the supplier. It flips order.status to
 *    `pending_fulfilment`, which the fulfilment job (next phase) consumes.
 *  - Every event is logged with an outcome so the admin can audit mis-fires.
 */
import { Router, type Request, type Response } from "express";
import { eq, sql } from "drizzle-orm";
import { getDb } from "../db/client";
import { orders as ordersTable } from "../db/schema";
import {
  getStripeProvider,
  StripeProviderNotConfiguredError,
} from "../payments/stripeProvider";
import type { SupportedCurrency } from "../brand.config";
import { makeOrderId, type OrderId } from "../payments/paymentProvider";

// ---------------------------------------------------------------------------
// Logging helper — one JSON line per webhook so logs are greppable
// ---------------------------------------------------------------------------

type Outcome =
  | "paid"
  | "already_paid"
  | "expired"
  | "failed"
  | "refunded"
  | "ignored_unknown"
  | "missing_order_id"
  | "signature_invalid"
  | "db_unavailable"
  | "internal_error";

function logWebhook(event: {
  outcome: Outcome;
  orderId: OrderId | null;
  sessionId?: string;
  eventType?: string;
  detail?: unknown;
}): void {
  // One-line structured log. Never log raw body or keys.
  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify({
      at: new Date().toISOString(),
      channel: "stripe_webhook",
      ...event,
      orderId: event.orderId ?? null,
    }),
  );
}

// ---------------------------------------------------------------------------
// The router
// ---------------------------------------------------------------------------

/**
 * Dependencies injected by the app about how the raw body was captured.
 * The route expects `req.body` to be a Buffer (mount with express.raw).
 * We convert to a UTF-8 string because Stripe's HMAC is over the raw bytes;
 * for JSON payloads the UTF-8 string is byte-identical.
 */
function rawBodyString(req: Request): string | null {
  const body = (req as unknown as { body?: unknown }).body;
  if (Buffer.isBuffer(body)) return body.toString("utf8");
  if (typeof body === "string") return body;
  return null;
}

export function createStripeWebhookRouter(): Router {
  const router = Router();

  router.post("/", async (req: Request, res: Response) => {
    const provider = getStripeProvider();
    if (!provider.isConfigured) {
      // Missing STRIPE_SECRET_KEY: we cannot verify. Fail loudly (500) so
      // Stripe retries and the admin is alerted. This is not a "success".
      logWebhook({ outcome: "signature_invalid", orderId: null, detail: "stripe_not_configured" });
      res.status(500).json({ ok: false, error: "stripe_not_configured" });
      return;
    }

    const raw = rawBodyString(req);
    if (!raw) {
      logWebhook({ outcome: "signature_invalid", orderId: null, detail: "raw_body_unavailable" });
      res.status(400).json({ ok: false, error: "raw_body_unavailable" });
      return;
    }

    const signatureHeader =
      (req.headers["stripe-signature"] as string | undefined) ?? null;

    let verified;
    try {
      verified = await provider.verifyWebhook({ rawBody: raw, signatureHeader });
    } catch (err) {
      logWebhook({
        outcome: "internal_error",
        orderId: null,
        detail: err instanceof Error ? err.message : "verify_threw",
      });
      res.status(500).json({ ok: false, error: "verify_error" });
      return;
    }

    if (!verified.ok) {
      logWebhook({ outcome: "signature_invalid", orderId: null, detail: verified.reason });
      res.status(400).json({ ok: false, error: "signature_invalid", reason: verified.reason });
      return;
    }

    // From here the signature is valid; we owe Stripe an early 200 so it
    // doesn't retry on top of slow processing. We still respond with the
    // outcome because this handler completes in well under a second (DB
    // write only, no supplier call).

    const { orderId, paymentStatus, sessionId, charged } = verified;

    if (paymentStatus === "unknown") {
      // Stripe emits many event types we don't care about. Returning 200
      // prevents pointless retries; we still log.
      logWebhook({ outcome: "ignored_unknown", orderId, sessionId });
      res.status(200).json({ ok: true, handled: false, reason: "ignored_event_type" });
      return;
    }

    if (!orderId) {
      // No order id in metadata — nothing we can reconcile. The event is
      // legitimate, so 200, but the ops team needs to see this.
      logWebhook({ outcome: "missing_order_id", orderId: null, sessionId });
      res.status(200).json({ ok: true, handled: false, reason: "missing_order_id" });
      return;
    }

    const db = getDb();
    if (!db) {
      logWebhook({ outcome: "db_unavailable", orderId, sessionId });
      // 503 lets Stripe retry once the DB comes back.
      res.status(503).json({ ok: false, error: "db_unavailable" });
      return;
    }

    try {
      const result = await applyPaymentStatus({
        orderId,
        paymentStatus,
        sessionId,
        charged,
      });
      logWebhook({ outcome: result.outcome, orderId, sessionId });
      res.status(200).json({ ok: true, handled: result.changed, outcome: result.outcome });
      return;
    } catch (err) {
      logWebhook({
        outcome: "internal_error",
        orderId,
        sessionId,
        detail: err instanceof Error ? err.message : "db_write_threw",
      });
      // 500 → Stripe retries. Our handler is idempotent so retries are safe.
      res.status(500).json({ ok: false, error: "internal_error" });
      return;
    }
  });

  // Method-not-allowed is worth logging because it usually means a bad mount.
  router.all("/", (_req: Request, res: Response) => {
    res.status(405).json({ ok: false, error: "method_not_allowed" });
  });

  return router;
}

// ---------------------------------------------------------------------------
// Core transition: signature-verified event → order state
// ---------------------------------------------------------------------------

interface ApplyInput {
  orderId: OrderId;
  paymentStatus: "paid" | "unpaid" | "refunded" | "failed" | "expired" | "unknown";
  sessionId: string;
  charged?: { amount: number; currency: SupportedCurrency };
}

interface ApplyResult {
  changed: boolean;
  outcome: Outcome;
}

/**
 * Apply a verified Stripe event to the order it references.
 *
 * The order row is created if it doesn't exist yet. This is a fallback for
 * the case where the checkout route created the Stripe session but the
 * pre-checkout row wasn't written (which today happens because the current
 * checkout route does not persist an order row before creating the
 * session — the fulfilment phase will add that staging step). By creating
 * the order from the Stripe payload we still deliver the eSIM the buyer
 * paid for. The fulfilment phase can reconcile retail/wholesale USD from
 * the line items Stripe recorded.
 *
 * Idempotency: any repeated event for an already-final state is a no-op.
 * Paid → paid is a no-op. Expired-after-paid stays paid (the payment
 * succeeded; Stripe can emit an `expired` follow-up for sessions where the
 * checkout was reopened). Refunded-after-paid moves to `refunded`.
 */
async function applyPaymentStatus(input: ApplyInput): Promise<ApplyResult> {
  const db = getDb();
  if (!db) throw new StripeProviderNotConfiguredError(); // not used; caller checked

  // One round trip: check current state.
  const [existing] = await db
    .select({
      id: ordersTable.id,
      status: ordersTable.status,
      paidAt: ordersTable.paidAt,
    })
    .from(ordersTable)
    .where(eq(ordersTable.publicId, input.orderId))
    .limit(1);

  const now = new Date();

  // CASE A: no order row yet.
  if (!existing) {
    if (input.paymentStatus !== "paid") {
      // An event for an order we never created, and it wasn't a completed
      // payment — nothing to persist. Logged as changed=false.
      return { changed: false, outcome: mapNonPaidOutcome(input.paymentStatus) };
    }
    if (!input.charged) {
      // We can't invent an amount. Refuse to create a paid order without
      // the charge figure from Stripe.
      return { changed: false, outcome: "missing_order_id" };
    }
    // Insert a minimal order so fulfilment has a work item. Currency and
    // retail_total are populated from Stripe's charge; wholesale/profit
    // are reconciled by the fulfilment phase from the package snapshot.
    await db.insert(ordersTable).values({
      publicId: input.orderId,
      status: "pending_fulfilment",
      currency: input.charged.currency,
      // retail_total is numeric(12,4) in the initial migration. Stripe
      // amounts are in minor units; we store the major-unit figure.
      retailTotal: minorUnitsToDecimalString(input.charged.amount, input.charged.currency),
      stripeSessionId: input.sessionId,
      quantity: 1,
      placedAt: now,
      paidAt: now,
    });
    return { changed: true, outcome: "paid" };
  }

  // CASE B: order exists.
  switch (input.paymentStatus) {
    case "paid": {
      if (existing.status === "paid" || existing.status === "pending_fulfilment") {
        // Already processed. If paid_at is null (edge case from partial
        // failures), fill it in, but keep status unchanged to preserve the
        // fulfilment handoff.
        if (!existing.paidAt) {
          await db
            .update(ordersTable)
            .set({ paidAt: now, updatedAt: now })
            .where(eq(ordersTable.id, existing.id));
          return { changed: true, outcome: "already_paid" };
        }
        return { changed: false, outcome: "already_paid" };
      }
      // Anything else (e.g. `pending`, `processing`, `failed`) moves to paid.
      await db
        .update(ordersTable)
        .set({
          status: "pending_fulfilment",
          paidAt: now,
          stripeSessionId: input.sessionId,
          updatedAt: now,
        })
        .where(eq(ordersTable.id, existing.id));
      return { changed: true, outcome: "paid" };
    }
    case "expired": {
      // If already paid, ignore — a paid order is not expired.
      if (existing.status === "paid" || existing.status === "pending_fulfilment") {
        return { changed: false, outcome: "already_paid" };
      }
      if (existing.status === "expired") return { changed: false, outcome: "expired" };
      await db
        .update(ordersTable)
        .set({ status: "expired", updatedAt: now })
        .where(eq(ordersTable.id, existing.id));
      return { changed: true, outcome: "expired" };
    }
    case "failed": {
      if (existing.status === "paid" || existing.status === "pending_fulfilment") {
        return { changed: false, outcome: "already_paid" };
      }
      await db
        .update(ordersTable)
        .set({ status: "failed", updatedAt: now })
        .where(eq(ordersTable.id, existing.id));
      return { changed: true, outcome: "failed" };
    }
    case "refunded": {
      // Only meaningful if we were paid.
      if (existing.status !== "paid" && existing.status !== "pending_fulfilment") {
        return { changed: false, outcome: "refunded" };
      }
      await db
        .update(ordersTable)
        .set({ status: "refunded", updatedAt: now })
        .where(eq(ordersTable.id, existing.id));
      return { changed: true, outcome: "refunded" };
    }
    case "unpaid":
    case "unknown": {
      // Neither moves an order we already know about. A paid order briefly
      // showing unpaid is a Stripe quirk (e.g. async payment pending); we
      // log it and wait for the terminal event.
      return { changed: false, outcome: "ignored_unknown" };
    }
  }
}

function mapNonPaidOutcome(status: ApplyInput["paymentStatus"]): Outcome {
  switch (status) {
    case "expired":
      return "expired";
    case "failed":
      return "failed";
    case "refunded":
      return "refunded";
    default:
      return "ignored_unknown";
  }
}

/**
 * Convert a minor-units charge (e.g. 1340 for SGD 13.40, or 134000 for
 * whole VND dong) into a decimal string suitable for numeric(12,4).
 * VND is zero-decimal; all other currencies use two decimal places.
 */
export function minorUnitsToDecimalString(amount: number, currency: SupportedCurrency): string {
  if (!Number.isInteger(amount) || amount < 0) {
    throw new Error(`Invalid minor-units amount: ${String(amount)}`);
  }
  const decimals = currency === "VND" ? 0 : 2;
  const factor = 10 ** decimals;
  const major = amount / factor;
  // Pad to four decimal places so PostgreSQL numeric(12,4) parses cleanly and
  // preserves the store's rounding policy (we don't round here; Stripe has
  // already decided the price).
  return major.toFixed(4);
}

// ---------------------------------------------------------------------------
// Test-only surface
// ---------------------------------------------------------------------------

export const __test__ = {
  minorUnitsToDecimalString,
};

// Suppress unused-import lint for the helper we may want with future SQL.
void sql;

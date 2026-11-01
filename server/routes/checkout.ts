/**
 * Checkout routes.
 *
 * Endpoints (mounted at /api/checkout by the app):
 *   GET  /api/checkout/config           payment provider capabilities + currencies
 *   POST /api/checkout/session          create a checkout session for a plan
 *
 * Contract:
 * - This route NEVER calls the supplier (`esimAccess`). It resolves a package
 *   from the packages table via the pricing engine, builds a Stripe Checkout
 *   Session, and hands back the hosted URL. Fulfilment — the actual
 *   `/esim/order` call — happens ONLY after the Stripe webhook confirms
 *   payment (next batch, `server/routes/stripeWebhook.ts`).
 * - Guest checkout is allowed. Order identity uses the shared
 *   `resolveOrderIdentity` helper so every order-shaped route enforces the
 *   same "email required for guests" rule.
 * - Discount and gift-card inputs are accepted and echoed into Stripe metadata
 *   so the growth phase can validate them against a real table without
 *   changing this route's shape. For NOW they do not alter the total — the
 *   growth phase inserts the application step between form building and
 *   `createSession`. This is documented as a gap, not a silent no-op.
 * - Missing Stripe config → 503 `payment_unconfigured`, never a fake success.
 * - Amounts are built from `retailUsd` (the same number the storefront shows),
 *   converted per-currency at a fixed display FX table. FX conversions are a
 *   documented approximation used only for the hosted page total; the
 *   authoritative USD figures are still stored on the order.
 * - Response envelope matches the other API routes: `{ ok: true, data }` /
 *   `{ ok: false, error, message }`.
 */
import { Router, type Request, type Response, type NextFunction } from "express";
import { and, eq } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { brand, type SupportedCurrency } from "../brand.config";
import { getDb } from "../db/client";
import { packages } from "../db/schema";
import { loadPricingContext, toPricedPackage } from "../services/pricing";
import { resolveOrderIdentity } from "../middleware/requireAuth";
import {
  getStripeProvider,
  StripeApiError,
  StripeInvalidAmountError,
  StripeProviderNotConfiguredError,
  __test__ as stripeTest,
} from "../payments/stripeProvider";
import {
  makeOrderId,
  type CheckoutMetadata,
  type PaymentLineItem,
  type PaymentProviderInfo,
  type ProviderLookupResult,
} from "../payments/paymentProvider";

// ---------------------------------------------------------------------------
// Envelope types
// ---------------------------------------------------------------------------

interface CheckoutOk<T> {
  ok: true;
  data: T;
}
interface CheckoutErr {
  ok: false;
  error: string;
  message: string;
}

// ---------------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------------

const giftSchema = z
  .object({
    recipientName: z.string().trim().min(1).max(120),
    recipientEmail: z.string().trim().min(3).max(320),
    message: z.string().trim().max(500).optional(),
    sendDate: z.string().trim().max(40).optional(),
  })
  .strict();

const sessionSchema = z
  .object({
    planCode: z.string().trim().min(1).max(120),
    // Group orders (count > 1) are supported here; the fulfilment phase creates
    // one eSIM per unit each with its own shareable install link.
    quantity: z.number().int().min(1).max(10).default(1),
    currency: z.enum(["SGD", "USD", "VND", "CNY"]).default(brand.defaultCurrency),
    guestEmail: z.string().trim().min(3).max(320).optional(),
    saveCard: z.boolean().optional(),
    gift: giftSchema.optional(),
    // Reserved for the growth phase. Both are validated as syntax only for now.
    discount: z.object({ code: z.string().trim().min(1).max(64) }).optional(),
    giftCard: z.object({ code: z.string().trim().min(1).max(64) }).optional(),
    locale: z.enum(["en", "zh", "vi"]).optional(),
    /** Where the buyer returns after payment. Relative path or absolute URL. */
    successUrl: z.string().trim().max(500).optional(),
    /** Where the buyer returns on cancel. */
    cancelUrl: z.string().trim().max(500).optional(),
  })
  .strict();

type SessionInput = z.infer<typeof sessionSchema>;

// ---------------------------------------------------------------------------
// FX table — ONE place to swap in a live rate feed.
//
// USD is the canonical price. Conversions below are approximations rounded to
// the nearest sensible minor unit for each currency. They are used ONLY to
// display the hosted Stripe page in the buyer's chosen currency. The USD
// amount remains authoritative on the order row so profit reporting is exact.
// ---------------------------------------------------------------------------

interface FxEntry {
  /** Multiplier applied to a USD amount. */
  usdTo: number;
  /** Whether the currency has cents (false for VND). */
  decimals: 2 | 0;
}

const FX: Record<SupportedCurrency, FxEntry> = {
  USD: { usdTo: 1, decimals: 2 },
  SGD: { usdTo: 1.34, decimals: 2 },
  VND: { usdTo: 25_000, decimals: 0 },
  CNY: { usdTo: 7.2, decimals: 2 },
};

/** Convert a USD retail price (2dp) into integer minor units for `currency`. */
export function convertUsdToMinorUnits(usdAmount: number, currency: SupportedCurrency): number {
  if (!Number.isFinite(usdAmount) || usdAmount < 0) {
    throw new StripeInvalidAmountError(`Cannot convert invalid USD amount ${String(usdAmount)}.`);
  }
  const fx = FX[currency];
  const converted = usdAmount * fx.usdTo;
  if (fx.decimals === 0) {
    return Math.round(converted);
  }
  return Math.round(converted * 100);
}

// ---------------------------------------------------------------------------
// Provider lookup — currently Stripe only; MoMo/ZaloPay slot in here later.
// ---------------------------------------------------------------------------

export function getPaymentProvider(): ProviderLookupResult {
  const stripe = getStripeProvider();
  const info: PaymentProviderInfo = {
    id: "stripe",
    label: "Stripe",
    supportedCurrencies: stripe.supportedCurrencies,
    configured: stripe.isConfigured,
    methods: ["card", "apple_pay", "google_pay", "paynow", "alipay", "wechat_pay"],
  };
  return { provider: stripe.isConfigured ? stripe : null, info };
}

// ---------------------------------------------------------------------------
// Order-id factory
// ---------------------------------------------------------------------------

/**
 * Generate a stable order id used as the `client_reference_id` on the Stripe
 * session, the `transactionId` when calling `/esim/order` in the fulfilment
 * phase, and the primary key on the orders table. Format: `zipy-<hex>` so it
 * is at a glance ours (never a supplier id).
 */
export function generateOrderId(): string {
  // 12 hex chars = 48 bits of entropy; enough for uniqueness in our lifetime
  // while staying short enough to surface in URLs / emails.
  return `zipy-${randomBytes(6).toString("hex")}`;
}

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

export function createCheckoutRouter(): Router {
  const router = Router();

  // -------------------------------------------------------------------------
  // GET /config
  // -------------------------------------------------------------------------
  router.get("/config", (_req: Request, res: Response) => {
    const { info } = getPaymentProvider();
    res.status(200).json({
      ok: true,
      data: {
        providers: [info],
        currencies: brand.currencies,
        defaultCurrency: brand.defaultCurrency,
        guaranteeCopy: brand.guaranteeCopy,
      },
    } satisfies CheckoutOk<{
      providers: PaymentProviderInfo[];
      currencies: readonly SupportedCurrency[];
      defaultCurrency: SupportedCurrency;
      guaranteeCopy: string;
    }>);
  });

  // -------------------------------------------------------------------------
  // POST /session
  // -------------------------------------------------------------------------
  router.post(
    "/session",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const parsed = sessionSchema.safeParse(req.body);
        if (!parsed.success) {
          res.status(400).json({
            ok: false,
            error: "invalid_request",
            message: parsed.error.issues[0]?.message ?? "Invalid checkout payload.",
          } satisfies CheckoutErr);
          return;
        }
        const input = parsed.data;

        // Identity: signed-in user or guest-with-email. `resolveOrderIdentity`
        // enforces the same rule every order-shaped route uses.
        const identity = resolveOrderIdentity(req, input.guestEmail);
        if (!identity.ok) {
          res.status(400).json({
            ok: false,
            error: identity.error,
            message: identity.message,
          } satisfies CheckoutErr);
          return;
        }

        const lookup = getPaymentProvider();
        if (!lookup.provider) {
          res.status(503).json({
            ok: false,
            error: "payment_unconfigured",
            message:
              "Payments are not available yet. Set STRIPE_SECRET_KEY (and PUBLIC_BASE_URL) in Replit Secrets to enable checkout.",
          } satisfies CheckoutErr);
          return;
        }
        if (!lookup.info.supportedCurrencies.includes(input.currency)) {
          res.status(400).json({
            ok: false,
            error: "unsupported_currency",
            message: `Currency ${input.currency} is not supported by the configured payment provider.`,
          } satisfies CheckoutErr);
          return;
        }

        // Load the package row + pricing. Only DB rows, never the supplier.
        const db = getDb();
        if (!db) {
          res.status(503).json({
            ok: false,
            error: "catalog_unavailable",
            message: "Catalog store is not configured.",
          } satisfies CheckoutErr);
          return;
        }
        const [row] = await db
          .select()
          .from(packages)
          .where(and(eq(packages.active, true), eq(packages.code, input.planCode)))
          .limit(1);
        if (!row) {
          res.status(404).json({
            ok: false,
            error: "plan_not_found",
            message: `Plan ${input.planCode} is not available.`,
          } satisfies CheckoutErr);
          return;
        }
        const context = await loadPricingContext();
        const priced = toPricedPackage(row, context.globalMarkupPercent, context.overrides);

        // Compute the per-unit price in minor units of the chosen currency.
        const unitAmount = convertUsdToMinorUnits(priced.retailUsd, input.currency);
        if (unitAmount <= 0) {
          res.status(400).json({
            ok: false,
            error: "invalid_amount",
            message: "This plan has no purchasable price.",
          } satisfies CheckoutErr);
          return;
        }

        const items: PaymentLineItem[] = [
          {
            packageCode: priced.code,
            name: priced.name,
            unitAmount,
            quantity: input.quantity,
          },
        ];
        const totalAmount = unitAmount * input.quantity;

        const orderId = makeOrderId(generateOrderId());

        const metadata: CheckoutMetadata = {
          guestEmail: identity.userId == null ? identity.email : undefined,
          saveCard: input.saveCard === true,
          gift: input.gift
            ? {
                recipientName: input.gift.recipientName,
                recipientEmail: input.gift.recipientEmail,
                message: input.gift.message,
                sendDate: input.gift.sendDate,
              }
            : undefined,
          discount: input.discount,
          giftCard: input.giftCard,
          locale: input.locale,
        };

        const success = input.successUrl ?? `/checkout/success?orderId=${orderId}`;
        const cancel = input.cancelUrl ?? `/checkout/cancel?orderId=${orderId}`;

        // NOTE: In the growth phase a new line runs between here and
        // `createSession` that (a) validates `input.discount` / `input.giftCard`
        // against their tables, and (b) reduces `totalAmount` / `items`
        // accordingly. For now both hints are echoed into metadata only.
        const session = await lookup.provider.createSession({
          orderId,
          total: { amount: totalAmount, currency: input.currency },
          items,
          successUrl: success,
          cancelUrl: cancel,
          metadata,
        });

        res.status(200).json({
          ok: true,
          data: {
            orderId,
            provider: session.provider,
            checkoutUrl: session.checkoutUrl,
            sessionId: session.sessionId,
            expiresAt: session.expiresAt?.toISOString(),
            amount: totalAmount,
            currency: input.currency,
            // USD figures the buyer will be charged against once paid. Shown
            // on the success page so the buyer can reconcile FX in their bank
            // app; the USD amounts are what the order row stores for profit.
            usdAmount: Math.round(priced.retailUsd * input.quantity * 100) / 100,
            quantity: input.quantity,
            planCode: priced.code,
          },
        } satisfies CheckoutOk<{
          orderId: string;
          provider: "stripe";
          checkoutUrl: string;
          sessionId: string;
          expiresAt?: string;
          amount: number;
          currency: SupportedCurrency;
          usdAmount: number;
          quantity: number;
          planCode: string;
        }>);
      } catch (err) {
        if (err instanceof StripeProviderNotConfiguredError) {
          res.status(503).json({
            ok: false,
            error: "payment_unconfigured",
            message: err.message,
          } satisfies CheckoutErr);
          return;
        }
        if (err instanceof StripeInvalidAmountError) {
          res.status(400).json({
            ok: false,
            error: "invalid_amount",
            message: err.message,
          } satisfies CheckoutErr);
          return;
        }
        if (err instanceof StripeApiError) {
          // eslint-disable-next-line no-console
          console.error("[checkout] stripe api error", {
            status: err.status,
            message: err.message,
            detail: err.detail,
          });
          res.status(502).json({
            ok: false,
            error: "payment_provider_error",
            message: "The payment provider rejected the checkout. Please try again.",
          } satisfies CheckoutErr);
          return;
        }
        next(err);
      }
    },
  );

  // Router-local error handler (defence in depth).
  router.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    const message = err instanceof Error ? err.message : "Unexpected checkout error";
    // eslint-disable-next-line no-console
    console.error("[checkout route error]", message);
    res.status(500).json({
      ok: false,
      error: "internal_error",
      message,
    } satisfies CheckoutErr);
    void next;
  });

  return router;
}

// ---------------------------------------------------------------------------
// Test-only surface (kept tiny; expanded in the test batch).
// ---------------------------------------------------------------------------

export const __test__ = {
  convertUsdToMinorUnits,
  generateOrderId,
  FX,
  stripeTest,
};

/**
 * Payment provider abstraction.
 *
 * The checkout route and the (later) refund service depend only on this
 * interface, never on Stripe directly. That keeps a future MoMo / ZaloPay
 * gateway a one-file addition — a new class implementing `PaymentProvider`
 * registered in `getPaymentProvider()`.
 *
 * For THIS batch only the Stripe implementation is wired. Missing Stripe keys
 * do not throw on import; `isConfigured` reports false and the route returns
 * an honest 503 rather than pretending checkout works.
 */
import type { SupportedCurrency } from "../brand.config";

/** The canonical order identity used across the system (also the Stripe metadata key). */
export type OrderId = string & { readonly __brand: "OrderId" };

/** Convenience constructor: callers don't have to cast. */
export function makeOrderId(raw: string): OrderId {
  return raw as OrderId;
}

/** A monetary amount is integer minor units + a currency code. */
export interface Money {
  /** Integer amount in the smallest currency unit (cents, or VND whole units). */
  amount: number;
  currency: SupportedCurrency;
}

/** A single line item passed to the provider. */
export interface PaymentLineItem {
  /** Package code (our stable id). */
  packageCode: string;
  /** Display name — surfaces on the receipt / Stripe hosted page. */
  name: string;
  /** Unit amount (integer minor units). */
  unitAmount: number;
  /** Quantity for group orders (count > 1). */
  quantity: number;
}

/** Discount hook reserved for the growth phase (Phase 8). */
export interface CheckoutDiscountHint {
  /** Raw code the user typed. Validation happens in the growth phase. */
  code: string;
}

/** Gift card hook reserved for the growth phase (Phase 8). */
export interface CheckoutGiftCardHint {
  /** Raw code the user typed. Validation happens in the growth phase. */
  code: string;
}

/** Gift eSIM metadata — passed through to the fulfilment phase. */
export interface GiftInput {
  recipientName: string;
  recipientEmail: string;
  message?: string;
  /** ISO 8601 date; the recipient email is sent on/after this date. */
  sendDate?: string;
}

/** Extra metadata that must survive across the redirect + webhook. */
export interface CheckoutMetadata {
  /** Buyer email for guest checkout (also recorded on the order). */
  guestEmail?: string;
  /** Buyer's opt-in to save the card for future top-ups. */
  saveCard?: boolean;
  /** If present, the resulting eSIMs are gifts and fulfilment emails the recipient. */
  gift?: GiftInput;
  /** Reserved: discount code (validated later, echoed for the growth phase). */
  discount?: CheckoutDiscountHint;
  /** Reserved: gift card code (validated later, echoed for the growth phase). */
  giftCard?: CheckoutGiftCardHint;
  /** Locale used for the order-confirmation email template. */
  locale?: string;
}

/** Request shape to create a hosted payment session. */
export interface CreateSessionRequest {
  /** Internal order id; also sent to the provider as the idempotent reference. */
  orderId: OrderId;
  /** Money must be the FINAL amount the user pays (already includes discounts). */
  total: Money;
  /** One or more line items (group orders list each package once with a quantity). */
  items: PaymentLineItem[];
  /** Absolute URL the provider redirects to after the buyer pays. */
  successUrl: string;
  /** Absolute URL the provider redirects to when the buyer cancels. */
  cancelUrl: string;
  /** Metadata persisted by the provider and replayed on the webhook. */
  metadata: CheckoutMetadata;
}

/** Result of creating a session. */
export interface CreateSessionResult {
  /** Which provider created this session (e.g. `"stripe"`). */
  provider: PaymentProviderId;
  /** Session id the provider will reference in the webhook payload. */
  sessionId: string;
  /** Hosted checkout URL the buyer is redirected to. */
  checkoutUrl: string;
  /** When the session expires (if the provider returns it). */
  expiresAt?: Date;
}

/** Result of verifying an inbound webhook from the provider. */
export type VerifyWebhookResult =
  | {
      ok: true;
      /** The session this event relates to (the provider's id). */
      sessionId: string;
      /** The provider-assigned payment intent status when available. */
      paymentStatus: "paid" | "unpaid" | "refunded" | "failed" | "expired" | "unknown";
      /** Our order id, replayed from metadata. */
      orderId: OrderId | null;
      /** Total actually charged, when the provider returns it. */
      charged?: Money;
    }
  | { ok: false; reason: string };

/** A pluggable payment provider. */
export interface PaymentProvider {
  readonly id: PaymentProviderId;
  /** True when this provider has enough config to actually take a payment. */
  readonly isConfigured: boolean;
  /** Currencies this provider supports (subset of the brand list). */
  readonly supportedCurrencies: readonly SupportedCurrency[];

  /** Create (or return the existing) hosted session for an order. */
  createSession(input: CreateSessionRequest): Promise<CreateSessionResult>;

  /**
   * Verify an inbound webhook. Implementations MUST use a real signature
   * check (constant-time) against the raw request body. Return `{ ok:false }`
   * for every failure mode so the route can 400 cleanly.
   */
  verifyWebhook(input: VerifyWebhookInput): Promise<VerifyWebhookResult>;
}

/** Webhook payload as delivered by the provider. */
export interface VerifyWebhookInput {
  /** Raw body bytes (must be the exact bytes — signatures cover them). */
  rawBody: string;
  /** Provider-signature headers (case-insensitive lookup upstream). */
  signatureHeader: string | null;
}

/** Logos/metadata that the checkout page may want to display. */
export interface PaymentProviderInfo {
  id: PaymentProviderId;
  label: string;
  supportedCurrencies: readonly SupportedCurrency[];
  /** True only when the provider can actually take a payment right now. */
  configured: boolean;
  /** Human-friendly method names — matches what the buyer will see. */
  methods: readonly string[];
}

/** Provider ids we know about. Extend when adding MoMo / ZaloPay. */
export type PaymentProviderId = "stripe";

/** Registry entry returned by `getPaymentProvider()`. */
export interface ProviderLookupResult {
  provider: PaymentProvider | null;
  info: PaymentProviderInfo;
}

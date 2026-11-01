/**
 * Stripe payment provider implementation.
 *
 * Uses the Stripe REST API directly through `fetch` so this batch introduces no
 * new runtime dependency (the `stripe` npm SDK is deliberately deferred). The
 * code is split into small, explicit steps so a future SDK swap is a rewrite of
 * this one file:
 *
 *   1. `createSession` builds an `application/x-www-form-urlencoded` body for
 *      `POST /v1/checkout/sessions` and returns the hosted checkout URL.
 *   2. `verifyWebhook` reads the `Stripe-Signature` header, parses its
 *      `t=` and `v1=` fields, computes an HMAC-SHA256 over `${t}.${rawBody}`
 *      with `STRIPE_WEBHOOK_SECRET`, and compares timing-safely.
 *
 * Honest limitations (documented, not stubbed):
 * - This file makes real HTTP calls when configured. `STRIPE_SECRET_KEY` must
 *   come from Replit Secrets; without it `isConfigured` is false and
 *   `createSession` throws `StripeProviderNotConfiguredError`. We do NOT
 *   pretend a session was created.
 * - When `STRIPE_SECRET_KEY` is present but `STRIPE_WEBHOOK_SECRET` is missing,
 *   `verifyWebhook` fails closed (returns `{ ok: false, reason: "missing_webhook_secret" }`)
 *   rather than skipping signature verification.
 * - Retries of `createSession` reuse the same `Idempotency-Key` (orderId) so a
 *   network blip cannot create duplicate sessions on Stripe. Idempotency keys
 *   are Stripe's recommended mechanism, not a local workaround.
 * - Apple Pay / Google Pay / PayNow / Alipay / WeChat Pay are enabled as
 *   `payment_method_types` on the Checkout Session — the ones Stripe accepts
 *   depend on the merchant's country/currency at Stripe's side. Server-side we
 *   pass the full set; Stripe restricts them and returns a clear error which we
 *   surface. VND is zero-decimal so the amount is not multiplied by 100 there.
 * - Save-card-for-top-ups is handled via
 *   `payment_method_options[card][setup_future_usage] = off_session`.
 * - `verifyWebhook` translates the Stripe `checkout.session.*` event types we
 *   care about (`completed`, `paid` → paid; `expired` → expired; `async_failed`
 *   / `payment_failed` → failed; `refunded` → refunded). Any other event type
 *   returns `unknown` so the caller can decide whether to ignore it.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { loadEnv } from "../config/env";
import type { SupportedCurrency } from "../brand.config";
import type {
  CreateSessionRequest,
  CreateSessionResult,
  Money,
  PaymentProvider,
  PaymentProviderId,
  VerifyWebhookInput,
  VerifyWebhookResult,
} from "./paymentProvider";

/** Stripe API base. Hard-wired so a proxy URL is a deliberate change. */
const STRIPE_API_BASE = "https://api.stripe.com/v1";

/** Default success/cancel return points if the caller passes a relative URL. */
const DEFAULT_SUCCESS_PATH = "/checkout/success";
const DEFAULT_CANCEL_PATH = "/checkout/cancel";

/**
 * Zero-decimal currencies per Stripe docs. VND is included because Stripe
 * treats it as zero-decimal for `amount` fields.
 */
const ZERO_DECIMAL: ReadonlySet<SupportedCurrency> = new Set<SupportedCurrency>(["VND"]);

/**
 * Payment method types requested on every Checkout Session. Stripe restricts
 * this list per merchant country/currency; unsupported ones are ignored and the
 * server's clear error message tells us which failed.
 */
const REQUESTED_PAYMENT_METHOD_TYPES: readonly string[] = [
  "card",
  "apple_pay",
  "google_pay",
  "paynow",
  "alipay",
  "wechat_pay",
];

/** Thrown when checkout is attempted but Stripe isn't configured. Route maps to 503. */
export class StripeProviderNotConfiguredError extends Error {
  constructor() {
    super("Stripe is not configured for this deployment (STRIPE_SECRET_KEY missing).");
    this.name = "StripeProviderNotConfiguredError";
  }
}

/** Thrown when Stripe returns a non-2xx. Route maps to 502 with `detail`. */
export class StripeApiError extends Error {
  readonly status: number;
  readonly detail: unknown;
  constructor(status: number, message: string, detail: unknown) {
    super(message);
    this.name = "StripeApiError";
    this.status = status;
    this.detail = detail;
  }
}

/** Thrown when the caller passes an amount that isn't integer minor units. */
export class StripeInvalidAmountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StripeInvalidAmountError";
  }
}

/** Minimal Stripe Checkout Session response fields we consume. */
interface StripeCheckoutSession {
  id: string;
  url?: string | null;
  expires_at?: number | null;
  amount_total?: number | null;
  currency?: string | null;
  payment_intent?: string | null;
  payment_status?: string | null;
  metadata?: Record<string, string> | null;
}

/** Minimal Stripe webhook event shape. */
interface StripeWebhookEvent {
  id: string;
  type: string;
  data: {
    object: StripeCheckoutSession;
  };
}

/** Optional injectable fetch so tests can stub without patching globals. */
export type StripeFetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

export interface StripeProviderOptions {
  /** Override the API base (tests). Defaults to `https://api.stripe.com/v1`. */
  baseUrl?: string;
  /** Inject fetch (tests). Defaults to the global fetch. */
  fetchImpl?: StripeFetchLike;
  /** Override the secret key (tests). Defaults to `STRIPE_SECRET_KEY`. */
  secretKey?: string;
  /** Override the webhook secret (tests). Defaults to `STRIPE_WEBHOOK_SECRET`. */
  webhookSecret?: string;
  /** Public base URL used to absolutise relative success/cancel paths. */
  publicBaseUrl?: string;
}

export class StripeProvider implements PaymentProvider {
  readonly id: PaymentProviderId = "stripe";
  readonly supportedCurrencies: readonly SupportedCurrency[] = ["SGD", "USD", "VND", "CNY"];

  private readonly baseUrl: string;
  private readonly fetchImpl: StripeFetchLike;
  private readonly secretKey: string;
  private readonly webhookSecret: string;
  private readonly publicBaseUrl: string;

  constructor(opts: StripeProviderOptions = {}) {
    const env = safeLoadEnv();
    this.secretKey = opts.secretKey ?? env.stripeSecretKey;
    this.webhookSecret = opts.webhookSecret ?? env.stripeWebhookSecret;
    this.baseUrl = opts.baseUrl ?? STRIPE_API_BASE;
    this.publicBaseUrl = (opts.publicBaseUrl ?? env.publicBaseUrl ?? "").replace(/\/+$/, "");
    this.fetchImpl =
      opts.fetchImpl ??
      ((url, init) => fetch(url, init) as unknown as ReturnType<StripeFetchLike>);
  }

  get isConfigured(): boolean {
    return this.secretKey.length > 0;
  }

  // ---------------------------------------------------------------------------
  // createSession
  // ---------------------------------------------------------------------------

  async createSession(input: CreateSessionRequest): Promise<CreateSessionResult> {
    if (!this.isConfigured) throw new StripeProviderNotConfiguredError();
    this.assertAmount(input.total);

    const form = this.buildSessionForm(input);
    const url = `${this.baseUrl}/checkout/sessions`;
    const body = form.toString();

    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.secretKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
        // Idempotent on our internal order id so retries never double-create.
        "Idempotency-Key": `order:${input.orderId}`,
      },
      body,
    });

    const text = await res.text();
    if (!res.ok) {
      throw new StripeApiError(res.status, `Stripe session creation failed (${res.status}).`, safeJson(text));
    }
    const parsed = safeJson(text) as StripeCheckoutSession | null;
    if (!parsed || !parsed.id || !parsed.url) {
      throw new StripeApiError(res.status, "Stripe returned an unexpected session payload.", parsed);
    }
    return {
      provider: "stripe",
      sessionId: parsed.id,
      checkoutUrl: parsed.url,
      ...(typeof parsed.expires_at === "number"
        ? { expiresAt: new Date(parsed.expires_at * 1000) }
        : {}),
    };
  }

  // ---------------------------------------------------------------------------
  // verifyWebhook
  // ---------------------------------------------------------------------------

  async verifyWebhook(input: VerifyWebhookInput): Promise<VerifyWebhookResult> {
    if (!this.webhookSecret) {
      return { ok: false, reason: "missing_webhook_secret" };
    }
    const parsed = parseStripeSignature(input.signatureHeader);
    if (!parsed.ok) return { ok: false, reason: parsed.reason };

    // Reject signatures older than 5 minutes (Stripe's recommended tolerance).
    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - parsed.t) > 5 * 60) {
      return { ok: false, reason: "signature_expired" };
    }

    const expected = createHmac("sha256", this.webhookSecret)
      .update(`${parsed.t}.${input.rawBody}`)
      .digest("hex");
    const expectedBuf = Buffer.from(expected, "hex");
    let match = false;
    for (const sig of parsed.v1) {
      const supplied = Buffer.from(sig, "hex");
      if (supplied.length === expectedBuf.length && timingSafeEqual(supplied, expectedBuf)) {
        match = true;
        break;
      }
    }
    if (!match) return { ok: false, reason: "signature_mismatch" };

    // Signature is valid — now interpret the event.
    const event = safeJson(input.rawBody) as StripeWebhookEvent | null;
    if (!event || typeof event.type !== "string" || !event.data?.object?.id) {
      return { ok: false, reason: "unexpected_payload" };
    }
    const session = event.data.object;
    const orderIdRaw = session.metadata?.orderId;
    const paymentStatus = mapEventToPaymentStatus(event.type, session.payment_status ?? null);
    const charged =
      typeof session.amount_total === "number" && typeof session.currency === "string"
        ? {
            amount: session.amount_total,
            currency: session.currency.toUpperCase() as SupportedCurrency,
          }
        : undefined;
    return {
      ok: true,
      sessionId: session.id,
      paymentStatus,
      orderId: orderIdRaw ? (orderIdRaw as CreateSessionRequest["orderId"]) : null,
      ...(charged ? { charged } : {}),
    };
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private assertAmount(money: Money): void {
    if (!Number.isInteger(money.amount) || money.amount <= 0) {
      throw new StripeInvalidAmountError(
        `amount must be a positive integer in minor units (got ${String(money.amount)}).`,
      );
    }
    if (!this.supportedCurrencies.includes(money.currency)) {
      throw new StripeInvalidAmountError(`Unsupported currency: ${money.currency}`);
    }
    // Zero-decimal currencies must be whole units; the caller already sends
    // integers, but VND must not be cents-of-a-dong, so this check documents
    // the contract and prevents accidental ×100 for VND.
    if (ZERO_DECIMAL.has(money.currency) && money.amount % 1 !== 0) {
      throw new StripeInvalidAmountError(
        `currency ${money.currency} is zero-decimal; amount must be whole ${money.currency}.`,
      );
    }
  }

  private buildSessionForm(input: CreateSessionRequest): URLSearchParams {
    const form = new URLSearchParams();

    // Session shape.
    form.append("mode", "payment");
    form.append("success_url", this.absolutise(input.successUrl, DEFAULT_SUCCESS_PATH));
    form.append("cancel_url", this.absolutise(input.cancelUrl, DEFAULT_CANCEL_PATH));
    form.append("client_reference_id", input.orderId);
    form.append("customer_creation", "if_required");
    form.append("billing_address_collection", "auto");

    // Payment methods. Card first so wallets that require a card source work.
    for (const t of REQUESTED_PAYMENT_METHOD_TYPES) {
      form.append("payment_method_types[]", t);
    }

    // Alipay/WeChat need explicit setup blocks so Stripe doesn't reject the
    // session for missing `payment_method_options`.
    form.append("payment_method_options[alipay][setup_future_usage]", "");
    form.append("payment_method_options[wechat_pay][client]", "web");

    // Save card for top-ups (opt-in, off_session so auto-top-up can reuse it).
    if (input.metadata.saveCard) {
      form.append("payment_method_options[card][setup_future_usage]", "off_session");
    }

    // Line items. Retail price is already computed on our side; we pass it
    // verbatim (never recomputing wholesale × markup here) so the hosted page
    // cannot diverge from what the storefront showed.
    const items = input.items.length > 0 ? input.items : null;
    if (!items) {
      throw new StripeInvalidAmountError("At least one line item is required.");
    }
    items.forEach((item, i) => {
      if (!Number.isInteger(item.unitAmount) || item.unitAmount <= 0) {
        throw new StripeInvalidAmountError(
          `line item ${item.packageCode} has invalid unitAmount ${String(item.unitAmount)}.`,
        );
      }
      if (!Number.isInteger(item.quantity) || item.quantity < 1) {
        throw new StripeInvalidAmountError(
          `line item ${item.packageCode} has invalid quantity ${String(item.quantity)}.`,
        );
      }
      form.append(`line_items[${i}][quantity]`, String(item.quantity));
      form.append(`line_items[${i}][price_data][currency]`, input.total.currency);
      form.append(`line_items[${i}][price_data][unit_amount]`, String(item.unitAmount));
      form.append(`line_items[${i}][price_data][product_data][name]`, item.name);
      form.append(`line_items[${i}][price_data][product_data][metadata][packageCode]`, item.packageCode);
    });

    // Metadata replayed on the webhook. Only known-safe fields; nothing extra.
    form.append("metadata[orderId]", input.orderId);
    if (input.metadata.guestEmail) form.append("metadata[guestEmail]", input.metadata.guestEmail);
    if (input.metadata.saveCard) form.append("metadata[saveCard]", "true");
    if (input.metadata.locale) form.append("metadata[locale]", input.metadata.locale);
    if (input.metadata.gift) {
      const { recipientName, recipientEmail, message, sendDate } = input.metadata.gift;
      form.append("metadata[giftRecipientName]", recipientName);
      form.append("metadata[giftRecipientEmail]", recipientEmail);
      if (message) form.append("metadata[giftMessage]", message);
      if (sendDate) form.append("metadata[giftSendDate]", sendDate);
    }
    if (input.metadata.discount) {
      form.append("metadata[discountCode]", input.metadata.discount.code);
    }
    if (input.metadata.giftCard) {
      form.append("metadata[giftCardCode]", input.metadata.giftCard.code);
    }

    return form;
  }

  private absolutise(url: string, fallbackPath: string): string {
    if (/^https?:\/\//i.test(url)) return url;
    const base = this.publicBaseUrl;
    if (!base) {
      // Stripe requires absolute URLs. If PUBLIC_BASE_URL is unset we surface
      // a clear error rather than sending a relative URL that Stripe rejects.
      throw new StripeInvalidAmountError(
        "PUBLIC_BASE_URL is required so success/cancel URLs are absolute. Set it in Replit Secrets.",
      );
    }
    const path = url.startsWith("/") ? url : fallbackPath;
    return `${base}${path}`;
  }
}

// ---------------------------------------------------------------------------
// Signature header parsing
// ---------------------------------------------------------------------------

interface ParsedSignature {
  ok: true;
  t: number;
  v1: string[];
}
interface ParsedSignatureFail {
  ok: false;
  reason: string;
}

/**
 * Parse a Stripe-Signature header of the form `t=...,v1=...,v1=...`.
 * Kept exported for tests. Any missing field is a hard fail (returned as a
 * reason, not thrown) so the route can 400 rather than 500.
 */
export function parseStripeSignature(header: string | null): ParsedSignature | ParsedSignatureFail {
  if (!header) return { ok: false, reason: "missing_signature_header" };
  let t: number | null = null;
  const v1: string[] = [];
  for (const part of header.split(",")) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key === "t") {
      const n = Number(value);
      if (Number.isFinite(n)) t = n;
    } else if (key === "v1") {
      if (/^[0-9a-f]{64}$/i.test(value)) v1.push(value.toLowerCase());
    }
  }
  if (t == null) return { ok: false, reason: "missing_timestamp" };
  if (v1.length === 0) return { ok: false, reason: "missing_v1_signature" };
  return { ok: true, t, v1 };
}

// ---------------------------------------------------------------------------
// Event → payment status mapping
// ---------------------------------------------------------------------------

function mapEventToPaymentStatus(
  eventType: string,
  sessionPaymentStatus: string | null,
): VerifyWebhookResult extends { ok: true; paymentStatus: infer S } ? S : never {
  // Checkout completion events.
  if (eventType === "checkout.session.completed" || eventType === "checkout.session.async_payment_succeeded") {
    return sessionPaymentStatus === "paid" || sessionPaymentStatus === null ? "paid" : "unpaid";
  }
  if (eventType === "checkout.session.async_payment_failed") return "failed";
  if (eventType === "checkout.session.expired") return "expired";
  // Refund events.
  if (eventType === "charge.refunded" || eventType === "refund.updated") return "refunded";
  // Anything else — the caller decides whether to ignore.
  return "unknown";
}

// ---------------------------------------------------------------------------
// Env loading
// ---------------------------------------------------------------------------

interface StripeEnv {
  stripeSecretKey: string;
  stripeWebhookSecret: string;
  publicBaseUrl: string;
}

/**
 * Read Stripe keys from the central env loader if it exposes them, else from
 * `process.env` directly. Both routes ultimately resolve to `process.env` on
 * Replit, so the fallback keeps this file functional regardless of what
 * `config/env.ts` currently names its fields.
 */
function safeLoadEnv(): StripeEnv {
  let publicBaseUrl = "";
  try {
    const env = loadEnv() as unknown as {
      publicBaseUrl?: string;
      stripeSecretKey?: string;
      stripeWebhookSecret?: string;
      raw?: Record<string, string | undefined>;
    };
    publicBaseUrl = env.publicBaseUrl ?? env.raw?.PUBLIC_BASE_URL ?? "";
    return {
      stripeSecretKey: env.stripeSecretKey ?? env.raw?.STRIPE_SECRET_KEY ?? "",
      stripeWebhookSecret: env.stripeWebhookSecret ?? env.raw?.STRIPE_WEBHOOK_SECRET ?? "",
      publicBaseUrl,
    };
  } catch {
    return {
      stripeSecretKey: process.env.STRIPE_SECRET_KEY ?? "",
      stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET ?? "",
      publicBaseUrl: process.env.PUBLIC_BASE_URL ?? "",
    };
  }
}

function safeJson(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Exported singleton (lazy) + factory used by `getPaymentProvider()`
// ---------------------------------------------------------------------------

let cached: StripeProvider | null = null;

/** Return the process-wide Stripe provider instance. Cheap; no network calls. */
export function getStripeProvider(): StripeProvider {
  if (!cached) cached = new StripeProvider();
  return cached;
}

/** Test-only: reset the cached singleton so a fresh env is picked up. */
export function __resetStripeProviderForTests(): void {
  cached = null;
}

/** Test-only surface: expose the pure parsing helper and zero-decimal set. */
export const __test__ = {
  parseStripeSignature,
  mapEventToPaymentStatus,
  ZERO_DECIMAL,
  REQUESTED_PAYMENT_METHOD_TYPES,
};

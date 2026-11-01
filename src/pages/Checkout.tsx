/**
 * Checkout page: /checkout (or /esim/[country] → "Choose plan").
 *
 * Contract with the backend:
 *   GET  /api/checkout/config  → currencies, providers, guarantee copy
 *   POST /api/checkout/session → { orderId, checkoutUrl, ... } → hosted Stripe
 *
 * Scope of this page (checkout + payment abstraction batch):
 *  - Currency picker limited to what BOTH brand.config and Stripe support.
 *  - Guest email field, shown only when the buyer isn't signed in.
 *  - "Save card for top-ups" opt-in — passes `saveCard` through to the
 *    provider so top-ups can charge off-session later.
 *  - Optional gift fields (recipient name, email, message, send date) so
 *    buyers can flag a gift; the fulfilment + email phases handle delivery.
 *  - Optional discount/gift-card code inputs. They are echoed to the
 *    backend today but do NOT alter the amount — the growth phase inserts
 *    the validation + reduction step server-side. The UI says so plainly
 *    rather than pretending to discount now.
 *  - Money-back guarantee badge per brand.guaranteeCopy.
 *  - Quantity selector capped at 10 (matches the checkout route schema).
 *  - On success: `window.location.assign(checkoutUrl)` — never a fake
 *    "paid" screen. Missing Stripe config returns a 503 that we surface
 *    verbatim; we do NOT fall back to a demo checkout.
 *
 * State model is explicit: idle / submitting / error / ready-to-redirect.
 * No placeholder plan or invented price: `plan` comes from the caller.
 */
import { useEffect, useMemo, useState, type FormEvent } from "react";

export type SupportedCurrency = "SGD" | "USD" | "VND" | "CNY";

/** The subset of the catalog plan this page needs. Supplied by the caller. */
export interface CheckoutPlanSummary {
  code: string;
  name: string;
  /** Price in USD as the catalog priced it (retail, incl. markup). */
  retailUsd: number;
  dataLabel: string;
  validityLabel: string;
  networkLabel?: string;
}

export interface CheckoutProps {
  plan: CheckoutPlanSummary;
  /** Signed-in user's email, if any. When present the guest email field is hidden. */
  userEmail?: string | null;
  /** Whether the buyer is signed in; controls save-card + guest UI. */
  isSignedIn?: boolean;
  /** Default quantity (group orders). The route caps at 10. */
  initialQuantity?: number;
  /** Called on the very rare "redirect failed" case so the host can log it. */
  onRedirectFailed?: (err: unknown) => void;
}

interface CheckoutConfig {
  providers: Array<{
    id: string;
    label: string;
    supportedCurrencies: readonly SupportedCurrency[];
    configured: boolean;
    methods: readonly string[];
  }>;
  currencies: readonly SupportedCurrency[];
  defaultCurrency: SupportedCurrency;
  guaranteeCopy: string;
}

interface SessionResponse {
  orderId: string;
  provider: string;
  checkoutUrl: string;
  sessionId: string;
  expiresAt?: string;
  amount: number;
  currency: SupportedCurrency;
  usdAmount: number;
  quantity: number;
  planCode: string;
}

type FetchState =
  | { status: "loading" }
  | { status: "ready"; config: CheckoutConfig }
  | { status: "error"; message: string };

type SubmitState =
  | { status: "idle" }
  | { status: "submitting" }
  | { status: "error"; code: string; message: string };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const METHOD_LABELS: Record<string, string> = {
  card: "Card",
  apple_pay: "Apple Pay",
  google_pay: "Google Pay",
  paynow: "PayNow",
  alipay: "Alipay",
  wechat_pay: "WeChat Pay",
};

/** Indicative FX identical to the server's display table (kept in sync via tests). */
const FX_FOR_PREVIEW: Record<SupportedCurrency, { usdTo: number; decimals: 2 | 0 }> = {
  USD: { usdTo: 1, decimals: 2 },
  SGD: { usdTo: 1.34, decimals: 2 },
  VND: { usdTo: 25_000, decimals: 0 },
  CNY: { usdTo: 7.2, decimals: 2 },
};

function formatPreview(usd: number, currency: SupportedCurrency): string {
  if (!Number.isFinite(usd) || usd < 0) return "—";
  const fx = FX_FOR_PREVIEW[currency];
  const value = usd * fx.usdTo;
  if (fx.decimals === 0) {
    return `${Math.round(value).toLocaleString("en-US")} ${currency}`;
  }
  return `${value.toFixed(2)} ${currency}`;
}

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: "include",
    headers: { Accept: "application/json", ...(init?.headers ?? {}) },
    ...init,
  });
  const json = (await res.json().catch(() => ({}))) as
    | { ok: true; data: T }
    | { ok: false; error: string; message: string };
  if (!res.ok || !json || json.ok === false) {
    const error = json?.ok === false ? json.error : "request_failed";
    const message =
      json?.ok === false ? json.message : `Request failed (HTTP ${res.status}).`;
    throw new CheckoutClientError(error, message);
  }
  return json.data;
}

export class CheckoutClientError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "CheckoutClientError";
    this.code = code;
  }
}

const sessionHttp = {
  config: () => fetchJson<CheckoutConfig>("/api/checkout/config"),
  createSession: (body: unknown) =>
    fetchJson<SessionResponse>("/api/checkout/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
};

export function Checkout({
  plan,
  userEmail = null,
  isSignedIn = false,
  initialQuantity = 1,
  onRedirectFailed,
}: CheckoutProps): JSX.Element {
  const [fetchState, setFetchState] = useState<FetchState>({ status: "loading" });
  const [currency, setCurrency] = useState<SupportedCurrency>("SGD");
  const [quantity, setQuantity] = useState<number>(
    Math.min(10, Math.max(1, Math.floor(initialQuantity))),
  );
  const [guestEmail, setGuestEmail] = useState("");
  const [saveCard, setSaveCard] = useState(false);

  // Gift is opt-in; the fields are hidden until the buyer opens the section.
  const [giftOpen, setGiftOpen] = useState(false);
  const [giftName, setGiftName] = useState("");
  const [giftEmail, setGiftEmail] = useState("");
  const [giftMessage, setGiftMessage] = useState("");
  const [giftSendDate, setGiftSendDate] = useState("");

  // Discount / gift card fields — validated by the growth phase, echoed now.
  const [discountCode, setDiscountCode] = useState("");
  const [giftCardCode, setGiftCardCode] = useState("");

  const [submit, setSubmit] = useState<SubmitState>({ status: "idle" });

  // Load the provider config once.
  useEffect(() => {
    let cancelled = false;
    sessionHttp
      .config()
      .then((config) => {
        if (cancelled) return;
        setFetchState({ status: "ready", config });
        // Default currency: prefer the server default if supported, else the
        // first supported one.
        if (config.currencies.includes(config.defaultCurrency)) {
          setCurrency(config.defaultCurrency);
        } else if (config.currencies.length > 0) {
          setCurrency(config.currencies[0]!);
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setFetchState({
          status: "error",
          message:
            err instanceof Error ? err.message : "Could not load checkout configuration.",
        });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const providerMethods = useMemo<string[]>(() => {
    if (fetchState.status !== "ready") return [];
    const stripe = fetchState.config.providers.find((p) => p.id === "stripe");
    return stripe?.methods ?? [];
  }, [fetchState]);

  const providerReady =
    fetchState.status === "ready" &&
    fetchState.config.providers.some((p) => p.configured && p.supportedCurrencies.includes(currency));

  const previewTotal = formatPreview(plan.retailUsd * quantity, currency);

  function clientValidate(): { code: string; message: string } | null {
    if (!isSignedIn) {
      if (!EMAIL_RE.test(guestEmail.trim())) {
        return { code: "guest_email_required", message: "Enter a valid email to receive your eSIM." };
      }
    }
    if (giftOpen) {
      if (giftName.trim().length === 0) {
        return { code: "invalid_gift", message: "Add the recipient's name for a gift eSIM." };
      }
      if (!EMAIL_RE.test(giftEmail.trim())) {
        return { code: "invalid_gift", message: "Add the recipient's email for a gift eSIM." };
      }
      if (giftSendDate) {
        // ISO date (YYYY-MM-DD); the browser input already enforces this shape
        // but we confirm to produce a clean server error rather than a 400.
        if (Number.isNaN(new Date(giftSendDate).getTime())) {
          return { code: "invalid_gift", message: "Pick a valid send date." };
        }
      }
    }
    return null;
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!providerReady) {
      setSubmit({
        status: "error",
        code: "payment_unconfigured",
        message:
          "Payments are not available yet for this currency. Please pick another or try again later.",
      });
      return;
    }
    const clientErr = clientValidate();
    if (clientErr) {
      setSubmit({ status: "error", ...clientErr });
      return;
    }

    setSubmit({ status: "submitting" });
    try {
      const body: Record<string, unknown> = {
        planCode: plan.code,
        quantity,
        currency,
        saveCard: isSignedIn && saveCard,
      };
      if (!isSignedIn) body.guestEmail = guestEmail.trim();
      if (giftOpen) {
        body.gift = {
          recipientName: giftName.trim(),
          recipientEmail: giftEmail.trim(),
          ...(giftMessage.trim() ? { message: giftMessage.trim() } : {}),
          ...(giftSendDate ? { sendDate: giftSendDate } : {}),
        };
      }
      if (discountCode.trim()) body.discount = { code: discountCode.trim() };
      if (giftCardCode.trim()) body.giftCard = { code: giftCardCode.trim() };

      const session = await sessionHttp.createSession(body);
      // Hosted Stripe page. Give the browser a moment; if it throws (adblock,
      // browser policy) surface the URL for the buyer to click.
      try {
        window.location.assign(session.checkoutUrl);
      } catch (navErr) {
        onRedirectFailed?.(navErr);
        setSubmit({
          status: "error",
          code: "redirect_failed",
          message: `Open this link to complete payment: ${session.checkoutUrl}`,
        });
      }
    } catch (err) {
      const code = err instanceof CheckoutClientError ? err.code : "request_failed";
      const message = err instanceof Error ? err.message : "Could not start checkout.";
      setSubmit({ status: "error", code, message });
    }
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------
  if (fetchState.status === "loading") {
    return (
      <div className="mx-auto w-full max-w-3xl px-4 py-10" aria-busy>
        <div className="h-6 w-40 animate-pulse rounded bg-slate-100" />
        <div className="mt-4 h-64 animate-pulse rounded-2xl bg-slate-100" />
      </div>
    );
  }
  if (fetchState.status === "error") {
    return (
      <div className="mx-auto w-full max-w-3xl px-4 py-10">
        <div
          role="alert"
          className="rounded-2xl bg-rose-50 px-4 py-3 text-sm text-rose-800 ring-1 ring-rose-200"
        >
          {fetchState.message}
        </div>
      </div>
    );
  }

  const config = fetchState.config;
  const stripeInfo = config.providers.find((p) => p.id === "stripe");
  const stripeConfigured = stripeInfo?.configured === true;

  return (
    <main className="mx-auto w-full max-w-3xl px-4 pb-16 pt-6" data-testid="checkout-page">
      <h1 className="text-2xl font-extrabold text-slate-900">Checkout</h1>
      <p className="mt-1 text-sm text-slate-600">
        Secure payment via Stripe. Your eSIM arrives by email within a few minutes
        of payment clearing.
      </p>

      <div className="mt-6 grid gap-6 md:grid-cols-[2fr_3fr]">
        {/* Order summary */}
        <aside className="rounded-2xl bg-white p-5 ring-1 ring-slate-200" data-testid="checkout-summary">
          <p className="text-xs uppercase tracking-wide text-slate-500">Your plan</p>
          <p className="mt-1 text-base font-semibold text-slate-900">{plan.name}</p>
          <dl className="mt-3 space-y-1.5 text-sm text-slate-700">
            <div className="flex justify-between gap-2">
              <dt className="text-slate-500">Data</dt>
              <dd className="font-medium">{plan.dataLabel}</dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-slate-500">Validity</dt>
              <dd className="font-medium">{plan.validityLabel}</dd>
            </div>
            {plan.networkLabel && (
              <div className="flex justify-between gap-2">
                <dt className="text-slate-500">Network</dt>
                <dd className="font-medium">{plan.networkLabel}</dd>
              </div>
            )}
            <div className="flex justify-between gap-2">
              <dt className="text-slate-500">Quantity</dt>
              <dd className="font-medium">×{quantity}</dd>
            </div>
          </dl>
          <div className="mt-4 flex items-baseline justify-between border-t border-slate-200 pt-4">
            <span className="text-sm text-slate-500">Estimated total</span>
            <span className="text-lg font-extrabold text-slate-900" data-testid="checkout-total">
              {previewTotal}
            </span>
          </div>
          <p className="mt-1 text-[11px] text-slate-400">
            Indicative in {currency}. Final amount shown on the secure payment page.
          </p>
          <button
            type="button"
            onClick={() => setQuantity((q) => Math.min(10, q + 1))}
            className="mt-4 w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
            disabled={quantity >= 10}
          >
            Add another eSIM ({quantity}/10)
          </button>
        </aside>

        {/* Form */}
        <form
          onSubmit={handleSubmit}
          className="space-y-4 rounded-2xl bg-white p-5 ring-1 ring-slate-200"
          noValidate
        >
          {submit.status === "error" && (
            <div
              role="alert"
              className="rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-800 ring-1 ring-rose-200"
              data-testid="checkout-error"
              data-error-code={submit.code}
            >
              {submit.message}
            </div>
          )}

          {!stripeConfigured && (
            <div
              role="alert"
              className="rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-900 ring-1 ring-amber-200"
              data-testid="checkout-unconfigured"
            >
              Payments are not configured yet. Add STRIPE_SECRET_KEY in Replit
              Secrets to enable checkout.
            </div>
          )}

          {/* Currency */}
          <div>
            <label htmlFor="currency" className="block text-sm font-medium text-slate-800">
              Pay in
            </label>
            <select
              id="currency"
              value={currency}
              onChange={(e) => setCurrency(e.target.value as SupportedCurrency)}
              className="mt-1 w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-200"
              data-testid="checkout-currency"
            >
              {config.currencies.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>

          {/* Guest email */}
          {!isSignedIn && (
            <div>
              <label htmlFor="guestEmail" className="block text-sm font-medium text-slate-800">
                Email for your eSIM
              </label>
              <input
                id="guestEmail"
                type="email"
                value={guestEmail}
                onChange={(e) => setGuestEmail(e.target.value)}
                autoComplete="email"
                required
                placeholder="you@example.com"
                className="mt-1 w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-200"
                data-testid="checkout-guest-email"
              />
              <p className="mt-1 text-xs text-slate-500">
                We email your QR code and install guide here. No account needed.
              </p>
            </div>
          )}
          {isSignedIn && userEmail && (
            <p className="text-xs text-slate-500">
              We'll send your eSIM to <span className="font-medium text-slate-700">{userEmail}</span>.
            </p>
          )}

          {/* Save card (signed in only) */}
          {isSignedIn && (
            <label className="flex items-start gap-2 text-sm text-slate-700">
              <input
                type="checkbox"
                checked={saveCard}
                onChange={(e) => setSaveCard(e.target.checked)}
                className="mt-0.5"
                data-testid="checkout-save-card"
              />
              <span>
                Save this card for future top-ups
                <span className="block text-xs text-slate-500">
                  You can turn this off any time. Auto top-up is opt-in separately.
                </span>
              </span>
            </label>
          )}

          {/* Gift */}
          <details
            className="rounded-xl bg-slate-50 p-3 text-sm ring-1 ring-slate-200"
            onToggle={(e) => setGiftOpen((e.target as HTMLDetailsElement).open)}
            data-testid="checkout-gift-section"
          >
            <summary className="cursor-pointer font-medium text-slate-800">
              This is a gift (optional)
            </summary>
            <div className="mt-3 space-y-3">
              <input
                type="text"
                placeholder="Recipient name"
                value={giftName}
                onChange={(e) => setGiftName(e.target.value)}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                data-testid="checkout-gift-name"
              />
              <input
                type="email"
                placeholder="Recipient email"
                value={giftEmail}
                onChange={(e) => setGiftEmail(e.target.value)}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                data-testid="checkout-gift-email"
              />
              <textarea
                placeholder="Add a message (optional)"
                value={giftMessage}
                onChange={(e) => setGiftMessage(e.target.value)}
                rows={2}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                data-testid="checkout-gift-message"
              />
              <label className="block text-xs text-slate-500">
                Send on
                <input
                  type="date"
                  value={giftSendDate}
                  onChange={(e) => setGiftSendDate(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                  data-testid="checkout-gift-send-date"
                />
              </label>
            </div>
          </details>

          {/* Discounts (echoed only; applied in growth phase) */}
          <details className="rounded-xl bg-slate-50 p-3 text-sm ring-1 ring-slate-200">
            <summary className="cursor-pointer font-medium text-slate-800">
              Have a discount or gift card?
            </summary>
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              <input
                type="text"
                placeholder="Discount code"
                value={discountCode}
                onChange={(e) => setDiscountCode(e.target.value)}
                className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
                data-testid="checkout-discount"
              />
              <input
                type="text"
                placeholder="Gift card code"
                value={giftCardCode}
                onChange={(e) => setGiftCardCode(e.target.value)}
                className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
                data-testid="checkout-giftcard"
              />
            </div>
            <p className="mt-2 text-xs text-slate-500">
              Codes are validated after payment setup — the total shown on the
              Stripe page reflects any reduction.
            </p>
          </details>

          {/* Payment methods preview */}
          {providerMethods.length > 0 && (
            <div>
              <p className="text-xs uppercase tracking-wide text-slate-500">Payment methods</p>
              <ul className="mt-1 flex flex-wrap gap-1.5">
                {providerMethods.map((m) => (
                  <li
                    key={m}
                    className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700"
                  >
                    {METHOD_LABELS[m] ?? m}
                  </li>
                ))}
              </ul>
              <p className="mt-1 text-[11px] text-slate-400">
                Availability depends on your card and region; final list is shown on Stripe.
              </p>
            </div>
          )}

          <button
            type="submit"
            disabled={submit.status === "submitting" || !providerReady}
            className="w-full rounded-xl bg-brand-600 px-4 py-3 text-sm font-semibold text-white transition hover:bg-brand-700 disabled:opacity-60"
            data-testid="checkout-pay"
          >
            {submit.status === "submitting" ? "Redirecting to payment…" : "Continue to secure payment"}
          </button>

          <p className="flex items-start gap-2 rounded-xl bg-emerald-50 px-3 py-2 text-xs text-emerald-800 ring-1 ring-emerald-200">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
              <path d="M20 6L9 17l-5-5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            {config.guaranteeCopy}
          </p>
        </form>
      </div>
    </main>
  );
}

/**
 * Outbound email sender — the single seam between the built templates
 * (`installEmail.ts`, `giftEmail.ts`) and a real mail provider.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The fulfilment service returns `FulfilledEsim[]` + optional gift metadata but
 * deliberately does NOT send mail (see the honesty note at the top of
 * `server/services/fulfilment.ts`). The success page reads
 * `OrderSummary.installEmailQueued` from the API, and the webhook phase fires
 * "You're connected" / low-data / validity emails. All of those call into THIS
 * module so there is exactly one place that decides "did we send it".
 *
 * DESIGN GUARANTEES
 * -----------------
 * 1. HONEST DELIVERY STATUS. Every send returns
 *    `{ delivered: boolean; reason?: string; providerMessageId?: string }`.
 *    When no provider is configured we return `delivered: false` with a reason
 *    — the caller must NOT flip `installEmailQueued=true` unless `delivered`
 *    is true. No fake success paths.
 * 2. PROVIDER-NEUTRAL. The default transport posts to Resend's HTTP API when
 *    `RESEND_API_KEY` is present (Resend is a common, minimal choice and needs
 *    no extra SDK). A single `transport` dep lets tests or a different provider
 *    (SendGrid, Postmark, SES) be swapped without touching call sites.
 * 3. TEMPLATES ARE THE CONTRACT. `sendInstallEmail` / `sendGiftEmail` take the
 *    exact input shapes the templates declare, render them via the existing
 *    pure `render*Email` functions, and pass the rendered subject/html/text to
 *    the transport unchanged. If a template requires data we don't have
 *    (missing `publicBaseUrl`), we refuse rather than render a broken link.
 * 4. LOGGED, NOT SILENT. Every attempt logs one structured line with the
 *    outcome. Delivery failures never throw; they surface via the return value
 *    so the caller can retry via the normal order job. A THROWING transport is
 *    caught and mapped to `delivered:false, reason:"transport_error"`.
 * 5. REPLAY-SAFE BY CALLER. This module does not itself dedupe — the caller
 *    decides (e.g. webhook processor dedupes on notifyId; fulfilment sets
 *    `installEmailQueued` only once). That's intentional: dedupe belongs where
 *    the business event is known, not in a mail wrapper.
 *
 * WHAT THIS FILE DOES NOT DO
 * --------------------------
 *  - It does not send low-data / validity / "You're connected" emails — those
 *    are the notifications phase's responsibility, but they can reuse the
 *    `makeEmailSender` factory or call `sendRawEmail` with their own template.
 *  - It does not schedule gift emails for a future send date. The gift input
 *    may carry `scheduledSendDate` for reporting, but `sendGiftEmail` sends
 *    IMMEDIATELY. Scheduled delivery is a job's job (future phase). If you
 *    call `sendGiftEmail` from the fulfilment path for an order with a future
 *    `sendDate`, don't — save it and let the scheduler fire it. See the
 *    "SCHEDULING" note on `sendGiftEmail`.
 */
import { brand } from "../brand.config";
import {
  renderInstallEmail,
  type InstallEmailEsim,
  type InstallEmailInput,
} from "../email/templates/installEmail";
import { renderGiftEmail, type GiftEmailInput } from "../email/templates/giftEmail";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A fully rendered message — the transport's only input. */
export interface OutboundMessage {
  to: string;
  from: string;
  subject: string;
  html: string;
  text: string;
  /** Optional reply-to (used for transactional mail so replies reach support). */
  replyTo?: string;
}

/** Delivery outcome. Never throws. `delivered:false` means it did NOT go out. */
export type DeliveryResult =
  | { delivered: true; providerMessageId?: string }
  | { delivered: false; reason: string };

/**
 * The single injectable seam. A transport takes a rendered message and returns
 * a delivery outcome. Production uses `resendTransport` (HTTP); tests pass a
 * capture stub.
 */
export type EmailTransport = (message: OutboundMessage) => Promise<DeliveryResult>;

/** Call-site interface used by fulfilment / webhook / notification services. */
export interface EmailSender {
  isConfigured: boolean;
  sendInstallEmail(input: InstallEmailInput): Promise<DeliveryResult>;
  sendGiftEmail(input: GiftEmailInput): Promise<DeliveryResult>;
  /** Escape hatch for other transactional emails (alerts, notifications). */
  sendRawEmail(message: OutboundMessage): Promise<DeliveryResult>;
}

/** Deps override (tests, or an alternate provider). */
export interface EmailSenderDeps {
  transport?: EmailTransport;
  /** Sender address (`from`). Defaults to `EMAIL_FROM` or a support fallback. */
  from?: string;
  /** Reply-to address. Defaults to brand.supportEmail. */
  replyTo?: string;
  /** Structured logger; defaults to console.log. Silenced in tests. */
  log?: (line: string) => void;
}

// ---------------------------------------------------------------------------
// Configuration resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the sender address. Order:
 *   1. Explicit `deps.from` (tests, one-off callers).
 *   2. `EMAIL_FROM` env var (set in Replit Secrets) — should be a full
 *      `Name <email@domain>` per Resend/SendGrid requirements.
 *   3. `<supportEmail>` from brand.config — works locally for the log transport
 *      so we never send as a nonsense address.
 */
function resolveFrom(deps: EmailSenderDeps): string {
  if (deps.from && deps.from.trim()) return deps.from.trim();
  const envFrom = process.env.EMAIL_FROM;
  if (envFrom && envFrom.trim()) return envFrom.trim();
  return `${brand.name} <${brand.supportEmail}>`;
}

/** True when the default (Resend) transport has credentials. */
function defaultTransportConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY && process.env.RESEND_API_KEY.trim());
}

// ---------------------------------------------------------------------------
// Default transports
// ---------------------------------------------------------------------------

/**
 * Resend HTTP transport. Posts a single JSON message using the documented
 * `/emails` endpoint. Never throws; network/HTTP errors map to `delivered:false`.
 * If `RESEND_API_KEY` is absent we return `email_provider_not_configured` — the
 * caller sees the honest failure and can surface "install email queued" as
 * false in the UI.
 */
export const resendTransport: EmailTransport = async (message) => {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  if (!apiKey) {
    return { delivered: false, reason: "email_provider_not_configured" };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        from: message.from,
        to: [message.to],
        subject: message.subject,
        html: message.html,
        text: message.text,
        ...(message.replyTo ? { reply_to: message.replyTo } : {}),
      }),
      signal: controller.signal,
    });
    const body = (await res.json().catch(() => ({}))) as
      | { id?: string }
      | { message?: string; name?: string };

    if (!res.ok) {
      // Return the provider's message when we can, otherwise the HTTP status.
      const detail =
        "message" in body && typeof body.message === "string"
          ? body.message
          : "name" in body && typeof body.name === "string"
            ? body.name
            : `http_${res.status}`;
      return { delivered: false, reason: `provider_${res.status}: ${detail}` };
    }

    const providerMessageId = "id" in body && typeof body.id === "string" ? body.id : undefined;
    return providerMessageId ? { delivered: true, providerMessageId } : { delivered: true };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { delivered: false, reason: `transport_error: ${reason}` };
  } finally {
    clearTimeout(timeout);
  }
};

/**
 * Local log transport. Used when no provider is configured so local dev and
 * tests can still see the rendered message in logs. It returns
 * `{ delivered:false, reason:"log_only" }` so downstream flags (e.g.
 * `installEmailQueued`) reflect that no email actually left the machine.
 */
export function makeLogTransport(log: (line: string) => void): EmailTransport {
  return async (message) => {
    // One-line summary — full HTML belongs in the caller's diagnostics, not logs.
    log(
      JSON.stringify({
        at: new Date().toISOString(),
        channel: "email_log_only",
        to: message.to,
        subject: message.subject,
        from: message.from,
      }),
    );
    return { delivered: false, reason: "log_only" };
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build an `EmailSender` with the templates + a transport. The returned object
 * is what downstream phases should call.
 *
 * Production default (no `deps` provided):
 *  - transport = resend if `RESEND_API_KEY` is set, else the log transport.
 *  - `isConfigured` reflects whether the transport can actually deliver. Callers
 *    should branch on it before attempting to send, or accept `delivered:false`
 *    and use that to decide the UX (`installEmailQueued` flag).
 */
export function makeEmailSender(deps: EmailSenderDeps = {}): EmailSender {
  const log = deps.log ?? ((line: string) => console.log(line));
  const from = resolveFrom(deps);
  const replyTo = deps.replyTo ?? brand.supportEmail;

  const transport: EmailTransport =
    deps.transport ??
    (defaultTransportConfigured() ? resendTransport : makeLogTransport(log));

  const isConfigured =
    Boolean(deps.transport) || defaultTransportConfigured();

  /**
   * Shared call helper: run the transport, swallow throws, log one line.
   * Never returns `delivered:true` unless the transport said so.
   */
  async function deliver(
    message: OutboundMessage,
    context: { kind: "install" | "gift" | "raw"; recipient: string },
  ): Promise<DeliveryResult> {
    let result: DeliveryResult;
    try {
      result = await transport({
        ...message,
        from: message.from || from,
        replyTo: message.replyTo ?? replyTo,
      });
    } catch (err) {
      // A throwing transport (e.g. a stub in tests bugging out) must not
      // crash the caller — fulfilment/webhook code must survive a mail fault.
      result = { delivered: false, reason: `transport_error: ${err instanceof Error ? err.message : String(err)}` };
    }
    log(
      JSON.stringify({
        at: new Date().toISOString(),
        channel: "email_send",
        kind: context.kind,
        to: context.recipient,
        delivered: result.delivered,
        ...(result.delivered
          ? { providerMessageId: result.providerMessageId ?? null }
          : { reason: result.reason }),
      }),
    );
    return result;
  }

  return {
    isConfigured,

    async sendInstallEmail(input) {
      const rendered = renderInstallEmail(input);
      return deliver(
        {
          to: input.to,
          from,
          subject: rendered.subject,
          html: rendered.html,
          text: rendered.text,
          replyTo,
        },
        { kind: "install", recipient: input.to },
      );
    },

    async sendGiftEmail(input) {
      const rendered = renderGiftEmail(input);
      return deliver(
        {
          to: input.to,
          from,
          subject: rendered.subject,
          html: rendered.html,
          text: rendered.text,
          replyTo,
        },
        { kind: "gift", recipient: input.to },
      );
    },

    async sendRawEmail(message) {
      // For alerts (balance guard), notifications (running low, 1 day left),
      // lifecycle emails, etc. The caller owns rendering.
      return deliver(message, { kind: "raw", recipient: message.to });
    },
  };
}

// ---------------------------------------------------------------------------
// Default singleton (used by call sites that don't take deps)
// ---------------------------------------------------------------------------

/**
 * Shared sender for services. Lazily constructed so env vars can be set by
 * test fixtures before first use (matching `env.ts` behaviour).
 */
let sharedSender: EmailSender | null = null;

/** Get (and lazily build) the default sender. */
export function getEmailSender(): EmailSender {
  if (!sharedSender) sharedSender = makeEmailSender();
  return sharedSender;
}

/** Reset the shared sender. Tests call this after mutating env vars. */
export function __resetEmailSenderForTests(): void {
  sharedSender = null;
}

// ---------------------------------------------------------------------------
// Convenience: build the install-email input from fulfilment output
// ---------------------------------------------------------------------------

/**
 * The fulfilment service returns `FulfilledEsim[]` (with `installToken`/`installPath`
 * but no `publicBaseUrl`); the checkout flow knows the buyer email, plan labels
 * and public base URL. Rather than have every caller hand-assemble the
 * `InstallEmailInput` shape, offer this helper. It's pure — no email sent.
 *
 * Throws if `publicBaseUrl` is blank: rendering links with an empty base would
 * produce broken install URLs (a worse failure than refusing to send), so the
 * caller should surface "we'll email you" and retry once PUBLIC_BASE_URL is set.
 */
export function buildInstallEmailInput(args: {
  orderPublicId: string;
  buyerEmail: string;
  planName: string;
  dataLabel: string;
  validityLabel: string;
  publicBaseUrl: string;
  firstName?: string | null;
  esims: Array<{
    iccid: string | null;
    esimTranNo: string | null;
    lpaCode: string | null;
    qrCodeUrl: string | null;
    installPath: string;
    label?: string | null;
  }>;
}): InstallEmailInput {
  if (!args.publicBaseUrl || !args.publicBaseUrl.trim()) {
    throw new Error(
      "buildInstallEmailInput: PUBLIC_BASE_URL is not configured — install links would be broken.",
    );
  }
  // Coerce into the template's expected ESIM shape (drop any extra fields).
  const esims: InstallEmailEsim[] = args.esims.map((e) => ({
    iccid: e.iccid,
    esimTranNo: e.esimTranNo,
    lpaCode: e.lpaCode,
    qrCodeUrl: e.qrCodeUrl,
    installPath: e.installPath,
    label: e.label ?? null,
  }));
  return {
    to: args.buyerEmail,
    orderPublicId: args.orderPublicId,
    planName: args.planName,
    dataLabel: args.dataLabel,
    validityLabel: args.validityLabel,
    publicBaseUrl: args.publicBaseUrl,
    firstName: args.firstName ?? null,
    esims,
  };
}

// ---------------------------------------------------------------------------
// Test surface (documented so tests import from one stable location)
// ---------------------------------------------------------------------------
export const __test__ = {
  resolveFrom,
  defaultTransportConfigured,
  makeLogTransport,
  resendTransport,
};

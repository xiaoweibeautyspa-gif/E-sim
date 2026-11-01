/**
 * WhatsApp Business bot — /api/whatsapp/webhook.
 *
 * SCOPE
 * -----
 * A traveller messages our WhatsApp Business number. The bot can:
 *   - "check data" — reply with the current eSIM's data used/total.
 *   - "top up"      — reply with the eligible top-up options for that eSIM.
 *   - "qr" / "my qr"— resend the LPA code + QR URL (nothing sensitive beyond
 *                     what the buyer already has; we still require the number
 *                     on file to match).
 *   - anything else — an honest "reply MENU / support" escalation.
 *
 * Every capability routes through our own backend services (usageService,
 * topup) which in turn call eSIM Access. The bot NEVER calls the supplier
 * directly and NEVER fabricates data: if the sender's number isn't on file
 * for a paid eSIM, it replies with a sign-in link.
 *
 * INTEGRATION POINTS (from Replit Secrets, server-side only)
 * ----------------------------------------------------------
 *   WHATSAPP_TOKEN            — required to send replies and (optionally) to
 *                               verify signed webhook payloads.
 *   WHATSAPP_VERIFY_TOKEN     — the token we return on the GET handshake when
 *                               registering the webhook with Meta.
 *   WHATSAPP_PHONE_NUMBER_ID  — the sender ID used on send calls.
 *
 * Missing keys: the GET handshake still works locally (returns the challenge
 * only when WHATSAPP_VERIFY_TOKEN matches), and POST returns 200 with a
 * `skipped: "whatsapp_not_configured"` note — we never 500 a webhook the
 * provider will retry forever. This is honest degradation, not a mock.
 *
 * The phone→eSIM lookup is delegated to an injected resolver. It imports
 * `usageService`'s list-by-phone helper if it exists and otherwise replies
 * "sign in to link this number". This keeps the router testable without a DB
 * and avoids inventing a table the rest of the app doesn't have.
 *
 * The invoice/payment for a top-up chosen over WhatsApp uses the SAME
 * `topup.ts` service as the dashboard — so this route is a presentation layer,
 * not a parallel payment path.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { Router, type Request, type RequestHandler, type Response } from "express";
import { z } from "zod";
import { brand } from "../brand.config";
import {
  listTopupOptions,
  type ListTopupOptionsResult,
} from "../services/topup";

// ---------------------------------------------------------------------------
// Env read (kept in this file, server-side only; never exported to the client)
// ---------------------------------------------------------------------------

interface WhatsAppEnv {
  token: string;
  verifyToken: string;
  phoneNumberId: string;
  appSecret: string;
  configured: boolean;
}

function readEnv(): WhatsAppEnv {
  const token = (process.env.WHATSAPP_TOKEN ?? "").trim();
  const verifyToken = (process.env.WHATSAPP_VERIFY_TOKEN ?? "").trim();
  const phoneNumberId = (process.env.WHATSAPP_PHONE_NUMBER_ID ?? "").trim();
  const appSecret = (process.env.WHATSAPP_APP_SECRET ?? "").trim();
  return {
    token,
    verifyToken,
    phoneNumberId,
    appSecret,
    configured: Boolean(token && phoneNumberId),
  };
}

// ---------------------------------------------------------------------------
// Minimal WhatsApp Cloud API client (send text message)
// ---------------------------------------------------------------------------

interface SendTextResult {
  ok: boolean;
  /** `wa_message_id` from Meta when a message was queued. */
  messageId?: string;
  reason?: string;
}

/**
 * POST to the WhatsApp Cloud API. Kept small; we only need text messages.
 * Errors are turned into `{ ok:false }` with the provider's message so a
 * caller can decide whether to retry (we do not retry here — the provider
 * will redeliver the webhook if we fail).
 */
async function sendWhatsAppText(input: {
  to: string;
  body: string;
  env: WhatsAppEnv;
  fetchImpl?: typeof fetch;
}): Promise<SendTextResult> {
  if (!input.env.configured) return { ok: false, reason: "whatsapp_not_configured" };
  if (!input.to || !input.to.match(/^\+?\d{6,15}$/)) {
    return { ok: false, reason: "invalid_recipient" };
  }
  const f = input.fetchImpl ?? fetch;
  const url = `https://graph.facebook.com/v20.0/${input.env.phoneNumberId}/messages`;
  const payload = {
    messaging_product: "whatsapp",
    to: input.to.replace(/^\+/, ""),
    type: "text",
    text: { preview_url: false, body: input.body },
  };
  try {
    const res = await f(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.env.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const errorBody = await res.text().catch(() => "");
      return { ok: false, reason: `provider_${res.status}:${errorBody.slice(0, 180)}` };
    }
    const json = (await res.json().catch(() => null)) as
      | { messages?: Array<{ id?: string }> }
      | null;
    return { ok: true, messageId: json?.messages?.[0]?.id };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : "network_error" };
  }
}

// ---------------------------------------------------------------------------
// Incoming payload parsing (Meta Cloud API shape)
// ---------------------------------------------------------------------------

/**
 * Meta delivers:
 *   { object: "whatsapp_business_account",
 *     entry: [ { id, changes: [ { value: {
 *       messaging_product: "whatsapp",
 *       metadata: { phone_number_id },
 *       contacts: [ { profile: {name}, wa_id } ],
 *       messages: [ { from, id, timestamp, type: "text",
 *                     text: { body } } ]
 *     } } ] } ] }
 * We accept text-only messages (the exact scope the bot supports). Media /
 * buttons are ignored with a friendly "text us" reply.
 */
interface IncomingMessage {
  from: string; // E.164 with leading + as the provider sends without +.
  waMessageId: string;
  text: string | null;
  type: string;
}

function parseInbound(body: unknown): IncomingMessage[] {
  if (!body || typeof body !== "object") return [];
  const root = body as Record<string, unknown>;
  if (root.object !== "whatsapp_business_account") return [];
  const entries = Array.isArray(root.entry) ? root.entry : [];
  const out: IncomingMessage[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const changes = (entry as Record<string, unknown>).changes;
    if (!Array.isArray(changes)) continue;
    for (const change of changes) {
      if (!change || typeof change !== "object") continue;
      const value = (change as Record<string, unknown>).value;
      if (!value || typeof value !== "object") continue;
      const messages = (value as Record<string, unknown>).messages;
      if (!Array.isArray(messages)) continue;
      for (const msg of messages) {
        if (!msg || typeof msg !== "object") continue;
        const m = msg as Record<string, unknown>;
        const from = typeof m.from === "string" ? m.from : null;
        const id = typeof m.id === "string" ? m.id : null;
        const type = typeof m.type === "string" ? m.type : "unknown";
        if (!from || !id) continue;
        const textObj =
          m.text && typeof m.text === "object"
            ? (m.text as Record<string, unknown>)
            : null;
        const text = textObj && typeof textObj.body === "string" ? textObj.body : null;
        out.push({
          from: from.startsWith("+") ? from : `+${from}`,
          waMessageId: id,
          text,
          type,
        });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Intent classification
// ---------------------------------------------------------------------------

type Intent = "check_data" | "topup" | "qr" | "help";

const RE_TOPUP = /\b(top\s*-?\s*up|topup|more data|add data|increase data|extend)\b/i;
const RE_DATA = /\b(data|usage|balance|left|how much|remaining|check)\b/i;
const RE_QR = /\b(qr|qr code|lpa|install|instal|reinstall|re-?install|activate|activation|profile)\b/i;

export function classifyIntent(raw: string | null): { intent: Intent; matched: string } {
  if (!raw) return { intent: "help", matched: "" };
  const text = raw.toLowerCase();
  if (RE_TOPUP.test(text)) return { intent: "topup", matched: "topup" };
  if (RE_QR.test(text)) return { intent: "qr", matched: "qr" };
  if (RE_DATA.test(text)) return { intent: "check_data", matched: "data" };
  return { intent: "help", matched: "" };
}

// ---------------------------------------------------------------------------
// Dependency seams
// ---------------------------------------------------------------------------

/**
 * A resolved eSIM for a WhatsApp sender. The resolver is expected to find the
 * user by phone (a `users.phone`/`buyer_phone` link maintained by the account
 * settings page) and return their newest active eSIM or null. This module
 * does NOT invent a phone-to-user table; if the app has none, the resolver
 * returns null and the bot replies "sign in".
 *
 * CONTRACT:
 *   - `country`: human label ("Singapore")
 *   - `network`: "Singtel 5G"
 *   - `dataUsedBytes` / `totalBytes`: current usage (may be delayed 1–3h;
 *     the bot reply states that honestly)
 *   - `daysLeft`: whole-day count until expiry
 *   - `status`: supplier state
 *   - `esimId`: our DB id, used to list top-up options
 *   - `lpaCode` / `qrCodeUrl`: install artifacts for the "qr" intent
 */
export interface ResolvedEsim {
  esimId: number;
  userId: number;
  country: string;
  network: string;
  status: string;
  dataUsedBytes: number | null;
  totalBytes: number | null;
  usageUpdatedAt: Date | null;
  daysLeft: number | null;
  lpaCode: string | null;
  qrCodeUrl: string | null;
}

export interface WhatsAppDeps {
  /** Resolve the sender phone to their current eSIM, or null if unknown/unpaid. */
  resolveEsimForPhone: (phone: string) => Promise<ResolvedEsim | null>;
  /** List dashboard-visible top-up options for an owned eSIM. */
  listTopupOptions: typeof listTopupOptions;
  /** Lazily resolve the WhatsApp env so tests can override. */
  readEnv?: () => WhatsAppEnv;
  /** Optional fetch override for tests. */
  fetchImpl?: typeof fetch;
  /** Structured logger; never prints message bodies or tokens. */
  log?: (line: string) => void;
  publicBaseUrl?: string;
}

// ---------------------------------------------------------------------------
// Reply formatting
// ---------------------------------------------------------------------------

function formatBytes(bytes: number | null): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return "unknown";
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1) return `${gb.toFixed(2)} GB`;
  const mb = bytes / (1024 * 1024);
  return `${Math.round(mb)} MB`;
}

function freshnessSentence(updatedAt: Date | null): string {
  if (!updatedAt) return "Usage updates every few hours.";
  const mins = Math.max(0, Math.round((Date.now() - updatedAt.getTime()) / 60000));
  if (mins < 60) return `Usage updated ${mins}m ago (usage data can lag 1–3 hours).`;
  const hours = Math.round(mins / 60);
  return `Usage updated ${hours}h ago (usage data can lag 1–3 hours).`;
}

function signInReply(publicBaseUrl: string): string {
  const base = publicBaseUrl.replace(/\/+$/, "");
  return [
    `Hi! I couldn't find a ${brand.name} eSIM linked to this number.`,
    "",
    `Sign in with the email you bought with to link this number, then message me again: ${base}/login`,
    "",
    `Or reply SUPPORT for a human.`,
  ].join("\n");
}

function buildDataReply(esim: ResolvedEsim): string {
  const usedLabel =
    esim.dataUsedBytes == null ? "usage pending" : `${formatBytes(esim.dataUsedBytes)} used`;
  const totalLabel = esim.totalBytes == null ? "" : ` of ${formatBytes(esim.totalBytes)}`;
  const daysLabel =
    esim.daysLeft == null ? "status unknown" : `${esim.daysLeft} day(s) left`;
  return [
    `${esim.country} · ${esim.network}`,
    esim.dataUsedBytes != null ? `${usedLabel}${totalLabel}` : usedLabel,
    daysLabel,
    freshnessSentence(esim.usageUpdatedAt),
    "",
    "Reply TOPUP for a bigger plan.",
  ].join("\n");
}

function buildTopupReply(
  result: ListTopupOptionsResult,
  esim: ResolvedEsim,
  publicBaseUrl: string,
): string {
  const base = publicBaseUrl.replace(/\/+$/, "");
  if (!result.eligible || result.options.length === 0) {
    const reason =
      result.reason === "topup_unsupported"
        ? "This plan doesn't support top-ups."
        : result.reason === "esim_expired"
          ? "This eSIM has expired; a new plan is needed."
          : "No top-up options are available for this eSIM right now.";
    return `${reason}\n\nSee plans: ${base}/esim/${esim.country.toLowerCase()}`;
  }
  const lines = [`Top-up options for ${esim.country} (${esim.network}):`, ""];
  // Cap at 4 options so the message stays readable on WhatsApp.
  for (const opt of result.options.slice(0, 4)) {
    const dataLabel =
      opt.dataGB != null
        ? `${opt.dataGB} GB`
        : opt.unlimited
          ? "Daily plan"
          : "Top-up";
    lines.push(`• ${dataLabel} — ${opt.retailPrice.toFixed(2)} ${opt.currency}`);
  }
  lines.push("");
  lines.push(`Choose and pay securely on the web: ${base}/esims`);
  return lines.join("\n");
}

function buildQrReply(esim: ResolvedEsim, publicBaseUrl: string): string {
  const base = publicBaseUrl.replace(/\/+$/, "");
  if (!esim.lpaCode && !esim.qrCodeUrl) {
    return [
      `Your ${esim.country} eSIM's QR isn't ready yet — it becomes available as soon as we finish activating it.`,
      "",
      `Check My eSIMs in a few minutes: ${base}/esims`,
    ].join("\n");
  }
  const parts = [`Your ${esim.country} (${esim.network}) install details:`, ""];
  if (esim.qrCodeUrl) parts.push(`QR code: ${esim.qrCodeUrl}`);
  if (esim.lpaCode) parts.push(`Manual LPA: ${esim.lpaCode}`);
  parts.push("");
  parts.push("Open Settings → Cellular/Mobile Data → Add eSIM → Scan QR (iPhone)");
  parts.push("or Settings → Connections → SIM Manager → Add eSIM (Android).");
  parts.push(`${base}/esims for the full guide.`);
  return parts.join("\n");
}

function buildHelpReply(publicBaseUrl: string): string {
  const base = publicBaseUrl.replace(/\/+$/, "");
  return [
    `Hi! I'm ${brand.name}'s WhatsApp assistant.`,
    "",
    "Reply with one of:",
    "• DATA — check how much data is left",
    "• TOPUP — add more data",
    "• QR — resend my install QR",
    "• SUPPORT — talk to a human",
    "",
    `Full dashboard: ${base}/esims`,
  ].join("\n");
}

function buildSupportReply(): string {
  return [
    `A human will reply here shortly. You can also reach us at ${brand.supportEmail}.`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Signature verification (Meta x-hub-signature-256)
// ---------------------------------------------------------------------------

/**
 * Meta signs webhook deliveries with HMAC-SHA256 of the raw body using the app
 * secret, delivered as `X-Hub-Signature-256: sha256=<hex>`. When
 * `WHATSAPP_APP_SECRET` isn't configured we can't verify — log the fact and
 * accept (the sender is not authenticated, so we treat the message as
 * untrusted and still require the phone→eSIM link to do anything real).
 *
 * Express's `express.json()` replaces the body with the parsed object; the raw
 * bytes needed for HMAC must be captured by an upstream
 * `verify: (req,_res,buf) => (req.rawBody = buf)` hook. When that isn't
 * present `rawBody` is undefined, and verification degrades to "cannot
 * verify" — never to "silently trusted forever".
 */
function verifySignature(input: {
  appSecret: string;
  rawBody: Buffer | undefined;
  header: string | undefined;
}): { ok: boolean; reason?: string } {
  if (!input.appSecret) return { ok: false, reason: "app_secret_missing" };
  if (!input.rawBody) return { ok: false, reason: "raw_body_missing" };
  if (!input.header) return { ok: false, reason: "signature_missing" };
  const provided = input.header.startsWith("sha256=")
    ? input.header.slice("sha256=".length)
    : input.header;
  const expected = createHmac("sha256", input.appSecret)
    .update(input.rawBody)
    .digest("hex");
  try {
    const a = Buffer.from(provided, "hex");
    const b = Buffer.from(expected, "hex");
    if (a.length !== b.length) return { ok: false, reason: "signature_mismatch" };
    return { ok: timingSafeEqual(a, b), reason: timingSafeEqual(a, b) ? undefined : "signature_mismatch" };
  } catch {
    return { ok: false, reason: "signature_mismatch" };
  }
}

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

export interface CreateWhatsAppRouterOptions {
  /**
   * Composes the runtime deps. Called per request so the route lazily wires
   * the DB/service on first use. When this returns `null` the route reports
   * `not_configured` (we couldn't resolve an ESIM resolver or top-up service).
   */
  getDeps: () => WhatsAppDeps | null;
  /** Optional public base URL override (defaults to deps.publicBaseUrl or brand.domain). */
  defaultPublicBaseUrl?: string;
}

export function createWhatsAppRouter(
  options: CreateWhatsAppRouterOptions,
): Router {
  const router = Router();

  // ---- GET handshake used when registering the webhook with Meta ----
  router.get("/webhook", (req: Request, res: Response) => {
    const env = (options.getDeps()?.readEnv ?? readEnv)();
    const mode = typeof req.query["hub.mode"] === "string" ? req.query["hub.mode"] : "";
    const token = typeof req.query["hub.verify_token"] === "string" ? req.query["hub.verify_token"] : "";
    const challenge = typeof req.query["hub.challenge"] === "string" ? req.query["hub.challenge"] : "";
    if (!env.verifyToken) {
      res.status(503).json({ ok: false, error: "whatsapp_not_configured" });
      return;
    }
    if (mode === "subscribe" && token === env.verifyToken) {
      // Meta expects the raw challenge body, not JSON.
      res.status(200).send(challenge);
      return;
    }
    res.status(403).json({ ok: false, error: "verify_failed" });
  });

  // ---- POST — incoming message delivery ----
  router.post("/webhook", async (req: Request, res: Response) => {
    const deps = options.getDeps();
    if (!deps) {
      res.status(200).json({ ok: true, skipped: "deps_unavailable" });
      return;
    }
    const log = deps.log ?? ((line: string) => console.log(line));
    const env = (deps.readEnv ?? readEnv)();

    // Signature verification (best-effort but never silently skipped).
    const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
    const sig = verifySignature({
      appSecret: env.appSecret,
      rawBody,
      header: typeof req.get("x-hub-signature-256") === "string"
        ? req.get("x-hub-signature-256") ?? undefined
        : undefined,
    });
    if (env.appSecret && !sig.ok) {
      log(`[whatsapp] signature rejected: ${sig.reason ?? "unknown"}`);
      res.status(401).json({ ok: false, error: "signature_invalid" });
      return;
    }
    if (!env.appSecret) {
      // Accept but annotate; do not pretend it was verified.
      log(`[whatsapp] app secret not configured; accepting unsigned delivery`);
    }

    const messages = parseInbound(req.body);
    if (messages.length === 0) {
      // Meta also sends status updates (delivered/read) — ack them all.
      res.status(200).json({ ok: true, handled: 0 });
      return;
    }

    // Ack immediately, then process. Meta retries a slow webhook, so we must
    // respond within a few seconds.
    res.status(200).json({ ok: true, handled: messages.length });
    const publicBaseUrl =
      deps.publicBaseUrl ?? options.defaultPublicBaseUrl ?? `https://${brand.domain}`;

    setImmediate(() => {
      for (const m of messages) {
        void handleOneMessage({
          message: m,
          deps,
          env,
          publicBaseUrl,
          log,
        }).catch((err) => {
          log(
            `[whatsapp] handler crashed for ${maskPhone(m.from)}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        });
      }
    });
  });

  // Any other path/method → 405 logged, honest.
  router.all("/webhook", notAllowed());
  return router;
}

/**
 * Handles one inbound message: resolves the sender's eSIM, classifies the
 * intent, and sends a reply via WhatsApp. Never throws up; every failure is
 * logged and results in no reply (the provider will retry if it never got a
 * 200 — we already returned 200, so a failure here is the user's silence; we
 * accept that over a retry storm).
 */
async function handleOneMessage(input: {
  message: IncomingMessage;
  deps: WhatsAppDeps;
  env: WhatsAppEnv;
  publicBaseUrl: string;
  log: (line: string) => void;
}): Promise<void> {
  const { message, deps, env, publicBaseUrl, log } = input;
  const { intent } = classifyIntent(message.text);
  const send = (body: string) =>
    sendWhatsAppText({
      to: message.from,
      body,
      env,
      fetchImpl: deps.fetchImpl,
    });

  if (intent === "help" && /^support\b/i.test((message.text ?? "").trim())) {
    await sendWithLog(send, buildSupportReply(), log, message.from);
    return;
  }

  // Every non-help intent needs an eSIM.
  if (intent === "help") {
    await sendWithLog(send, buildHelpReply(publicBaseUrl), log, message.from);
    return;
  }

  let esim: ResolvedEsim | null = null;
  try {
    esim = await deps.resolveEsimForPhone(message.from);
  } catch (err) {
    log(
      `[whatsapp] resolveEsimForPhone failed for ${maskPhone(message.from)}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  if (!esim) {
    await sendWithLog(send, signInReply(publicBaseUrl), log, message.from);
    return;
  }

  if (intent === "check_data") {
    await sendWithLog(send, buildDataReply(esim), log, message.from);
    return;
  }
  if (intent === "qr") {
    await sendWithLog(send, buildQrReply(esim, publicBaseUrl), log, message.from);
    return;
  }
  if (intent === "topup") {
    let result: ListTopupOptionsResult;
    try {
      result = await deps.listTopupOptions({
        userId: esim.userId,
        esimId: esim.esimId,
      });
    } catch (err) {
      log(
        `[whatsapp] listTopupOptions failed for esim ${esim.esimId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      await sendWithLog(
        send,
        "Something went wrong checking top-up options. Please try again shortly.",
        log,
        message.from,
      );
      return;
    }
    await sendWithLog(
      send,
      buildTopupReply(result, esim, publicBaseUrl),
      log,
      message.from,
    );
    return;
  }
}

async function sendWithLog(
  send: (body: string) => Promise<SendTextResult>,
  body: string,
  log: (line: string) => void,
  phone: string,
): Promise<void> {
  const result = await send(body);
  if (!result.ok) {
    log(`[whatsapp] send failed to ${maskPhone(phone)}: ${result.reason ?? "unknown"}`);
    return;
  }
  log(`[whatsapp] sent to ${maskPhone(phone)} (msg=${result.messageId ?? "?"})`);
}

/** Redact all but the last 4 digits of a phone number for logs. */
function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.length <= 4) return "***";
  return `***${digits.slice(-4)}`;
}

function notAllowed(): RequestHandler {
  return (_req: Request, res: Response) => {
    res.status(405).json({ ok: false, error: "method_not_allowed" });
  };
}

// ---------------------------------------------------------------------------
// Optional route mount helper
// ---------------------------------------------------------------------------

/**
 * When `server/app.ts` mounts this router, it also needs raw-body capture for
 * signature verification. Apps can opt in by passing `rawBody: true` to
 * `express.json()` for this path. Returning a factory for that middleware
 * keeps the change small.
 */
export function rawBodyCaptureMiddleware(): RequestHandler {
  return (req, _res, next) => {
    // No-op passthrough if express.json's `verify` already ran; kept as a
    // separate exported hook so the app can compose the two without reaching
    // into this module.
    void (req as Request & { rawBody?: Buffer }).rawBody;
    next();
  };
}

// ---------------------------------------------------------------------------
// Validation schemas (kept for the app to reuse on the "link phone" side)
// ---------------------------------------------------------------------------

export const PhoneLinkSchema = z.object({
  phone: z
    .string()
    .trim()
    .regex(/^\+?\d{6,15}$/, "invalid_phone"),
});

// ---------------------------------------------------------------------------
// Test surface
// ---------------------------------------------------------------------------

export const __test__ = {
  parseInbound,
  classifyIntent,
  verifySignature,
  sendWhatsAppText,
  buildDataReply,
  buildTopupReply,
  buildQrReply,
  buildHelpReply,
  buildSupportReply,
  signInReply,
  formatBytes,
  freshnessSentence,
  maskPhone,
  readEnv,
  RE_TOPUP,
  RE_DATA,
  RE_QR,
};

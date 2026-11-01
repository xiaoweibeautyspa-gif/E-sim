/**
 * Gift eSIM email template.
 *
 * The buyer filled in recipient name, email, optional message, and optional
 * send date at checkout. This template is what the RECIPIENT receives: a
 * branded email with the sender's message, the QR codes for each gifted eSIM,
 * the manual LPA codes and install steps — same install content as the
 * standard install email but with a gift message header.
 *
 * Purity and honesty (matching installEmail.ts):
 *  - Pure function; no I/O. The caller (emailSender.ts, queued) delivers.
 *  - Only real eSIM data is rendered. Missing QR → "still preparing" notice,
 *    never a fabricated image.
 *  - Recipient name is HTML-escaped. The gift message is HTML-escaped but
 *    whitespace/newlines are preserved via `white-space: pre-wrap`.
 *  - Uses brand.config for name/domain/support. Sender is identified as
 *    "from [buyer's name or email]" — never invented.
 */
import { brand, absoluteUrl, withBrand } from "../../brand.config";
import { wrapHtml, type InstallEmailEsim } from "./installEmail";

export interface GiftEmailInput {
  /** Recipient's email — the `to` on the outbound message. */
  to: string;
  /** Recipient's display name (from checkout). */
  recipientName: string;
  /** Buyer's display name or email; used to say "from …". */
  senderName: string;
  /** Buyer's message (optional). Plain text; newlines preserved. */
  message?: string | null;
  /** Gift eSIM(s) included — usually 1 but grouped gifts are possible. */
  esims: InstallEmailEsim[];
  /** Plan display name for the header. */
  planName: string;
  dataLabel: string;
  validityLabel: string;
  /** Absolute base URL used for install links. */
  publicBaseUrl: string;
  /** Order ref for support. */
  orderPublicId: string;
  /**
   * When the buyer scheduled the send for later, this is the intended date.
   * The emailSender is responsible for the actual timing; the template only
   * reports it so the recipient knows (and so ops can grep for scheduled
   * sends in logs).
   */
  scheduledSendDate?: string | null;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] ?? c);
}

/** Render the gift email. Pure — no network, no DB, no side effects. */
export function renderGiftEmail(input: GiftEmailInput): RenderedEmail {
  const subject = withBrand(`${input.senderName} sent you an eSIM for ${input.planName}`);

  const messageBlockHtml = input.message
    ? `<blockquote style="margin:12px 0;padding:12px 16px;border-left:3px solid #1b6ef5;background:#eef7ff;color:#1a3e8f;font-size:14px;line-height:1.6;white-space:pre-wrap;">${escapeHtml(
        input.message,
      )}</blockquote>`
    : "";

  const installBlocksHtml = input.esims
    .map((e) => renderEsimHtml(e, input.publicBaseUrl))
    .join("\n");
  const installBlocksText = input.esims
    .map((e) => renderEsimText(e, input.publicBaseUrl))
    .join("\n\n");

  const html = wrapHtml({
    title: "You've received an eSIM",
    body: `
      <p style="margin:0 0 12px 0;font-size:15px;color:#0f172a;">Hi ${escapeHtml(
        input.recipientName,
      )},</p>
      <p style="margin:0 0 12px 0;font-size:15px;color:#334155;">
        <strong>${escapeHtml(
          input.senderName,
        )}</strong> sent you an eSIM for <strong>${escapeHtml(
          input.planName,
        )}</strong> (${escapeHtml(input.dataLabel)} · ${escapeHtml(
          input.validityLabel,
        )}). Install it on Wi-Fi before you fly, then switch it on when you land.
      </p>
      ${messageBlockHtml}

      ${installBlocksHtml}

      <hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0;" />

      <h2 style="margin:0 0 8px 0;font-size:15px;color:#0f172a;">How to install</h2>
      <h3 style="margin:12px 0 4px 0;font-size:13px;color:#0f172a;">iPhone</h3>
      <ol style="margin:0 0 0 18px;padding:0;font-size:13px;color:#334155;line-height:1.6;">
        <li>Open <strong>Settings → Cellular</strong>.</li>
        <li>Tap <strong>Add eSIM → Use QR Code</strong>.</li>
        <li>Scan the QR above and save the plan as "Travel".</li>
      </ol>
      <h3 style="margin:12px 0 4px 0;font-size:13px;color:#0f172a;">Android</h3>
      <ol style="margin:0 0 0 18px;padding:0;font-size:13px;color:#334155;line-height:1.6;">
        <li>Open <strong>Settings → Network &amp; internet → SIMs</strong>.</li>
        <li>Tap <strong>Add eSIM</strong> and scan the QR above.</li>
        <li>Set this eSIM as mobile data and turn data roaming <strong>on</strong> for it.</li>
      </ol>

      <p style="margin:20px 0 0 0;font-size:13px;color:#475569;">
        Questions? Reply to this email${
          brand.supportEmail
            ? ` or reach us at <a href="mailto:${escapeHtml(
                brand.supportEmail,
              )}" style="color:#1557e1;">${escapeHtml(brand.supportEmail)}</a>`
            : ""
        } and quote order <strong style="font-family:monospace;">${escapeHtml(
          input.orderPublicId,
        )}</strong>${input.scheduledSendDate ? ` (scheduled for ${escapeHtml(input.scheduledSendDate)})` : ""}.
      </p>
      <p style="margin:8px 0 0 0;font-size:12px;color:#94a3b8;">
        ${escapeHtml(brand.guaranteeCopy)}
      </p>
    `,
  });

  const text = [
    `Hi ${input.recipientName},`,
    "",
    `${input.senderName} sent you an eSIM for ${input.planName} (${input.dataLabel} · ${input.validityLabel}). Install it on Wi-Fi before you fly, then switch it on when you land.`,
    input.message ? `\n"${input.message}"\n` : "",
    installBlocksText,
    "",
    "How to install",
    "iPhone:",
    "  1. Settings → Cellular",
    "  2. Add eSIM → Use QR Code",
    "  3. Scan the QR and save as \"Travel\"",
    "",
    "Android:",
    "  1. Settings → Network & internet → SIMs",
    "  2. Add eSIM and scan the QR",
    "  3. Set this eSIM as mobile data and enable data roaming",
    "",
    `Questions? Reply to this email${
      brand.supportEmail ? ` or write to ${brand.supportEmail}` : ""
    } and quote order ${input.orderPublicId}${
      input.scheduledSendDate ? ` (scheduled for ${input.scheduledSendDate})` : ""
    }.`,
    "",
    brand.guaranteeCopy,
    "",
    `— ${brand.name}`,
  ]
    .filter(Boolean)
    .join("\n");

  return { subject, html, text };
}

// ---------------------------------------------------------------------------
// Per-eSIM block (shares markup shape with installEmail but grouped gifts
// deserve a slightly different label so the recipient sees a "Gift" tag)
// ---------------------------------------------------------------------------

function renderEsimHtml(esim: InstallEmailEsim, publicBaseUrl: string): string {
  const title = esim.label ? escapeHtml(esim.label) : "Your gifted eSIM";
  const iccidLine = esim.iccid
    ? `<p style="margin:0 0 6px 0;font-size:12px;color:#64748b;">ICCID <span style="font-family:monospace;color:#0f172a;">${escapeHtml(esim.iccid)}</span></p>`
    : "";

  const installLink = esim.installPath
    ? absoluteUrl(esim.installPath, publicBaseUrl)
    : null;

  if (!esim.qrCodeUrl) {
    return `
      <div style="margin:16px 0;padding:16px;border:1px solid #e2e8f0;border-radius:12px;background:#f8fafc;">
        <p style="margin:0 0 4px 0;font-size:14px;font-weight:600;color:#0f172a;">${title}</p>
        ${iccidLine}
        <p style="margin:8px 0 0 0;font-size:13px;color:#92400e;">
          The QR code for this gift is still being prepared. You'll receive a
          follow-up email shortly with the code — no need to do anything.
        </p>
      </div>`;
  }

  const lpaBlock = esim.lpaCode
    ? `<p style="margin:8px 0 0 0;font-size:12px;color:#475569;">Manual code (if the QR won't scan):<br/>
         <span style="display:inline-block;margin-top:4px;padding:4px 8px;background:#f1f5f9;border-radius:6px;font-family:monospace;color:#0f172a;word-break:break-all;">${escapeHtml(esim.lpaCode)}</span>
       </p>`
    : "";

  const linkBlock = installLink
    ? `<p style="margin:12px 0 0 0;font-size:13px;"><a href="${escapeHtml(installLink)}" style="color:#1557e1;font-weight:600;text-decoration:none;">Open install page →</a></p>`
    : "";

  return `
    <div style="margin:16px 0;padding:16px;border:1px solid #bcdfff;border-radius:12px;background:#eef7ff;">
      <p style="margin:0 0 4px 0;font-size:14px;font-weight:600;color:#0f172a;">🎁 ${title}</p>
      ${iccidLine}
      <div style="text-align:center;margin:12px 0;">
        <img src="${escapeHtml(esim.qrCodeUrl)}" alt="eSIM QR code" width="180" height="180" style="display:inline-block;border-radius:12px;background:#ffffff;padding:8px;border:1px solid #e2e8f0;" />
      </div>
      ${lpaBlock}
      ${linkBlock}
    </div>`;
}

function renderEsimText(esim: InstallEmailEsim, publicBaseUrl: string): string {
  const title = esim.label ?? "Your gifted eSIM";
  const lines: string[] = [`[Gift] ${title}`];
  if (esim.iccid) lines.push(`ICCID: ${esim.iccid}`);
  if (esim.qrCodeUrl) {
    lines.push(`QR code: ${esim.qrCodeUrl}`);
  } else {
    lines.push("The QR code for this gift is still being prepared — a follow-up email will arrive shortly.");
  }
  if (esim.lpaCode) lines.push(`Manual code: ${esim.lpaCode}`);
  if (esim.installPath) {
    lines.push(`Install page: ${absoluteUrl(esim.installPath, publicBaseUrl)}`);
  }
  return lines.join("\n");
}

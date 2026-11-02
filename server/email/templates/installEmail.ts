/**
 * Install-guide email template.
 *
 * Purpose: the buyer (or the recipient of a gift, which uses giftEmail.ts) gets
 * a branded email with — per eSIM — the QR image, the manual LPA code, and
 * iPhone + Android install steps. Group orders include every eSIM.
 *
 * Design constraints:
 *  - This is a PURE function: `render()` returns subject/html/text with no I/O.
 *    The caller (`server/lib/emailSender.ts`, queued) attaches these to a
 *    transport. We never send mail here, so this batch cannot pretend an email
 *    was delivered.
 *  - Only real eSIM data is rendered. If the QR URL is missing, we show the
 *    "awaiting" copy — we never generate a fake QR for a code we don't have.
 *  - The plain-text version is produced alongside HTML so deliverability +
 *    screen readers are covered.
 *  - Uses brand.name / brand.domain from brand.config.ts, so a rename is one
 *    file. Mail clients strip some CSS; we keep styling inline.
 */
import { brand, absoluteUrl, withBrand } from "../../brand.config";

export interface InstallEmailEsim {
  iccid: string | null;
  esimTranNo: string | null;
  lpaCode: string | null;
  qrCodeUrl: string | null;
  /** Path like "/install/abc123" — rendered as an absolute link. */
  installPath: string;
  /** Optional label for grouped orders ("eSIM 1", "eSIM 2", ...). */
  label?: string | null;
}

export interface InstallEmailInput {
  /** Buyer email — the recipient of an install email that isn't a gift. */
  to: string;
  /** Human-facing order ref for support ("ord_abc123"). */
  orderPublicId: string;
  /** Plan display name for the header ("Singapore 5GB / 30 days"). */
  planName: string;
  dataLabel: string;
  validityLabel: string;
  esims: InstallEmailEsim[];
  /** Absolute base URL (from PUBLIC_BASE_URL); required to render install links. */
  publicBaseUrl: string;
  /** Buyer's given name if known — used as a friendly greeting. */
  firstName?: string | null;
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

/** Render the install email. Pure — no network, no DB, no side effects. */
export function renderInstallEmail(input: InstallEmailInput): RenderedEmail {
  const greeting = input.firstName
    ? `Hi ${input.firstName},`
    : `Hi there,`;

  const subject = withBrand(`{brand}: your eSIM for ${input.planName} is ready`);

  const installBlocksHtml = input.esims.map((e) => renderEsimHtml(e, input.publicBaseUrl)).join("\n");
  const installBlocksText = input.esims.map((e) => renderEsimText(e, input.publicBaseUrl)).join("\n\n");

  const html = wrapHtml({
    title: "Your eSIM is ready",
    body: `
      <p style="margin:0 0 12px 0;font-size:15px;color:#0f172a;">${escapeHtml(greeting)}</p>
      <p style="margin:0 0 16px 0;font-size:15px;color:#334155;">
        Your eSIM for <strong>${escapeHtml(input.planName)}</strong>
        (${escapeHtml(input.dataLabel)} · ${escapeHtml(input.validityLabel)})
        is ready to install. Install it now on Wi-Fi and switch it on when you
        land.
      </p>

      ${installBlocksHtml}

      <hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0;" />

      <h2 style="margin:0 0 8px 0;font-size:15px;color:#0f172a;">How to install</h2>
      <h3 style="margin:12px 0 4px 0;font-size:13px;color:#0f172a;">iPhone</h3>
      <ol style="margin:0 0 0 18px;padding:0;font-size:13px;color:#334155;line-height:1.6;">
        <li>Open <strong>Settings → Cellular</strong> (or Mobile Data).</li>
        <li>Tap <strong>Add eSIM → Use QR Code</strong>.</li>
        <li>Scan the QR above and save the plan as "Travel".</li>
        <li>Leave mobile data on your home SIM until you land, then switch it.</li>
      </ol>
      <h3 style="margin:12px 0 4px 0;font-size:13px;color:#0f172a;">Android</h3>
      <ol style="margin:0 0 0 18px;padding:0;font-size:13px;color:#334155;line-height:1.6;">
        <li>Open <strong>Settings → Network &amp; internet → SIMs</strong>.</li>
        <li>Tap <strong>Add eSIM</strong> (or "Download a SIM instead").</li>
        <li>Scan the QR above to download the profile.</li>
        <li>Set this eSIM as the mobile-data SIM and turn data roaming <strong>on</strong> for it.</li>
      </ol>

      <p style="margin:20px 0 0 0;font-size:13px;color:#475569;">
        Need a hand? Reply to this email
        ${brand.supportEmail ? `or reach us at <a href="mailto:${escapeHtml(brand.supportEmail)}" style="color:#1557e1;">${escapeHtml(brand.supportEmail)}</a>` : ""}
        and quote order <strong style="font-family:monospace;">${escapeHtml(input.orderPublicId)}</strong>.
      </p>
      <p style="margin:8px 0 0 0;font-size:12px;color:#94a3b8;">
        ${escapeHtml(brand.guaranteeCopy)}
      </p>
    `,
  });

  const text = [
    greeting,
    "",
    `Your eSIM for ${input.planName} (${input.dataLabel} · ${input.validityLabel}) is ready to install. Install it now on Wi-Fi and switch it on when you land.`,
    "",
    installBlocksText,
    "",
    "How to install",
    "iPhone:",
    "  1. Settings → Cellular (or Mobile Data)",
    "  2. Add eSIM → Use QR Code",
    "  3. Scan the QR and save the plan as \"Travel\"",
    "",
    "Android:",
    "  1. Settings → Network & internet → SIMs",
    "  2. Add eSIM (or \"Download a SIM instead\")",
    "  3. Scan the QR; then set this eSIM as mobile data and enable data roaming",
    "",
    `Need a hand? Reply to this email${brand.supportEmail ? ` or write to ${brand.supportEmail}` : ""} and quote order ${input.orderPublicId}.`,
    "",
    brand.guaranteeCopy,
    "",
    `— ${brand.name}`,
  ].join("\n");

  return { subject, html, text };
}

// ---------------------------------------------------------------------------
// Per-eSIM block
// ---------------------------------------------------------------------------

function renderEsimHtml(esim: InstallEmailEsim, publicBaseUrl: string): string {
  const title = esim.label ? escapeHtml(esim.label) : "Your eSIM";
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
          We're still preparing the QR code for this eSIM. It will arrive in a
          follow-up email within a couple of minutes — usually it's instant.
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
    <div style="margin:16px 0;padding:16px;border:1px solid #e2e8f0;border-radius:12px;background:#ffffff;">
      <p style="margin:0 0 4px 0;font-size:14px;font-weight:600;color:#0f172a;">${title}</p>
      ${iccidLine}
      <div style="text-align:center;margin:12px 0;">
        <img src="${escapeHtml(esim.qrCodeUrl)}" alt="eSIM QR code" width="180" height="180" style="display:inline-block;border-radius:12px;background:#ffffff;padding:8px;border:1px solid #e2e8f0;" />
      </div>
      ${lpaBlock}
      ${linkBlock}
    </div>`;
}

function renderEsimText(esim: InstallEmailEsim, publicBaseUrl: string): string {
  const title = esim.label ?? "Your eSIM";
  const lines: string[] = [title];
  if (esim.iccid) lines.push(`ICCID: ${esim.iccid}`);
  if (esim.qrCodeUrl) {
    lines.push(`QR code: ${esim.qrCodeUrl}`);
  } else {
    lines.push("The QR code for this eSIM is still being prepared — we'll email it shortly.");
  }
  if (esim.lpaCode) lines.push(`Manual code: ${esim.lpaCode}`);
  if (esim.installPath) {
    lines.push(`Install page: ${absoluteUrl(esim.installPath, publicBaseUrl)}`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Shared HTML wrapper
// ---------------------------------------------------------------------------

export function wrapHtml(opts: { title: string; body: string }): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(opts.title)} — ${escapeHtml(brand.name)}</title>
</head>
<body style="margin:0;padding:0;background:${escapeHtml(brand.backgroundColor)};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#0f172a;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${escapeHtml(brand.backgroundColor)};">
    <tr>
      <td align="center" style="padding:24px 12px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #e2e8f0;">
          <tr>
            <td style="background:${escapeHtml(brand.themeColor)};padding:16px 24px;color:#ffffff;">
              <span style="font-size:15px;font-weight:700;">${escapeHtml(brand.name)}</span>
              <span style="float:right;font-size:12px;color:#cbd5e1;">${escapeHtml(brand.tagline)}</span>
            </td>
          </tr>
          <tr>
            <td style="padding:24px;font-size:14px;color:#334155;line-height:1.6;">
              ${opts.body}
            </td>
          </tr>
          <tr>
            <td style="padding:16px 24px;background:#f8fafc;border-top:1px solid #e2e8f0;font-size:11px;color:#94a3b8;">
              Sent by ${escapeHtml(brand.name)} · ${escapeHtml(brand.domain)}
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

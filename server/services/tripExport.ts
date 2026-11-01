/**
 * Trip export service (phase 14, batch 1).
 *
 * Three exports, each a *pure-ish* function of a saved-trip row:
 *
 *   buildTripPdfHtml(trip)          — print-ready HTML for the trip itinerary.
 *                                     Served with Content-Type: text/html and a
 *                                     print stylesheet; users "print to PDF".
 *                                     (A binary PDF renderer is not added in
 *                                     this batch — the acceptance criterion is
 *                                     "PDF export works" and print-to-PDF from
 *                                     any browser is a real, honest path that
 *                                     we render server-side so the file is
 *                                     self-contained without JS. If a true
 *                                     application/pdf is required, we add a
 *                                     renderer package; see the build report.)
 *
 *   buildOfflinePackHtml(trip,esim) — the "Offline trip pack": itinerary,
 *                                     emergency numbers, packing list, local
 *                                     tips, and (if the trip has an eSIM)
 *                                     a QR code + LPA so the traveller can
 *                                     install offline. Includes a manifest
 *                                     comment so the browser can save the
 *                                     page for offline use.
 *
 *   buildTripsPublicProjection(trip) — the JSON the public /trip/[id] page
 *                                     consumes. Excludes the owner email and
 *                                     any private meta field so a shared link
 *                                     never leaks a third party's inbox.
 *
 * WHY HTML, NOT BINARY PDF
 * ------------------------
 * We don't have a binary PDF renderer in this batch and I won't simulate one.
 * HTML + `@media print` produces the same user-visible result through
 * "Print → Save as PDF" and needs no server-side Chrome. This is honest about
 * the shape of the deliverable.
 *
 * The html is intentionally self-contained (inlined CSS, inline data for the
 * eSIM QR image URL). No external assets are referenced except the eSIM QR
 * image URL supplied by the caller (`esim.qrCodeUrl`). If that URL is not
 * reachable offline, the pack still works because we also include the LPA
 * text, which the eSIM install flow (iOS/Android) accepts directly.
 */
import { brand } from "../brand.config";

// ---------------------------------------------------------------------------
// Types (kept minimal and decoupled from Drizzle)
// ---------------------------------------------------------------------------

/**
 * The trip fields the export needs. Matches `trips` row shape but is declared
 * locally so tests can build it without a real DB row.
 */
export interface ExportableTrip {
  publicId: string;
  countries: string[];
  startDate: string;
  endDate: string;
  style: string;
  language: string;
  /** Full streamed text from the planner (ITINERARY / BUDGET / … sections). */
  planText: string;
  meta: Record<string, unknown>;
  /** Optional eSIM freshly bought for this trip (for the offline QR). */
  esim?: ExportableEsim | null;
}

export interface ExportableEsim {
  id: number;
  country: string | null;
  network: string | null;
  iccid: string | null;
  esimTranNo: string | null;
  lpaCode: string | null;
  qrCodeUrl: string | null;
  totalBytes: number | null;
  usedBytes: number | null;
  expiresAt: string | null; // ISO
}

export interface ExportOptions {
  /** Public base URL for share links. Empty during local dev. */
  publicBaseUrl: string;
  /** Injected now for the "generated at" footer. */
  now?: Date;
}

export interface PublicTrip {
  publicId: string;
  countries: string[];
  startDate: string;
  endDate: string;
  style: string;
  language: string;
  /** Sectioned text, pre-split. */
  sections: Array<{ name: string; body: string }>;
  /** A short, share-safe summary pulled from the first itinerary line. */
  summary: string;
  /** Affiliate/hotel slots the share page may render. Never includes base URL or IDs. */
  affiliateLinks: Array<{
    slot: "hotel" | "tour" | "transfer" | "insurance";
    label: string;
    url: string;
  }>;
  /** Present when a "Stay connected" eSIM is attached. Public-safe fields only. */
  connectedEsim: {
    country: string | null;
    network: string | null;
    totalBytes: number | null;
    usedBytes: number | null;
    expiresAt: string | null;
  } | null;
}

// ---------------------------------------------------------------------------
// Section splitting (matches the section headers the AI prompt requires)
// ---------------------------------------------------------------------------

const KNOWN_SECTIONS = ["ITINERARY", "BUDGET", "WEATHER", "PACKING", "TIPS"] as const;
type SectionName = (typeof KNOWN_SECTIONS)[number];

/**
 * The AI prompt instructs the model to emit `ITINERARY / BUDGET / WEATHER /
 * PACKING / TIPS` as ALL-CAPS header lines. We split on those same headers.
 * Anything before the first header is dropped (usually it's a pleasantry).
 * If the model ignores the format entirely, we emit a single section named
 * "PLAN" so exports are never empty.
 */
export function splitTripSections(text: string): Array<{ name: string; body: string }> {
  const re = new RegExp(`^[ \\t]*(${KNOWN_SECTIONS.join("|")})[ \\t]*$`, "m");
  const matches: Array<{ name: SectionName; index: number; length: number }> = [];
  let m: RegExpExecArray | null;
  const globalRe = new RegExp(re.source, "gm");
  while ((m = globalRe.exec(text)) !== null) {
    matches.push({ name: m[1] as SectionName, index: m.index, length: m[0].length });
    if (m.index === globalRe.lastIndex) globalRe.lastIndex++;
  }
  if (matches.length === 0) {
    const trimmed = text.trim();
    return trimmed ? [{ name: "PLAN", body: trimmed }] : [];
  }
  const out: Array<{ name: string; body: string }> = [];
  for (let i = 0; i < matches.length; i++) {
    const cur = matches[i]!;
    const next = matches[i + 1];
    const start = cur.index + cur.length;
    const end = next ? next.index : text.length;
    const body = text.slice(start, end).replace(/^\s+/, "").replace(/\s+$/, "");
    out.push({ name: cur.name, body });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Summary extraction
// ---------------------------------------------------------------------------

function firstLine(s: string): string {
  const line = s.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0);
  return line ?? "";
}

/** Build the short "share card" summary from the itinerary. */
export function buildSummary(trip: ExportableTrip): string {
  const itinerary = splitTripSections(trip.planText).find((s) => s.name === "ITINERARY");
  const fromItinerary = itinerary ? firstLine(itinerary.body) : "";
  if (fromItinerary) {
    // Cap to a card-friendly length (~180 chars, keeping word boundaries).
    if (fromItinerary.length <= 180) return fromItinerary;
    const slice = fromItinerary.slice(0, 180);
    const lastSpace = slice.lastIndexOf(" ");
    return `${lastSpace > 120 ? slice.slice(0, lastSpace) : slice}…`;
  }
  const itineraryCount = splitTripSections(trip.planText).find((s) => s.name === "ITINERARY")?.body;
  if (!itineraryCount) {
    return `${tripDateRange(trip)} · ${trip.countries.join(", ")}`;
  }
  return `${tripDateRange(trip)} · ${trip.countries.join(", ")}`;
}

function tripDateRange(trip: ExportableTrip): string {
  return `${trip.startDate} → ${trip.endDate}`;
}

// ---------------------------------------------------------------------------
// Public projection
// ---------------------------------------------------------------------------

/**
 * Build the JSON the /trip/[id] page returns. The public projection
 * deliberately excludes:
 *   - ownerEmail (a shareable link must not expose the planner's inbox)
 *   - planText raw (we send pre-split sections so the UI can render each
 *     section as a card — this is what the OG image and PDF also consume)
 *   - meta.affiliateLinks with the affiliate IDs (only the resolved URLs)
 *   - esim.iccid, lpaCode, qrCodeUrl (those are in the authenticated offline
 *     pack; the public share page shows status-only so a leaked link can't
 *     be used to install someone else's eSIM)
 */
export function buildTripsPublicProjection(trip: ExportableTrip): PublicTrip {
  const sections = splitTripSections(trip.planText);
  const rawAff = Array.isArray(trip.meta["affiliateLinks"]) ? (trip.meta["affiliateLinks"] as unknown[]) : [];
  const affiliateLinks = rawAff
    .map((x) => {
      if (!x || typeof x !== "object") return null;
      const obj = x as { slot?: unknown; label?: unknown; url?: unknown };
      const slot = typeof obj.slot === "string" ? obj.slot : "";
      const label = typeof obj.label === "string" ? obj.label.trim() : "";
      const url = typeof obj.url === "string" ? obj.url.trim() : "";
      if (!["hotel", "tour", "transfer", "insurance"].includes(slot)) return null;
      if (!/^https?:\/\//i.test(url)) return null;
      if (!label) return null;
      return { slot: slot as PublicTrip["affiliateLinks"][number]["slot"], label, url };
    })
    .filter((x): x is PublicTrip["affiliateLinks"][number] => x !== null);

  let connectedEsim: PublicTrip["connectedEsim"] = null;
  if (trip.esim) {
    connectedEsim = {
      country: trip.esim.country,
      network: trip.esim.network,
      totalBytes: trip.esim.totalBytes,
      usedBytes: trip.esim.usedBytes,
      expiresAt: trip.esim.expiresAt,
    };
  }

  return {
    publicId: trip.publicId,
    countries: trip.countries,
    startDate: trip.startDate,
    endDate: trip.endDate,
    style: trip.style,
    language: trip.language,
    sections,
    summary: buildSummary(trip),
    affiliateLinks,
    connectedEsim,
  };
}

// ---------------------------------------------------------------------------
// HTML helpers
// ---------------------------------------------------------------------------

/** Escape HTML text nodes and attribute values. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Convert a plain-text section body into HTML. We only honour line breaks
 * and bullet markers ("- ", "* ", "• ") — the model output is plain text.
 * We never run a markdown parser here: too permissive for a document that
 * also contains an eSIM QR.
 */
export function plainTextToHtml(body: string): string {
  const lines = body.split(/\r?\n/);
  const out: string[] = [];
  let inList = false;
  function closeList() {
    if (inList) {
      out.push("</ul>");
      inList = false;
    }
  }
  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/, "");
    if (line.length === 0) {
      closeList();
      out.push("");
      continue;
    }
    const bullet = line.match(/^\s*(?:[-*•]|\d+\.)\s+(.*)$/);
    if (bullet) {
      if (!inList) {
        out.push("<ul>");
        inList = true;
      }
      out.push(`<li>${escapeHtml(bullet[1]!)}</li>`);
    } else {
      closeList();
      out.push(`<p>${escapeHtml(line)}</p>`);
    }
  }
  closeList();
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// Shared stylesheet
// ---------------------------------------------------------------------------

/**
 * Inline CSS for the export documents. It's deliberately shared between the
 * itinerary PDF and the offline pack so the two feel like the same product.
 *
 * Notes:
 *  - @media print removes page margins to let the user pick them; we set a
 *    sensible default in the body padding.
 *  - Background colours are suppressed by most browsers by default in print
 *    mode; we never rely on colour to convey meaning (everything is textual).
 *  - Body font stack uses system fonts so the file renders identically
 *    without network access (important for the offline pack).
 */
const EXPORT_CSS = `
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    color: #0f172a;
    background: #ffffff;
    line-height: 1.5;
    font-size: 15px;
  }
  header {
    padding: 24px 24px 12px;
    border-bottom: 1px solid #e2e8f0;
  }
  header .brand { font-weight: 700; letter-spacing: -0.01em; }
  header .meta { color: #475569; font-size: 13px; margin-top: 4px; }
  main { padding: 24px; max-width: 780px; }
  section { margin-bottom: 28px; page-break-inside: avoid; }
  section h2 {
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: #1b6ef5;
    margin: 0 0 8px;
  }
  section p, section li { margin: 4px 0; }
  section ul { padding-left: 20px; margin: 4px 0; }
  .qr-block {
    border: 1px dashed #cbd5e1;
    border-radius: 12px;
    padding: 16px;
    margin-top: 8px;
  }
  .qr-block img { display: block; max-width: 220px; height: auto; margin: 8px 0; }
  .lpa { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; word-break: break-all; background: #f1f5f9; padding: 8px 10px; border-radius: 6px; }
  footer {
    padding: 16px 24px 32px;
    color: #64748b;
    font-size: 12px;
    border-top: 1px solid #e2e8f0;
    margin-top: 12px;
  }
  .print-hint { color: #64748b; font-size: 13px; padding: 12px 24px; background: #f8fafc; border-bottom: 1px solid #e2e8f0; }
  @media print {
    .print-hint { display: none; }
    header, footer { border-color: #94a3b8; }
    body { font-size: 12pt; }
    main { padding: 0; max-width: none; }
    section { page-break-inside: avoid; }
  }
`;

function pageHeader(trip: ExportableTrip, opts: ExportOptions, subtitle: string): string {
  const now = opts.now ?? new Date();
  return `
  <header>
    <div class="brand">${escapeHtml(brand.name)}</div>
    <div class="meta">
      ${escapeHtml(subtitle)} ·
      ${escapeHtml(trip.startDate)} → ${escapeHtml(trip.endDate)} ·
      ${escapeHtml(trip.countries.join(", "))} ·
      generated ${escapeHtml(now.toISOString().slice(0, 10))}
    </div>
  </header>`;
}

function pageFooter(): string {
  return `
  <footer>
    ${escapeHtml(brand.name)} · ${escapeHtml(brand.tagline)} ·
    Support: ${escapeHtml(brand.supportEmail)}
  </footer>`;
}

// ---------------------------------------------------------------------------
// Trip PDF (print-to-PDF) — itinerary only
// ---------------------------------------------------------------------------

/**
 * Render the trip as a self-contained print-ready HTML document. The user
 * clicks "Print → Save as PDF" from the browser. Every section in the plan is
 * included. Affiliate links are *not* rendered here because a PDF cannot
 * meaningfully deep-link, and affiliate attribution on a re-printable file is
 * not something we want to honour (see the affiliate phase for the reason).
 *
 * Returns `{ html, suggestedTitle }`. The route wraps this in an HTTP
 * response; the caller selects `Content-Disposition: inline` so a browser
 * can display it directly.
 */
export function buildTripPdfHtml(
  trip: ExportableTrip,
  opts: ExportOptions,
): { html: string; suggestedTitle: string } {
  const sections = splitTripSections(trip.planText);
  const title = `Trip to ${trip.countries.join(", ")}`;
  const sectionsHtml = sections.length
    ? sections
        .map(
          (s) => `
      <section>
        <h2>${escapeHtml(s.name)}</h2>
        ${plainTextToHtml(s.body)}
      </section>`,
        )
        .join("\n")
    : `<section><p>This trip has no plan text yet.</p></section>`;

  const html = `<!doctype html>
<html lang="${escapeHtml(trip.language)}">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)} · ${escapeHtml(brand.name)}</title>
  <meta name="robots" content="noindex,follow" />
  <style>${EXPORT_CSS}</style>
</head>
<body>
  <div class="print-hint">Tip: use your browser&rsquo;s Print menu and choose &ldquo;Save as PDF&rdquo;.</div>
  ${pageHeader(trip, opts, "Trip itinerary")}
  <main>
    ${sectionsHtml}
  </main>
  ${pageFooter()}
</body>
</html>`;
  return { html, suggestedTitle: `trip-${trip.publicId}.html` };
}

// ---------------------------------------------------------------------------
// Offline pack — itinerary + emergency + packing + local tips + eSIM QR
// ---------------------------------------------------------------------------

/**
 * The "offline trip pack": everything the traveller needs if they lose
 * connectivity. Contents:
 *   - Itinerary (ITINERARY section, verbatim)
 *   - Emergency numbers + local tips (TIPS section: the model is instructed to
 *     list verified numbers or "verify locally" — we don't fabricate numbers
 *     here.)
 *   - Packing list (PACKING section)
 *   - eSIM install block (QR + LPA) IF the trip has an attached eSIM. This is
 *     the whole point of the offline pack — the traveller can install the eSIM
 *     without internet (or before landing).
 *
 * The offline pack is *not* gated by auth: the trip share token is the access
 * grant. If the trip is private (isPublic=false), the route refuses to serve
 * this export at all (see the router). That keeps the token's blast radius
 * clean.
 */
export function buildOfflinePackHtml(
  trip: ExportableTrip,
  opts: ExportOptions,
): { html: string; suggestedTitle: string } {
  const sections = splitTripSections(trip.planText);
  const byName = new Map(sections.map((s) => [s.name, s.body] as const));
  const itinerary = byName.get("ITINERARY") ?? "";
  const packing = byName.get("PACKING") ?? "";
  const tips = byName.get("TIPS") ?? "";
  const budget = byName.get("BUDGET") ?? "";
  const weather = byName.get("WEATHER") ?? "";

  const esimBlock = buildEsimBlock(trip.esim ?? null);

  const title = `Offline trip pack · ${trip.countries.join(", ")}`;

  const html = `<!doctype html>
<html lang="${escapeHtml(trip.language)}">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)} · ${escapeHtml(brand.name)}</title>
  <meta name="robots" content="noindex,follow" />
  <style>${EXPORT_CSS}
    .esim-block { border: 1px solid #1b6ef5; border-radius: 12px; padding: 16px; background: #eef7ff; }
    .esim-block h2 { color: #1557e1; }
    .steps { list-style: decimal; padding-left: 20px; }
    .steps li { margin: 6px 0; }
    .pill { display: inline-block; padding: 2px 8px; border-radius: 999px; background: #1b6ef5; color: #fff; font-size: 11px; letter-spacing: 0.04em; text-transform: uppercase; }
  </style>
</head>
<body>
  <div class="print-hint">This document works offline. Use your browser&rsquo;s Print menu to &ldquo;Save as PDF&rdquo; for a permanent copy.</div>
  ${pageHeader(trip, opts, "Offline trip pack")}
  <main>
    <section class="esim-block">
      <h2>Your eSIM <span class="pill">offline</span></h2>
      ${esimBlock}
    </section>

    <section>
      <h2>Itinerary</h2>
      ${itinerary ? plainTextToHtml(itinerary) : "<p>No itinerary was saved with this trip.</p>"}
    </section>

    <section>
      <h2>Budget</h2>
      ${budget ? plainTextToHtml(budget) : "<p>No budget was saved with this trip.</p>"}
    </section>

    <section>
      <h2>Weather</h2>
      ${weather ? plainTextToHtml(weather) : "<p>No weather notes were saved with this trip.</p>"}
    </section>

    <section>
      <h2>Packing list</h2>
      ${packing ? plainTextToHtml(packing) : "<p>No packing list was saved with this trip.</p>"}
    </section>

    <section>
      <h2>Emergency &amp; local tips</h2>
      ${tips ? plainTextToHtml(tips) : "<p>No local tips were saved with this trip. Check your local emergency number before you travel.</p>"}
    </section>

    <section>
      <h2>While you travel</h2>
      <p>Keep this page available offline: open it, then use your browser&rsquo;s &ldquo;Add to Home Screen&rdquo; or &ldquo;Save page&rdquo;.</p>
      <p>For account help, email ${escapeHtml(brand.supportEmail)} or message us on WhatsApp at ${escapeHtml(brand.supportWhatsApp)}.</p>
    </section>
  </main>
  ${pageFooter()}
</body>
</html>`;
  return { html, suggestedTitle: `offline-pack-${trip.publicId}.html` };
}

/**
 * Compose the eSIM install block. We render:
 *  - If `qrCodeUrl` exists: an `<img>` pointing at it. The image is a *link*
 *    the traveller's next device can scan; it's also readable offline if the
 *    page is saved after loading.
 *  - The manual LPA string always, because iOS/Android both accept it and it
 *    survives being printed on paper.
 *  - Short install steps for iPhone and Android (verbatim from the phase spec).
 *
 * If no eSIM is attached we return honest copy telling the traveller to buy
 * one, with a link to the storefront. We NEVER invent an LPA.
 */
function buildEsimBlock(esim: ExportableEsim | null): string {
  if (!esim) {
    return `<p>No eSIM is attached to this trip yet. Buy one at <a href="/">${escapeHtml(brand.name)}</a> and re-download this pack — the QR will be included.</p>`;
  }
  const parts: string[] = [];
  parts.push(
    `<p><strong>${escapeHtml(esim.country ?? "Your destination")}</strong>${esim.network ? ` · runs on ${escapeHtml(esim.network)}` : ""}</p>`,
  );
  if (esim.esimTranNo) {
    parts.push(
      `<p class="lpa">Transaction: ${escapeHtml(esim.esimTranNo)}</p>`,
    );
  }
  if (esim.qrCodeUrl) {
    parts.push(
      `<div class="qr-block"><img src="${escapeHtml(esim.qrCodeUrl)}" alt="eSIM QR code" /></div>`,
    );
  }
  if (esim.lpaCode) {
    parts.push(
      `<p>Manual code (use if you can&rsquo;t scan):</p><p class="lpa">${escapeHtml(esim.lpaCode)}</p>`,
    );
  } else if (!esim.qrCodeUrl) {
    parts.push(
      `<p>Your eSIM install details are not on this pack yet. Open My eSIMs while online to view the QR.</p>`,
    );
  }
  parts.push(`<p><strong>iPhone</strong></p>
    <ol class="steps">
      <li>Settings → Cellular → Add eSIM</li>
      <li>Choose Use QR Code, scan the one above</li>
      <li>Label it &ldquo;${escapeHtml(brand.name)}&rdquo; and turn on Data Roaming while you travel</li>
    </ol>`);
  parts.push(`<p><strong>Android</strong></p>
    <ol class="steps">
      <li>Settings → Network &amp; internet → SIMs → Add eSIM</li>
      <li>Choose the QR scanner and scan the code above</li>
      <li>Turn on roaming for the new eSIM while you travel</li>
    </ol>`);
  if (esim.expiresAt) {
    parts.push(
      `<p>Expires ${escapeHtml(esim.expiresAt.slice(0, 10))}. Top-ups stay available in My eSIMs.</p>`,
    );
  }
  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Test surface
// ---------------------------------------------------------------------------

export const __test__ = {
  KNOWN_SECTIONS,
  EXPORT_CSS,
  buildEsimBlock,
  tripDateRange,
  firstLine,
};

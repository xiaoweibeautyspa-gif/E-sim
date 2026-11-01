/**
 * Calendar helpers for saved trips (phase 14, batch 1).
 *
 * Two responsibilities, both pure (no DB, no network):
 *
 *   1. `buildIcs(trip)` — produce an RFC 5545 `.ics` document for "Add to
 *      calendar". We emit a *single all-day, multi-day* event covering the
 *      trip, plus one `VALARM` one day before departure. Do NOT emit a dozen
 *      individual day events: the trip name is the anchor and users add the
 *      whole trip as one event in practice. Downstream UIs that need per-day
 *      events can be added later without breaking the contract.
 *
 *   2. `googleCalendarUrl(trip)` / `outlookCalendarUrl(trip)` — hand-off
 *      URLs so the UI can offer "Google Calendar", "Outlook", "Apple (via
 *      .ics file)". Apple/macOS/iOS install the .ics, so both paths end up at
 *      the same event.
 *
 * WHAT WE DELIBERATELY DO NOT DO
 * ------------------------------
 *  - We don't fetch a timezone for each country. All-day events avoid the
 *    problem entirely: an all-day event on 2026-04-10 is that calendar date
 *    regardless of where you are. The reminder alarm (1 day before the event
 *    start) is a local-time trigger for the *calendar app*, not us.
 *  - We don't inject the user's email address as ORGANIZER. The .ics is
 *    opened locally; no organizer field means the calendar app asks the user.
 *  - We don't recurse. Trips are single events.
 *
 * RFC 5545 practicalities: lines >75 octets must be folded with CRLF + a
 * single space; TEXT fields escape backslash, comma, semicolon, newline.
 * Both are implemented because Google/Outlook do enforce folding.
 */
import { brand, absoluteUrl } from "../brand.config";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The calendar service accepts the *minimum* of what it needs, so it can be
 * used from tests and other services without importing the full trip row.
 */
export interface CalendarTrip {
  /** Public share id (used in URLs). */
  publicId: string;
  /** Human label. Defaults to "Trip to {countries}". */
  title: string;
  countries: string[];
  startDate: string; // YYYY-MM-DD (all-day, inclusive)
  endDate: string; // YYYY-MM-DD (all-day, inclusive)
  notes?: string | null;
}

export interface CalendarOptions {
  /** Base URL for the share link embedded in DESCRIPTION, e.g. "https://x.com". */
  publicBaseUrl: string;
  /** Injected clock; when > startDate, we don't add a "leave in NN days" line. */
  now?: Date;
}

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

/**
 * Turn a YYYY-MM-DD into the RFC 5545 all-day form (DATE, not DATE-TIME).
 * The caller supplies the value; we validate the shape and reject anything
 * else rather than guess.
 */
function validateDate(d: string, field: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) {
    throw new Error(`calendar: ${field} must be YYYY-MM-DD, got ${JSON.stringify(d)}`);
  }
  // Round-trip through Date to reject impossible dates like 2026-02-31.
  const t = Date.parse(`${d}T00:00:00Z`);
  if (!Number.isFinite(t)) throw new Error(`calendar: ${field} is not a real date`);
  const back = new Date(t).toISOString().slice(0, 10);
  if (back !== d) throw new Error(`calendar: ${field} is not a real date`);
  return d;
}

/**
 * RFC 5545 uses "value date" without dashes (e.g. 20260410). For an all-day
 * event spanning multiple days, DTEND is *exclusive*: the day AFTER the last
 * day of the trip. This is a common off-by-one source; we implement the
 * spec rule (DTEND = day after endDate) and cover it in tests.
 */
function toIcsDate(d: string): string {
  return d.replace(/-/g, "");
}

function addOneDay(d: string): string {
  const t = Date.parse(`${d}T00:00:00Z`);
  if (!Number.isFinite(t)) throw new Error(`calendar: cannot add a day to ${d}`);
  const next = new Date(t + 86_400_000);
  return next.toISOString().slice(0, 10);
}

function ymdCompactFromDate(d: Date): string {
  // Use UTC: we only need a stable unique-ish value for a host fingerprint.
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

// ---------------------------------------------------------------------------
// ICS text helpers
// ---------------------------------------------------------------------------

/** Escape a TEXT field into an ICS-safe value (RFC 5545 §3.3.11). */
export function escapeIcsText(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/\r\n|\r|\n/g, "\\n")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,");
}

/**
 * Fold long lines to ≤75 octets per RFC 5545 §3.1, using CRLF + single space.
 * We measure in UTF-8 codepoints (Buffer.byteLength) because folder indices
 * are byte-based, not character-based. This is what trips up naive string
 * slicing of Chinese/Vietnamese text.
 */
export function foldIcsLine(line: string): string {
  // Fast path: short ASCII lines can't need folding.
  if (Buffer.byteLength(line, "utf8") <= 75) return line;

  const out: string[] = [];
  // We consume the string codepoint-by-codepoint, tracking cumulative UTF-8
  // byte length per fold segment. Continuation lines begin with a space and
  // therefore have a 74-byte budget.
  let current = "";
  let budget = 75;
  let bytes = 0;
  for (const ch of line) {
    const b = Buffer.byteLength(ch, "utf8");
    if (bytes + b > budget) {
      out.push(current);
      current = ch;
      bytes = b;
      // Continuation segments start with a space added below, which the
      // budget already accounts for.
      budget = 74;
    } else {
      current += ch;
      bytes += b;
    }
  }
  if (current.length > 0) out.push(current);
  // Join with CRLF + one space (the space is the continuation marker).
  return out.join("\r\n ");
}

/** Build an RFC 5545 COMPLIANT timestamp from a Date (UTC `...Z`). */
function utcStamp(d: Date): string {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mi = String(d.getUTCMinutes()).padStart(2, "0");
  const ss = String(d.getUTCSeconds()).padStart(2, "0");
  return `${yyyy}${mm}${dd}T${hh}${mi}${ss}Z`;
}

// ---------------------------------------------------------------------------
// ICS document
// ---------------------------------------------------------------------------

/**
 * Build the .ics payload for a trip.
 *
 * Contents:
 *   - VERSION, PRODID, CALSCALE, METHOD:PUBLISH
 *   - One VEVENT: DTSTART=startDate, DTEND=endDate+1 (all-day, exclusive)
 *   - DESCRIPTION: a short "what this is" line + share link
 *   - VALARM 1: -P1D (one day before start) — what the "day before
 *     departure" reminder is meant to look like in the user's calendar app.
 *   - A second VALARM at -PT2H (2 hours before start): the 1-day alarm fires
 *     at 00:00 the day before in most apps, which is too early to act on. The
 *     +2h alarm catches the "get ready" moment. This is a product choice; the
 *     acceptance criterion ("add to calendar") is satisfied by having any
 *     alarm — the reminders we *own* are the email + push ones in the queued
 *     reminder job.
 *
 * Returns a string suitable for direct file download or `data:text/calendar`
 * URL.
 */
export function buildIcs(trip: CalendarTrip, opts: CalendarOptions): string {
  if (trip.countries.length === 0) {
    throw new Error("calendar: trip.countries must not be empty");
  }
  validateDate(trip.startDate, "trip.startDate");
  validateDate(trip.endDate, "trip.endDate");
  if (trip.endDate < trip.startDate) {
    throw new Error("calendar: trip.endDate must not precede trip.startDate");
  }

  const now = opts.now ?? new Date();
  const startCompact = toIcsDate(trip.startDate);
  const dtEndCompact = toIcsDate(addOneDay(trip.endDate));
  // UID: stable per share token + start date. Using the share token means a
  // regenerated "add to calendar" replaces the previous event on re-import
  // (calendar apps dedupe by UID).
  const uid = `trip-${trip.publicId}-${startCompact}@${hostOf(opts.publicBaseUrl) || brand.domain}`;
  const shareUrl = absoluteUrl(`/trip/${trip.publicId}`, opts.publicBaseUrl);
  const title = trip.title.trim() || `Trip to ${trip.countries.join(", ")}`;
  const descriptionParts: string[] = [];
  if (trip.notes) descriptionParts.push(trip.notes.trim());
  descriptionParts.push(`View your trip: ${shareUrl}`);
  descriptionParts.push(`Planned with ${brand.name}.`);

  const lines: string[] = [];
  lines.push("BEGIN:VCALENDAR");
  lines.push("VERSION:2.0");
  lines.push(`PRODID:-//${foldIcsLine(escapeIcsText(brand.name))}//Trip Planner//EN`);
  lines.push("CALSCALE:GREGORIAN");
  lines.push("METHOD:PUBLISH");
  lines.push("BEGIN:VEVENT");
  lines.push(`UID:${uid}`);
  lines.push(`DTSTAMP:${utcStamp(now)}`);
  lines.push(`DTSTART;VALUE=DATE:${startCompact}`);
  lines.push(`DTEND;VALUE=DATE:${dtEndCompact}`);
  lines.push(`SUMMARY:${foldIcsLine(escapeIcsText(title))}`);
  lines.push(`DESCRIPTION:${foldIcsLine(escapeIcsText(descriptionParts.join("\n\n")))}`);
  lines.push(`URL:${shareUrl}`);
  // VALARM: 1 day before start.
  lines.push("BEGIN:VALARM");
  lines.push("ACTION:DISPLAY");
  lines.push("TRIGGER:-P1D");
  lines.push(`DESCRIPTION:${foldIcsLine(escapeIcsText(`Your trip starts tomorrow — ${title}`))}`);
  lines.push("END:VALARM");
  // VALARM: 2 hours before start of the all-day event. Note: an all-day
  // event starts at 00:00 local; -PT2H would be the previous day at 22:00.
  // That's intentional — the "pack tonight" alarm. Users can edit it.
  lines.push("BEGIN:VALARM");
  lines.push("ACTION:DISPLAY");
  lines.push("TRIGGER:-PT2H");
  lines.push(`DESCRIPTION:${foldIcsLine(escapeIcsText(`Pack for ${title} — starting soon`))}`);
  lines.push("END:VALARM");
  lines.push("END:VEVENT");
  lines.push("END:VCALENDAR");

  // RFC 5545 wants CRLF line endings — not platform-native LF. Some strict
  // parsers (Outlook) are picky.
  return lines.join("\r\n") + "\r\n";
}

function hostOf(baseUrl: string): string {
  if (!baseUrl) return "";
  try {
    return new URL(baseUrl.startsWith("http") ? baseUrl : `https://${baseUrl}`).host;
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// Web-calendar hand-offs
// ---------------------------------------------------------------------------

/**
 * Google Calendar "TEMPLATE" hand-off URL (all-day). Google rounds DTEND
 * down to *exclusive* all-day exactly like RFC 5545, so we pass endDate+1.
 *
 * Google encodes spaces as %20 (not +) in dates. We encode the whole query
 * via URLSearchParams which uses `+` for spaces; Google accepts both, but
 * we normalise to %20 to be safe with older Android intents.
 */
export function googleCalendarUrl(trip: CalendarTrip, opts: CalendarOptions): string {
  validateDate(trip.startDate, "trip.startDate");
  validateDate(trip.endDate, "trip.endDate");
  const startCompact = toIcsDate(trip.startDate);
  const endCompact = toIcsDate(addOneDay(trip.endDate));
  const shareUrl = absoluteUrl(`/trip/${trip.publicId}`, opts.publicBaseUrl);
  const text = trip.title.trim() || `Trip to ${trip.countries.join(", ")}`;
  const details = [trip.notes?.trim(), `View your trip: ${shareUrl}`, `Planned with ${brand.name}.`]
    .filter(Boolean)
    .join("\n\n");
  const dates = `${startCompact}/${endCompact}`;
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text,
    dates,
    details,
    // Google needs an explicit location for all-day events; we use the
    // first country name — Google accepts a free-text location.
    location: trip.countries[0] ?? "",
  });
  // URLSearchParams spaces → "+"; Google is happy with it. We just normalise.
  return `https://calendar.google.com/calendar/render?${params.toString().replace(/\+/g, "%20")}`;
}

/**
 * Outlook Web "compose" deeplink. All-day events use `allday=true` and
 * `startdt`/`enddt`. Like Google, Outlook's all-day enddt is exclusive.
 */
export function outlookCalendarUrl(trip: CalendarTrip, opts: CalendarOptions): string {
  validateDate(trip.startDate, "trip.startDate");
  validateDate(trip.endDate, "trip.endDate");
  const startIso = `${trip.startDate}T00:00:00Z`;
  // Outlook expects exclusive end as well, but the parameter is a full ISO
  // timestamp. To avoid end-of-day ambiguity we set enddt to endDate+1 at
  // 00:00:00Z. All-day handling on Outlook will normalise.
  const endIso = `${addOneDay(trip.endDate)}T00:00:00Z`;
  const shareUrl = absoluteUrl(`/trip/${trip.publicId}`, opts.publicBaseUrl);
  const text = trip.title.trim() || `Trip to ${trip.countries.join(", ")}`;
  const body = [trip.notes?.trim(), `View your trip: ${shareUrl}`, `Planned with ${brand.name}.`]
    .filter(Boolean)
    .join("\n\n");
  const params = new URLSearchParams({
    path: "/calendar/action/compose",
    rru: "addevent",
    subject: text,
    body,
    startdt: startIso,
    enddt: endIso,
    allday: "true",
    location: trip.countries[0] ?? "",
  });
  return `https://outlook.live.com/calendar/0/deeplink/compose?${params.toString()}`;
}

/**
 * A tiny helper that the UI can call to decide which buttons to render.
 * Returning `null` for `.ics` means the trip is malformed — the UI can hide
 * the buttons without duplicating validation logic.
 */
export function calendarLinks(
  trip: CalendarTrip,
  opts: CalendarOptions,
):
  | {
      ics: string;
      googleUrl: string;
      outlookUrl: string;
      suggestedFilename: string;
    }
  | null {
  try {
    const ics = buildIcs(trip, opts);
    return {
      ics,
      googleUrl: googleCalendarUrl(trip, opts),
      outlookUrl: outlookCalendarUrl(trip, opts),
      suggestedFilename: `trip-${trip.publicId}-${ymdCompactFromDate(new Date(`${trip.startDate}T00:00:00Z`))}.ics`,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Test surface
// ---------------------------------------------------------------------------

export const __test__ = {
  validateDate,
  toIcsDate,
  addOneDay,
  utcStamp,
  hostOf,
};

/**
 * Trip planner prompt + stream section tracking.
 *
 * Two jobs, kept together so callers can't drift:
 *
 *  1. `buildTripPlannerPrompt(input)` — the ONLY place that describes the
 *     shape of the model output. Section order is fixed (ITINERARY, BUDGET,
 *     WEATHER, PACKING, TIPS) so the client can render deterministically
 *     under streaming. The system prompt hard-bans inventing eSIM plans,
 *     prices, emergency numbers, plug types and live-forecast claims; the
 *     storefront adds its own "Stay connected" recommendation *below* the
 *     text so the model never needs to know about our catalogue.
 *
 *  2. `createSectionTracker()` / `tagSection(text)` — convert a stream of raw
 *     text deltas into the `{ section, text }` pieces the route forwards over
 *     SSE. Deliberately simple: a section starts when an ALL-CAPS header
 *     appears on its own line at the start of a delta OR after a newline.
 *     Partial headers split across deltas are buffered until they resolve, so
 *     we never leak "BUDGE" as itinerary text.
 *
 * The route `server/routes/tripPlanner.ts` currently holds an equivalent
 * inline copy of these two functions (it predates this file). Names and return
 * shapes match exactly so a follow-up batch can swap the import without
 * touching call-sites. Until that swap, this file is the source of truth for
 * future callers and tests.
 *
 * Conventions:
 *  - No DB access, no env, no I/O. Pure functions — easy to test in isolation.
 *  - The `Section` union is the single list everything else (route, page)
 *    must agree with. Export it.
 *  - Language is passed as 'en' | 'zh' | 'vi'. Anything else is coerced to
 *    'en' at the boundary; we never send a mixed-language instruction set.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The five sections, in emission order. */
export const TRIP_SECTIONS = [
  "ITINERARY",
  "BUDGET",
  "WEATHER",
  "PACKING",
  "TIPS",
] as const;

export type TripSection = (typeof TRIP_SECTIONS)[number];

export type TripLanguage = "en" | "zh" | "vi";

export type TripStyle =
  | "relaxed"
  | "foodie"
  | "adventure"
  | "family"
  | "business";

export type TripCurrency = "SGD" | "USD" | "VND" | "CNY";

/**
 * The prompt inputs. This mirrors the validated shape of the plan request body
 * in the route; `flight` is the *resolved* flight (post-lookup) or null. We do
 * not accept a raw flight number here — the route owns the lookup so this
 * module stays pure.
 */
export interface TripPlannerPromptInput {
  countries: string[];
  startDate: string; // YYYY-MM-DD
  endDate: string; // YYYY-MM-DD
  style: TripStyle;
  language: TripLanguage;
  budget: { amount: number; currency: TripCurrency } | null;
  flight: TripFlight | null;
}

export interface TripFlight {
  flightNumber: string;
  airline: string | null;
  departure: { iata: string; city: string | null; country: string | null };
  arrival: { iata: string; city: string | null; country: string | null };
  startDate: string;
  endDate: string;
}

export interface TripPlannerPrompt {
  /** System prompt: role, style, and hard limits. */
  system: string;
  /** User prompt: the concrete request in section order. */
  prompt: string;
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

/** 1-based day count between two YYYY-MM-DD dates, inclusive. Never < 1. */
export function countDays(startDate: string, endDate: string): number {
  const start = Date.parse(`${startDate}T00:00:00Z`);
  const end = Date.parse(`${endDate}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return 1;
  return Math.floor((end - start) / 86_400_000) + 1;
}

/** Coerce an arbitrary language code to one we instruct the model in. */
export function coerceLanguage(value: string | undefined | null): TripLanguage {
  return value === "zh" || value === "vi" ? value : "en";
}

/** Human-readable, one-line-per-field description of the trip. */
function describeTrip(input: TripPlannerPromptInput, days: number): string[] {
  const lines: string[] = [];
  lines.push(`Plan a ${days}-day trip to: ${input.countries.join(", ")}.`);
  lines.push(`Dates: ${input.startDate} to ${input.endDate}.`);
  lines.push(`Travel style: ${input.style}.`);
  if (input.budget) {
    lines.push(`Budget: ${input.budget.amount} ${input.budget.currency}.`);
  } else {
    lines.push("No budget stated — use typical mid-range costs for these destinations.");
  }
  if (input.flight) {
    const f = input.flight;
    const airline = f.airline ? `${f.airline} ` : "";
    lines.push(
      `The user is flying ${airline}${f.flightNumber}, ${f.departure.iata} → ${f.arrival.iata}. ` +
        `Use those airport codes and treat ${f.arrival.city ?? f.arrival.iata} as the arrival city.`,
    );
  }
  return lines;
}

/**
 * Build the system and user prompt. The user prompt is deliberately
 * prescriptive about the *format* (headers, blank lines, per-item shape) so
 * `createSectionTracker` can stream reliably without a real parser.
 */
export function buildTripPlannerPrompt(input: TripPlannerPromptInput): TripPlannerPrompt {
  const days = countDays(input.startDate, input.endDate);
  const language = coerceLanguage(input.language);

  const system = [
    "You are a calm, practical travel planner helping real travellers.",
    "Write in the user's chosen language for every section, including the section headers if that is natural — but ALWAYS keep the five section header keywords (ITINERARY, BUDGET, WEATHER, PACKING, TIPS) in English on their own line so the app can split the stream. The body text is in the user's language.",
    "Never invent eSIM plan names, prices, or store URLs. Do not mention eSIM plans at all — the storefront adds its own recommendation.",
    "Never invent emergency phone numbers, plug types, or tipping customs. If you are not certain of a country-specific fact, write 'verify locally' rather than stating a number.",
    "Do not claim live-forecast weather. Weather notes are seasonal generalities.",
    "Budgets are estimates; label them as such. Do not present false precision.",
    "When you are unsure of a fact, say so plainly.",
    language === "zh" ? "The user asked for Simplified Chinese." : "",
    language === "vi" ? "The user asked for Vietnamese." : "",
  ]
    .filter(Boolean)
    .join(" ");

  const prompt = [
    ...describeTrip(input, days),
    "",
    "Return exactly these five sections in this order. Start each section with its name in ALL CAPS on its own line, then a blank line:",
    "",
    "ITINERARY",
    `One line per day, in the form 'Day 1 (Mon, 3 Jun): …' with 2–4 concrete activities that fit the travel style. Do not exceed ${days} days.`,
    "",
    "BUDGET",
    "A short paragraph, then a bullet list of 4–6 categories (accommodation, food, local transport, activities, shopping, misc) with amounts in the requested currency, then a total. Label it as an estimate.",
    "",
    "WEATHER",
    "Two short paragraphs: one overall seasonal note, then one sentence per country about what to pack for. No live-forecast claims.",
    "",
    "PACKING",
    "A bullet list of 8–12 items tailored to the travel style and climate.",
    "",
    "TIPS",
    "A bullet list covering: emergency numbers if you are certain (otherwise 'verify locally'), plug type, tipping norms, useful apps to download.",
  ].join("\n");

  return { system, prompt };
}

// ---------------------------------------------------------------------------
// Section detection
// ---------------------------------------------------------------------------

const SECTION_HEADER_RE = new RegExp(
  `(^|\\n)[ \\t]*(${TRIP_SECTIONS.join("|")})[ \\t]*(\\r?\\n|$)`,
);

/**
 * Return the section named by a header in `text`, or null. Matches only when
 * the header token appears on its own line (preceded by start-of-string or a
 * newline, followed by newline or end-of-string). This is the same rule the
 * route uses; keeping it exported lets tests assert parity.
 */
export function tagSection(text: string): TripSection | null {
  const match = text.match(SECTION_HEADER_RE);
  if (!match) return null;
  const name = match[2] as TripSection;
  return name;
}

// ---------------------------------------------------------------------------
// Section tracker
// ---------------------------------------------------------------------------

export interface SectionChunk {
  /** The section this chunk belongs to, or null for pre-header text. */
  section: TripSection | null;
  /** Text to emit to the client verbatim. May be empty when we suppress a header. */
  text: string;
  /** True when a new section header started at this chunk. */
  started: boolean;
}

export interface SectionTracker {
  /**
   * Feed a raw text delta from the model. Returns zero or more `SectionChunk`
   * pieces in order. The tracker never drops user-visible text; it may buffer
   * the tail of a delta if it looks like the start of a (potentially) split
   * header, and it may suppress the header line itself (which is just markup
   * for us, not content the user needs to read).
   */
  push(delta: string): SectionChunk[];
  /** Flush any buffered tail. Call once at end-of-stream. */
  flush(): SectionChunk[];
  /** The section currently being written, or null before any header. */
  current(): TripSection | null;
  /** The section that just completed, or null if none has. */
  lastCompleted(): TripSection | null;
  /** All heads for which a chunk was emitted, in order. */
  seen(): TripSection[];
}

/** Max bytes we'll hold while waiting to see if a header is being split. */
const PENDING_HEADER_MAX = 16; // longer than any header token; safe upper bound.

/**
 * Create a stateful tracker. The rules:
 *
 *  - Before the first header, we hold everything in a pending buffer until we
 *    either see a header (then we drop the pre-header text on the floor: it's
 *    usually a preamble like "Sure! Here's your plan:", which readers don't
 *    need) or the buffer exceeds `PENDING_HEADER_MAX` without a header (then
 *    we flush it as section=null text).
 *  - After a header, we scan the cumulative buffer for the *next* header. The
 *    text between the current header and the next header is emitted as
 *    section=<current>.
 *  - We suppress the header line + the blank line after it from emitted text.
 *
 * The tracker is idempotent to `flush()` (calling it twice is harmless, the
 * second flush returns []).
 */
export function createSectionTracker(): SectionTracker {
  let current: TripSection | null = null;
  let lastDone: TripSection | null = null;
  const seenList: TripSection[] = [];
  // Buffer of everything not yet emitted / not yet recognized as header.
  let buffer = "";

  function emit(text: string, section: TripSection | null, started = false): SectionChunk {
    return { section, text, started };
  }

  function push(delta: string): SectionChunk[] {
    if (delta.length === 0) return [];
    buffer += delta;
    const out: SectionChunk[] = [];

    // Loop: emit text up to the next header, then consume the header and set
    // current. If no header yet, we either wait for more input (buffer below
    // PENDING_HEADER_MAX before any section) or flush the safe prefix.
    while (true) {
      const match = buffer.match(SECTION_HEADER_RE);
      if (match) {
        const headerIndex = match.index ?? 0;
        // Text before the header (may be empty). Emit under the PREVIOUS section.
        const before = buffer.slice(0, headerIndex);
        if (before.length > 0) {
          out.push(emit(before, current));
        }
        const nextSection = match[2] as TripSection;
        if (current && current !== nextSection) {
          // Mark previous section complete. The route also emits `section_done`
          // on its side; here we only track state for chunk tagging.
          lastDone = current;
        }
        current = nextSection;
        if (!seenList.includes(nextSection)) seenList.push(nextSection);
        out.push(emit("", nextSection, true));
        // Consume the header line (and the leading newline, if any).
        const consumedLength = (match[1] === "\n" ? 1 : 0) + match[2].length + match[3].length;
        buffer = buffer.slice(headerIndex + consumedLength);
        continue;
      }

      // No header ready yet.
      if (current === null) {
        // Before the first header, hold near-complete header tails in buffer.
        // Once the buffer is clearly longer than any header token could be,
        // flush the safe prefix as "pre-header" text (section = null).
        if (buffer.length > PENDING_HEADER_MAX) {
          const safeLength = buffer.length - PENDING_HEADER_MAX;
          const safe = buffer.slice(0, safeLength);
          buffer = buffer.slice(safeLength);
          out.push(emit(safe, null));
        }
      } else {
        // After a header, we can emit everything. If the tail of the buffer
        // *could* be the start of a header token (e.g. ends with "BUD"), we
        // keep the last few characters buffered so a subsequent delta can
        // complete the match. We compute the longest suffix of `buffer` that
        // is a prefix of any section header.
        const keep = longestHeaderPrefixSuffix(buffer);
        if (keep > 0) {
          const safeLength = buffer.length - keep;
          if (safeLength > 0) {
            const safe = buffer.slice(0, safeLength);
            buffer = buffer.slice(safeLength);
            out.push(emit(safe, current));
          }
        } else {
          const safe = buffer;
          buffer = "";
          out.push(emit(safe, current));
        }
      }
      break;
    }

    return out;
  }

  function flush(): SectionChunk[] {
    if (buffer.length === 0) return [];
    const out: SectionChunk[] = [emit(buffer, current)];
    buffer = "";
    return out;
  }

  function currentFn(): TripSection | null {
    return current;
  }

  function lastCompleted(): TripSection | null {
    return lastDone;
  }

  function seen(): TripSection[] {
    return [...seenList];
  }

  return { push, flush, current: currentFn, lastCompleted, seen };
}

/**
 * Return the length of the longest suffix of `s` that is a strict prefix of
 * any section header token (e.g. "…BUD" → 3 because "BUD" prefixes "BUDGET").
 * Returns 0 when no such suffix. Used to avoid emitting a header's first
 * characters as body text when the delta split mid-header.
 */
function longestHeaderPrefixSuffix(s: string): number {
  const max = Math.max(...TRIP_SECTIONS.map((h) => h.length)) - 1;
  const limit = Math.min(s.length, max);
  for (let len = limit; len > 0; len--) {
    const suffix = s.slice(s.length - len);
    for (const header of TRIP_SECTIONS) {
      if (header.startsWith(suffix) && suffix.length < header.length) {
        return len;
      }
    }
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Test surface
// ---------------------------------------------------------------------------

export const __test__ = {
  SECTION_HEADER_RE,
  longestHeaderPrefixSuffix,
  countDays,
  coerceLanguage,
};

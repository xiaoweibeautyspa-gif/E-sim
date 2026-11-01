/**
 * CompleteYourTrip — the "Complete your trip" affiliate panel under a
 * streamed trip plan.
 *
 * Contract:
 *   - Props carry REAL affiliate links from the server (the `affiliates` SSE
 *     event shape in `server/routes/tripPlanner.ts`), or an empty list. The
 *     component NEVER fabricates a URL: if `links` is empty it renders
 *     nothing (`return null`), so callers can drop it in without a null check.
 *   - Each link is opened in a new tab with `rel="noopener noreferrer
 *     sponsored"` (sponsored = honest disclosure to search engines).
 *   - A short, plain-language affiliate disclosure is shown whenever the
 *     section is visible. We do not hide it behind a tooltip.
 *   - We accept links whose `slot` is one of the four known slots
 *     (`hotel|tour|transfer|insurance`). Unknown slots are filtered out
 *     defensively so a future server change can't render an unlabelled
 *     "→" ghost button.
 *
 * Design notes:
 *   - Purely presentational: no fetch, no state, no effects. Safe to render
 *     inside a streamed output that re-renders once per received event.
 *   - Mobile-first: single column on phones, two columns from `sm` up.
 *   - Matches the visual language of StayConnectedCard (rounded-2xl, ring,
 *     slate surfaces) so the two cards sit well together.
 *   - Accessible: a real `<section>` with an `aria-label`; each link is a
 *     real `<a>` so middle-click / cmd-click work. `data-testid` set on the
 *     section and per-slot links so route-level UI tests can assert what
 *     rendered and where it points.
 */

// ---------------------------------------------------------------------------
// Types — mirror the route's `AffiliateLink` shape so this file can be used
// directly from a saved trip payload later without a translation layer.
// ---------------------------------------------------------------------------

export type AffiliateSlot = "hotel" | "tour" | "transfer" | "insurance";

export interface AffiliateLink {
  slot: AffiliateSlot;
  label: string;
  url: string;
}

export interface CompleteYourTripProps {
  /** Real links from the server, or [] → renders nothing. */
  links: readonly AffiliateLink[];
  /** Heading level for the section title. Defaults to h2. */
  headingLevel?: 2 | 3;
  /** Optional heading override. Defaults to "Complete your trip". */
  heading?: string;
  /**
   * Copy for the affiliate disclosure. Default calls out that we may earn a
   * commission at no extra cost to the traveler — matching the spec's
   * "affiliate links" requirement without inventing affiliate IDs here.
   */
  disclosure?: string;
  /** Optional class appended to the outer section. */
  className?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const KNOWN_SLOTS: readonly AffiliateSlot[] = ["hotel", "tour", "transfer", "insurance"];

/**
 * Small glyph per slot so a horizontal scan is easy. Deliberately minimal
 * (single character in a rounded square) — the panel is not the hero, so we
 * keep the visual weight low.
 */
const SLOT_GLYPH: Record<AffiliateSlot, string> = {
  hotel: "🛏",
  tour: "🗺",
  transfer: "🚕",
  insurance: "🛡",
};

const DEFAULT_DISCLOSURE =
  "Some links are affiliate links. We may earn a commission at no extra cost to you.";

// ---------------------------------------------------------------------------
// Sanitisation
// ---------------------------------------------------------------------------

/**
 * Filter out rows that can't be rendered as a safe, labelled link. We keep
 * the check narrow: a link needs a known slot, a non-empty label and an
 * absolute http(s) URL. `javascript:` / `data:` URLs are dropped even though
 * the server controls the data, because a compromised admin row should not
 * become an XSS vector through this component.
 */
export function filterRenderableLinks(
  links: readonly AffiliateLink[],
): AffiliateLink[] {
  const out: AffiliateLink[] = [];
  for (const l of links) {
    if (!KNOWN_SLOTS.includes(l.slot)) continue;
    const label = (l.label ?? "").trim();
    const url = (l.url ?? "").trim();
    if (!label || !url) continue;
    if (!/^https?:\/\//i.test(url)) continue;
    out.push({ slot: l.slot, label, url });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function CompleteYourTrip({
  links,
  headingLevel = 2,
  heading = "Complete your trip",
  disclosure = DEFAULT_DISCLOSURE,
  className = "",
}: CompleteYourTripProps): JSX.Element | null {
  const renderable = filterRenderableLinks(links);
  if (renderable.length === 0) return null;

  const Heading = headingLevel === 3 ? "h3" : "h2";

  return (
    <section
      className={`rounded-2xl bg-white p-5 ring-1 ring-slate-200 ${className}`}
      aria-label={heading}
      data-testid="complete-your-trip"
      data-link-count={renderable.length}
    >
      <Heading className="text-base font-bold text-slate-900">{heading}</Heading>
      <p className="mt-1 text-sm text-slate-600">
        Book the rest of your trip with our partners.
      </p>

      <ul className="mt-3 grid gap-2 sm:grid-cols-2">
        {renderable.map((l) => (
          <li key={`${l.slot}-${l.url}`}>
            <a
              href={l.url}
              target="_blank"
              rel="noopener noreferrer sponsored"
              className="flex items-center gap-3 rounded-xl bg-slate-50 px-3 py-2.5 text-sm font-medium text-slate-800 ring-1 ring-slate-200 transition hover:bg-slate-100"
              data-testid={`complete-trip-link-${l.slot}`}
              data-slot={l.slot}
            >
              <span
                aria-hidden
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-white text-base ring-1 ring-slate-200"
              >
                {SLOT_GLYPH[l.slot]}
              </span>
              <span className="min-w-0 flex-1 truncate">{l.label}</span>
              <span aria-hidden className="text-slate-400">
                →
              </span>
            </a>
          </li>
        ))}
      </ul>

      <p className="mt-3 text-[11px] text-slate-400">{disclosure}</p>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Test surface
// ---------------------------------------------------------------------------

export const __test__ = {
  KNOWN_SLOTS,
  SLOT_GLYPH,
  DEFAULT_DISCLOSURE,
  filterRenderableLinks,
};

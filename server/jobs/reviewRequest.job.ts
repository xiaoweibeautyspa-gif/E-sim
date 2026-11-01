/**
 * Review request job (after trip).
 *
 * Trigger: a saved trip's end_date has passed AND we have not yet sent the
 * review request email for it. We intentionally wait until the return date
 * so the traveller has actually *used* the eSIM. If they're still in-country
 * (e.g. an extended trip), we include an "extend your eSIM" link — see the
 * review request copy below.
 *
 * We also reach out only to people who actually bought something from us:
 * `review_request_sent_at` is only meaningful if a qualifying order exists,
 * so the SELECT joins `orders` on the trip's owner. Conversely, we do NOT
 * ask for a review from guest trips that never produced an order (that would
 * be spam). If the join yields no row, the trip is skipped and logged.
 *
 * OUTPUT
 * ------
 * - One email per trip, category `review-request`.
 * - Push channel is NOT used. A review prompt is not time sensitive and push
 *   fatigue is real; email is enough.
 *
 * The write path (`markRequested`) sets `review_request_sent_at` on the trip
 * so the following tick will not send again. It runs only after a successful
 * email.
 *
 * SCOPE
 * -----
 * - Pure function `runReviewRequestOnce` with injectable deps.
 * - No DB writes outside the deps (see `markRequested`).
 * - The scheduler mirrors `departureReminder.job.ts`.
 */

import type { Pool } from "pg";
import { brand } from "../brand.config";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DueReviewTripRow {
  tripId: number;
  publicId: string;
  ownerEmail: string;
  userId: number | null;
  countries: string[];
  endDate: string; // YYYY-MM-DD
  /** Public slug for the /esim/[country] page that will host the review. */
  reviewCountrySlug: string | null;
}

export interface ReviewRequestRunRecord {
  startedAt: Date;
  finishedAt: Date | null;
  matched: number;
  sent: number;
  failed: number;
  skipped: number;
  error: string | null;
}

export interface ReviewRequestDeps {
  selectDueTrips(): Promise<DueReviewTripRow[]>;
  markRequested(tripId: number, at: Date): Promise<void>;
  sendEmail(input: {
    to: string;
    subject: string;
    html: string;
    text?: string;
    category?: string;
  }): Promise<void>;
  publicBaseUrl: string;
  now(): Date;
  log(line: string): void;
}

export interface ReviewRequestOptions {
  deps?: Partial<ReviewRequestDeps>;
  intervalMs?: number;
  onRun?: (record: ReviewRequestRunRecord) => void;
  runImmediately?: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Tick hourly; the query is cheap (indexed on (end_date, review_request_sent_at)). */
export const REVIEW_REQUEST_INTERVAL_MS = 60 * 60 * 1000;

/** Give the traveller a day after landing before nagging. */
export const REVIEW_REQUEST_GRACE_DAYS = 1;

export const REVIEW_REQUEST_CATEGORY = "review-request" as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function toUtcDateString(d: Date): string {
  const yyyy = d.getUTCFullYear().toString().padStart(4, "0");
  const mm = (d.getUTCMonth() + 1).toString().padStart(2, "0");
  const dd = d.getUTCDate().toString().padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Compute the review cutoff: trip.end_date must be <= this date (i.e. ended
 * on or before this day's start, allowing the grace period).
 */
export function reviewCutoff(now: Date): string {
  const cutoff = new Date(now.getTime() - REVIEW_REQUEST_GRACE_DAYS * 24 * 60 * 60 * 1000);
  return toUtcDateString(cutoff);
}

// ---------------------------------------------------------------------------
// Email template
// ---------------------------------------------------------------------------

export function buildReviewRequestEmail(
  trip: DueReviewTripRow,
  publicBaseUrl: string,
): { subject: string; html: string; text: string } {
  const countries = trip.countries.join(", ");
  const subject = `How was your eSIM in ${countries}?`;
  const reviewUrl = trip.reviewCountrySlug
    ? `${publicBaseUrl}/esim/${encodeURIComponent(trip.reviewCountrySlug)}#reviews`
    : `${publicBaseUrl}/reviews`;
  const myEsimsUrl = `${publicBaseUrl}/my-esims`;

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /></head>
<body style="margin:0;padding:24px;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#0f172a;">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:16px;padding:24px;box-shadow:0 1px 3px rgba(15,23,42,0.06);">
    <p style="margin:0 0 8px;font-size:12px;letter-spacing:0.06em;text-transform:uppercase;color:#1b6ef5;font-weight:600;">${brand.name}</p>
    <h1 style="margin:0 0 12px;font-size:22px;line-height:1.3;color:#0f172a;">Welcome back from ${escapeHtml(countries)}</h1>
    <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#334155;">
      We hope your eSIM worked everywhere you needed it. It takes 30 seconds
      to leave a quick review — it really helps the next traveller pick the
      right plan.
    </p>
    <a href="${escapeHtml(reviewUrl)}" style="display:inline-block;background:#1b6ef5;color:#ffffff;text-decoration:none;font-weight:600;font-size:14px;padding:10px 16px;border-radius:12px;margin:0 8px 8px 0;">Leave a review</a>
    <a href="${escapeHtml(myEsimsUrl)}" style="display:inline-block;background:#ffffff;color:#1b6ef5;text-decoration:none;font-weight:600;font-size:14px;padding:10px 16px;border-radius:12px;border:1px solid #1b6ef5;margin:0 0 8px 0;">Manage my eSIMs</a>
    <p style="margin:24px 0 0;font-size:12px;color:#64748b;">
      Already have another trip booked? Grab a fresh eSIM any time.
    </p>
  </div>
</body></html>`;

  const text = [
    `${brand.name} – welcome back from ${countries}`,
    "",
    "Thanks for travelling with us. Leave a quick review to help the next traveller:",
    reviewUrl,
    "",
    `Manage your eSIMs: ${myEsimsUrl}`,
  ].join("\n");

  return { subject, html, text };
}

// ---------------------------------------------------------------------------
// Default deps
// ---------------------------------------------------------------------------

class DepMissingError extends Error {
  readonly dep: string;
  constructor(dep: string, detail: string) {
    super(`reviewRequest: ${dep} unavailable — ${detail}`);
    this.name = "DepMissingError";
    this.dep = dep;
  }
}

async function loadDefaultWiring(): Promise<{
  selectDueTrips: ReviewRequestDeps["selectDueTrips"];
  markRequested: ReviewRequestDeps["markRequested"];
  sendEmail: ReviewRequestDeps["sendEmail"];
  publicBaseUrl: string;
}> {
  const [dbMod, notifyMod, envMod] = await Promise.all([
    import("../db/client").catch((e) => {
      throw new DepMissingError("db/client", e instanceof Error ? e.message : "import failed");
    }),
    import("../services/notifications").catch((e) => {
      throw new DepMissingError("notifications", e instanceof Error ? e.message : "import failed");
    }),
    import("../config/env").catch(() => null),
  ]);

  const db = dbMod as unknown as { getPool?: () => Pool; pool?: Pool };
  const pool = db.getPool?.() ?? db.pool ?? null;
  if (!pool) throw new DepMissingError("db/client", "no getPool()/pool export");

  const notif = notifyMod as unknown as {
    sendEmail?: ReviewRequestDeps["sendEmail"];
  };
  const sendEmail: ReviewRequestDeps["sendEmail"] =
    typeof notif.sendEmail === "function"
      ? notif.sendEmail
      : async () => {
          throw new DepMissingError(
            "notifications.sendEmail",
            "not exported by server/services/notifications.ts",
          );
        };

  const env = envMod as unknown as {
    loadEnv?: () => { raw?: Record<string, string | undefined> };
    getEnvValue?: (k: string) => string | undefined;
  } | null;
  const publicBaseUrl =
    env?.getEnvValue?.("PUBLIC_BASE_URL") ??
    env?.loadEnv?.().raw?.PUBLIC_BASE_URL ??
    process.env.PUBLIC_BASE_URL ??
    "";

  return {
    async selectDueTrips() {
      const cutoff = reviewCutoff(new Date());
      // The join asserts a paid order exists for the trip's owner email —
      // otherwise, skip the trip (guests who never bought anything).
      const sql = `
        SELECT t.id              AS "tripId",
               t.public_id       AS "publicId",
               t.owner_email     AS "ownerEmail",
               t.user_id         AS "userId",
               t.countries       AS "countries",
               t.end_date        AS "endDate",
               (
                 SELECT p.country_slug
                   FROM packages p
                  WHERE p.country_slug IS NOT NULL
                    AND p.country_slug = ANY(
                      SELECT LOWER(unnest(t.countries))
                    )
                  LIMIT 1
               )                 AS "reviewCountrySlug"
          FROM trips t
         WHERE t.review_request_sent_at IS NULL
           AND t.end_date <= $1
           AND t.owner_email IS NOT NULL
           AND t.owner_email <> ''
           AND EXISTS (
                 SELECT 1 FROM orders o
                  WHERE LOWER(o.buyer_email) = LOWER(t.owner_email)
                    AND o.status = 'paid'
               )
         ORDER BY t.end_date ASC, t.id ASC
         LIMIT 200;
      `;
      const res = await pool.query(sql, [cutoff]);
      return res.rows.map((r: Record<string, unknown>) => ({
        tripId: Number(r.tripId),
        publicId: String(r.publicId),
        ownerEmail: String(r.ownerEmail ?? ""),
        userId: r.userId == null ? null : Number(r.userId),
        countries: Array.isArray(r.countries)
          ? (r.countries as string[])
          : typeof r.countries === "string"
            ? (JSON.parse(r.countries) as string[])
            : [],
        endDate: String(r.endDate),
        reviewCountrySlug:
          r.reviewCountrySlug == null ? null : String(r.reviewCountrySlug),
      }));
    },

    async markRequested(tripId, at) {
      await pool.query(
        `UPDATE trips SET review_request_sent_at = $1, updated_at = now() WHERE id = $2`,
        [at.toISOString(), tripId],
      );
    },

    sendEmail,
    publicBaseUrl,
  };
}

let defaultDepsPromise: Promise<ReviewRequestDeps> | null = null;
async function getDefaultDeps(): Promise<ReviewRequestDeps> {
  if (!defaultDepsPromise) {
    defaultDepsPromise = (async () => {
      const w = await loadDefaultWiring();
      return {
        selectDueTrips: w.selectDueTrips,
        markRequested: w.markRequested,
        sendEmail: w.sendEmail,
        publicBaseUrl: w.publicBaseUrl,
        now: () => new Date(),
        log: (line: string) => console.log(line),
      };
    })();
  }
  return defaultDepsPromise;
}

// ---------------------------------------------------------------------------
// Run once
// ---------------------------------------------------------------------------

export async function runReviewRequestOnce(
  options: ReviewRequestOptions = {},
): Promise<ReviewRequestRunRecord> {
  const startedAt = new Date();
  const record: ReviewRequestRunRecord = {
    startedAt,
    finishedAt: null,
    matched: 0,
    sent: 0,
    failed: 0,
    skipped: 0,
    error: null,
  };

  let deps: ReviewRequestDeps;
  try {
    const defaults = await getDefaultDeps();
    deps = { ...defaults, ...(options.deps ?? {}) };
  } catch (err) {
    record.error = err instanceof Error ? err.message : "could not resolve default deps";
    record.finishedAt = new Date();
    options.onRun?.(record);
    console.error(`[reviewRequest] ${record.error}`);
    return record;
  }

  let due: DueReviewTripRow[] = [];
  try {
    due = await deps.selectDueTrips();
    record.matched = due.length;
  } catch (err) {
    record.error =
      err instanceof Error ? `selectDueTrips: ${err.message}` : "selectDueTrips failed";
    record.finishedAt = new Date();
    deps.log(`[reviewRequest] ${record.error}`);
    options.onRun?.(record);
    return record;
  }

  for (const trip of due) {
    if (!trip.ownerEmail || !trip.ownerEmail.includes("@")) {
      record.skipped += 1;
      deps.log(`[reviewRequest] trip ${trip.publicId} has no owner email; skipping`);
      continue;
    }
    const { subject, html, text } = buildReviewRequestEmail(trip, deps.publicBaseUrl);
    try {
      await deps.sendEmail({
        to: trip.ownerEmail,
        subject,
        html,
        text,
        category: REVIEW_REQUEST_CATEGORY,
      });
      await deps.markRequested(trip.tripId, deps.now());
      record.sent += 1;
    } catch (err) {
      record.failed += 1;
      deps.log(
        `[reviewRequest] send failed for trip ${trip.publicId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  record.finishedAt = new Date();
  deps.log(
    `[reviewRequest] matched=${record.matched} sent=${record.sent} ` +
      `failed=${record.failed} skipped=${record.skipped}`,
  );
  options.onRun?.(record);
  return record;
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

let timer: NodeJS.Timeout | null = null;
let running = false;
let lastRun: ReviewRequestRunRecord | null = null;

export function getLastReviewRequestRun(): ReviewRequestRunRecord | null {
  return lastRun;
}

export function startReviewRequestJob(options: ReviewRequestOptions = {}): void {
  if (timer) {
    (options.deps?.log ?? console.log)(
      "[reviewRequest] already started; ignoring duplicate start",
    );
    return;
  }
  const interval = Math.max(60_000, options.intervalMs ?? REVIEW_REQUEST_INTERVAL_MS);

  const tick = async () => {
    if (running) {
      (options.deps?.log ?? console.log)(
        "[reviewRequest] previous run still in flight; skipping",
      );
      return;
    }
    running = true;
    try {
      lastRun = await runReviewRequestOnce({
        deps: options.deps,
        onRun: (r) => {
          lastRun = r;
          options.onRun?.(r);
        },
      });
    } finally {
      running = false;
    }
  };

  timer = setInterval(() => {
    void tick();
  }, interval);
  timer.unref?.();
  (options.deps?.log ?? console.log)(
    `[reviewRequest] scheduled every ${interval}ms`,
  );
  if (options.runImmediately) void tick();
}

export function stopReviewRequestJob(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

export function __resetReviewRequestStateForTests(): void {
  stopReviewRequestJob();
  defaultDepsPromise = null;
  running = false;
  lastRun = null;
}

export const __test__ = {
  escapeHtml,
  toUtcDateString,
  buildReviewRequestEmail,
  reviewCutoff,
  REVIEW_REQUEST_GRACE_DAYS,
  REVIEW_REQUEST_CATEGORY,
};

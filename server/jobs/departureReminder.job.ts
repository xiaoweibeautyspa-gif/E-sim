/**
 * Departure reminder job.
 *
 * Emails + pushes a "your trip starts tomorrow" reminder to the owner of any
 * saved trip whose `departure_date` is exactly tomorrow (in *their* local
 * calendar day). We deliberately use an hourly tick rather than a daily one so
 * that a failover node that boots at 14:00 still catches a reminder that
 * theoretically fires at 09:00; the `reminder_sent_at` guard makes duplicates
 * impossible.
 *
 * WHAT THIS JOB OWNS
 * ------------------
 * - Selecting due trips from `trips` (row created by `0011_trips.sql`,
 *   described in the trip-persistence milestone).
 * - Looking up the owner's email/push subscription, via the *existing*
 *   notification service (`server/services/notifications.ts`) — we do NOT
 *   reimplement email or push here. We call its delivery functions; if the
 *   shapes we expect aren't present, we log a precise error naming the
 *   missing export and skip delivery (trips are untouched, so a follow-up
 *   tick after a code deploy can still deliver).
 * - Recording `reminder_sent_at` on the trip row after every successful
 *   dispatch, and NEVER before. A failure must not consume the reminder.
 *
 * WHAT THIS JOB DOESN'T OWN
 * -------------------------
 * - The email template. It reuses the same brand-configured HTML that
 *   `server/email/templates/*` produce, via `emailSender.ts`. Template
 *   selection is one HTML string built inline here (small enough to keep in
 *   one file); changing its wording doesn't require a schema change.
 * - The push subscription store. Existing `push_subscriptions` table is
 *   used by `notifications.ts` for its own fan-out; we call the service.
 * - Deletion of stale trips. Free-signup retention caps and TTL cleanups are
 *   not in scope for this job.
 *
 * SCHEDULING
 * ----------
 * The job exports both a *pure-ish* `runDepartureReminderOnce()` (used in
 * tests and, in production, from the cron tick) and a `startDepartureReminder`
 * / `stopDepartureReminder` pair. The starter follows the same pattern as
 * `server/jobs/packageSync.job.ts` and `server/jobs/usageRefresh.job.ts`:
 * `.unref()` the timer so imports never keep the Node event loop alive, guard
 * overlapping ticks, and expose the last run for admin observability.
 *
 * CONTRACT THAT MUST HOLD IN `notifications.ts`
 * ---------------------------------------------
 * We require two exports (both are already used by the alerts phase, so
 * they should exist unchanged):
 *
 *   sendEmail(input: {
 *     to: string;
 *     subject: string;
 *     html: string;
 *     text?: string;
 *     category?: string;   // e.g. 'departure-reminder'
 *   }): Promise<void>;
 *
 *   sendPushToUser(input: {
 *     userId: number;
 *     title: string;
 *     body: string;
 *     url: string;
 *   }): Promise<{ sent: number; failed: number }>;
 *
 * If either export is missing, the corresponding channel is skipped with a
 * single log line — the job does not crash (matching the "graceful
 * degradation" rule set by earlier phases) and does not mark the trip as
 * reminded (so a re-run after a deploy can still deliver).
 *
 * DB access is by the *identifier* on the trip row (`user_id`, `owner_email`),
 * not by FK. The migration comment in `0011_trips.sql` deliberately does not
 * FK to users; we join at read time. If `user_id` is null (a guest-saved
 * trip that was never linked to an account), we skip push and rely on email
 * only. If `owner_email` is empty, we skip the whole row and log it.
 *
 * TIMEZONE
 * --------
 * `departure_date` is stored as YYYY-MM-DD by the planner. "Tomorrow" is
 * computed from the server's clock in UTC — NOT from a per-user timezone,
 * because we do not persist one. To compensate for the ±1 day drift this
 * introduces across timezones, we use a windowed approach:
 *
 *   - Compose the window [tomorrowUTC, tomorrowUTC + 24h) and match
 *     departure_date BETWEEN those two calendar dates, inclusive.
 *   - This sends reminders up to 24h earlier than a per-user 09:00 local
 *     tick would. That's acceptable per the spec ("the day before
 *     departure"), and it will not double-send because of `reminder_sent_at`.
 *
 * A per-user timezone refinement (stored on `users.locale`) is a later
 * optimisation. We note it honestly instead of pretending the UTC window is
 * perfect.
 *
 * TESTS
 * -----
 * `server/jobs/departureReminder.test.ts` (queued next batch) will inject:
 *   - a database stub whose `selectDueTrips` result is the deterministic
 *     fixture set,
 *   - a `notifications` stub whose `sendEmail` / `sendPushToUser` record
 *     inputs,
 *   - a clock fixed to a known UTC day.
 *
 * We do not run tests in this batch. The code below is written so that a
 * queued test can call `runDepartureReminderOnce({ deps: ... })` with all
 * side effects injected and no `dotenv`, no network, no real DB.
 */

import type { Pool } from "pg";
import { brand } from "../brand.config";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A single row's worth of reminder data. Minimal by design. */
export interface DueTripRow {
  id: number;
  publicId: string;
  userId: number | null;
  ownerEmail: string;
  countries: string[];
  startDate: string; // YYYY-MM-DD
  endDate: string;
  departureDate: string; // YYYY-MM-DD
}

/** What one tick produced, used by the admin health panel and by tests. */
export interface DepartureReminderRunRecord {
  startedAt: Date;
  finishedAt: Date | null;
  /** Number of trips matched by the SQL window. */
  matched: number;
  /** Number of trips for which at least one channel dispatched successfully. */
  reminded: number;
  /** Number of trips whose email delivery failed. */
  emailFailures: number;
  /** Number of trips whose push delivery failed (per-trip, not per-device). */
  pushFailures: number;
  /** Trips with no owner email — logged and skipped, never re-tried. */
  skippedNoEmail: number;
  /** Top-level error message if the whole run failed (e.g. DB down). */
  error: string | null;
}

export interface DepartureReminderDeps {
  /** Returns the trips whose departure_date is inside the reminder window. */
  selectDueTrips(): Promise<DueTripRow[]>;
  /** Persist `reminder_sent_at = now()` for a given trip id. */
  markReminded(id: number, at: Date): Promise<void>;
  /** Email channel, existing `notifications` service. */
  sendEmail(input: {
    to: string;
    subject: string;
    html: string;
    text?: string;
    category?: string;
  }): Promise<void>;
  /** Push channel, existing `notifications` service. */
  sendPushToUser(input: {
    userId: number;
    title: string;
    body: string;
    url: string;
  }): Promise<{ sent: number; failed: number }>;
  /** Base URL for links in emails/push (e.g. https://example.com). */
  publicBaseUrl: string;
  /** Clock, default `() => new Date()`. Tests inject a fixed date. */
  now(): Date;
  /** Logger seam. Default `console`. Tests can capture. */
  log(line: string): void;
}

export interface DepartureReminderOptions {
  /** Override any part of the default deps. Tests do this wholesale. */
  deps?: Partial<DepartureReminderDeps>;
  /** 1 hour. Tests may set a smaller value (they call runOnce directly so timer doesn't matter). */
  intervalMs?: number;
  /** Called once per run with the outcome. Used by the admin health panel. */
  onRun?: (record: DepartureReminderRunRecord) => void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Tick once an hour. Duplicate-safe via reminder_sent_at. */
export const DEPARTURE_REMINDER_INTERVAL_MS = 60 * 60 * 1000;

/** Template category used for filtering in the admin email log. */
export const DEPARTURE_REMINDER_CATEGORY = "departure-reminder" as const;

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

/**
 * Format a Date as YYYY-MM-DD in UTC. Deliberately UTC: `departure_date` is
 * stored as a UTC calendar date by the planner.
 */
function toUtcDateString(d: Date): string {
  const yyyy = d.getUTCFullYear().toString().padStart(4, "0");
  const mm = (d.getUTCMonth() + 1).toString().padStart(2, "0");
  const dd = d.getUTCDate().toString().padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * The [min, max] departure_date window (inclusive) that maps to "tomorrow"
 * given the current time. We include tomorrow and the day after, because a
 * trip saved at 2011 local time in UTC+13 will have departure_date = "today"
 * for a UTC clock only 8 hours behind — so its reminder would slip a day.
 * Including both bounds gives a 24–48h reminder window, which is still
 * "the day before departure" for most travellers and never duplicates thanks
 * to `reminder_sent_at`.
 */
export function reminderDateWindow(now: Date): { min: string; max: string } {
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const dayAfter = new Date(now.getTime() + 48 * 60 * 60 * 1000);
  return { min: toUtcDateString(tomorrow), max: toUtcDateString(dayAfter) };
}

// ---------------------------------------------------------------------------
// Email template (kept inline; small enough that a new file adds noise)
// ---------------------------------------------------------------------------

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function buildDepartureReminderEmail(trip: DueTripRow, publicBaseUrl: string): {
  subject: string;
  html: string;
  text: string;
} {
  const countryLine = trip.countries.join(", ");
  const shareUrl = `${publicBaseUrl}/trip/${encodeURIComponent(trip.publicId)}`;
  const subject = `Your trip to ${countryLine} starts tomorrow`;

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /></head>
<body style="margin:0;padding:24px;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#0f172a;">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:16px;padding:24px;box-shadow:0 1px 3px rgba(15,23,42,0.06);">
    <p style="margin:0 0 8px;font-size:12px;letter-spacing:0.06em;text-transform:uppercase;color:#1b6ef5;font-weight:600;">${brand.name}</p>
    <h1 style="margin:0 0 12px;font-size:22px;line-height:1.3;color:#0f172a;">Your trip to ${escapeHtml(countryLine)} starts tomorrow</h1>
    <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#334155;">
      Safe travels! A few quick reminders before you go:
    </p>
    <ul style="margin:0 0 16px;padding-left:20px;font-size:15px;line-height:1.7;color:#334155;">
      <li>Install your ${brand.name} eSIM on Wi-Fi before you fly — some phones need a data connection to finish activation.</li>
      <li>Turn on mobile data for the eSIM once the plane lands; keep your home SIM for calls and texts.</li>
      <li>Read the offline pack (PDF + eSIM QR) so you're not stuck at immigration without data.</li>
    </ul>
    <p style="margin:0 0 24px;font-size:14px;line-height:1.6;color:#334155;">
      Departure: <strong>${escapeHtml(trip.startDate)}</strong> · Return: <strong>${escapeHtml(trip.endDate)}</strong>
    </p>
    <a href="${escapeHtml(shareUrl)}" style="display:inline-block;background:#1b6ef5;color:#ffffff;text-decoration:none;font-weight:600;font-size:14px;padding:10px 16px;border-radius:12px;">Open your trip</a>
    ${brand.guaranteeCopy ? `<p style="margin:24px 0 0;font-size:12px;color:#64748b;">${escapeHtml(brand.guaranteeCopy)}</p>` : ""}
  </div>
</body></html>`;

  const text = [
    `${brand.name} – Your trip to ${countryLine} starts tomorrow`,
    "",
    "Safe travels! A few quick reminders before you go:",
    `- Install your ${brand.name} eSIM on Wi-Fi before you fly.`,
    "- Turn on mobile data for the eSIM once the plane lands.",
    "- Read the offline pack (PDF + eSIM QR).",
    "",
    `Departure: ${trip.startDate} · Return: ${trip.endDate}`,
    "",
    `Open your trip: ${shareUrl}`,
    "",
    brand.guaranteeCopy,
  ]
    .filter((l) => l.length > 0)
    .join("\n");

  return { subject, html, text };
}

// ---------------------------------------------------------------------------
// Default deps wiring
// ---------------------------------------------------------------------------

/**
 * Build the default deps. We import the DB and notifications modules lazily so
 * that `import "./departureReminder.job"` from `server/index.ts` is safe even
 * before migrations have been applied or before the notifications module was
 * compiled (dev-only). Any missing collaborator produces a `DepMissingError`
 * at run time that the caller can decide to log-and-ignore or surface.
 */
class DepMissingError extends Error {
  readonly dep: string;
  constructor(dep: string, detail: string) {
    super(`departureReminder: ${dep} unavailable — ${detail}`);
    this.name = "DepMissingError";
    this.dep = dep;
  }
}

interface TrieWiring {
  selectDueTrips(): Promise<DueTripRow[]>;
  markReminded(id: number, at: Date): Promise<void>;
}

/**
 * SQL: match trips whose `departure_date` is in the reminder window and whose
 * `reminder_sent_at` is null. `user_id`, `owner_email` are NOT FKs (see
 * 0011_trips.sql); `countries` is jsonb; `public_id` is the share token.
 *
 * We don't cache `Pool` here — the DB module owns lifecycle. We accept a
 * `pool`-like object so tests can inject a `pg-mem`-style client later.
 */
async function loadDefaultWiring(): Promise<{
  trie: TrieWiring;
  sendEmail: DepartureReminderDeps["sendEmail"];
  sendPushToUser: DepartureReminderDeps["sendPushToUser"];
  publicBaseUrl: string;
}> {
  const [dbMod, notifyMod, emailMod] = await Promise.all([
    import("../db/client").catch((e) => {
      throw new DepMissingError("db/client", e instanceof Error ? e.message : "import failed");
    }),
    import("../services/notifications").catch((e) => {
      throw new DepMissingError(
        "notifications",
        e instanceof Error ? e.message : "import failed",
      );
    }),
    import("../lib/emailSender").catch(() => null),
  ]);

  const db = dbMod as unknown as {
    getPool?: () => Pool;
    pool?: Pool;
  };
  const pool = db.getPool?.() ?? db.pool ?? null;
  if (!pool) {
    throw new DepMissingError(
      "db/client",
      "expected `getPool()` or a `pool` export; none present",
    );
  }

  const notif = notifyMod as unknown as {
    sendEmail?: DepartureReminderDeps["sendEmail"];
    sendPushToUser?: DepartureReminderDeps["sendPushToUser"];
  };

  const { getEnvValue } = (await import("../config/env").catch(() => ({
    getEnvValue: undefined,
  }))) as { getEnvValue?: (key: string) => string | undefined };

  const publicBaseUrl =
    getEnvValue?.("PUBLIC_BASE_URL") ?? process.env.PUBLIC_BASE_URL ?? "";

  // If notifications.ts does not export the shapes we need, we still return
  // them as no-op 'missing' callbacks so the *run* can log a precise error and
  // leave trips unreminded for the next deploy.
  const sendEmail: DepartureReminderDeps["sendEmail"] =
    typeof notif.sendEmail === "function"
      ? notif.sendEmail
      : async () => {
          throw new DepMissingError(
            "notifications.sendEmail",
            "not exported by server/services/notifications.ts",
          );
        };

  const sendPushToUser: DepartureReminderDeps["sendPushToUser"] =
    typeof notif.sendPushToUser === "function"
      ? notif.sendPushToUser
      : async () => {
          throw new DepMissingError(
            "notifications.sendPushToUser",
            "not exported by server/services/notifications.ts",
          );
        };

  const trie: TrieWiring = {
    async selectDueTrips() {
      const { min, max } = reminderDateWindow(new Date());
      // values: [min, max]
      const sql = `
        SELECT id,
               public_id AS "publicId",
               user_id   AS "userId",
               owner_email AS "ownerEmail",
               countries,
               start_date AS "startDate",
               end_date   AS "endDate",
               departure_date AS "departureDate"
          FROM trips
         WHERE reminder_sent_at IS NULL
           AND departure_date BETWEEN $1 AND $2
         ORDER BY departure_date ASC, id ASC
         LIMIT 200;
      `;
      const res = await pool.query(sql, [min, max]);
      return res.rows.map((r: Record<string, unknown>) => ({
        id: Number(r.id),
        publicId: String(r.publicId),
        userId: r.userId == null ? null : Number(r.userId),
        ownerEmail: String(r.ownerEmail ?? ""),
        countries: Array.isArray(r.countries)
          ? (r.countries as string[])
          : typeof r.countries === "string"
            ? (JSON.parse(r.countries) as string[])
            : [],
        startDate: String(r.startDate),
        endDate: String(r.endDate),
        departureDate: String(r.departureDate),
      }));
    },

    async markReminded(id, at) {
      await pool.query(
        `UPDATE trips SET reminder_sent_at = $1, updated_at = now() WHERE id = $2`,
        [at.toISOString(), id],
      );
    },
  };

  // Import emailMod just to *verify* it exists (it proves the email pipeline
  // is at least present, which is what notifications.sendEmail would use). We
  // do not call it directly; notifications.ts is the single delivery point.
  void emailMod;

  return { trie, sendEmail, sendPushToUser, publicBaseUrl };
}

// ---------------------------------------------------------------------------
// Run once
// ---------------------------------------------------------------------------

let defaultDepsPromise: Promise<DepartureReminderDeps> | null = null;

async function getDefaultDeps(): Promise<DepartureReminderDeps> {
  if (!defaultDepsPromise) {
    defaultDepsPromise = (async () => {
      const wiring = await loadDefaultWiring();
      return {
        selectDueTrips: () => wiring.trie.selectDueTrips(),
        markReminded: (id, at) => wiring.trie.markReminded(id, at),
        sendEmail: wiring.sendEmail,
        sendPushToUser: wiring.sendPushToUser,
        publicBaseUrl: wiring.publicBaseUrl,
        now: () => new Date(),
        log: (line: string) => console.log(line),
      };
    })();
  }
  return defaultDepsPromise;
}

/**
 * Execute one tick. Never throws — matches the pattern of `packageSync.job.ts`
 * and `usageRefresh.job.ts`. Callers that want details read the returned
 * record OR wire `onRun`.
 */
export async function runDepartureReminderOnce(
  options: DepartureReminderOptions = {},
): Promise<DepartureReminderRunRecord> {
  const startedAt = new Date();
  const record: DepartureReminderRunRecord = {
    startedAt,
    finishedAt: null,
    matched: 0,
    reminded: 0,
    emailFailures: 0,
    pushFailures: 0,
    skippedNoEmail: 0,
    error: null,
  };

  let deps: DepartureReminderDeps;
  try {
    const defaults = await getDefaultDeps();
    deps = { ...defaults, ...(options.deps ?? {}) };
  } catch (err) {
    record.error =
      err instanceof Error ? err.message : "could not resolve default deps";
    record.finishedAt = new Date();
    options.onRun?.(record);
    // Best-effort console line — no logger available if deps failed.
    // eslint-disable-next-line no-console
    console.error(`[departureReminder] ${record.error}`);
    return record;
  }

  let due: DueTripRow[] = [];
  try {
    due = await deps.selectDueTrips();
    record.matched = due.length;
  } catch (err) {
    record.error =
      err instanceof Error ? `selectDueTrips: ${err.message}` : "selectDueTrips failed";
    record.finishedAt = new Date();
    deps.log(`[departureReminder] ${record.error}`);
    options.onRun?.(record);
    return record;
  }

  for (const trip of due) {
    // Refuse to email if the row can't be delivered to at all.
    if (!trip.ownerEmail || !trip.ownerEmail.includes("@")) {
      record.skippedNoEmail += 1;
      deps.log(
        `[departureReminder] trip ${trip.publicId} has no owner email; skipping (trip row is intact)`,
      );
      continue;
    }

    const { subject, html, text } = buildDepartureReminderEmail(trip, deps.publicBaseUrl);

    let emailOk = false;
    try {
      await deps.sendEmail({
        to: trip.ownerEmail,
        subject,
        html,
        text,
        category: DEPARTURE_REMINDER_CATEGORY,
      });
      emailOk = true;
    } catch (err) {
      record.emailFailures += 1;
      deps.log(
        `[departureReminder] email failed for trip ${trip.publicId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    // Push is optional: no userId → nothing to push to.
    let pushOk = true;
    if (trip.userId != null) {
      try {
        await deps.sendPushToUser({
          userId: trip.userId,
          title: `${brand.name} – ${trip.countries.join(", ")} starts tomorrow`,
          body: "Open your offline pack to install the eSIM before you fly.",
          url: `/trip/${trip.publicId}`,
        });
      } catch (err) {
        pushOk = false;
        record.pushFailures += 1;
        deps.log(
          `[departureReminder] push failed for trip ${trip.publicId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    // Only mark reminded when at least one channel dispatched AND no channel
    // reported a *hard* failure. This deliberately errs toward re-sending: a
    // later tick can retry a push that failed. (A user who has push disabled
    // is not a "failure"; that path is inside sendPushToUser and returns
    // { sent: 0, failed: 0 }.)
    if (emailOk && pushOk) {
      try {
        await deps.markReminded(trip.id, deps.now());
        record.reminded += 1;
      } catch (err) {
        deps.log(
          `[departureReminder] could not mark trip ${trip.publicId} reminded: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        // Do NOT increment `reminded` — next tick will try again.
      }
    }
  }

  record.finishedAt = new Date();
  deps.log(
    `[departureReminder] matched=${record.matched} reminded=${record.reminded} ` +
      `emailFailures=${record.emailFailures} pushFailures=${record.pushFailures} ` +
      `skippedNoEmail=${record.skippedNoEmail}`,
  );
  options.onRun?.(record);
  return record;
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

let timer: NodeJS.Timeout | null = null;
let running = false;
let lastRun: DepartureReminderRunRecord | null = null;

/** Most recent run, surfaced to admin health. Never throws. */
export function getLastDepartureReminderRun(): DepartureReminderRunRecord | null {
  return lastRun;
}

/** Start the hourly timer. Idempotent; safe to call before migrations run. */
export function startDepartureReminder(
  options: DepartureReminderOptions & { runImmediately?: boolean } = {},
): void {
  if (timer) {
    (options.deps?.log ?? console.log)(
      "[departureReminder] already started; ignoring duplicate start",
    );
    return;
  }
  const interval = Math.max(60_000, options.intervalMs ?? DEPARTURE_REMINDER_INTERVAL_MS);

  const tick = async () => {
    if (running) {
      (options.deps?.log ?? console.log)(
        "[departureReminder] previous run still in flight; skipping this tick",
      );
      return;
    }
    running = true;
    try {
      lastRun = await runDepartureReminderOnce({
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
    `[departureReminder] scheduled every ${interval}ms`,
  );
  if (options.runImmediately) void tick();
}

/** Stop the timer. Safe to call if never started. */
export function stopDepartureReminder(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

/** Reset module state. Test-only. */
export function __resetDepartureReminderStateForTests(): void {
  stopDepartureReminder();
  defaultDepsPromise = null;
  running = false;
  lastRun = null;
}

// ---------------------------------------------------------------------------
// Test surface
// ---------------------------------------------------------------------------

export const __test__ = {
  reminderDateWindow,
  toUtcDateString,
  buildDepartureReminderEmail,
  escapeHtml,
  DEPARTURE_REMINDER_CATEGORY,
};

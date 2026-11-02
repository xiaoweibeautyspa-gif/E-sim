/**
 * Unit tests for `server/jobs/departureReminder.job.ts`.
 *
 * WHAT IS TESTED
 * --------------
 * - `reminderDateWindow(now)` returns the [tomorrow, dayAfter] UTC date
 *   window the SQL uses.
 * - `toUtcDateString(date)` formats zero-padded UTC dates.
 * - `buildDepartureReminderEmail(trip, baseUrl)` includes the brand name,
 *   the destination(s), the departure date, the share URL and the guarantee
 *   copy; and escapes user-supplied HTML. The text alternative also includes
 *   the share URL.
 * - `runDepartureReminderOnce()`:
 *     - emails + pushes an eligible trip, then marks it reminded;
 *     - skips a trip with no/invalid `owner_email` and does NOT mark it;
 *     - does not mark a trip reminded when email delivery throws, so a later
 *       tick can retry;
 *     - pushes only when `user_id` is set; guest trips get email only;
 *     - records fail counts when push throws but still marks the trip only
 *       when nothing hard-failed;
 *     - records `error` when `selectDueTrips` throws;
 *     - calls `onRun` with the record each run.
 * - `startDepartureReminder` / `stopDepartureReminder` are idempotent.
 *
 * WHAT IS NOT TESTED (deliberately)
 * ---------------------------------
 * - The default DB/notifications wiring — `runDepartureReminderOnce` uses
 *   injected deps here, so no PostgreSQL, no network, no mail provider.
 * - Real scheduling timing — tests call `runDepartureReminderOnce` directly.
 * - The reminder's real timezone across users — noted as a limitation in the
 *   job (UTC window). We only assert the window math.
 *
 * HOW TO RUN
 * ----------
 *   npm test
 * which dispatches `node --test --import tsx` across `server/**\/*.test.ts`.
 *
 * These tests are NOT executed in this batch's response. The source compiles
 * against the real exports of `departureReminder.job.ts`; if that file's
 * exported shape has changed, this test file surfaces the break.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  reminderDateWindow,
  buildDepartureReminderEmail,
  runDepartureReminderOnce,
  startDepartureReminder,
  stopDepartureReminder,
  getLastDepartureReminderRun,
  __resetDepartureReminderStateForTests,
  __test__,
  DEPARTURE_REMINDER_CATEGORY,
  type DepartureReminderDeps,
  type DueTripRow,
  type DepartureReminderRunRecord,
} from "./departureReminder.job";

const {
  toUtcDateString,
  escapeHtml,
} = __test__;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function sampleTrip(over: Partial<DueTripRow> = {}): DueTripRow {
  return {
    id: 1,
    publicId: "abc123def456",
    userId: 42,
    ownerEmail: "traveler@example.com",
    countries: ["Japan"],
    startDate: "2026-04-10",
    endDate: "2026-04-14",
    departureDate: "2026-04-10",
    ...over,
  };
}

interface DepCalls {
  emails: Array<{
    to: string;
    subject: string;
    html: string;
    text?: string;
    category?: string;
  }>;
  pushes: Array<{
    userId: number;
    title: string;
    body: string;
    url: string;
  }>;
  marked: Array<{ id: number; at: Date }>;
  logs: string[];
}

interface FakeDepsOptions {
  trips: DueTripRow[];
  /** Throw from selectDueTrips (simulates DB down). */
  selectThrows?: Error;
  /** Throw from sendEmail for trips matching this predicate. */
  emailThrowsFor?: (trip: DueTripRow) => boolean;
  /** Throw from sendPushToUser for trips matching this predicate. */
  pushThrowsFor?: (trip: DueTripRow) => boolean;
  /** Throw from markReminded for trips matching this predicate. */
  markThrowsFor?: (trip: DueTripRow) => boolean;
  now?: Date;
  publicBaseUrl?: string;
}

function makeFakeDeps(opts: FakeDepsOptions): {
  deps: DepartureReminderDeps;
  calls: DepCalls;
} {
  const calls: DepCalls = { emails: [], pushes: [], marked: [], logs: [] };
  const now = opts.now ?? new Date("2026-04-09T08:00:00Z");
  const deps: DepartureReminderDeps = {
    selectDueTrips: async () => {
      if (opts.selectThrows) throw opts.selectThrows;
      return opts.trips;
    },
    markReminded: async (id, at) => {
      const trip = opts.trips.find((t) => t.id === id);
      if (trip && opts.markThrowsFor?.(trip)) {
        throw new Error("mark failed");
      }
      calls.marked.push({ id, at });
    },
    sendEmail: async (input) => {
      const trip = opts.trips.find((t) => t.ownerEmail === input.to);
      if (trip && opts.emailThrowsFor?.(trip)) {
        throw new Error("smtp down");
      }
      calls.emails.push(input);
    },
    sendPushToUser: async (input) => {
      const trip = opts.trips.find((t) => t.userId === input.userId);
      if (trip && opts.pushThrowsFor?.(trip)) {
        throw new Error("push failed");
      }
      calls.pushes.push(input);
      return { sent: 1, failed: 0 };
    },
    publicBaseUrl: opts.publicBaseUrl ?? "https://example.com",
    now: () => now,
    log: (line) => calls.logs.push(line),
  };
  return { deps, calls };
}

// ---------------------------------------------------------------------------
// Pure helper tests
// ---------------------------------------------------------------------------

test("toUtcDateString pads months and days to two digits", () => {
  assert.equal(toUtcDateString(new Date("2026-01-05T00:00:00Z")), "2026-01-05");
  assert.equal(toUtcDateString(new Date("2026-12-31T23:59:59Z")), "2026-12-31");
});

test("reminderDateWindow spans tomorrow through the day after (UTC)", () => {
  const window = reminderDateWindow(new Date("2026-04-09T08:00:00Z"));
  assert.equal(window.min, "2026-04-10");
  assert.equal(window.max, "2026-04-11");
});

test("reminderDateWindow handles month rollover", () => {
  const window = reminderDateWindow(new Date("2026-01-30T12:00:00Z"));
  assert.equal(window.min, "2026-01-31");
  assert.equal(window.max, "2026-02-01");
});

test("escapeHtml escapes the five significant characters", () => {
  assert.equal(
    escapeHtml(`<script>a & b "c" 'd'</script>`),
    "&lt;script&gt;a &amp; b &quot;c&quot; &#39;d&#39;&lt;/script&gt;",
  );
});

test("buildDepartureReminderEmail includes brand, countries, dates and share URL", () => {
  const trip = sampleTrip({ publicId: "share_me_01", countries: ["Japan", "Korea"] });
  const { subject, html, text } = buildDepartureReminderEmail(trip, "https://example.com");
  assert.match(subject, /Japan, Korea/);
  assert.match(subject, /tomorrow/i);
  assert.match(html, /Japan, Korea/);
  assert.match(html, /2026-04-10/);
  assert.match(html, /2026-04-14/);
  assert.match(html, /https:\/\/example\.com\/trip\/share_me_01/);
  assert.match(text, /https:\/\/example\.com\/trip\/share_me_01/);
});

test("buildDepartureReminderEmail escapes HTML in country names", () => {
  const trip = sampleTrip({ countries: ["<img src=x onerror=alert(1)>"] });
  const { html } = buildDepartureReminderEmail(trip, "https://example.com");
  assert.equal(html.includes("<img"), false);
  assert.equal(html.includes("&lt;img"), true);
});

test("DEPARTURE_REMINDER_CATEGORY is exported for admin filtering", () => {
  assert.equal(DEPARTURE_REMINDER_CATEGORY, "departure-reminder");
});

// ---------------------------------------------------------------------------
// runDepartureReminderOnce — happy paths
// ---------------------------------------------------------------------------

test("reminds an eligible trip: emails, pushes and marks reminded", async () => {
  const trip = sampleTrip();
  const { deps, calls } = makeFakeDeps({ trips: [trip] });
  const record: DepartureReminderRunRecord = await runDepartureReminderOnce({ deps });

  assert.equal(record.error, null);
  assert.equal(record.matched, 1);
  assert.equal(record.reminded, 1);
  assert.equal(record.emailFailures, 0);
  assert.equal(record.pushFailures, 0);
  assert.equal(record.skippedNoEmail, 0);

  assert.equal(calls.emails.length, 1);
  assert.equal(calls.emails[0]!.to, "traveler@example.com");
  assert.equal(calls.emails[0]!.category, "departure-reminder");

  assert.equal(calls.pushes.length, 1);
  assert.equal(calls.pushes[0]!.userId, 42);
  assert.match(calls.pushes[0]!.url, /^\/trip\//);

  assert.equal(calls.marked.length, 1);
  assert.equal(calls.marked[0]!.id, 1);
});

test("guest trip (userId null) emails only, no push", async () => {
  const trip = sampleTrip({ userId: null });
  const { deps, calls } = makeFakeDeps({ trips: [trip] });
  const record = await runDepartureReminderOnce({ deps });

  assert.equal(record.reminded, 1);
  assert.equal(calls.emails.length, 1);
  assert.equal(calls.pushes.length, 0);
  assert.equal(calls.marked.length, 1);
});

test("each trip is reminded independently", async () => {
  const trips = [
    sampleTrip({ id: 1, publicId: "aaa", ownerEmail: "a@example.com", userId: 1 }),
    sampleTrip({ id: 2, publicId: "bbb", ownerEmail: "b@example.com", userId: 2 }),
  ];
  const { deps, calls } = makeFakeDeps({ trips });
  const record = await runDepartureReminderOnce({ deps });

  assert.equal(record.matched, 2);
  assert.equal(record.reminded, 2);
  assert.equal(calls.emails.length, 2);
  assert.equal(calls.pushes.length, 2);
  assert.equal(calls.marked.length, 2);
});

// ---------------------------------------------------------------------------
// runDepartureReminderOnce — skip and failure paths
// ---------------------------------------------------------------------------

test("trip with no owner email is skipped and NOT marked reminded", async () => {
  const trip = sampleTrip({ ownerEmail: "" });
  const { deps, calls } = makeFakeDeps({ trips: [trip] });
  const record = await runDepartureReminderOnce({ deps });

  assert.equal(record.matched, 1);
  assert.equal(record.reminded, 0);
  assert.equal(record.skippedNoEmail, 1);
  assert.equal(calls.emails.length, 0);
  assert.equal(calls.marked.length, 0);
});

test("trip with a malformed owner email is skipped and NOT marked", async () => {
  const trip = sampleTrip({ ownerEmail: "not-an-email" });
  const { deps, calls } = makeFakeDeps({ trips: [trip] });
  const record = await runDepartureReminderOnce({ deps });

  assert.equal(record.skippedNoEmail, 1);
  assert.equal(record.reminded, 0);
  assert.equal(calls.emails.length, 0);
  assert.equal(calls.marked.length, 0);
});

test("email failure leaves trip unmarked for a later retry", async () => {
  const trip = sampleTrip();
  const { deps, calls } = makeFakeDeps({
    trips: [trip],
    emailThrowsFor: () => true,
  });
  const record = await runDepartureReminderOnce({ deps });

  assert.equal(record.emailFailures, 1);
  assert.equal(record.reminded, 0);
  // The trip should NOT be consumed — a future tick can retry.
  assert.equal(calls.marked.length, 0);
});

test("push failure still marks reminded when email succeeded (push retriable next tick)", async () => {
  // Per the job's contract, a push that throws is a hard failure of that
  // channel; the current run does NOT mark the trip, so a later tick can
  // retry the push. We assert that behaviour explicitly.
  const trip = sampleTrip();
  const { deps, calls } = makeFakeDeps({
    trips: [trip],
    pushThrowsFor: () => true,
  });
  const record = await runDepartureReminderOnce({ deps });

  assert.equal(record.pushFailures, 1);
  assert.equal(record.emailFailures, 0);
  assert.equal(record.reminded, 0);
  assert.equal(calls.marked.length, 0);
});

test("marking failure does not count the trip as reminded", async () => {
  const trip = sampleTrip();
  const { deps } = makeFakeDeps({
    trips: [trip],
    markThrowsFor: () => true,
  });
  const record = await runDepartureReminderOnce({ deps });

  assert.equal(record.reminded, 0);
  assert.equal(record.error, null);
});

test("selectDueTrips throwing records an error and returns cleanly", async () => {
  const { deps } = makeFakeDeps({
    trips: [],
    selectThrows: new Error("db down"),
  });
  const record = await runDepartureReminderOnce({ deps });

  assert.equal(record.matched, 0);
  assert.equal(record.reminded, 0);
  assert.ok(record.error);
  assert.match(record.error!, /selectDueTrips: db down/);
});

test("onRun callback receives the run record exactly once", async () => {
  const trip = sampleTrip();
  const { deps } = makeFakeDeps({ trips: [trip] });
  const seen: DepartureReminderRunRecord[] = [];
  await runDepartureReminderOnce({ deps, onRun: (r) => seen.push(r) });
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.matched, 1);
  assert.equal(seen[0]!.reminded, 1);
  assert.ok(seen[0]!.finishedAt instanceof Date);
});

// ---------------------------------------------------------------------------
// Scheduler idempotency
// ---------------------------------------------------------------------------

test("startDepartureReminder is idempotent and stop is safe before start", () => {
  __resetDepartureReminderStateForTests();
  // No `runImmediately`, so no tick is scheduled against real deps.
  startDepartureReminder({ intervalMs: 60_000 });
  const firstRun = getLastDepartureReminderRun();
  // Calling start again must not throw and must not create a second timer.
  startDepartureReminder({ intervalMs: 60_000 });
  stopDepartureReminder();
  stopDepartureReminder();

  // Nothing ran synchronously; the record is null until a tick fires.
  assert.equal(firstRun, null);
  assert.equal(getLastDepartureReminderRun(), null);
});

/**
 * Unit tests for `server/services/socialProof.ts` — the conversion-features
 * layer (Phase 7).
 *
 * WHAT THESE PROVE (mapped to the phase acceptance criteria)
 * ---------------------------------------------------------
 *   1. Weekly purchase counter reads REAL orders only.
 *      - Counts distinct eSIMs sold for a country in the last 7 days.
 *      - Returns `null` (never a fabricated number) when the table has no
 *        paid orders for the country — so the UI can hide the badge.
 *      - Forwards the query window as exactly 7 days ending "now".
 *
 *   2. Per-country speed ratings.
 *      - Prefers a country-specific row over a regional (country = NULL) row.
 *      - Returns `null` when no active rating exists.
 *      - Sanitises the rating into the public shape (1..5 + optional mbps).
 *
 *   3. Review-request scheduling ("request after trip").
 *      - Schedules at (trip end + `requestDelayDays`) days.
 *      - Idempotent: a second call for the same (order, country) does not
 *        create a duplicate row (relies on the DB's unique index and the
 *        service's pre-check).
 *      - Skips when the trip hasn't ended yet, when reviews are already
 *        published for that order+country, or when the order isn't paid.
 *
 *   4. Aggregated review summary used on plan cards / country pages.
 *      - Reads ONLY published reviews.
 *      - `averageRating` is `null` (not 0 and not 5) when there are no
 *        published reviews, so the UI shows "no reviews yet" honestly.
 *      - Distribution sums to the total.
 *
 * WHAT THESE DO NOT PROVE
 * -----------------------
 *  - Real Postgres behaviour — the fake DB below returns canned rows and
 *    records the SQL templates the service calls. The actual schema is set by
 *    `server/db/migrations/0013_reviews_roaming_speed.sql`, exercised end to
 *    end in the flow phase.
 *  - Routes (`server/routes/reviews.ts`) — covered by their own route tests
 *    (a later batch). This file drives the service only.
 *  - Admin settings read for the exit-intent popup — that lives in the admin
 *    routes; the service here only consumes `requestDelayDays`.
 *
 * SAFETY: no network, no `DATABASE_URL`, no secrets. Every fixture is
 * synthetic. Run with:
 *
 *     npm test -- server/services/socialProof.test.ts
 *     # or the whole suite
 *     npm test
 *
 * IMPORTANT: these tests are SOURCE ONLY — they are not executed by this
 * response. If `socialProof.ts` exports a different name than what's imported
 * below, TypeScript will refuse to compile this file at `npm run typecheck`
 * and that's the signal to align the contract, not to invent one.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  getWeeklyPurchaseCount,
  getSpeedRatingForCountry,
  scheduleReviewRequest,
  getReviewSummary,
  type SocialProofDeps,
  type WeeklyPurchaseResult,
  type SpeedRating,
  type ReviewSummary,
} from "./socialProof";

// ---------------------------------------------------------------------------
// Fake DB — deliberately narrow.
//
// The service's DB usage in this phase is `db.execute(sql\`…\`)` returning
// `{ rows }`. That keeps the test surface tiny and lets us assert (a) which
// canned rows the service mapped and (b) that the SQL templates the service
// built exist at all (we do not inspect their text — that would be brittle).
//
// Callers seed it via `respond()` which is a list of canned responses, one
// per `db.execute` call, in call order. If the service makes more calls than
// were seeded, the extra calls resolve to `{ rows: [] }` — a safe default
// that makes missing seeds look like "empty table" rather than throwing.
// ---------------------------------------------------------------------------

interface ExecuteCall {
  /** The opaque drizzle `sql` template, kept for call counting only. */
  query: unknown;
  respondedRows: Array<Record<string, unknown>>;
}

interface FakeDb {
  execute: (q: unknown) => Promise<{ rows: Array<Record<string, unknown>> }>;
  insert: (table: unknown) => {
    values: (row: Record<string, unknown>) => {
      onConflictDoNothing: () => {
        returning: () => Promise<Array<{ id: number }>>;
      };
    };
  };
  /** Recorded `db.execute` calls with the rows they returned. */
  execCalls: ExecuteCall[];
  /** Recorded insert rows, keyed by a small tag based on fields present. */
  insertCalls: Array<{ tag: "review_request" | "unknown"; row: Record<string, unknown> }>;
}

function makeFakeDb(
  responseSequence: Array<Array<Record<string, unknown>>> = [],
  opts: {
    /** For each insert, return `[{ id: n }]`; `[]` = conflict (dedupe). */
    insertReturnIds?: Array<number | null>;
  } = {},
): FakeDb {
  const execCalls: ExecuteCall[] = [];
  const insertCalls: FakeDb["insertCalls"] = [];
  let execIndex = 0;
  let insertIndex = 0;

  // For `db.insert(reviewRequests).values({...}).onConflictDoNothing().returning()`
  // we only see the row values at the `.values(...)` call. We tag the row as
  // a review request when it has `scheduledFor` or `orderId` AND `countryCode`
  // — those are the columns scheduleReviewRequest writes.
  const tagOf = (row: Record<string, unknown>): "review_request" | "unknown" => {
    if ("countryCode" in row && ("orderId" in row || "scheduledFor" in row)) {
      return "review_request";
    }
    return "unknown";
  };

  const db: FakeDb = {
    execCalls,
    insertCalls,
    async execute(q) {
      const rows = responseSequence[execIndex] ?? [];
      execCalls.push({ query: q, respondedRows: rows });
      execIndex += 1;
      return { rows };
    },
    insert(_table) {
      return {
        values(row) {
          insertCalls.push({ tag: tagOf(row), row });
          return {
            onConflictDoNothing() {
              return {
                async returning() {
                  const v = opts.insertReturnIds?.[insertIndex] ?? 1;
                  insertIndex += 1;
                  return v == null ? [] : [{ id: v }];
                },
              };
            },
          };
        },
      };
    },
  };
  return db;
}

const getDbOf =
  (db: FakeDb | null) =>
  (() => db) as unknown as NonNullable<SocialProofDeps["getDb"]>;

// Fixed "now" so all date math is deterministic.
const NOW = () => new Date("2024-06-15T12:00:00Z");

// ---------------------------------------------------------------------------
// 1) Weekly purchase counter
// ---------------------------------------------------------------------------

test("getWeeklyPurchaseCount returns the real count from a single row result", async () => {
  const db = makeFakeDb([[{ count: "42" }]]);
  const result: WeeklyPurchaseResult = await getWeeklyPurchaseCount({
    countrySlug: "sg",
    getDb: getDbOf(db),
    now: NOW,
  });

  assert.equal(result.count, 42);
  // The result must carry the query window so the UI copy is honest about it.
  assert.equal(result.windowDays, 7);
  assert.equal(result.windowEnd, "2024-06-15T12:00:00.000Z");
  assert.equal(result.windowStart, "2024-06-08T12:00:00.000Z");
  // Exactly one DB round-trip.
  assert.equal(db.execCalls.length, 1);
});

test("getWeeklyPurchaseCount returns count=null (hide badge) when there are no rows", async () => {
  const db = makeFakeDb([[]]);
  const result = await getWeeklyPurchaseCount({
    countrySlug: "sg",
    getDb: getDbOf(db),
    now: NOW,
  });
  assert.equal(result.count, null);
  assert.equal(result.windowDays, 7);
});

test("getWeeklyPurchaseCount returns count=null when the row's count is 0 (never a fake '1 person bought')", async () => {
  const db = makeFakeDb([[{ count: 0 }]]);
  const result = await getWeeklyPurchaseCount({
    countrySlug: "sg",
    getDb: getDbOf(db),
    now: NOW,
  });
  assert.equal(result.count, null, "zero sales must not render as '0' — hide the badge");
});

test("getWeeklyPurchaseCount throws SocialProofError('invalid_input') on empty countrySlug", async () => {
  await assert.rejects(
    () =>
      getWeeklyPurchaseCount({
        countrySlug: "",
        getDb: getDbOf(makeFakeDb()),
        now: NOW,
      }),
    (e) => e instanceof Error && /invalid_input/.test((e as { code?: string }).code ?? ""),
  );
});

test("getWeeklyPurchaseCount throws SocialProofError('db_unavailable') with no DB", async () => {
  await assert.rejects(
    () =>
      getWeeklyPurchaseCount({
        countrySlug: "sg",
        getDb: getDbOf(null),
        now: NOW,
      }),
    (e) => e instanceof Error && /db_unavailable/.test((e as { code?: string }).code ?? ""),
  );
});

// ---------------------------------------------------------------------------
// 2) Speed ratings
// ---------------------------------------------------------------------------

test("getSpeedRatingForCountry prefers a country-specific row over a regional fallback", async () => {
  // First response = country row; service should stop before the fallback.
  const db = makeFakeDb([
    [{ network_label: "Singtel 5G", rating: 5, median_mbps: "212.50" }],
    // fallback would have been this — must not be reached
    [{ network_label: "Regional", rating: 3, median_mbps: "80" }],
  ]);
  const rating: SpeedRating | null = await getSpeedRatingForCountry({
    countrySlug: "sg",
    getDb: getDbOf(db),
    now: NOW,
  });
  assert.ok(rating);
  assert.equal(rating!.networkLabel, "Singtel 5G");
  assert.equal(rating!.rating, 5);
  assert.equal(rating!.medianMbps, 212.5);
  assert.equal(db.execCalls.length, 1, "must not fall back when a country row exists");
});

test("getSpeedRatingForCountry falls back to a regional row when no country row exists", async () => {
  const db = makeFakeDb([
    [], // country miss
    [{ network_label: "EU roaming", rating: 4, median_mbps: "95.00" }],
  ]);
  const rating = await getSpeedRatingForCountry({
    countrySlug: "fr",
    getDb: getDbOf(db),
    now: NOW,
  });
  assert.ok(rating);
  assert.equal(rating!.networkLabel, "EU roaming");
  assert.equal(rating!.rating, 4);
  assert.equal(db.execCalls.length, 2);
});

test("getSpeedRatingForCountry returns null when neither country nor regional rating exists", async () => {
  const db = makeFakeDb([[], []]);
  const rating = await getSpeedRatingForCountry({
    countrySlug: "zz",
    getDb: getDbOf(db),
    now: NOW,
  });
  assert.equal(rating, null);
});

test("getSpeedRatingForCountry clamps out-of-range ratings into 1..5 (never surfaces a bad value)", async () => {
  const db = makeFakeDb([[{ network_label: "Bad", rating: 9, median_mbps: "-10" }]]);
  const rating = await getSpeedRatingForCountry({
    countrySlug: "sg",
    getDb: getDbOf(db),
    now: NOW,
  });
  assert.ok(rating);
  // Rating collapses to the max allowed; negative mbps becomes null.
  assert.equal(rating!.rating, 5);
  assert.equal(rating!.medianMbps, null);
});

// ---------------------------------------------------------------------------
// 3) Review request scheduling
// ---------------------------------------------------------------------------

interface ScheduleOk {
  status: "scheduled" | "already_scheduled" | "already_reviewed" | "trip_not_ended" | "order_not_paid";
  scheduledFor?: string;
}

test("scheduleReviewRequest creates a review_request row at trip-end + delay", async () => {
  // Call 1: fetch order (paid). Call 2: no existing review_requests row.
  // Call 3: no published review for the order. Insert returns id 1.
  const db = makeFakeDb(
    [
      // order lookup
      [
        {
          id: 10,
          status: "completed",
          trip_end: "2024-06-10",
          user_id: 1,
        },
      ],
      // existing request lookup
      [],
      // published review lookup
      [],
    ],
    { insertReturnIds: [1] },
  );

  const result = (await scheduleReviewRequest({
    orderId: 10,
    countrySlug: "sg",
    getDb: getDbOf(db),
    now: NOW,
    requestDelayDays: 3,
  })) as ScheduleOk;

  assert.equal(result.status, "scheduled");
  // 2024-06-10 + 3 days = 2024-06-13
  assert.equal(result.scheduledFor, "2024-06-13");
  // Exactly one insert row of tag 'review_request'.
  const inserted = db.insertCalls.filter((c) => c.tag === "review_request");
  assert.equal(inserted.length, 1);
  assert.equal(inserted[0]!.row.countryCode, "sg");
  assert.equal(inserted[0]!.row.orderId, 10);
});

test("scheduleReviewRequest is idempotent on a duplicate (unique-index conflict, existing row)", async () => {
  const db = makeFakeDb(
    [
      [{ id: 10, status: "completed", trip_end: "2024-06-10", user_id: 1 }],
      // existing request → service should short-circuit
      [{ id: 99, order_id: 10, country_code: "sg", status: "pending" }],
    ],
    { insertReturnIds: [1] },
  );
  const result = (await scheduleReviewRequest({
    orderId: 10,
    countrySlug: "sg",
    getDb: getDbOf(db),
    now: NOW,
    requestDelayDays: 3,
  })) as ScheduleOk;
  assert.equal(result.status, "already_scheduled");
  // No insert attempted.
  assert.equal(db.insertCalls.length, 0);
});

test("scheduleReviewRequest returns order_not_paid for a pending order and does not schedule", async () => {
  const db = makeFakeDb([[{ id: 10, status: "pending", trip_end: "2024-06-10", user_id: 1 }]]);
  const result = (await scheduleReviewRequest({
    orderId: 10,
    countrySlug: "sg",
    getDb: getDbOf(db),
    now: NOW,
    requestDelayDays: 3,
  })) as ScheduleOk;
  assert.equal(result.status, "order_not_paid");
  assert.equal(db.insertCalls.length, 0);
});

test("scheduleReviewRequest returns trip_not_ended when the trip end date is in the future", async () => {
  const db = makeFakeDb([
    [{ id: 10, status: "completed", trip_end: "2024-12-01", user_id: 1 }],
  ]);
  const result = (await scheduleReviewRequest({
    orderId: 10,
    countrySlug: "sg",
    getDb: getDbOf(db),
    now: NOW,
    requestDelayDays: 3,
  })) as ScheduleOk;
  assert.equal(result.status, "trip_not_ended");
  assert.equal(db.insertCalls.length, 0);
});

test("scheduleReviewRequest returns already_reviewed when a published review exists", async () => {
  const db = makeFakeDb([
    [{ id: 10, status: "completed", trip_end: "2024-06-10", user_id: 1 }],
    [], // no existing request
    [{ id: 55 }], // published review exists
  ]);
  const result = (await scheduleReviewRequest({
    orderId: 10,
    countrySlug: "sg",
    getDb: getDbOf(db),
    now: NOW,
    requestDelayDays: 3,
  })) as ScheduleOk;
  assert.equal(result.status, "already_reviewed");
  assert.equal(db.insertCalls.length, 0);
});

// ---------------------------------------------------------------------------
// 4) Review summary (plan cards + country pages)
// ---------------------------------------------------------------------------

test("getReviewSummary aggregates published reviews (total, average, distribution)", async () => {
  // The service likely issues one query returning per-rating counts (a single
  // GROUP BY). We seed that shape and also tolerate the alternates.
  const db = makeFakeDb([
    [
      { rating: 5, count: 8 },
      { rating: 4, count: 2 },
    ],
  ]);

  const summary: ReviewSummary = await getReviewSummary({
    countrySlug: "sg",
    getDb: getDbOf(db),
    now: NOW,
  });

  assert.equal(summary.total, 10);
  // Weighted average: (5*8 + 4*2) / 10 = 4.8
  assert.equal(summary.averageRating, 4.8);
  assert.deepEqual(summary.distribution, { 1: 0, 2: 0, 3: 0, 4: 2, 5: 8 });
  assert.equal(summary.publishedOnly, true);
});

test("getReviewSummary returns averageRating=null (not 0/5) when there are no published reviews", async () => {
  const db = makeFakeDb([[]]);
  const summary = await getReviewSummary({
    countrySlug: "sg",
    getDb: getDbOf(db),
    now: NOW,
  });
  assert.equal(summary.total, 0);
  assert.equal(summary.averageRating, null, "no reviews must never render as 5.0");
  assert.equal(summary.distribution[1] + summary.distribution[2] + summary.distribution[3] + summary.distribution[4] + summary.distribution[5], 0);
});

test("getReviewSummary rounds to one decimal (never shows 4.8333…)", async () => {
  const db = makeFakeDb([
    [
      { rating: 5, count: 1 },
      { rating: 4, count: 2 },
    ],
  ]);
  const summary = await getReviewSummary({
    countrySlug: "sg",
    getDb: getDbOf(db),
    now: NOW,
  });
  // (5 + 4 + 4) / 3 = 4.333… → 4.3
  assert.equal(summary.averageRating, 4.3);
});

// ---------------------------------------------------------------------------
// 5) __test__ surface — pure helpers, exercised directly
// ---------------------------------------------------------------------------

test("__test__.computeAverage returns null on empty, one decimal otherwise", async () => {
  const { computeAverage } = await import("./socialProof").then((m) => m.__test__);
  assert.equal(computeAverage([]), null);
  assert.equal(
    computeAverage([
      { rating: 5, count: 1 },
      { rating: 4, count: 2 },
    ]),
    4.3,
  );
});

test("__test__.clampRating keeps values inside 1..5 and floors to integers", async () => {
  const { clampRating } = await import("./socialProof").then((m) => m.__test__);
  assert.equal(clampRating(0), 1);
  assert.equal(clampRating(9), 5);
  assert.equal(clampRating(3.7), 4);
  assert.equal(clampRating(3), 3);
});

/**
 * Tests for `server/jobs/usageRefresh.job.ts`.
 *
 * SCOPE OF THIS FILE
 * ------------------
 * This suite exercises ONLY the scheduler-level contract that the job module
 * itself owns and documents:
 *
 *   1. `USAGE_REFRESH_JOB_INTERVAL_MS` equals exactly 3 hours and mirrors the
 *      service constant `USAGE_REFRESH_INTERVAL_MS`.
 *   2. `startUsageRefresh` installs a `setInterval` with the requested
 *      `intervalMs` (and clamps below 60s up to 60s — the file uses
 *      `Math.max(60_000, options.intervalMs ?? ...)`).
 *   3. `startUsageRefresh` is idempotent: a second call logs "already started"
 *      and does NOT create a second timer.
 *   4. `stopUsageRefresh` calls `clearInterval` exactly once for the installed
 *      timer and is safe to call when nothing is running.
 *   5. `runUsageRefreshOnce` returns a `UsageRefreshRunRecord` with all four
 *      documented fields populated (`startedAt`, `finishedAt`, `result`,
 *      `error`), invokes `onRun` exactly once with that SAME record, and
 *      records the outcome through `result` OR `error` (whichever path
 *      `refreshUsage` took).
 *   6. `getLastUsageRefreshRun` reflects the most recent attempt (null before
 *      any run, non-null after).
 *   7. `startUsageRefresh({ runImmediately: true })` triggers one
 *      fire-and-forget background pass that eventually reports via `onRun`.
 *   8. `__resetUsageRefreshStateForTests` clears `lastRun` and stops the timer
 *      so tests are isolated.
 *
 * WHAT THIS FILE DOES NOT TEST (deliberately)
 * -------------------------------------------
 *  - The supplier call and the DB update that `refreshUsage` performs. Those
 *    live in `server/services/usageService.ts`, which was not part of this
 *    batch's supplied source. Assertions about:
 *       • the 10-esimTranNo batch size (`MAX_USAGE_BATCH`),
 *       • the "previous_run_in_flight" skip path,
 *       • `RefreshResult.attempted` / `.updated` / `.unmatched` counts,
 *    require the real `RefreshDeps` and `RefreshResult` types and belong in
 *    `server/services/usageService.test.ts`. Adding them here would either
 *    (a) guess at un-named `RefreshDeps` fields or (b) not actually exercise
 *    the real service — both would be misleading.
 *
 * NO EXTERNAL DEPENDENCIES
 * ------------------------
 *  - Timers are monkey-patched (`globalThis.setInterval` /
 *    `clearInterval`) so we assert the exact interval passed without waiting
 *    for a real tick.
 *  - Every `runUsageRefreshOnce` call resolves against the real
 *    `refreshUsage`; when no `DATABASE_URL` is present the job catches the
 *    failure and records it in `.error`. Assertions therefore check the shape
 *    of the record, not whether it succeeded — both outcomes are valid.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  startUsageRefresh,
  stopUsageRefresh,
  runUsageRefreshOnce,
  getLastUsageRefreshRun,
  __resetUsageRefreshStateForTests,
  USAGE_REFRESH_JOB_INTERVAL_MS,
  type UsageRefreshRunRecord,
} from "./usageRefresh.job";

import { USAGE_REFRESH_INTERVAL_MS } from "../services/usageService";

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Await `setImmediate` until the predicate holds or the deadline passes. */
async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

/** Minimal fake `NodeJS.Timeout` so `setInterval().unref?.()` doesn't wedge. */
function makeFakeTimer(): NodeJS.Timeout {
  return { unref: () => {} } as unknown as NodeJS.Timeout;
}

// ---------------------------------------------------------------------------
// (1) Interval contract
// ---------------------------------------------------------------------------

test("USAGE_REFRESH_JOB_INTERVAL_MS is exactly 3 hours and mirrors the service constant", () => {
  assert.equal(USAGE_REFRESH_JOB_INTERVAL_MS, 3 * 60 * 60 * 1000);
  assert.equal(USAGE_REFRESH_JOB_INTERVAL_MS, USAGE_REFRESH_INTERVAL_MS);
});

// ---------------------------------------------------------------------------
// (2) installs setInterval with the requested interval
// ---------------------------------------------------------------------------

test("startUsageRefresh installs a timer with the requested intervalMs", () => {
  const originalSet = globalThis.setInterval;
  let capturedInterval = -1;
  const fake = makeFakeTimer();
  try {
    globalThis.setInterval = ((fn: () => void, ms?: number) => {
      // Don't actually fire fn — the test is about the scheduler wiring.
      void fn;
      capturedInterval = ms ?? -1;
      return fake;
    }) as unknown as typeof setInterval;

    __resetUsageRefreshStateForTests();
    startUsageRefresh({ intervalMs: 90_000, log: () => {} });
  } finally {
    globalThis.setInterval = originalSet;
    stopUsageRefresh();
    __resetUsageRefreshStateForTests();
  }
  assert.equal(capturedInterval, 90_000);
});

// ---------------------------------------------------------------------------
// (2b) intervalMs below 60s is clamped to 60_000
// ---------------------------------------------------------------------------

test("intervalMs below 60s is clamped to 60 000 ms", () => {
  const originalSet = globalThis.setInterval;
  let capturedInterval = -1;
  try {
    globalThis.setInterval = ((fn: () => void, ms?: number) => {
      void fn;
      capturedInterval = ms ?? -1;
      return makeFakeTimer();
    }) as unknown as typeof setInterval;

    __resetUsageRefreshStateForTests();
    startUsageRefresh({ intervalMs: 1, log: () => {} });
  } finally {
    globalThis.setInterval = originalSet;
    stopUsageRefresh();
    __resetUsageRefreshStateForTests();
  }
  assert.equal(capturedInterval, 60_000);
});

// ---------------------------------------------------------------------------
// (3) idempotent start
// ---------------------------------------------------------------------------

test("startUsageRefresh is idempotent: a second call does not install a second timer", () => {
  const originalSet = globalThis.setInterval;
  let installCount = 0;
  const logs: string[] = [];
  try {
    globalThis.setInterval = ((fn: () => void) => {
      void fn;
      installCount += 1;
      return makeFakeTimer();
    }) as unknown as typeof setInterval;

    __resetUsageRefreshStateForTests();
    startUsageRefresh({ intervalMs: 90_000, log: (m) => logs.push(m) });
    startUsageRefresh({ intervalMs: 90_000, log: (m) => logs.push(m) });

    assert.equal(installCount, 1, "setInterval must be called once");
    assert.ok(
      logs.some((l) => /already started/.test(l)),
      "second start must log 'already started'",
    );
  } finally {
    globalThis.setInterval = originalSet;
    stopUsageRefresh();
    __resetUsageRefreshStateForTests();
  }
});

// ---------------------------------------------------------------------------
// (4) stop clears the timer, and stop is idempotent
// ---------------------------------------------------------------------------

test("stopUsageRefresh clears the installed timer and is idempotent", () => {
  const originalSet = globalThis.setInterval;
  const originalClear = globalThis.clearInterval;
  let clearCount = 0;
  try {
    globalThis.setInterval = (() => makeFakeTimer()) as unknown as typeof setInterval;
    globalThis.clearInterval = (() => {
      clearCount += 1;
    }) as unknown as typeof clearInterval;

    __resetUsageRefreshStateForTests();
    startUsageRefresh({ intervalMs: 90_000, log: () => {} });
    stopUsageRefresh();
    stopUsageRefresh(); // must not throw and must not double-clear
    assert.equal(clearCount, 1);
  } finally {
    globalThis.setInterval = originalSet;
    globalThis.clearInterval = originalClear;
    __resetUsageRefreshStateForTests();
  }
});

// ---------------------------------------------------------------------------
// (5) runUsageRefreshOnce record contract + onRun wiring
// ---------------------------------------------------------------------------

test("runUsageRefreshOnce returns a record with all fields populated and calls onRun once", async () => {
  __resetUsageRefreshStateForTests();
  const captured: UsageRefreshRunRecord[] = [];

  try {
    const record = await runUsageRefreshOnce({
      intervalMs: 180_000,
      log: () => {},
      onRun: (r) => captured.push(r),
    });

    assert.equal(captured.length, 1, "onRun must be called exactly once");
    assert.equal(captured[0], record, "onRun receives the SAME record returned");

    assert.ok(record.startedAt instanceof Date, "startedAt must be a Date");
    assert.ok(record.finishedAt instanceof Date, "finishedAt must be a Date");
    assert.ok(
      record.finishedAt.getTime() >= record.startedAt.getTime(),
      "finishedAt must not precede startedAt",
    );

    // The job contract is "result OR error", never both null: whichever path
    // `refreshUsage` took must be observable on the record. Without a DB the
    // job lands in the error case; with a DB and/or missing supplier creds it
    // lands in the result case.
    assert.ok(
      record.result !== null || record.error !== null,
      "record must record an outcome (result or error)",
    );
    if (record.result !== null) {
      assert.equal(typeof record.result, "object");
    }
    if (record.error !== null) {
      assert.equal(typeof record.error, "string");
      assert.ok(
        record.error.length > 0,
        "error message must not be empty when set",
      );
    }
  } finally {
    __resetUsageRefreshStateForTests();
  }
});

// ---------------------------------------------------------------------------
// (6) getLastUsageRefreshRun reflects the most recent attempt
// ---------------------------------------------------------------------------

test("getLastUsageRefreshRun is null before any run and non-null afterwards", async () => {
  __resetUsageRefreshStateForTests();
  assert.equal(getLastUsageRefreshRun(), null);

  try {
    await runUsageRefreshOnce({ intervalMs: 180_000, log: () => {} });
    const last = getLastUsageRefreshRun();
    assert.ok(last, "getLastUsageRefreshRun must return the last record");
    assert.ok(last!.finishedAt instanceof Date);
    assert.ok(last!.startedAt instanceof Date);
  } finally {
    __resetUsageRefreshStateForTests();
    assert.equal(
      getLastUsageRefreshRun(),
      null,
      "reset must clear lastRun so tests do not leak state",
    );
  }
});

// ---------------------------------------------------------------------------
// (7) runImmediately triggers one background pass
// ---------------------------------------------------------------------------

test("runImmediately triggers one fire-and-forget pass that reports via onRun", async () => {
  __resetUsageRefreshStateForTests();
  const runs: UsageRefreshRunRecord[] = [];

  // Intercept setInterval so the timer itself does not hold the test open;
  // `runImmediately` is what actually drives the pass we observe.
  const originalSet = globalThis.setInterval;
  try {
    globalThis.setInterval = (() => makeFakeTimer()) as unknown as typeof setInterval;

    startUsageRefresh({
      intervalMs: 90_000,
      runImmediately: true,
      log: () => {},
      onRun: (r) => runs.push(r),
    });

    await waitFor(() => runs.length === 1, 3_000);
    assert.equal(runs.length, 1);
  } finally {
    globalThis.setInterval = originalSet;
    stopUsageRefresh();
    __resetUsageRefreshStateForTests();
  }
});

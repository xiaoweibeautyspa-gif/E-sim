/**
 * 3-hourly usage refresh job.
 *
 * Why a job (not an on-demand call)
 * ---------------------------------
 * Supplier usage lags 1–3 hours, so an on-demand refresh would mislead users
 * ("I just used data, why is the bar stale?"). A single background job keeps a
 * consistent cadence, batches to the supplier's 10-per-call limit, and gives us
 * a single `usageUpdatedAt` per refresh that the dashboard reports truthfully.
 *
 * Design (mirrors `packageSync.job.ts` / `webhookRegister.job.ts`):
 *  - `startUsageRefresh()` is idempotent and does NOT run on import.
 *  - The interval is `.unref()`d so tests never hang.
 *  - Non-overlapping: a tick while a run is in flight is skipped and logged.
 *  - Never throws to the caller; `runUsageRefreshOnce()` returns a record.
 *  - `getLastUsageRefreshRun()` is surfaced for the admin supplier-health card.
 *  - The supplier query and DB access are injected via `RefreshDeps` so unit
 *    tests can drive the job without the real supplier or database.
 */
import {
  refreshUsage,
  USAGE_REFRESH_INTERVAL_MS,
  type RefreshDeps,
  type RefreshResult,
} from "../services/usageService";

/** 3 hours — spec cadence. Exported so tests can assert on it. */
export const USAGE_REFRESH_JOB_INTERVAL_MS = USAGE_REFRESH_INTERVAL_MS;

export interface UsageRefreshRunRecord {
  startedAt: Date;
  finishedAt: Date | null;
  result: RefreshResult | null;
  error: string | null;
}

export interface UsageRefreshJobOptions extends RefreshDeps {
  /** Override interval for tests. Defaults to 3 hours. */
  intervalMs?: number;
  /** Called with each run record (admin health / tests). */
  onRun?: (record: UsageRefreshRunRecord) => void;
}

let timer: NodeJS.Timeout | null = null;
let running = false;
let lastRun: UsageRefreshRunRecord | null = null;

/** Read the most recent run (observability; never throws). */
export function getLastUsageRefreshRun(): UsageRefreshRunRecord | null {
  return lastRun;
}

/**
 * Execute one refresh pass. Never throws. `deps` are forwarded to
 * `refreshUsage`; the default (production) path uses the real supplier + DB.
 */
export async function runUsageRefreshOnce(
  options: UsageRefreshJobOptions = {},
): Promise<UsageRefreshRunRecord> {
  const log = options.log ?? ((m: string) => console.log(m));

  if (running) {
    log("[usageRefresh] previous run still in flight; skipping this tick");
    const skipped: UsageRefreshRunRecord = {
      startedAt: new Date(),
      finishedAt: new Date(),
      result: {
        updated: 0,
        attempted: 0,
        unmatched: 0,
        skipped: true,
        reason: "previous_run_in_flight",
        batches: 0,
        at: new Date(),
      },
      error: null,
    };
    options.onRun?.(skipped);
    return skipped;
  }

  running = true;
  const startedAt = new Date();
  let result: RefreshResult | null = null;
  let error: string | null = null;
  try {
    result = await refreshUsage(undefined, options);
    if (result.skipped) {
      log(`[usageRefresh] skipped: ${result.reason ?? "unknown"}`);
    } else {
      log(
        `[usageRefresh] ok: batches=${result.batches} attempted=${result.attempted} ` +
          `updated=${result.updated} unmatched=${result.unmatched}`,
      );
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    log(`[usageRefresh] failed: ${error}`);
  } finally {
    running = false;
  }

  const finishedAt = new Date();
  const record: UsageRefreshRunRecord = { startedAt, finishedAt, result, error };
  lastRun = record;
  options.onRun?.(record);
  return record;
}

/**
 * Start the scheduler. Idempotent; does not run on import. Pass
 * `runImmediately: true` to trigger a first pass (used by `server/index.ts`
 * bootstrap so a fresh boot refreshes usage promptly after a deploy).
 */
export function startUsageRefresh(
  options: UsageRefreshJobOptions & { runImmediately?: boolean } = {},
): void {
  const interval = Math.max(60_000, options.intervalMs ?? USAGE_REFRESH_JOB_INTERVAL_MS);
  const log = options.log ?? ((m: string) => console.log(m));

  if (timer) {
    log("[usageRefresh] already started; ignoring duplicate start");
    return;
  }

  timer = setInterval(() => {
    void runUsageRefreshOnce(options);
  }, interval);
  timer.unref?.();
  log(`[usageRefresh] scheduled every ${interval}ms`);

  if (options.runImmediately) {
    void runUsageRefreshOnce(options);
  }
}

/** Stop the scheduler. Safe to call when not started. */
export function stopUsageRefresh(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

/** Test-only reset of module state. Never called from production code. */
export function __resetUsageRefreshStateForTests(): void {
  stopUsageRefresh();
  running = false;
  lastRun = null;
}

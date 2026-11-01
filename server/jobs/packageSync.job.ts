/**
 * Catalog sync scheduler.
 *
 * Pulls `/package/list` every 6 hours into the `packages` table via the
 * existing `syncPackages()` service. Nothing else in the app is allowed to
 * call the supplier for catalog data — pages read from DB rows only.
 *
 * Design notes:
 * - No external scheduler dependency: a single `setInterval` running on the
 *   Node event loop. The interval is `.unref()`d so tests (which import this
 *   module) never keep the node:test process alive.
 * - The first run happens only when `startPackageSync()` is called explicitly,
 *   so importing this module for tests has no side effects.
 * - Guard against overlapping runs: if a previous tick is still in flight, the
 *   next tick is skipped and logged. Catalog sync is idempotent but a slow run
 *   shouldn't pile up queued runs.
 * - Missing supplier credentials are not an error (the service returns
 *   `skipped: true`); we log that distinctly so the admin dashboard can surface
 *   "supplier not configured" without treating it as a failure.
 * - The job exposes its last result so the admin "supplier health" surface can
 *   render the last sync time and outcome without another query.
 */
import { syncPackages, type SyncResult } from "../services/catalogSync";

/** 6 hours in ms — the spec's sync cadence. */
export const PACKAGE_SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000;

export interface PackageSyncRunRecord {
  startedAt: Date;
  finishedAt: Date | null;
  result: SyncResult | null;
  error: string | null;
}

export interface PackageSyncJobOptions {
  /** Override interval (tests use a tiny value). Defaults to 6h. */
  intervalMs?: number;
  /** Inject the sync implementation for tests. Defaults to `syncPackages`. */
  runOnce?: () => Promise<SyncResult>;
  /** Logger seam. Defaults to console; tests can capture. */
  log?: (msg: string) => void;
  /** Called with the run record after every attempt (success or failure). */
  onRun?: (record: PackageSyncRunRecord) => void;
}

let timer: NodeJS.Timeout | null = null;
let running = false;
/** Last recorded run, surfaced to the admin dashboard / health endpoint. */
let lastRun: PackageSyncRunRecord | null = null;

/** Read the most recent supplied run (observability only; never throws). */
export function getLastPackageSyncRun(): PackageSyncRunRecord | null {
  return lastRun;
}

/**
 * Execute one catalog sync. Never throws — the scheduler needs to survive a
 * transient supplier/DB error and retry on the next interval. Callers that
 * want to know the result read the returned record.
 */
export async function runPackageSyncOnce(
  options: Pick<PackageSyncJobOptions, "runOnce" | "log" | "onRun"> = {},
): Promise<PackageSyncRunRecord> {
  const log = options.log ?? ((m: string) => console.log(m));
  const call = options.runOnce ?? syncPackages;

  if (running) {
    log("[packageSync] previous run still in flight; skipping this tick");
    const record: PackageSyncRunRecord = {
      startedAt: new Date(),
      finishedAt: new Date(),
      result: null,
      error: "skipped: previous run still in flight",
    };
    options.onRun?.(record);
    return record;
  }

  running = true;
  const startedAt = new Date();
  let result: SyncResult | null = null;
  let error: string | null = null;
  try {
    result = await call();
    if (result.skipped) {
      log(`[packageSync] skipped: ${result.reason ?? "supplier not configured"}`);
    } else {
      log(
        `[packageSync] ok: fetched=${result.fetched} inserted=${result.inserted} ` +
          `updated=${result.updated} deactivated=${result.deactivated}` +
          (result.reason ? ` note=${result.reason}` : ""),
      );
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    log(`[packageSync] failed: ${error}`);
  } finally {
    running = false;
  }

  const finishedAt = new Date();
  const record: PackageSyncRunRecord = { startedAt, finishedAt, result, error };
  lastRun = record;
  options.onRun?.(record);

  // Return the record either way — the job never throws to the caller.
  if (error) {
    return { ...record, error };
  }
  return record;
}

/**
 * Start the 6-hourly scheduler. Idempotent: calling twice does not create two
 * timers. Does NOT run an initial sync — callers that want one call
 * `runPackageSyncOnce()` explicitly (or use `startPackageSync({ runImmediately: true })`).
 */
export function startPackageSync(
  options: PackageSyncJobOptions & { runImmediately?: boolean } = {},
): void {
  const interval = Math.max(1_000, options.intervalMs ?? PACKAGE_SYNC_INTERVAL_MS);

  if (timer) {
    (options.log ?? console.log)("[packageSync] already started; ignoring duplicate start");
    return;
  }

  timer = setInterval(() => {
    void runPackageSyncOnce(options);
  }, interval);
  // Never hold the event loop open just for this timer (important for tests
  // and for short-lived maintenance scripts).
  timer.unref?.();

  (options.log ?? console.log)(`[packageSync] scheduled every ${interval}ms`);

  if (options.runImmediately) {
    void runPackageSyncOnce(options);
  }
}

/** Stop the scheduler. Safe to call even if not started. */
export function stopPackageSync(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

/** For tests: reset module-level state. Never called from production code. */
export function __resetPackageSyncStateForTests(): void {
  stopPackageSync();
  running = false;
  lastRun = null;
}

/**
 * Order readiness poller.
 *
 * After `/esim/order` returns, the supplier may not have populated ICCID / LPA
 * / QR yet. The spec says: poll `/esim/query` every 3 seconds, up to 10 tries,
 * and if still not ready fall back to the ORDER_STATUS webhook.
 *
 * This module exposes `pollForOrderReady()` (used inline by the fulfilment
 * service) and a `startOrderPoller()` background sweep that re-drives any
 * `processing` order on a slower cadence so a missed webhook doesn't strand an
 * order forever.
 *
 * Honesty / safety notes:
 * - Every supplier call goes through the shared eSIM Access client, which is
 *   already rate-limited to 8 req/sec and retried with backoff. Polling here
 *   adds a deliberate 3s gap so 10 tries span ~30s and never flood the API.
 * - The poll is keyed on our `transactionId` (our order id) as a fallback
 *   query key when `orderNo` is unknown, because idempotency lives on our side.
 *   `/esim/query` accepts `orderNo`, `transactionId`, `iccid`, or `esimTranNo`;
 *   we prefer `orderNo`, else `transactionId`.
 * - "Ready" means we have at least one eSIM with an iccid AND (lpaCode OR
 *   qrCodeUrl). Anything less is not installable and we do not claim success.
 * - On exhaustion we return `{ ready:false }` and the caller marks the order
 *   `processing`; it will be completed by the ORDER_STATUS webhook (next
 *   batch) or re-driven by the background sweep.
 * - No network calls happen on import; the sweeper only runs when started, and
 *   its interval is `.unref()`d so tests never hang.
 */
import { and, eq, inArray } from "drizzle-orm";
import { esimAccess, type SupplierEsim } from "../esimaccess";
import { getDb } from "../db/client";
import { orders } from "../db/schema";
import { resumeProcessingOrder } from "../services/fulfilment";

/** 3 seconds between `/esim/query` attempts. */
export const POLL_INTERVAL_MS = 3_000;
/** Up to 10 attempts (≈ 30s of polling). */
export const MAX_POLL_ATTEMPTS = 10;
/** Background sweep cadence for still-processing orders. */
export const SWEEP_INTERVAL_MS = 60_000;
/** How many processing orders the sweep handles per tick. */
export const SWEEP_BATCH = 25;

export interface PollResult {
  ready: boolean;
  esims: SupplierEsim[];
  attempts: number;
  reason?: string;
}

export interface PollDeps {
  /** Query one order's current state from the supplier. */
  query?: (input: { orderNo: string | null; transactionId: string }) => Promise<{
    status: string;
    esims: SupplierEsim[];
  }>;
  /** Sleep between attempts (tests can pass a no-op). Defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /** Interval override (tests). */
  intervalMs?: number;
  /** Max attempts override (tests). */
  maxAttempts?: number;
  log?: (msg: string) => void;
}

/**
 * Poll `/esim/query` until an installable eSIM is returned or attempts run out.
 * Never throws on a single failed query — it logs and retries up to the limit.
 */
export async function pollForOrderReady(
  input: { orderNo: string | null; transactionId: string },
  deps: PollDeps = {},
): Promise<PollResult> {
  const log = deps.log ?? ((m: string) => console.log(m));
  const intervalMs = Math.max(0, deps.intervalMs ?? POLL_INTERVAL_MS);
  const maxAttempts = Math.max(1, Math.trunc(deps.maxAttempts ?? MAX_POLL_ATTEMPTS));
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  const query =
    deps.query ??
    ((q) =>
      esimAccess.queryOrder({
        ...(q.orderNo ? { orderNo: q.orderNo } : {}),
        transactionId: q.transactionId,
      }).then((r) => ({ status: r.status, esims: r.esims })));

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const state = await query({ orderNo: input.orderNo, transactionId: input.transactionId });
      const esims = state.esims ?? [];
      if (esims.length > 0 && esims.every(isInstallable)) {
        log(`[orderPoller] ready after attempt ${attempt} (status=${state.status})`);
        return { ready: true, esims, attempts: attempt };
      }
      // A terminal failure from the supplier is not worth polling further.
      if (isTerminalFailure(state.status)) {
        return {
          ready: false,
          esims,
          attempts: attempt,
          reason: `supplier_status_${state.status}`,
        };
      }
    } catch (err) {
      log(
        `[orderPoller] query attempt ${attempt} failed: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (attempt < maxAttempts) await sleep(intervalMs);
  }
  return {
    ready: false,
    esims: [],
    attempts: maxAttempts,
    reason: "poll_exhausted",
  };
}

// ---------------------------------------------------------------------------
// Background sweep
// ---------------------------------------------------------------------------

let sweepTimer: NodeJS.Timeout | null = null;
let sweepRunning = false;

export interface OrderPollerOptions {
  intervalMs?: number;
  batch?: number;
  log?: (msg: string) => void;
  /** Injectable order-loader for tests; default reads DB. */
  loadProcessingOrderIds?: () => Promise<string[]>;
  /** Injectable per-order driver for tests; default calls resumeProcessingOrder. */
  driveOrder?: (orderPublicId: string) => Promise<void>;
}

/**
 * Start the background poller. Idempotent; does not run immediately unless the
 * caller invokes `sweepProcessingOrdersOnce` itself. Interval is unref'd.
 */
export function startOrderPoller(options: OrderPollerOptions = {}): void {
  const interval = Math.max(5_000, options.intervalMs ?? SWEEP_INTERVAL_MS);
  const log = options.log ?? ((m: string) => console.log(m));
  if (sweepTimer) {
    log("[orderPoller] already started; ignoring duplicate start");
    return;
  }
  sweepTimer = setInterval(() => {
    void sweepProcessingOrdersOnce(options);
  }, interval);
  sweepTimer.unref?.();
  log(`[orderPoller] sweep scheduled every ${interval}ms`);
}

export function stopOrderPoller(): void {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}

/**
 * One sweep: re-drive up to `batch` orders currently in `processing` so a
 * missed webhook doesn't leave an order stuck. Never throws — logs failures.
 */
export async function sweepProcessingOrdersOnce(options: OrderPollerOptions = {}): Promise<{
  processed: number;
  errors: number;
}> {
  const log = options.log ?? ((m: string) => console.log(m));
  if (sweepRunning) {
    log("[orderPoller] previous sweep still running; skipping");
    return { processed: 0, errors: 0 };
  }
  sweepRunning = true;
  let processed = 0;
  let errors = 0;
  try {
    const loadIds =
      options.loadProcessingOrderIds ??
      (() => loadProcessingOrderIds(options.batch ?? SWEEP_BATCH));
    const drive =
      options.driveOrder ??
      (async (publicId: string) => {
        await resumeProcessingOrder(publicId, { log });
      });

    const ids = await loadIds();
    for (const id of ids) {
      try {
        await drive(id);
        processed += 1;
      } catch (err) {
        errors += 1;
        log(
          `[orderPoller] drive failed for ${id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  } catch (err) {
    errors += 1;
    log(`[orderPoller] sweep failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    sweepRunning = false;
  }
  return { processed, errors };
}

async function loadProcessingOrderIds(batch: number): Promise<string[]> {
  const db = getDb();
  if (!db) return [];
  const rows = await db
    .select({ publicId: orders.publicId })
    .from(orders)
    .where(inArray(orders.status, ["processing"]))
    .limit(Math.max(1, Math.trunc(batch)));
  return rows.map((r) => r.publicId);
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function isInstallable(e: SupplierEsim): boolean {
  return Boolean(e.iccid && (e.lpaCode || e.qrCodeUrl));
}

function isTerminalFailure(status: string): boolean {
  const s = status.toUpperCase();
  return s === "CANCELLED" || s === "CANCELED" || s === "FAILED" || s === "REJECTED";
}

export const __test__ = {
  isInstallable,
  isTerminalFailure,
  POLL_INTERVAL_MS,
  MAX_POLL_ATTEMPTS,
};

// Referenced to avoid unused-import lint when a downstream build tree-shakes.
void and;
void eq;

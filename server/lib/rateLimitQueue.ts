/**
 * A minimal, dependency-free async rate limiter used to keep supplier calls
 * under the eSIM Access limit (8 req/sec). Two responsibilities:
 *
 * 1. `RateLimiter` — serialises task start times so at most `maxPerSecond`
 *    tasks begin within any rolling 1s window. Callers `await limiter.run(fn)`.
 * 2. `retryWithBackoff` — wraps a callable and retries on retryable errors
 *    (5xx, network, 429) with exponential backoff + full jitter.
 *
 * Design notes:
 * - No external library. Kept intentionally small.
 * - Supports per-key queues via `RateLimiter({ name })` for observability.
 * - `retryWithBackoff` accepts a predicate so the caller decides what is
 *   retryable; unrelated errors propagate unchanged.
 */

export interface RateLimiterOptions {
  /** Requests allowed to begin per rolling second. Default 8. */
  maxPerSecond?: number;
  /** Cosmetic label used in error messages. */
  name?: string;
}

interface QueueEntry<T> {
  run: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

export class RateLimiter {
  private readonly maxPerSecond: number;
  private readonly name: string;
  /** Timestamps (ms) of the most recent task starts in the current window. */
  private recentStarts: number[] = [];
  private queue: QueueEntry<unknown>[] = [];
  private pumping = false;

  constructor(opts: RateLimiterOptions = {}) {
    this.maxPerSecond = Math.max(1, Math.floor(opts.maxPerSecond ?? 8));
    this.name = opts.name ?? "rate-limiter";
  }

  /** Number of tasks waiting to start (exposed for tests/metrics). */
  get pending(): number {
    return this.queue.length;
  }

  /** Schedule a task; resolves with its result once it actually runs. */
  run<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        run: task as () => Promise<unknown>,
        resolve: resolve as (v: unknown) => void,
        reject,
      });
      void this.pump();
    });
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.queue.length > 0) {
        const now = Date.now();
        // Drop timestamps outside the 1s window.
        while (this.recentStarts.length > 0 && now - this.recentStarts[0] >= 1000) {
          this.recentStarts.shift();
        }

        if (this.recentStarts.length < this.maxPerSecond) {
          const entry = this.queue.shift()!;
          this.recentStarts.push(now);
          // Fire-and-forget: do not block the pump while the task runs.
          Promise.resolve()
            .then(entry.run)
            .then(entry.resolve, entry.reject);
          continue;
        }

        // Wait until the oldest start falls out of the window.
        const waitMs = Math.max(1, 1000 - (now - this.recentStarts[0]));
        await sleep(waitMs);
      }
    } finally {
      this.pumping = false;
    }
  }
}

export interface RetryOptions {
  /** Maximum number of attempts including the first. Default 4. */
  maxAttempts?: number;
  /** Base delay in ms. Default 250. */
  baseDelayMs?: number;
  /** Cap on backoff delay. Default 4000. */
  maxDelayMs?: number;
  /** Decide whether an error is retryable. Defaults to `isRetryableError`. */
  isRetryable?: (error: unknown, attempt: number) => boolean;
  /** Called before each retry (e.g. for logging / metrics). */
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
  /** Optional AbortSignal. */
  signal?: AbortSignal;
}

/** Fetch-like errors with an HTTP status. */
export interface HttpishError extends Error {
  status?: number;
  retryable?: boolean;
}

export function isRetryableError(error: unknown): boolean {
  const e = error as HttpishError | undefined;
  if (!e) return false;
  if (e.retryable === true) return true;
  if (typeof e.status === "number") {
    return e.status === 408 || e.status === 425 || e.status === 429 || e.status >= 500;
  }
  // Network errors (Node fetch throws TypeError / AbortError for connection issues).
  if (e.name === "AbortError") return false;
  if (e.name === "TypeError") return true;
  return false;
}

export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const maxAttempts = Math.max(1, opts.maxAttempts ?? 4);
  const baseDelayMs = Math.max(1, opts.baseDelayMs ?? 250);
  const maxDelayMs = Math.max(baseDelayMs, opts.maxDelayMs ?? 4000);
  const isRetryable = opts.isRetryable ?? isRetryableError;

  let attempt = 1;
  for (;;) {
    try {
      return await fn();
    } catch (error) {
      if (attempt >= maxAttempts || !isRetryable(error, attempt)) {
        throw error;
      }
      // Exponential backoff with full jitter: delay = random(0, min*2^(n-1)).
      const cap = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      const delayMs = Math.floor(Math.random() * cap) + 1;
      opts.onRetry?.(error, attempt, delayMs);
      if (opts.signal?.aborted) throw error;
      await sleep(delayMs);
      attempt += 1;
    }
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Per-caller rate limiting for AI endpoints.
 *
 * Why this file exists
 * --------------------
 * Every AI request costs money and can be slow. The data estimator / support
 * chat / (later) trip planner endpoints must be protected by a rate limiter
 * that is (a) cheap (in-memory, no Redis dependency for phase scope),
 * (b) testable, and (c) called *before* the provider so refused calls never
 * incur cost.
 *
 * Bucket model
 * ------------
 * A per-key sliding window of N requests per `windowMs`. Keys are opaque
 * strings composed by the caller — typically `${scope}:${identity}` where
 * identity is `user:<id>`, `session:<sid>` or `ip:<addr>`. Sliding (not fixed)
 * windows avoid the boundary-burst problem where a user gets 2N requests in
 * one second by straddling a fixed window boundary.
 *
 * Not a global quota
 * ------------------
 * This module is NOT the place to enforce per-account monthly spend. That is
 * `costLog.ts` + admin-configured limits. Here we only refuse bursts.
 *
 * Honest limitations
 * ------------------
 * - In-memory: a process restart resets windows, and a multi-instance deploy
 *   does not share state. Replit's typical single-instance Node process is
 *   fine; horizontal scaling needs Redis (documented TODO below, not
 *   implemented).
 * - No persistence: nothing about the caller is stored on disk. Windows are
 *   forgotten once they fully slide out.
 */
import { sleep } from "../lib/rateLimitQueue";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface AiRateLimitRule {
  /** Requests allowed per window per key. */
  limit: number;
  /** Window length in ms. */
  windowMs: number;
}

/**
 * Default rules, aligned to what a low-friction AI surface should tolerate
 * for a paying visitor. Kept as a constant so tests can assert the values
 * and the admin dashboard can render them without a DB read.
 *
 * - estimator: a user may tap "Estimate" a few times per minute.
 * - support_chat: conversational — a burst of up to 10 messages per minute
 *   is polite and lets a real chat flow.
 * - trip_planner: expensive (streams a long answer); 3 per 10 minutes.
 */
export const AI_RATE_LIMITS = {
  estimator: { limit: 6, windowMs: 60_000 } as AiRateLimitRule,
  support_chat: { limit: 10, windowMs: 60_000 } as AiRateLimitRule,
  trip_planner: { limit: 3, windowMs: 10 * 60_000 } as AiRateLimitRule,
} as const;

export type AiScope = keyof typeof AI_RATE_LIMITS;

/** Fallback rule for unknown scopes (defensive; should never happen in prod). */
const FALLBACK_RULE: AiRateLimitRule = { limit: 5, windowMs: 60_000 };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RateLimitDecision {
  allowed: boolean;
  /** Requests remaining in the current window (>= 0). */
  remaining: number;
  /** When the window frees a slot for this key, in ms from now (0 if allowed). */
  retryAfterMs: number;
  /** Rule that was applied, echoed back for the API response headers. */
  rule: AiRateLimitRule;
}

// ---------------------------------------------------------------------------
// Sliding-window limiter
// ---------------------------------------------------------------------------

interface Bucket {
  /** Timestamps (ms) of accepted requests still inside the window. */
  hits: number[];
}

/**
 * A single limit scope. Construct once per process and share — bucket state
 * lives in the limiter.
 */
export class AiRateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly rules: Record<string, AiRateLimitRule>;
  private readonly now: () => number;

  constructor(opts: { rules?: Record<string, AiRateLimitRule>; now?: () => number } = {}) {
    this.rules = opts.rules ?? AI_RATE_LIMITS;
    this.now = opts.now ?? (() => Date.now());
  }

  /**
   * Try to consume one request for `key`. Pure bookkeeping: records the hit
   * only when allowed, so a burst of 20 requests gets 6 allowed + 14 refused
   * rather than push out earlier entries.
   */
  check(scope: AiScope, key: string): RateLimitDecision {
    const rule = this.rules[scope] ?? FALLBACK_RULE;
    const now = this.now();
    const cutoff = now - rule.windowMs;

    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { hits: [] };
      this.buckets.set(key, bucket);
    }
    // Drop hits that have slid out.
    while (bucket.hits.length > 0 && bucket.hits[0]! < cutoff) bucket.hits.shift();

    if (bucket.hits.length < rule.limit) {
      bucket.hits.push(now);
      return {
        allowed: true,
        remaining: Math.max(0, rule.limit - bucket.hits.length),
        retryAfterMs: 0,
        rule,
      };
    }

    // Earliest hit's expiry is when one slot will free.
    const earliest = bucket.hits[0] ?? now;
    const retryAfterMs = Math.max(0, rule.windowMs - (now - earliest));
    return { allowed: false, remaining: 0, retryAfterMs, rule };
  }

  /** Test/ops helper: forget one key's state. */
  reset(key?: string): void {
    if (key == null) this.buckets.clear();
    else this.buckets.delete(key);
  }

  /**
   * Housekeeping: drop *empty* buckets whose contents predate the longest
   * window. Called from a periodic sweep in the app, not per request. Safe to
   * call any time; only removes state for keys nobody has used recently.
   */
  sweep(): void {
    const now = this.now();
    const longest = Math.max(
      ...Object.values(this.rules).map((r) => r.windowMs),
      FALLBACK_RULE.windowMs,
    );
    for (const [k, bucket] of this.buckets) {
      const newest = bucket.hits[bucket.hits.length - 1];
      if (newest == null || newest < now - longest) {
        this.buckets.delete(k);
      }
    }
  }
}

/** Process-wide limiter used by the AI routes. */
export const aiRateLimiter = new AiRateLimiter();

// ---------------------------------------------------------------------------
// Key composition
// ---------------------------------------------------------------------------

/**
 * Build a stable key from an identity. The caller decides precedence:
 * a signed-in user id is more stable than a session, which is more stable
 * than an IP (shared IPs by design fall in the same bucket — conservative).
 *
 * Examples:
 *   composeKey("estimator", { userId: 42 })            -> "estimator:user:42"
 *   composeKey("support_chat", { sessionId: "ab12" })  -> "support_chat:session:ab12"
 *   composeKey("trip_planner", { ip: "1.2.3.4" })      -> "trip_planner:ip:1.2.3.4"
 */
export function composeKey(
  scope: AiScope,
  identity: { userId?: number | null; sessionId?: string | null; ip?: string | null },
): string {
  if (identity.userId != null) return `${scope}:user:${identity.userId}`;
  if (identity.sessionId) return `${scope}:session:${identity.sessionId}`;
  if (identity.ip) return `${scope}:ip:${identity.ip}`;
  return `${scope}:anonymous`;
}

// ---------------------------------------------------------------------------
// Express-friendly wrapper
// ---------------------------------------------------------------------------

/**
 * Small helper the routes use: runs the check and either returns the decision
 * or a `retryAfterMs` the route turns into a 429 with `Retry-After`.
 *
 * Not an Express middleware itself, because AI rules differ per route and we
 * want the route to be able to build the response body (e.g. add the scope
 * name). Keeping this plain means it's testable without spinning up a server.
 */
export function applyRateLimit(
  limiter: AiRateLimiter,
  scope: AiScope,
  identity: Parameters<typeof composeKey>[1],
): { key: string; decision: RateLimitDecision } {
  const key = composeKey(scope, identity);
  return { key, decision: limiter.check(scope, key) };
}

/**
 * Exposed for the route's 429 path: wait at most `ms` (bounded) before
 * resolving. Only used by tests / tests to exercise retry timing — production
 * routes return 429 immediately rather than delay the user.
 */
export async function delayForRetry(ms: number): Promise<void> {
  const bounded = Math.min(Math.max(0, ms), 5_000);
  await sleep(bounded);
}

// ---------------------------------------------------------------------------
// Test surface
// ---------------------------------------------------------------------------

export const __test__ = {
  FALLBACK_RULE,
};

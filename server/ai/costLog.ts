/**
 * AI usage + cost accounting.
 *
 * Purpose
 * -------
 * Every AI call must be attributable so the admin dashboard can show
 * "AI usage cost" and so we can enforce account spend limits later. This
 * module owns two responsibilities:
 *
 *   1. `costForUsage` — pure arithmetic from token usage + model name to USD.
 *      Kept pure so tests can assert pricing without touching a DB or env.
 *   2. `logAiUsage` — persist one row per call (success OR failure) into the
 *      `ai_usage_log` table. The DB is injected; if it is not configured the
 *      call is REFUSED with `{ persisted:false, reason:"db_unavailable" }`
 *      so callers can see the honest outcome rather than believe a row was
 *      written.
 *
 * Pricing table
 * -------------
 * The prices here are per-1M-token defaults for common OpenAI models, matching
 * the public pricing page as of the model names we use. They are *estimates*
 * for cost visibility, not authoritative billing — Stripe remains the source
 * of truth for what a user paid us, and the provider dashboard is the source of
 * truth for what we paid them. Where we do not recognise a model name we return
 * `null` (unknown cost) rather than 0 — 0 would silently under-report spend.
 * If pricing changes, edit `MODEL_PRICING` here (single source of truth) and
 * the admin total will reflect it on the next call.
 *
 * Schema (migration to add in the next batch — NOT included here)
 * ----------------------------------------------------------------
 *   CREATE TABLE ai_usage_log (
 *     id             BIGSERIAL PRIMARY KEY,
 *     user_id        INTEGER REFERENCES users(id) ON DELETE SET NULL,
 *     label          TEXT NOT NULL,           -- "data_estimator", "support_chat", ...
 *     model          TEXT,                    -- provider-reported model, may be NULL on failure
 *     ok             BOOLEAN NOT NULL,
 *     reason         TEXT,                    -- AiFailureReason when ok=false
 *     prompt_tokens  INTEGER,
 *     completion_tokens INTEGER,
 *     total_tokens   INTEGER,
 *     cost_usd       NUMERIC(12,6),           -- NULL when model pricing unknown
 *     currency       TEXT NOT NULL DEFAULT 'USD',
 *     latency_ms     INTEGER NOT NULL,
 *     country_slug   TEXT,                    -- optional context for reporting
 *     created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
 *   );
 *   CREATE INDEX ai_usage_log_created_at_idx ON ai_usage_log (created_at DESC);
 *   CREATE INDEX ai_usage_log_user_idx       ON ai_usage_log (user_id);
 *
 * Drizzle-typed inserts are handled by a thin adapter (`dbInsert`) so this
 * file does not need to import a specific table shape yet (schema.ts was not
 * supplied in this batch's context). The route wiring batch will supply a
 * `dbInsert` implementation bound to the real table.
 */
import type { AiUsage } from "./aiClient";

// ---------------------------------------------------------------------------
// Pricing (USD per 1M tokens)
// ---------------------------------------------------------------------------

interface ModelRate {
  /** USD per 1,000,000 prompt tokens. */
  promptPerMillion: number;
  /** USD per 1,000,000 completion tokens. */
  completionPerMillion: number;
}

/**
 * Default pricing for the models we may use. Keep alphabetical-ish and
 * documented. Matches OpenAI's published tiers for the standard (non-batch)
 * API; update if you change `AI_MODEL`.
 */
export const MODEL_PRICING: Record<string, ModelRate> = {
  "gpt-4o-mini": { promptPerMillion: 0.15, completionPerMillion: 0.6 },
  "gpt-4o": { promptPerMillion: 2.5, completionPerMillion: 10 },
  "gpt-4.1-mini": { promptPerMillion: 0.4, completionPerMillion: 1.6 },
  "gpt-4.1": { promptPerMillion: 2, completionPerMillion: 8 },
  "gpt-3.5-turbo": { promptPerMillion: 0.5, completionPerMillion: 1.5 },
};

/**
 * Compute the USD cost estimate for a completion. Returns `null` when
 * - the model is unknown, or
 * - either token count is missing/negative (partial usage should not be
 *   guessed — under-reporting is worse than reporting "unknown").
 *
 * Pure. Exported for tests.
 */
export function costForUsage(usage: AiUsage, model: string | null): number | null {
  if (!model) return null;
  const rate = MODEL_PRICING[model];
  if (!rate) return null;
  if (usage.promptTokens == null || usage.completionTokens == null) return null;
  if (usage.promptTokens < 0 || usage.completionTokens < 0) return null;
  const promptCost = (usage.promptTokens / 1_000_000) * rate.promptPerMillion;
  const completionCost = (usage.completionTokens / 1_000_000) * rate.completionPerMillion;
  // Round to micro-dollars to keep NUMERIC(12,6) exact.
  return round(value(promptCost + completionCost), 6);
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

/**
 * The shape persisted for one AI attempt. `ok:false` rows still record
 * `latency_ms` and `reason` so the admin dashboard can spot a spike in
 * failures without joining provider logs.
 */
export interface AiUsageRecord {
  userId: number | null;
  label: string;
  model: string | null;
  ok: boolean;
  reason: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  costUsd: number | null;
  currency: "USD";
  latencyMs: number;
  countrySlug: string | null;
  createdAt: Date;
}

export interface AiUsageRow extends AiUsageRecord {
  id: number;
}

/**
 * The DB is injected. Returning a `dbInsert` that returns `[{ id }]` is the
 * expected shape (mirrors drizzle's `.insert(...).values(...).returning({id})`).
 * The route-wiring batch will supply one bound to the real `ai_usage_log`
 * table.
 */
export type AiUsageInserter = (row: Omit<AiUsageRecord, "createdAt">) => Promise<{ id: number } | null>;

export type LogAiUsageResult =
  | { persisted: true; id: number }
  | { persisted: false; reason: string };

/**
 * Persist one AI attempt. Composes the row from an observer event (produced by
 * `aiClient`), then hands it to the injected inserter. Never throws: a
 * persistence failure returns the honest reason so the caller can log it or
 * surface it in admin, but must not fail the user's AI request. (Cost
 * accounting is important but not worth breaking the product.)
 */
export async function logAiUsage(input: {
  record: Omit<AiUsageRecord, "createdAt" | "currency">;
  insert: AiUsageInserter | null;
}): Promise<LogAiUsageResult> {
  if (!input.insert) {
    return { persisted: false, reason: "db_unavailable" };
  }
  try {
    const inserted = await input.insert({ ...input.record, currency: "USD" });
    if (!inserted) return { persisted: false, reason: "insert_returned_no_row" };
    return { persisted: true, id: inserted.id };
  } catch (err) {
    return {
      persisted: false,
      reason: `insert_failed: ${(err as Error)?.message ?? String(err)}`,
    };
  }
}

/**
 * Build a `logAiUsage` callback that satisfies `AiObserver` from `aiClient`.
 * This is what the AI routes wire into `makeAiClient({ observer })` so a
 * single call logs and (implicitly) tracks cost. `userId`/`countrySlug` come
 * from the request context.
 */
export function makeAiObserver(args: {
  insert: AiUsageInserter | null;
  userId: number | null;
  countrySlug?: string | null;
  log?: (line: string) => void;
}): (event: {
  label: string;
  ok: boolean;
  model: string | null;
  usage: AiUsage | null;
  costUsd: number | null;
  latencyMs: number;
  reason?: string;
}) => void {
  const log = args.log ?? ((line: string) => console.log(line));
  return (event) => {
    const record: Omit<AiUsageRecord, "createdAt" | "currency"> = {
      userId: args.userId,
      label: event.label,
      model: event.model,
      ok: event.ok,
      reason: event.reason ?? null,
      promptTokens: event.usage?.promptTokens ?? null,
      completionTokens: event.usage?.completionTokens ?? null,
      totalTokens: event.usage?.totalTokens ?? null,
      costUsd: event.costUsd,
      latencyMs: event.latencyMs,
      countrySlug: args.countrySlug ?? null,
    };
    void logProductLine(log, record);
    // Fire and forget: we do not block the response on a log insert, but a
    // persistence failure is captured in the log line so it is never silent.
    void logAiUsage({ record, insert: args.insert }).then((res) => {
      if (!res.persisted) {
        log(
          JSON.stringify({
            at: new Date().toISOString(),
            channel: "ai_cost_log_failed",
            label: record.label,
            reason: res.reason,
          }),
        );
      }
    });
  };
}

/** One-line JSON summary of an attempt — safe (no prompt/response, no secrets). */
function logProductLine(log: (line: string) => void, record: Omit<AiUsageRecord, "createdAt" | "currency">): void {
  log(
    JSON.stringify({
      at: new Date().toISOString(),
      channel: "ai_usage",
      label: record.label,
      userId: record.userId,
      ok: record.ok,
      reason: record.reason,
      model: record.model,
      promptTokens: record.promptTokens,
      completionTokens: record.completionTokens,
      costUsd: record.costUsd,
      latencyMs: record.latencyMs,
    }),
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function round(n: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

function value(n: number): number {
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

// ---------------------------------------------------------------------------
// Test surface
// ---------------------------------------------------------------------------

export const __test__ = {
  round,
};

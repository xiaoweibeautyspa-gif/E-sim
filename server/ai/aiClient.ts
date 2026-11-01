/**
 * Server-side AI client — the ONE place this app talks to an LLM provider.
 *
 * Design contract
 * ---------------
 * - Every AI call in the app (data estimator, support chat, trip planner)
 *   goes through `ai.complete()` or `ai.stream()`. No call site holds its own
 *   provider SDK or key.
 * - The provider key is read from Replit Secrets via `loadAiConfig()`. If the
 *   key is missing we return `{ ok:false, reason:"not_configured" }` — never a
 *   fabricated completion. Callers must branch on this and give the user an
 *   honest "the planner isn't live yet" message rather than fake data.
 * - Text output is returned as plain text. Structured (JSON) output is
 *   requested with `responseFormat: "json"` and parsed; a parse failure is
 *   surfaced as `{ ok:false, reason:"invalid_json" }` — the caller is
 *   responsible for validating against its own schema (e.g. an estimator
 *   recommendation), because we do not trust model JSON blindly.
 * - Streaming: `ai.stream()` yields token deltas and a final `done` event
 *   with usage. A network error mid-stream yields an `error` event and then
 *   terminates; the caller must handle a truncated stream.
 * - The client does NOT log cost. Cost logging is a separate, composable
 *   concern (`costLog.ts` + `rateLimit.ts`) so a test can verify each in
 *   isolation. Callers that want cost-tracked AI should use the
 *   `aiCostTracked` wrapper the estimator route will assemble.
 *
 * Configuration (all optional except the key)
 * -------------------------------------------
 *   AI_API_KEY        (required to make any call)
 *   AI_BASE_URL       (default https://api.openai.com/v1)
 *   AI_MODEL          (default gpt-4o-mini)
 *   AI_TIMEOUT_MS     (default 30_000)
 *   AI_MAX_TOKENS     (default 1024)
 *
 * The default base/model match the OpenAI Chat Completions API, which is what
 * the majority of "AI key in Secrets" workflows use, and it lets the client be
 * pointed at any OpenAI-compatible endpoint (Azure OpenAI, together.ai, a
 * self-hosted vLLM, etc.) by setting AI_BASE_URL. The client is intentionally
 * thin over `fetch` so there is no SDK lock-in.
 */
import { costForUsage } from "./costLog";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A single conversational turn. `system` is first, `user`/`assistant` after. */
export interface AiMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** Token usage as reported by the provider. `null` when the provider omits it. */
export interface AiUsage {
  promptTokens: number | null;
  completionTokens: number | null;
  /** Sum when both are present, else null. */
  totalTokens: number | null;
}

/** Successful non-streaming completion. */
export interface AiCompletion {
  ok: true;
  text: string;
  /** Only present when `responseFormat: "json"` and parsing succeeded. */
  json?: unknown;
  /** Model the provider actually used (may differ from the requested one). */
  model: string;
  usage: AiUsage;
  /** USD cost estimate derived from usage + model pricing. `null` if unknown. */
  costUsd: number | null;
  /** Wall-clock latency in ms, for cost/latency logging. */
  latencyMs: number;
}

export type AiFailureReason =
  | "not_configured"
  | "http_error"
  | "invalid_response"
  | "invalid_json"
  | "timeout"
  | "aborted"
  | "network_error";

export interface AiFailure {
  ok: false;
  reason: AiFailureReason;
  /** Human-readable detail suitable for logs, never for direct user display. */
  detail: string;
  /** HTTP status when the failure came from an HTTP response. */
  status?: number;
  latencyMs: number;
}

export type AiResult = AiCompletion | AiFailure;

export interface AiRequest {
  messages: AiMessage[];
  /** Short identifier for logs (e.g. "data_estimator"). Not sent to the model. */
  label: string;
  /** Ask the provider to return JSON; the client will attempt to parse it. */
  responseFormat?: "text" | "json";
  /** Override the configured model (e.g. a cheaper one for short chats). */
  model?: string;
  /** Override max tokens (bounded by AI_MAX_TOKENS if set). */
  maxTokens?: number;
  /** Override temperature (default 0.4). */
  temperature?: number;
  signal?: AbortSignal;
}

/** One incremental chunk of a streamed completion. */
export type AiStreamEvent =
  | { type: "delta"; text: string }
  | { type: "usage"; usage: AiUsage; model: string; costUsd: number | null }
  | { type: "done"; text: string; model: string; usage: AiUsage; costUsd: number | null; latencyMs: number }
  | { type: AiFailureReason; detail: string; status?: number; latencyMs: number };

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface AiConfig {
  /** Whether AI calls can be made at all. */
  configured: boolean;
  apiKey: string | null;
  baseUrl: string;
  defaultModel: string;
  timeoutMs: number;
  maxTokens: number;
}

/** Read AI config from `process.env`. Cached per process; tests can reset. */
let cachedConfig: AiConfig | null = null;

export function loadAiConfig(env: NodeJS.ProcessEnv = process.env): AiConfig {
  if (cachedConfig) return cachedConfig;
  const apiKey = tri(env.AI_API_KEY) ?? tri(env.OPENAI_API_KEY) ?? null;
  const baseUrl = (tri(env.AI_BASE_URL) ?? "https://api.openai.com/v1").replace(/\/+$/, "");
  const defaultModel = tri(env.AI_MODEL) ?? "gpt-4o-mini";
  const timeoutMs = numOr(env.AI_TIMEOUT_MS, 30_000);
  const maxTokens = numOr(env.AI_MAX_TOKENS, 1024);
  cachedConfig = {
    configured: Boolean(apiKey),
    apiKey,
    baseUrl,
    defaultModel,
    timeoutMs,
    maxTokens,
  };
  return cachedConfig;
}

export function __resetAiConfigForTests(): void {
  cachedConfig = null;
}

// ---------------------------------------------------------------------------
// Cost tracking hook (opt-in)
// ---------------------------------------------------------------------------

/**
 * Called with the outcome of every AI completion, regardless of success. Lets
 * the caller log cost/latency without the client knowing about the DB. The AI
 * routes wire this to `costLog.logAiUsage`. Kept as a plain callback so the
 * client has zero DB dependency.
 */
export type AiObserver = (event: {
  label: string;
  ok: boolean;
  model: string | null;
  usage: AiUsage | null;
  costUsd: number | null;
  latencyMs: number;
  reason?: AiFailureReason;
}) => void;

export interface AiClientDeps {
  /** Test seam: inject a `fetch`. Defaults to `globalThis.fetch`. */
  fetchImpl?: FetchLike;
  /** Read config (default `loadAiConfig`). */
  config?: () => AiConfig;
  /** Called after every attempt. Optional. */
  observer?: AiObserver;
  /** Clock for latency. */
  now?: () => number;
}

// Fetch shape we need — narrow so a test stub trivially satisfies it.
type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  body: ReadableStream<Uint8Array> | null;
  text: () => Promise<string>;
}>;

// ---------------------------------------------------------------------------
// Client factory
// ---------------------------------------------------------------------------

export interface AiClient {
  readonly isConfigured: boolean;
  complete(req: AiRequest): Promise<AiResult>;
  stream(req: AiRequest): AsyncGenerator<AiStreamEvent, void, void>;
}

/** Build an AI client with injectable deps. The app uses the singleton. */
export function makeAiClient(deps: AiClientDeps = {}): AiClient {
  const getConfig = deps.config ?? loadAiConfig;
  const now = deps.now ?? (() => Date.now());

  return {
    get isConfigured() {
      return getConfig().configured;
    },

    async complete(req: AiRequest): Promise<AiResult> {
      const cfg = getConfig();
      if (!cfg.configured || !cfg.apiKey) {
        return observeFailure(deps, req.label, {
          ok: false,
          reason: "not_configured",
          detail: "AI_API_KEY is not set (or AI is disabled).",
          latencyMs: 0,
        });
      }

      const startedAt = now();
      const model = req.model ?? cfg.defaultModel;
      const maxTokens = clampTokens(req.maxTokens ?? cfg.maxTokens, cfg.maxTokens);
      const temperature = clampTemp(req.temperature ?? 0.4);
      const body = JSON.stringify({
        model,
        messages: req.messages,
        max_tokens: maxTokens,
        temperature,
        ...(req.responseFormat === "json" ? { response_format: { type: "json_object" } } : {}),
      });

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
      const onAbort = () => controller.abort();
      req.signal?.addEventListener("abort", onAbort);

      try {
        const fetchImpl = deps.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
        const res = await fetchImpl(`${cfg.baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${cfg.apiKey}`,
          },
          body,
          signal: controller.signal,
        });

        const latencyMs = now() - startedAt;
        const text = await res.text();

        if (!res.ok) {
          return observeFailure(deps, req.label, {
            ok: false,
            reason: "http_error",
            status: res.status,
            detail: truncate(`HTTP ${res.status}: ${text}`, 400),
            latencyMs,
          });
        }

        const parsed = safeJson(text);
        if (!parsed) {
          return observeFailure(deps, req.label, {
            ok: false,
            reason: "invalid_response",
            detail: "Provider returned non-JSON.",
            latencyMs,
          });
        }
        const extracted = extractCompletion(parsed);
        if (!extracted) {
          return observeFailure(deps, req.label, {
            ok: false,
            reason: "invalid_response",
            detail: "Provider response had no assistant message content.",
            latencyMs,
          });
        }

        const usage = extractUsage(parsed);
        const costUsd = costForUsage(usage, extracted.model);

        if (req.responseFormat === "json") {
          const json = parseStrictJson(extracted.text);
          if (json === undefined) {
            return observeFailure(deps, req.label, {
              ok: false,
              reason: "invalid_json",
              detail: "Model response was not valid JSON; caller must not trust it.",
              latencyMs,
            });
          }
          const success: AiCompletion = {
            ok: true,
            text: extracted.text,
            json,
            model: extracted.model,
            usage,
            costUsd,
            latencyMs,
          };
          observeSuccess(deps, req.label, success);
          return success;
        }

        const success: AiCompletion = {
          ok: true,
          text: extracted.text,
          model: extracted.model,
          usage,
          costUsd,
          latencyMs,
        };
        observeSuccess(deps, req.label, success);
        return success;
      } catch (err) {
        const latencyMs = now() - startedAt;
        const isAbort = (err as { name?: string })?.name === "AbortError";
        const reason: AiFailureReason = isAbort
          ? req.signal?.aborted
            ? "aborted"
            : "timeout"
          : "network_error";
        return observeFailure(deps, req.label, {
          ok: false,
          reason,
          detail: truncate((err as Error)?.message ?? String(err), 300),
          latencyMs,
        });
      } finally {
        clearTimeout(timer);
        req.signal?.removeEventListener("abort", onAbort);
      }
    },

    async *stream(req: AiRequest): AsyncGenerator<AiStreamEvent, void, void> {
      const cfg = getConfig();
      if (!cfg.configured || !cfg.apiKey) {
        yield {
          type: "not_configured",
          detail: "AI_API_KEY is not set (or AI is disabled).",
          latencyMs: 0,
        };
        return;
      }

      const startedAt = now();
      const model = req.model ?? cfg.defaultModel;
      const maxTokens = clampTokens(req.maxTokens ?? cfg.maxTokens, cfg.maxTokens);
      const temperature = clampTemp(req.temperature ?? 0.4);
      const body = JSON.stringify({
        model,
        messages: req.messages,
        max_tokens: maxTokens,
        temperature,
        stream: true,
        stream_options: { include_usage: true },
      });

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
      const onAbort = () => controller.abort();
      req.signal?.addEventListener("abort", onAbort);

      let fullText = "";
      let usage: AiUsage = { promptTokens: null, completionTokens: null, totalTokens: null };
      let usedModel = model;

      try {
        const fetchImpl = deps.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
        const res = await fetchImpl(`${cfg.baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "text/event-stream",
            Authorization: `Bearer ${cfg.apiKey}`,
          },
          body,
          signal: controller.signal,
        });
        if (!res.ok || !res.body) {
          const text = await res.text();
          const reason: AiFailureReason = res.ok ? "invalid_response" : "http_error";
          const failure: AiStreamEvent = {
            type: reason,
            detail: truncate(`HTTP ${res.status}: ${text}`, 400),
            ...(res.ok ? {} : { status: res.status }),
            latencyMs: now() - startedAt,
          };
          deps.observer?.({
            label: req.label,
            ok: false,
            model: null,
            usage: null,
            costUsd: null,
            latencyMs: failure.latencyMs,
            reason,
          });
          yield failure;
          return;
        }

        const reader = (res.body as ReadableStream<Uint8Array>).getReader();
        const decoder = new TextDecoder("utf-8");
        let buffer = "";

        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          let idx = buffer.indexOf("\n\n");
          while (idx !== -1) {
            const rawEvent = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            for (const line of rawEvent.split("\n")) {
              if (!line.startsWith("data:")) continue;
              const payload = line.slice(5).trim();
              if (payload === "[DONE]") break;
              const chunk = safeJson(payload);
              if (!chunk) continue;
              const delta = extractDelta(chunk);
              if (delta) {
                fullText += delta;
                yield { type: "delta", text: delta };
              }
              if (chunk.model && typeof chunk.model === "string") usedModel = chunk.model;
              const u = extractUsage(chunk);
              if (u.totalTokens != null) usage = u;
            }
            idx = buffer.indexOf("\n\n");
          }
        }

        const latencyMs = now() - startedAt;
        const costUsd = costForUsage(usage, usedModel);
        deps.observer?.({
          label: req.label,
          ok: true,
          model: usedModel,
          usage,
          costUsd,
          latencyMs,
        });
        yield { type: "usage", usage, model: usedModel, costUsd };
        yield { type: "done", text: fullText, model: usedModel, usage, costUsd, latencyMs };
      } catch (err) {
        const isAbort = (err as { name?: string })?.name === "AbortError";
        const reason: AiFailureReason = isAbort
          ? req.signal?.aborted
            ? "aborted"
            : "timeout"
          : "network_error";
        const latencyMs = now() - startedAt;
        deps.observer?.({
          label: req.label,
          ok: false,
          model: null,
          usage: null,
          costUsd: null,
          latencyMs,
          reason,
        });
        yield {
          type: reason,
          detail: truncate((err as Error)?.message ?? String(err), 300),
          latencyMs,
        };
      } finally {
        clearTimeout(timer);
        req.signal?.removeEventListener("abort", onAbort);
      }
    },
  };
}

/** Default singleton used by the AI routes. Reads config lazily from env. */
export const ai: AiClient = makeAiClient();

// ---------------------------------------------------------------------------
// Response parsing helpers (exported for tests)
// ---------------------------------------------------------------------------

function safeJson(text: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function extractCompletion(payload: Record<string, unknown>): { text: string; model: string } | null {
  const choices = payload.choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first = choices[0] as Record<string, unknown> | undefined;
  const message = first?.message as Record<string, unknown> | undefined;
  const text = typeof message?.content === "string" ? message.content : null;
  if (text == null) return null;
  const model = typeof payload.model === "string" ? payload.model : "unknown";
  return { text, model };
}

function extractDelta(payload: Record<string, unknown>): string | null {
  const choices = payload.choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first = choices[0] as Record<string, unknown> | undefined;
  const delta = first?.delta as Record<string, unknown> | undefined;
  return typeof delta?.content === "string" ? delta.content : null;
}

function extractUsage(payload: Record<string, unknown>): AiUsage {
  const u = payload.usage as Record<string, unknown> | undefined;
  if (!u) return { promptTokens: null, completionTokens: null, totalTokens: null };
  const p = typeof u.prompt_tokens === "number" ? u.prompt_tokens : null;
  const c = typeof u.completion_tokens === "number" ? u.completion_tokens : null;
  const t = typeof u.total_tokens === "number" ? u.total_tokens : p != null && c != null ? p + c : null;
  return { promptTokens: p, completionTokens: c, totalTokens: t };
}

/** Parse JSON that might be wrapped in ```json fences from a chatty model. */
function parseStrictJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)```$/);
  const candidate = fenced?.[1]?.trim() ?? trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Observers
// ---------------------------------------------------------------------------

function observeSuccess(deps: AiClientDeps, label: string, c: AiCompletion): void {
  deps.observer?.({
    label,
    ok: true,
    model: c.model,
    usage: c.usage,
    costUsd: c.costUsd,
    latencyMs: c.latencyMs,
  });
}

function observeFailure(deps: AiClientDeps, label: string, f: AiFailure): AiFailure {
  deps.observer?.({
    label,
    ok: false,
    model: null,
    usage: null,
    costUsd: null,
    latencyMs: f.latencyMs,
    reason: f.reason,
  });
  return f;
}

// ---------------------------------------------------------------------------
// Env/clamp helpers
// ---------------------------------------------------------------------------

function tri(v: string | undefined): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

function numOr(v: string | undefined, fallback: number): number {
  const n = v != null ? Number(v) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function clampTokens(requested: number, hardCap: number): number {
  const n = Math.floor(requested);
  if (!Number.isFinite(n) || n <= 0) return hardCap;
  return Math.min(n, hardCap);
}

function clampTemp(t: number): number {
  if (!Number.isFinite(t)) return 0.4;
  return Math.max(0, Math.min(2, t));
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}

// ---------------------------------------------------------------------------
// Test surface
// ---------------------------------------------------------------------------

export const __test__ = {
  extractCompletion,
  extractDelta,
  extractUsage,
  parseStrictJson,
  clampTokens,
  clampTemp,
};

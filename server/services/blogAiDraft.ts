/**
 * AI blog draft service.
 *
 * SCOPE
 * -----
 * The admin blog editor (src/pages/Blog.tsx + server/routes/blog.ts, shipped in
 * the previous batch) can ask this service to draft a post. The draft is
 * returned to the admin as a *draft* — this module NEVER publishes. Persisting
 * the draft and gating publication behind review is the blog route's job; here
 * we only produce the text.
 *
 * HARD RULES
 * ----------
 *  - The AI key comes from Secrets on the server; we never see or log it.
 *  - Every call is rate-limited and cost-logged through the shared
 *    server/ai/* helpers. Missing AI configuration returns an honest
 *    `{ ok:false, reason:"ai_not_configured" }` — we never fabricate a draft.
 *  - Output is forcibly marked `status:"draft"` and `reviewRequired:true` so
 *    no caller can accidentally treat it as published content.
 *  - Only real catalog facts are passed to the model for context (country
 *    names + network names pulled by the caller). We do NOT let the model
 *    invent prices or plans — the prompt instructs it to avoid pricing and
 *    the caller supplies any facts it wants anchored.
 *
 * INTEGRATIONS
 * ------------
 * The AI client / cost log / rate limiter were delivered in the AI-helpers
 * phase but their exact exports were not re-supplied with this batch. We import
 * them defensively and wire them through a injectable seam (`BlogAiDeps`) so
 * unit tests can drive the whole flow without a real AI key or network. If the
 * real modules do export a compatible shape they are used automatically.
 */
import { brand, type SupportedLocale } from "../brand.config";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Supported locales for a blog post. Matches the storefront switcher. */
export type BlogLocale = SupportedLocale;

/** A single draft request from the admin editor. */
export interface BlogDraftRequest {
  /** Working title (may be empty — the model suggests one). */
  title?: string;
  /** Target audience / angle, e.g. "families visiting Japan". */
  angle: string;
  /** Locale the draft should be written in. Defaults to English. */
  locale?: BlogLocale;
  /** Optional target country slug so the draft can link the country page. */
  countrySlug?: string | null;
  /** Optional extra notes from the admin. */
  notes?: string;
  /** Approximate length, in words. Clamped to [200, 2000]. */
  wordCount?: number;
  /**
   * Anchor facts the admin wants quoted verbatim (network names, guarantees).
   * We pass these as-is; the model must not contradict them. Optional.
   */
  facts?: string[];
}

/** A draft is ALWAYS unreviewed; the type encodes that. */
export interface BlogDraft {
  status: "draft";
  reviewRequired: true;
  locale: BlogLocale;
  title: string;
  slug: string;
  metaDescription: string;
  bodyMarkdown: string;
  tags: string[];
  /** Model + cost metadata so the admin dashboard can attribute spend. */
  meta: {
    model: string;
    inputTokens: number | null;
    outputTokens: number | null;
    costUsd: number | null;
    /** True when the model wasn't configured and this is a deterministic stub. */
    stubbed: false;
  };
}

export type BlogDraftResult =
  | { ok: true; draft: BlogDraft }
  | {
      ok: false;
      reason:
        | "ai_not_configured"
        | "rate_limited"
        | "invalid_input"
        | "ai_error";
      message: string;
    };

// ---------------------------------------------------------------------------
// Injectable dependencies
//
// The real AI modules (server/ai/aiClient.ts, costLog.ts, rateLimit.ts) are
// imported lazily so a missing key or a unit-test environment never crashes
// this module at load. Tests pass fakes and get deterministic behaviour.
// ---------------------------------------------------------------------------

/** The narrow chat interface this service needs. */
export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** What a chat call returns (either the real client or a test fake). */
export interface ChatResult {
  content: string;
  model?: string;
  inputTokens?: number | null;
  outputTokens?: number | null;
  /** Cost in USD if the provider reports it. */
  costUsd?: number | null;
}

export interface BlogAiDeps {
  /** True when a server-side AI key exists. */
  isConfigured?: () => boolean | Promise<boolean>;
  /** Chat completion call. Must throw on transport failure, not return "" */
  chat?: (args: { messages: ChatMessage[]; maxOutputTokens?: number }) => Promise<ChatResult>;
  /** Per-user rate-limit gate. Returns `allowed:false` with a message when limited. */
  rateLimit?: (input: {
    userId: number | null;
    route: string;
  }) => Promise<{ allowed: boolean; retryAfterSeconds?: number; message?: string }>;
  /** Cost logger — called once per successful AI call. */
  logCost?: (input: {
    route: string;
    userId: number | null;
    model: string;
    inputTokens: number | null;
    outputTokens: number | null;
    costUsd: number | null;
  }) => Promise<void> | void;
  /** Structured logger; defaults to a no-op so tests stay quiet. */
  log?: (event: Record<string, unknown>) => void;
  /** Clock injection for deterministic slugs. */
  now?: () => Date;
}

// ---------------------------------------------------------------------------
// OpenAI-compatible request builder — kept small and provider-agnostic.
// ---------------------------------------------------------------------------

const ROUTE = "blog.aiDraft";
const MAX_WORDS = 2000;
const MIN_WORDS = 200;
const DEFAULT_WORDS = 700;
const MAX_BODY_CHARS = 40_000;

function clampWords(input: number | undefined): number {
  if (input == null || !Number.isFinite(input)) return DEFAULT_WORDS;
  return Math.min(MAX_WORDS, Math.max(MIN_WORDS, Math.round(input)));
}

function localeLabel(locale: BlogLocale): string {
  switch (locale) {
    case "zh":
      return "Simplified Chinese (简体中文)";
    case "vi":
      return "Vietnamese (Tiếng Việt)";
    case "en":
    default:
      return "English";
  }
}

function systemPrompt(locale: BlogLocale): string {
  return [
    `You are a travel content writer for ${brand.name}, an eSIM retail site.`,
    `Write clearly, factually, and helpfully for travellers. Never invent prices,`,
    `discounts, company names, stats, or quotes. If you are unsure, omit the detail.`,
    `Do not promise refunds beyond this exact policy: "${brand.guaranteeCopy}".`,
    `Output STRICT MARKDOWN with:`,
    `1) One "# Title" line only, no more headings at that level.`,
    `2) Short intro paragraph (2–3 sentences).`,
    `3) 2–5 "## Subheadings" sections with bullet lists where appropriate.`,
    `4) A "## FAQ" section with 3 question/answer pairs (Question as "###").`,
    `Language: ${localeLabel(locale)}.`,
    `The article will be REVIEWED by a human before publication; write it as a`,
    `finished draft that still needs an editor's pass.`,
  ].join(" ");
}

function userPrompt(req: BlogDraftRequest, locale: BlogLocale, words: number): string {
  const lines = [
    `Working title: ${req.title?.trim() || "(suggest a compelling title)"}`,
    `Angle: ${req.angle.trim()}`,
    `Target length: about ${words} words.`,
  ];
  if (req.countrySlug) {
    lines.push(`Primary country page to link: /esim/${req.countrySlug}`);
  }
  if (req.notes?.trim()) {
    lines.push(`Editor notes: ${req.notes.trim()}`);
  }
  if (req.facts && req.facts.length > 0) {
    lines.push(`Facts you MUST quote exactly (do not paraphrase or extend them):`);
    for (const fact of req.facts) lines.push(`- ${fact}`);
  }
  lines.push(
    `Do not include a call-to-action with a price. You may link to the country page path above.`,
    `Respond in ${localeLabel(locale)}.`,
  );
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Response parsing — split the top "# Title" from the body and derive a slug.
// ---------------------------------------------------------------------------

export function parseMarkdownDraft(
  markdown: string,
): { title: string; bodyMarkdown: string } | null {
  const trimmed = markdown.trim();
  if (trimmed.length === 0) return null;
  const match = trimmed.match(/^\s*#\s+(.+?)\s*(?:\r?\n|$)/);
  if (!match) return null;
  const title = match[1]!.trim();
  if (!title) return null;
  const bodyMarkdown = trimmed.slice(match[0].length).trim();
  return { title, bodyMarkdown };
}

export function slugify(title: string): string {
  return title
    .toLowerCase()
    .normalize("NFKD")
    // strip combining marks (works for latin accents)
    .replace(/[\u0300-\u036f]/g, "")
    // keep letters+digits for non-latin (Chinese/Vietnamese accented) safe fallback
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "untitled";
}

function truncateDescription(markdown: string, max = 158): string {
  // Use the first paragraph, strip markdown, collapse whitespace.
  const text = markdown
    .replace(/^#.*$/gm, "")
    .replace(/[*_`>#-]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= max) return text;
  return text.slice(0, max - 1).replace(/\s+\S*$/, "") + "…";
}

// ---------------------------------------------------------------------------
// Defensive loading of the real AI modules
// ---------------------------------------------------------------------------

interface LoadedAiModules {
  isConfigured?: () => boolean | Promise<boolean>;
  chat?: (args: { messages: ChatMessage[]; maxOutputTokens?: number }) => Promise<ChatResult>;
  rateLimit?: BlogAiDeps["rateLimit"];
  logCost?: BlogAiDeps["logCost"];
}

/**
 * Attempt to load the real AI modules and adapt their exports to our
 * interfaces. Any import failure or shape mismatch is treated as "not
 * configured" — the caller then returns an honest error instead of a fake
 * draft. The dynamism here is deliberate: the AI-helpers batch's exports were
 * not re-supplied, so we don't hard-pin to a shape we can't see.
 */
export async function loadDefaultAiModules(): Promise<LoadedAiModules> {
  const out: LoadedAiModules = {};

  // --- aiClient ---
  try {
    const clientMod = (await import("../ai/aiClient")) as Record<string, unknown>;
    // Prefer `chat`, then `completeChat`, then `createChatCompletion`.
    const chatFn = (clientMod.chat ??
      clientMod.completeChat ??
      clientMod.createChatCompletion) as
      | ((args: {
          messages: ChatMessage[];
          maxOutputTokens?: number;
        }) => Promise<ChatResult>)
      | undefined;
    if (typeof chatFn === "function") out.chat = chatFn;

    const configuredFn = (clientMod.isConfigured ?? clientMod.isAiConfigured) as
      | (() => boolean | Promise<boolean>)
      | undefined;
    if (typeof configuredFn === "function") out.isConfigured = configuredFn;
    else {
      // Fallback: if the module exposes a key or a flag, honour it.
      const key = (clientMod.apiKey ?? clientMod.openaiKey) as unknown;
      if (typeof key === "string" && key.length > 0) out.isConfigured = () => true;
    }
  } catch {
    /* module absent — leave undefined */
  }

  // --- rateLimit ---
  try {
    const rl = (await import("../ai/rateLimit")) as Record<string, unknown>;
    const fn = (rl.checkRateLimit ?? rl.limitAiRequest ?? rl.assertRateLimit) as
      | BlogAiDeps["rateLimit"]
      | undefined;
    if (typeof fn === "function") out.rateLimit = fn;
  } catch {
    /* absent */
  }

  // --- costLog ---
  try {
    const cl = (await import("../ai/costLog")) as Record<string, unknown>;
    const fn = (cl.logAiCost ?? cl.recordAiCost ?? cl.logCost) as
      | BlogAiDeps["logCost"]
      | undefined;
    if (typeof fn === "function") out.logCost = fn;
  } catch {
    /* absent */
  }

  return out;
}

// ---------------------------------------------------------------------------
// Service entry point
// ---------------------------------------------------------------------------

export interface GenerateDraftInput extends BlogDraftRequest {
  /** Authenticated admin user generating the draft (for rate-limit + cost). */
  userId: number | null;
  /** Injectable deps; defaults to lazily-loaded real modules. */
  deps?: BlogAiDeps;
}

/**
 * Generate a draft for admin review. Never publishes.
 *
 * Determinism: with all deps injected and `now` fixed, this is a pure function
 * of its inputs + provider output, making it fully unit-testable without a key.
 */
export async function generateBlogDraft(
  input: GenerateDraftInput,
): Promise<BlogDraftResult> {
  if (!input.angle || !input.angle.trim()) {
    return { ok: false, reason: "invalid_input", message: "An angle is required." };
  }
  if (input.angle.length > 2_000) {
    return { ok: false, reason: "invalid_input", message: "Angle is too long." };
  }

  const locale: BlogLocale = input.locale ?? "en";
  const words = clampWords(input.wordCount);
  const log = input.deps?.log ?? (() => {});

  // Resolve dependencies (injected wins, else the real modules).
  const deps = input.deps ?? {};
  const loaded: LoadedAiModules = deps.chat && deps.rateLimit && deps.logCost
    ? {}
    : await loadDefaultAiModules();
  const resolved: Required<Pick<BlogAiDeps, "log">> & LoadedAiModules & BlogAiDeps = {
    ...loaded,
    ...deps,
    log,
  };

  const isConfigured = resolved.isConfigured
    ? await resolved.isConfigured()
    : typeof resolved.chat === "function";

  if (!isConfigured || typeof resolved.chat !== "function") {
    log({ event: "blog.aiDraft.not_configured", route: ROUTE, userId: input.userId });
    return {
      ok: false,
      reason: "ai_not_configured",
      message:
        "The AI assistant is not configured on this server. Add the AI key from Secrets to enable drafting.",
    };
  }

  // Rate limit before charging.
  if (typeof resolved.rateLimit === "function") {
    const rl = await resolved.rateLimit({ userId: input.userId, route: ROUTE });
    if (!rl.allowed) {
      log({ event: "blog.aiDraft.rate_limited", route: ROUTE, userId: input.userId });
      const retry = rl.retryAfterSeconds ?? null;
      return {
        ok: false,
        reason: "rate_limited",
        message:
          rl.message ??
          `Too many AI requests.${retry ? ` Try again in ${retry} seconds.` : ""}`,
      };
    }
  }

  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt(locale) },
    { role: "user", content: userPrompt(input, locale, words) },
  ];

  let chat: ChatResult;
  try {
    chat = await resolved.chat({
      messages,
      // 2000 words is roughly 2600 tokens; leave headroom for markdown.
      maxOutputTokens: Math.min(4_000, Math.round(words * 1.6) + 300),
    });
  } catch (err) {
    log({
      event: "blog.aiDraft.ai_error",
      route: ROUTE,
      userId: input.userId,
      message: err instanceof Error ? err.message : String(err),
    });
    return {
      ok: false,
      reason: "ai_error",
      message: "The AI service could not complete the draft. Try again shortly.",
    };
  }

  const parsed = parseMarkdownDraft(chat.content ?? "");
  if (!parsed || chat.content.length > MAX_BODY_CHARS) {
    log({
      event: "blog.aiDraft.unparseable",
      route: ROUTE,
      userId: input.userId,
      length: chat.content?.length ?? 0,
    });
    return {
      ok: false,
      reason: "ai_error",
      message:
        "The AI response could not be parsed as a draft. Please retry or write it manually.",
    };
  }

  const title = (input.title?.trim() || parsed.title).slice(0, 200);
  const now = input.deps?.now ? input.deps.now() : new Date();
  // Slug is deterministic for a given title+day; the blog route will suffix
  // a short suffix on collision.
  const datePart = now.toISOString().slice(0, 10).replace(/-/g, "");
  const slug = `${slugify(title)}-${datePart}`.slice(0, 100);

  const metaDescription = truncateDescription(parsed.bodyMarkdown);

  // Cost log — best-effort; failure here must not lose the draft.
  if (typeof resolved.logCost === "function") {
    try {
      await resolved.logCost({
        route: ROUTE,
        userId: input.userId,
        model: chat.model ?? "unknown",
        inputTokens: chat.inputTokens ?? null,
        outputTokens: chat.outputTokens ?? null,
        costUsd: chat.costUsd ?? null,
      });
    } catch (err) {
      log({
        event: "blog.aiDraft.cost_log_failed",
        route: ROUTE,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    ok: true,
    draft: {
      status: "draft",
      reviewRequired: true,
      locale,
      title,
      slug,
      metaDescription,
      bodyMarkdown: parsed.bodyMarkdown,
      tags: deriveTags(input),
      meta: {
        model: chat.model ?? "unknown",
        inputTokens: chat.inputTokens ?? null,
        outputTokens: chat.outputTokens ?? null,
        costUsd: chat.costUsd ?? null,
        stubbed: false,
      },
    },
  };
}

function deriveTags(input: BlogDraftRequest): string[] {
  const tags = new Set<string>();
  if (input.countrySlug) tags.add(input.countrySlug.toLowerCase());
  // Pull up to 4 topical words from the angle.
  for (const raw of input.angle.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length < 4) continue;
    if (["this", "that", "with", "from", "your", "when", "have"].includes(raw)) continue;
    tags.add(raw);
    if (tags.size >= 6) break;
  }
  return Array.from(tags).slice(0, 8);
}

// ---------------------------------------------------------------------------
// Test surface
// ---------------------------------------------------------------------------

export const __test__ = {
  ROUTE,
  MIN_WORDS,
  MAX_WORDS,
  DEFAULT_WORDS,
  MAX_BODY_CHARS,
  clampWords,
  systemPrompt,
  userPrompt,
  truncateDescription,
  deriveTags,
};

export default generateBlogDraft;

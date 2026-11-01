/**
 * AI helper routes — server side.
 *
 * Scope of this batch:
 *   - AI Data Estimator: destinations + trip length + usage habits → estimated
 *     GB + (best plan, one bigger option), where plans are ONLY real packages
 *     from our DB (never invented). Each plan carries a "Buy now" path.
 *   - AI support chat: install/troubleshooting help. When an authenticated user
 *     is supplied it sees that user's eSIM status, and it can escalate to
 *     WhatsApp/email using brand support contacts.
 *   - Rate limiting + cost logging on every AI-backed call.
 *
 * Design notes / contracts
 * ------------------------
 * - This router is a factory (`createAiRouter`) with injectable seams, mirroring
 *   the established pattern in server/routes/esims.ts. That keeps the route
 *   testable without a live DB / model and avoids importing modules whose exact
 *   signatures we cannot see in this batch:
 *       getDb        () => DrizzleLike | null
 *       requireAuth  Express RequestHandler (attaches req.user)
 *       optionalAuth Express RequestHandler (attaches req.user when present)
 *       ai           { complete: (input) => Promise<{ text, usage }> }
 *       rateLimit    { check: (key, limit) => { ok, retryAfterMs? } }
 *       costLog      { record: (entry) => Promise<void> | void }
 *   `registerAiRoutes(app, deps?)` in this file wires production defaults by
 *   importing the previously-saved AI modules. The imports are the ONLY place
 *   that touches those modules directly; if their exported names differ, edit
 *   the `loadDefaultDeps` function's imports — nothing else changes.
 *
 * - Plans returned to the client always come from `packages`; the AI is only
 *   used to estimate GB. We do NOT let the model name a plan. The best/bigger
 *   selection is deterministic from the estimate + DB rows.
 *
 * - Prices: `packages` stores wholesale in USD-cents-with-4-decimals already
 *   (per pricing engine). We read the retail price the pricing layer computes
 *   and expose it as `retailUsd` (number). If the row only has wholesale, we
 *   fall back and let the client show "price at checkout".
 *
 * - Failure modes are explicit JSON: { ok: false, error, message } with 4xx/5xx.
 *   No mock model output; if the AI key is missing the route returns
 *   503 ai_unavailable and the estimator/chat UIs surface that plainly.
 */
import type { Express, Request, Response, RequestHandler } from "express";
import { Router } from "express";
import { z } from "zod";
import { brand } from "../brand.config";

// ---------------------------------------------------------------------------
// Public types shared with the client components (SupportChat / PhoneChecker /
// DataEstimator). Keep these stable — the UI imports them by structural shape.
// ---------------------------------------------------------------------------

export interface CompatibleModel {
  id: number;
  brand: string;
  model: string;
  /** True if the model supports eSIM per our admin-maintained list. */
  esimCapable: boolean;
  /** Optional note, e.g. "Dual-SIM, eSIM supported from iOS 16". */
  notes: string | null;
  /** Lowest iOS/Android that supports eSIM, when known. */
  minOs: string | null;
}

export interface CompatibilityResult {
  query: string;
  /** Exact/partial matches. Empty when the query is unknown to our list. */
  matches: CompatibleModel[];
  /**
   * Coarse verdict the UI can show without duplicating badge logic:
   *  - "capable"    at least one match with esimCapable === true
   *  - "incapable" matches exist but none are eSIM-capable
   *  - "unknown"    no matches — user should check another way
   */
  verdict: "capable" | "incapable" | "unknown";
  /** Always present: steps to check carrier lock, independent of matches. */
  carrierLockGuidance: string[];
}

export interface EsimStatusSummary {
  id: number;
  country: string | null;
  planName: string | null;
  status: string;
  daysLeft: number | null;
  usedBytes: number | null;
  totalBytes: number | null;
  topUpEligible: boolean;
}

export interface RecommendedPlan {
  code: string;
  name: string;
  /** Retail price in USD; null means "see checkout" (wholesale only). */
  retailUsd: number | null;
  dataGb: number | null;
  durationDays: number | null;
  isDailyPlan: boolean;
  operators: string[];
  /** Where to buy — the country page or a deep link the client uses. */
  buyPath: string;
}

export interface DataEstimateResponse {
  estimatedGb: number;
  /** Short, model-authored explanation of the estimate (not the plan). */
  rationale: string;
  /** Habits echo so the UI can render a "based on" line. */
  assumptions: string[];
  /** Best fit from our catalog; null when no destination/package matched. */
  bestPlan: RecommendedPlan | null;
  /** One step larger; null when none exists. */
  biggerPlan: RecommendedPlan | null;
  /** Non-empty when the destination has no packages yet (still useful to the UI). */
  note: string | null;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface SupportChatResponse {
  reply: string;
  /** Present when a real escalation is warranted; the client renders buttons. */
  escalation: {
    whatsappNumber: string;
    whatsappUrl: string;
    emailAddress: string;
    emailUrl: string;
  } | null;
  /** Redacted eSIM context the assistant was told about (for UI transparency). */
  esimContext: EsimStatusSummary[];
}

// ---------------------------------------------------------------------------
// Injectable dependencies
// ---------------------------------------------------------------------------

/** Minimal Drizzle-like surface we depend on. Kept structural on purpose. */
interface DrizzleLike {
  select: (fields?: unknown) => {
    from: (table: unknown) => {
      where: (cond: unknown) => {
        orderBy?: (col: unknown) => Promise<unknown[]>;
        limit?: (n: number) => Promise<unknown[]>;
        // Some chains end with `then` (drizzle returns a thenable).
        then?: (resolve: (rows: unknown[]) => void) => void;
      };
      orderBy?: (col: unknown) => Promise<unknown[]>;
      limit?: (n: number) => Promise<unknown[]>;
    };
  };
}

interface AiCompletionInput {
  system: string;
  messages: ChatMessage[];
  /** Ask for JSON when the caller wants structured data (estimator). */
  json?: boolean;
  /** Hard cap on tokens to keep cost bounded. */
  maxTokens?: number;
  /** Tag for cost logging (e.g. "estimator", "support_chat"). */
  purpose: string;
  /** User id when known, for attributing cost. */
  userId?: number | null;
}

interface AiCompletionResult {
  text: string;
  usage: { inputTokens: number; outputTokens: number };
}

interface AiClient {
  complete: (input: AiCompletionInput) => Promise<AiCompletionResult>;
}

interface RateLimitDecision {
  ok: boolean;
  retryAfterMs?: number;
}

interface RateLimiter {
  check: (key: string, limit: { windowMs: number; max: number }) => RateLimitDecision;
}

interface CostEntry {
  purpose: string;
  userId: number | null;
  inputTokens: number;
  outputTokens: number;
  model?: string;
  at: Date;
}

interface CostLogger {
  record: (entry: CostEntry) => Promise<void> | void;
}

export interface AiRouteDeps {
  getDb: () => DrizzleLike | null;
  /** Required for chat when we need to attach the user's eSIMs. */
  requireAuth: RequestHandler;
  /** Optional: attaches req.user when logged in, else calls next(). */
  optionalAuth: RequestHandler;
  ai: AiClient | null;
  rateLimit: RateLimiter;
  costLog: CostLogger;
  /** Injectable clock for tests. */
  now?: () => Date;
  /** Injectable table references so tests can pass fakes without DB. */
  tables?: {
    phoneModels: unknown;
    packages: unknown;
    esims: unknown;
  };
}

// ---------------------------------------------------------------------------
// Request augmentation (matches the pattern in other routes)
// ---------------------------------------------------------------------------

interface AuthedUser {
  id: number;
  email?: string;
}

interface RequestWithUser extends Request {
  user?: AuthedUser;
}

// ---------------------------------------------------------------------------
// Rate limit buckets — deliberately separate so chat abuse doesn't consume
// estimator quota and vice versa.
// ---------------------------------------------------------------------------

const RATE_ESTIMATOR = { windowMs: 60_000, max: 10 };
const RATE_CHAT = { windowMs: 60_000, max: 20 };
const RATE_COMPAT = { windowMs: 60_000, max: 60 }; // cheap DB-only lookups

function limitKey(req: Request, purpose: string): string {
  const uid = (req as RequestWithUser).user?.id;
  if (uid != null) return `u:${uid}:${purpose}`;
  // IP based for anonymous — best effort; trust proxy is configured upstream.
  const ip = req.ip || req.socket.remoteAddress || "unknown";
  return `ip:${ip}:${purpose}`;
}

function applyRateLimit(
  req: Request,
  res: Response,
  limiter: RateLimiter,
  purpose: string,
  limit: { windowMs: number; max: number },
): boolean {
  const decision = limiter.check(limitKey(req, purpose), limit);
  if (decision.ok) return true;
  const retrySeconds = Math.max(1, Math.ceil((decision.retryAfterMs ?? limit.windowMs) / 1000));
  res
    .status(429)
    .set("Retry-After", String(retrySeconds))
    .json({
      ok: false,
      error: "rate_limited",
      message: `Too many requests. Try again in ${retrySeconds}s.`,
      retryAfterSeconds: retrySeconds,
    });
  return false;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function fail(res: Response, status: number, error: string, message: string): Response {
  return res.status(status).json({ ok: false, error, message });
}

function ok<T>(res: Response, data: T): Response {
  return res.json({ ok: true, data });
}

function toNumber(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function normalizeQuery(q: string): string {
  return q.trim().toLowerCase().replace(/\s+/g, " ");
}

// ---------------------------------------------------------------------------
// Carrier-lock guidance (static copy, must be accurate; no AI here)
// ---------------------------------------------------------------------------

const CARRIER_LOCK_GUIDANCE: readonly string[] = [
  "Open Settings → General → About on iPhone (or Settings → About phone on Android).",
  "Look for 'Carrier Lock' (iPhone) or 'SIM lock' / 'Network lock' (Android).",
  "If it says 'SIM locked' or 'Locked', contact your carrier to unlock the phone before installing a travel eSIM.",
  "Most phones sold unlocked in the last few years support eSIM; the phone must also be eSIM-capable (see the list above).",
];

// ---------------------------------------------------------------------------
// Estimator prompt & parsing
// ---------------------------------------------------------------------------

const ESTIMATOR_SYSTEM = [
  "You are a travel data estimator for an eSIM store.",
  "Given a destination, trip length in days, and a set of usage habits, estimate the total mobile data (in GB) the traveller needs for the whole trip.",
  "Return ONLY strict JSON matching this shape:",
  '{"estimatedGb": number, "rationale": string, "assumptions": string[]}',
  "Rules:",
  "- estimatedGb must be a positive number with at most 1 decimal (round up to the nearest 0.5).",
  "- rationale is 1-2 sentences, plain language, no plan names, no prices.",
  "- assumptions lists what drove the estimate (e.g. 'video calls ~1 GB/hour').",
  "- Never invent plans or prices. You only estimate data.",
].join("\n");

interface EstimatorInput {
  destination: string;
  days: number;
  habits: string[];
}

function buildEstimatorUserMessage(input: EstimatorInput): string {
  return JSON.stringify({
    destination: input.destination,
    days: input.days,
    habits: input.habits,
  });
}

interface ParsedEstimate {
  estimatedGb: number;
  rationale: string;
  assumptions: string[];
}

/** Best-effort tolerant parse — models sometimes wrap JSON in fences. */
function parseEstimateJson(text: string): ParsedEstimate | null {
  const trimmed = text.trim();
  const candidate = trimmed
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim();
  // Find the first { ... last } to survive leading prose.
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  const gb = toNumber(obj.estimatedGb);
  const rationale = typeof obj.rationale === "string" ? obj.rationale : "";
  const assumptions = Array.isArray(obj.assumptions)
    ? obj.assumptions.filter((a): a is string => typeof a === "string")
    : [];
  if (gb == null || gb <= 0) return null;
  return {
    // Round UP to 0.5 GB steps as the prompt requests.
    estimatedGb: Math.ceil(gb * 2) / 2,
    rationale: rationale || "Estimated from your trip length and habits.",
    assumptions,
  };
}

// ---------------------------------------------------------------------------
// DB row shapes + plan selection (from real packages only)
// ---------------------------------------------------------------------------

interface PackageRow {
  code: string;
  name: string | null;
  countryCode: string | null;
  countryName: string | null;
  region: string | null;
  dataGb: number | string | null;
  durationDays: number | string | null;
  isDailyPlan: boolean | null;
  operators: unknown; // JSON array or null in some drivers
  retailUsd: number | string | null;
  wholesalePrice: number | string | null;
  supportTopUpType: number | null;
}

function mapPackageToPlan(row: PackageRow, buyPathPrefix: string): RecommendedPlan {
  const operators = Array.isArray(row.operators)
    ? row.operators.filter((o): o is string => typeof o === "string")
    : [];
  // Retail may be computed elsewhere; fall back to wholesale for display safety.
  const retail = toNumber(row.retailUsd);
  return {
    code: row.code,
    name: row.name ?? row.code,
    retailUsd: retail,
    dataGb: toNumber(row.dataGb),
    durationDays: toNumber(row.durationDays),
    isDailyPlan: row.isDailyPlan === true,
    operators,
    buyPath: `${buyPathPrefix}?plan=${encodeURIComponent(row.code)}`,
  };
}

/**
 * Pick the best and one-bigger plan from a destination's packages, using the
 * AI's GB estimate as the only input to selection. Plans ARE our catalog.
 *
 * Selection rules (deterministic, testable):
 *  - Candidate plans: country matches destination (case-insensitive), non-daily.
 *    Daily-unlimited plans are excluded from GB math — they're billed per day.
 *  - "Best": smallest dataGb >= estimatedGb; ties broken by cheapest retail.
 *    If none is big enough, fall back to the largest dataGb available.
 *  - "Bigger": the smallest plan strictly larger than Best's dataGb; null if
 *    none exists.
 *  - If the destination has no packages at all, both are null.
 */
export function pickPlans(
  packs: PackageRow[],
  destination: string,
  estimatedGb: number,
  buyPathPrefix: string,
): { bestPlan: RecommendedPlan | null; biggerPlan: RecommendedPlan | null; note: string | null } {
  const norm = normalizeQuery(destination);
  const inCountry = packs.filter((p) => {
    const name = (p.countryName ?? "").toLowerCase();
    const code = (p.countryCode ?? "").toLowerCase();
    return name === norm || code === norm;
  });
  const gbPlans = inCountry
    .filter((p) => p.isDailyPlan !== true)
    .map((p) => ({ row: p, gb: toNumber(p.dataGb), price: toNumber(p.retailUsd) ?? Infinity }))
    .filter((x): x is { row: PackageRow; gb: number; price: number } => x.gb != null && x.gb > 0);

  if (inCountry.length === 0) {
    return {
      bestPlan: null,
      biggerPlan: null,
      note: `We don't have plans for ${destination} in the catalog yet. Try a nearby country or check back soon.`,
    };
  }
  if (gbPlans.length === 0) {
    // Only daily plans exist for this country; still useful info for the UI.
    return {
      bestPlan: null,
      biggerPlan: null,
      note: `${destination} currently only has daily-unlimited plans. Open the destination page to browse them.`,
    };
  }

  // Sort ascending by GB then by price so tie-break is deterministic.
  const sorted = [...gbPlans].sort((a, b) => (a.gb - b.gb) || (a.price - b.price));
  const atLeast = sorted.find((x) => x.gb >= estimatedGb);
  const best = atLeast ?? sorted[sorted.length - 1]!;
  const bigger = sorted.find((x) => x.gb > best.gb) ?? null;

  return {
    bestPlan: mapPackageToPlan(best.row, `${buyPathPrefix}/${(best.row.countryCode ?? "").toLowerCase()}`),
    biggerPlan: bigger
      ? mapPackageToPlan(bigger.row, `${buyPathPrefix}/${(bigger.row.countryCode ?? "").toLowerCase()}`)
      : null,
    note: null,
  };
}

// ---------------------------------------------------------------------------
// eSIM status lookup for chat context (auth-required)
// ---------------------------------------------------------------------------

async function loadEsimContext(
  db: DrizzleLike,
  esimsTable: unknown,
  userId: number,
  eq: (col: unknown, val: unknown) => unknown,
  now: () => Date,
): Promise<EsimStatusSummary[]> {
  // We rely on drizzle's `eq` from the callers to build the predicate. The
  // structural typing keeps us decoupled from schema specifics — the route
  // only reads a handful of columns.
  const q = db.select().from(esimsTable).where(eq((esimsTable as { userId?: unknown }).userId, userId));
  const rows = (await (q.orderBy?.((esimsTable as { id?: unknown }).id) ?? q.limit?.(50) ?? [])) as Array<
    Record<string, unknown>
  >;
  const current = now();
  return rows.slice(0, 20).map((r) => {
    const expires = r.expiresAt ? new Date(String(r.expiresAt)) : null;
    const daysLeft =
      expires && !Number.isNaN(expires.getTime())
        ? Math.max(0, Math.floor((expires.getTime() - current.getTime()) / 86_400_000))
        : null;
    const status = typeof r.status === "string" ? r.status : "unknown";
    const topUpEligible =
      r.supportTopUpType === 2 && (daysLeft == null || daysLeft > 0) && status !== "expired";
    return {
      id: Number(r.id),
      country: typeof r.country === "string" ? r.country : null,
      planName: typeof r.planName === "string" ? r.planName : null,
      status,
      daysLeft,
      usedBytes: toNumber(r.usedBytes),
      totalBytes: toNumber(r.totalBytes),
      topUpEligible,
    };
  });
}

// ---------------------------------------------------------------------------
// Chat prompt builder
// ---------------------------------------------------------------------------

function buildChatSystemPrompt(esims: EsimStatusSummary[]): string {
  const context =
    esims.length === 0
      ? "The traveller has no eSIMs on their account yet."
      : esims
          .map((e) =>
            [
              `- ${e.country ?? "Unknown"} (${e.planName ?? "plan"})`,
              `status: ${e.status}`,
              e.daysLeft != null ? `${e.daysLeft} days left` : null,
              e.usedBytes != null && e.totalBytes != null
                ? `${Math.round((e.usedBytes / (1024 * 1024 * 1024)) * 10) / 10} GB of ${Math.round(
                    (e.totalBytes / (1024 * 1024 * 1024)) * 10,
                  ) / 10} GB used`
                : null,
              e.topUpEligible ? "top-up available" : "no top-up",
            ]
              .filter(Boolean)
              .join(" · "),
          )
          .join("\n");
  return [
    `You are the ${brand.name} support assistant for travel eSIMs.`,
    "Answer installation and troubleshooting questions clearly and briefly (under 150 words).",
    "Common fixes: check the eSIM is installed, set it as the data line, enable data roaming for that line, restart the phone, re-scan the QR if the LPA is invalid.",
    "If the user needs a refund, a manual review, or the issue is account-specific and cannot be solved in chat, offer to escalate to WhatsApp or email.",
    "Never invent prices, plans, or refund approvals. Never share internal URLs.",
    `Support WhatsApp: ${brand.supportWhatsApp}. Support email: ${brand.supportEmail}.`,
    "Traveller's current eSIMs:",
    context,
  ].join("\n");
}

function buildEscalation(): SupportChatResponse["escalation"] {
  const waDigits = brand.supportWhatsApp.replace(/[^0-9]/g, "");
  return {
    whatsappNumber: brand.supportWhatsApp,
    whatsappUrl: `https://wa.me/${waDigits}`,
    emailAddress: brand.supportEmail,
    emailUrl: `mailto:${brand.supportEmail}`,
  };
}

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

export function createAiRouter(deps: AiRouteDeps): Router {
  const router = Router();
  const now = deps.now ?? (() => new Date());
  const { requireAuth, optionalAuth, rateLimit, costLog } = deps;
  const ai = deps.ai;

  /**
   * Charge a rate-limit bucket even when the model call fails — otherwise an
   * erroring model becomes a free-for-all. We log cost only on success because
   * a failed call has no usage info; the underlying client is responsible for
   * logging billable partial calls if it ever has any.
   */
  async function runAi(
    req: Request,
    purpose: string,
    input: Omit<AiCompletionInput, "purpose">,
  ): Promise<{ text: string; usage: AiCompletionResult["usage"] } | null> {
    if (!ai) return null;
    const userId = (req as RequestWithUser).user?.id ?? null;
    try {
      const result = await ai.complete({ ...input, purpose });
      await costLog.record({
        purpose,
        userId,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        at: now(),
      });
      return result;
    } catch (err) {
      // Log the failure shape for audit; do NOT decrement rate-limit budget
      // (already consumed at request boundary). Provider error text is not
      // surfaced to the client to avoid leaking internals.
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[ai:${purpose}] completion failed: ${message}`);
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Phone compatibility — DB only, no AI. Admin-editable table.
  // -------------------------------------------------------------------------

  const compatQuery = z.object({
    q: z.string().trim().min(1, "Enter a phone model").max(100),
    limit: z.coerce.number().int().min(1).max(20).optional(),
  });

  router.get("/compatibility", optionalAuth, async (req: Request, res: Response) => {
    if (!applyRateLimit(req, res, rateLimit, "compat", RATE_COMPAT)) return;

    const parsed = compatQuery.safeParse(req.query);
    if (!parsed.success) {
      return fail(
        res,
        400,
        "invalid_query",
        parsed.error.issues[0]?.message ?? "Search for a phone model.",
      );
    }
    const db = deps.getDb();
    const tables = deps.tables;
    if (!db || !tables?.phoneModels) {
      return fail(res, 503, "compatibility_unavailable", "The phone list isn't available right now.");
    }

    // We import drizzle operators locally so the module stays usable in tests
    // where drizzle-orm may not be installed. A dynamic import keeps unit tests
    // free of a hard dependency at module load.
    let ilike: (col: unknown, pattern: string) => unknown;
    let or: (...conds: unknown[]) => unknown;
    try {
      const drizzle = await import("drizzle-orm");
      ilike = drizzle.ilike as unknown as typeof ilike;
      or = drizzle.or as unknown as typeof or;
    } catch {
      return fail(res, 503, "compatibility_unavailable", "The phone list isn't available right now.");
    }

    const pattern = `%${parsed.data.q.toLowerCase()}%`;
    const table = tables.phoneModels as {
      brand?: unknown;
      model?: unknown;
      id?: unknown;
    };
    try {
      const rows = (await db
        .select()
        .from(table)
        .where(or(ilike(table.brand, pattern), ilike(table.model, pattern)))
        .limit?.(parsed.data.limit ?? 10)) as Array<{
        id: unknown;
        brand: unknown;
        model: unknown;
        esimCapable: unknown;
        notes: unknown;
        minOs: unknown;
      }>;

      const matches: CompatibleModel[] = (rows ?? []).map((r) => ({
        id: Number(r.id),
        brand: typeof r.brand === "string" ? r.brand : "",
        model: typeof r.model === "string" ? r.model : "",
        esimCapable: r.esimCapable === true,
        notes: typeof r.notes === "string" ? r.notes : null,
        minOs: typeof r.minOs === "string" ? r.minOs : null,
      }));

      const verdict: CompatibilityResult["verdict"] =
        matches.length === 0
          ? "unknown"
          : matches.some((m) => m.esimCapable)
            ? "capable"
            : "incapable";

      const result: CompatibilityResult = {
        query: parsed.data.q,
        matches,
        verdict,
        carrierLockGuidance: [...CARRIER_LOCK_GUIDANCE],
      };
      return ok(res, result);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Lookup failed.";
      console.error(`[ai:compatibility] ${message}`);
      return fail(res, 500, "compatibility_failed", "We couldn't search the phone list. Try again.");
    }
  });

  // -------------------------------------------------------------------------
  // Data estimator — AI estimates GB, DB supplies plans.
  // -------------------------------------------------------------------------

  const estimatorBody = z.object({
    destination: z.string().trim().min(1, "Pick a destination").max(80),
    days: z.coerce.number().int().min(1).max(365),
    habits: z.array(z.enum([
      "maps",
      "social",
      "video_calls",
      "streaming",
      "hotspot",
      "music",
      "messaging",
      "gaming",
    ])).max(8).default([]),
  });

  router.post("/estimate", optionalAuth, async (req: Request, res: Response) => {
    if (!applyRateLimit(req, res, rateLimit, "estimator", RATE_ESTIMATOR)) return;

    const parsed = estimatorBody.safeParse(req.body);
    if (!parsed.success) {
      return fail(res, 400, "invalid_input", parsed.error.issues[0]?.message ?? "Check your inputs.");
    }
    if (!ai) {
      return fail(res, 503, "ai_unavailable", "The data estimator isn't available right now.");
    }

    const input: EstimatorInput = {
      destination: parsed.data.destination,
      days: parsed.data.days,
      habits: parsed.data.habits,
    };

    const result = await runAi(req, "estimator", {
      system: ESTIMATOR_SYSTEM,
      messages: [{ role: "user", content: buildEstimatorUserMessage(input) }],
      json: true,
      maxTokens: 300,
    });
    if (!result) {
      return fail(res, 502, "ai_failed", "The estimator had trouble. Please try again.");
    }

    const estimate = parseEstimateJson(result.text);
    if (!estimate) {
      return fail(res, 502, "ai_failed", "The estimator returned an unexpected answer. Please try again.");
    }

    // Load packages for the destination country only, from DB.
    const db = deps.getDb();
    const tables = deps.tables;
    let packs: PackageRow[] = [];
    if (db && tables?.packages) {
      try {
        const drizzle = await import("drizzle-orm");
        const table = tables.packages as {
          countryName?: unknown;
          countryCode?: unknown;
        };
        const norm = normalizeQuery(parsed.data.destination);
        const rows = (await db
          .select()
          .from(table)
          .where(
            drizzle.or(
              drizzle.ilike(table.countryName, `%${norm}%`),
              drizzle.eq(table.countryCode, parsed.data.destination.toUpperCase()),
            ),
          )
          .limit?.(200)) as PackageRow[];
        packs = Array.isArray(rows) ? rows : [];
      } catch (err) {
        const message = err instanceof Error ? err.message : "package query failed";
        console.error(`[ai:estimator] package lookup error: ${message}`);
        // Continue with empty packs: the estimate is still returned, the UI
        // shows the honest "no plans matched" note.
      }
    }

    const picks = pickPlans(packs, parsed.data.destination, estimate.estimatedGb, "/esim");

    const response: DataEstimateResponse = {
      estimatedGb: estimate.estimatedGb,
      rationale: estimate.rationale,
      assumptions: estimate.assumptions,
      bestPlan: picks.bestPlan,
      biggerPlan: picks.biggerPlan,
      note: picks.note,
    };
    return ok(res, response);
  });

  // -------------------------------------------------------------------------
  // Support chat — sees user's eSIMs when logged in, can escalate.
  // -------------------------------------------------------------------------

  const chatBody = z.object({
    messages: z
      .array(
        z.object({
          role: z.enum(["user", "assistant"]),
          content: z.string().trim().min(1).max(2000),
        }),
      )
      .min(1)
      .max(20),
  });

  router.post(
    "/support-chat",
    optionalAuth,
    async (req: Request, res: Response) => {
      if (!applyRateLimit(req, res, rateLimit, "support_chat", RATE_CHAT)) return;

      const parsed = chatBody.safeParse(req.body);
      if (!parsed.success) {
        return fail(res, 400, "invalid_input", parsed.error.issues[0]?.message ?? "Send a message.");
      }
      if (!ai) {
        return fail(res, 503, "ai_unavailable", "Chat support isn't available right now.");
      }

      const userId = (req as RequestWithUser).user?.id ?? null;

      // Load the user's eSIM context if signed in. On failure we proceed WITHOUT
      // context rather than failing the chat — a support conversation is more
      // useful than an error banner.
      let esimContext: EsimStatusSummary[] = [];
      if (userId != null && deps.getDb() && deps.tables?.esims) {
        try {
          const drizzle = await import("drizzle-orm");
          esimContext = await loadEsimContext(
            deps.getDb()!,
            deps.tables.esims,
            userId,
            drizzle.eq as unknown as (c: unknown, v: unknown) => unknown,
            now,
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : "esim lookup";
          console.error(`[ai:support_chat] esim context error: ${message}`);
        }
      }

      const result = await runAi(req, "support_chat", {
        system: buildChatSystemPrompt(esimContext),
        messages: parsed.data.messages,
        maxTokens: 400,
      });
      if (!result) {
        return fail(res, 502, "ai_failed", "Chat had trouble replying. Please try again or escalate.");
      }

      // Very light heuristic escalation: if the user answered "refund" or
      // "human" style requests, surface escalation. The model is also told to
      // offer it in prose; this is a UI aid, not the sole trigger.
      const lastUser = [...parsed.data.messages].reverse().find((m) => m.role === "user");
      const escalationWanted =
        !!lastUser && /\b(refund|human|agent|complaint|manager|escalate)\b/i.test(lastUser.content);

      const response: SupportChatResponse = {
        reply: result.text.trim(),
        escalation: escalationWanted ? buildEscalation() : null,
        esimContext,
      };
      return ok(res, response);
    },
  );

  // Keep the requireAuth dependency meaningful even though we currently use
  // optionalAuth for chat (so guests can chat too). Exposed for the future
  // "chat about MY eSIM" endpoint where context is mandatory.
  router.get("/support-chat/whoami", requireAuth, (req: Request, res: Response) => {
    const user = (req as RequestWithUser).user;
    if (!user) return fail(res, 401, "unauthorized", "Sign in required.");
    return ok(res, { userId: user.id });
  });

  return router;
}

// ---------------------------------------------------------------------------
// Production wiring
// ---------------------------------------------------------------------------

/**
 * Loads production defaults from the previously-saved AI modules.
 *
 * IMPORTANT: The exact exports of server/ai/aiClient.ts, rateLimit.ts, and
 * costLog.ts are not visible in this batch. Each import below is isolated so a
 * mismatch is a one-line fix rather than a whole-file rewrite. If any module
 * exports a differently named factory, adjust the call — the deps shape
 * (AiClient / RateLimiter / CostLogger) is what the router relies on.
 */
async function loadDefaultDeps(): Promise<{
  ai: AiClient | null;
  rateLimit: RateLimiter;
  costLog: CostLogger;
}> {
  // Dynamic imports keep this file importable by unit tests even when the
  // real AI modules need env vars at module load.
  let ai: AiClient | null = null;
  try {
    const mod = await import("../ai/aiClient");
    // Common export shapes we support: `createAiClient()`, or `aiClient` object.
    const anyMod = mod as unknown as {
      createAiClient?: () => AiClient;
      aiClient?: AiClient;
    };
    if (typeof anyMod.createAiClient === "function") ai = anyMod.createAiClient();
    else if (anyMod.aiClient) ai = anyMod.aiClient;
    else ai = null;
  } catch (err) {
    console.warn(
      `[ai] aiClient module could not be loaded, AI routes will be disabled: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  let rateLimit: RateLimiter;
  try {
    const mod = (await import("../ai/rateLimit")) as unknown as {
      rateLimiter?: RateLimiter;
      createRateLimiter?: () => RateLimiter;
    };
    rateLimit =
      mod.rateLimiter ??
      (typeof mod.createRateLimiter === "function" ? mod.createRateLimiter() : inMemoryRateLimiter());
  } catch {
    rateLimit = inMemoryRateLimiter();
  }

  let costLog: CostLogger;
  try {
    const mod = (await import("../ai/costLog")) as unknown as {
      costLogger?: CostLogger;
      createCostLogger?: () => CostLogger;
    };
    costLog =
      mod.costLogger ??
      (typeof mod.createCostLogger === "function" ? mod.createCostLogger() : consoleCostLogger());
  } catch {
    costLog = consoleCostLogger();
  }

  return { ai, rateLimit, costLog };
}

/** Fallback in-memory rate limiter (per-process). Fine behind a single replica. */
function inMemoryRateLimiter(): RateLimiter {
  const buckets = new Map<string, number[]>();
  return {
    check(key, { windowMs, max }) {
      const now = Date.now();
      const arr = (buckets.get(key) ?? []).filter((t) => now - t < windowMs);
      if (arr.length >= max) {
        const retryAfterMs = windowMs - (now - arr[0]!);
        return { ok: false, retryAfterMs };
      }
      arr.push(now);
      buckets.set(key, arr);
      return { ok: true };
    },
  };
}

/** Fallback cost logger (structured console output — no model data leaked). */
function consoleCostLogger(): CostLogger {
  return {
    record(entry) {
      console.info(
        `[ai-cost] purpose=${entry.purpose} user=${entry.userId ?? "anon"} in=${entry.inputTokens} out=${entry.outputTokens}`,
      );
    },
  };
}

/**
 * Production mount — call from server/app.ts:
 *
 *   import { registerAiRoutes } from "./routes/ai";
 *   await registerAiRoutes(app);
 *
 * Optional `deps` override lets a test or alternate host substitute fakes.
 */
export async function registerAiRoutes(app: Express, deps?: Partial<AiRouteDeps>): Promise<void> {
  const defaults = await loadDefaultDeps();

  // Lazy-import the shared pieces only when a caller does not supply them.
  // This keeps the file usable in a unit-test harness that never touches a DB.
  let getDb: AiRouteDeps["getDb"];
  let requireAuth: RequestHandler;
  let optionalAuth: RequestHandler;
  let tables: AiRouteDeps["tables"];

  if (deps?.getDb && deps.requireAuth && deps.optionalAuth) {
    getDb = deps.getDb;
    requireAuth = deps.requireAuth;
    optionalAuth = deps.optionalAuth;
    tables = deps.tables;
  } else {
    const [{ getDb: realGetDb }, authMod, schemaMod] = await Promise.all([
      import("../db/client"),
      import("../middleware/requireAuth"),
      import("../db/schema"),
    ]);
    getDb = deps?.getDb ?? (() => realGetDb() as unknown as DrizzleLike | null);
    requireAuth =
      deps?.requireAuth ??
      ((authMod as { requireAuth?: RequestHandler }).requireAuth ??
        ((_req, _res, next) => next()));
    optionalAuth =
      deps?.optionalAuth ??
      ((authMod as { optionalAuth?: RequestHandler }).optionalAuth ??
        ((_req, _res, next) => next()));
    const sm = schemaMod as {
      phoneModels?: unknown;
      packages?: unknown;
      esims?: unknown;
    };
    tables =
      deps?.tables ??
      ({
        phoneModels: sm.phoneModels,
        packages: sm.packages,
        esims: sm.esims,
      } as AiRouteDeps["tables"]);
  }

  const router = createAiRouter({
    getDb,
    requireAuth,
    optionalAuth,
    tables,
    ai: deps?.ai ?? defaults.ai,
    rateLimit: deps?.rateLimit ?? defaults.rateLimit,
    costLog: deps?.costLog ?? defaults.costLog,
    now: deps?.now,
  });
  app.use("/api/ai", router);
}

// Re-export the type surface for the client components.
export type { AiClient, RateLimiter, CostLogger };

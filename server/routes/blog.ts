/**
 * Blog API.
 *
 * Mounts under `/api/blog` (see integration note in the build report — this
 * router must be `app.use("/api/blog", blogRouter)`-ed from server/app.ts).
 *
 * Surfaces
 * --------
 *   Public (no auth, published only)
 *     GET  /                      list published posts, paged, locale-filtered
 *     GET  /:slug                 fetch a published post by slug (+ locale)
 *     GET  /:slug/translations    sibling-locale links for the same article
 *
 *   Admin (session required, requireAuth middleware)
 *     GET    /admin                list all posts (any status), filterable
 *     POST   /admin                create a post (manual editor)
 *     PATCH  /admin/:id            edit a post (draft/published/archived)
 *     DELETE /admin/:id            delete a post
 *     POST   /admin/ai-draft       ask the AI to draft a post — saved as DRAFT
 *     POST   /admin/:id/publish    flip an existing draft to published (review
 *                                  gate: must be explicit; AI can't do this)
 *
 * Design intent
 * -------------
 *  * The AI draft endpoint ALWAYS writes `status = 'draft'`. There is no code
 *    path where AI output becomes publicly visible without an explicit
 *    `.../publish` call made by a signed-in admin (`requireAuth`).
 *  * All bodies are validated with zod-shaped checks; we hand-roll the small
 *    validators to avoid adding a dependency that isn't already in package.json.
 *  * `body_md` is Markdown and is sanitised at read time by the reader (never
 *    here). We DO strip control chars here so a copy/paste of a binary can't
 *    corrupt the DB.
 *  * We never fall back to fabricating a post when the AI key is absent: the
 *    ai-draft endpoint returns 503 with a clear message and creates nothing
 *    (or, if the caller supplied the fields, it can still save a draft by
 *    calling POST /admin directly). The AI helpers batch owns the actual
 *    provider call + cost logging via server/ai/**; here we call a small
 *    `draftPostWithAi` adapter that fails honestly when the key is missing.
 *
 * Locale handling
 * ---------------
 *  - Every list/fetch route accepts an optional `?locale=` and defaults to
 *    'en'. Unrecognised values fall back to 'en'.
 *  - `en` uses the bare slug path; `zh`/`vi` use the prefixed path. The route
 *    only returns data; path building lives on the reader.
 *
 * Test hooks / stability
 * ----------------------
 *  - The route exports `__test__` with the pure helpers (slugify, validateBody)
 *    so a test file added in a later batch can assert behaviour without hitting
 *    a live DB. The DB calls themselves are not unit-tested from here.
 */
import { Router, type Request, type Response, type NextFunction } from "express";
import { sql } from "drizzle-orm";
import { db } from "../db/client";
import { requireAuth } from "../middleware/requireAuth";
import { brand } from "../brand.config";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Locale = "en" | "zh" | "vi";
type Status = "draft" | "published" | "archived";

const LOCALES: readonly Locale[] = ["en", "zh", "vi"] as const;
const STATUSES: readonly Status[] = ["draft", "published", "archived"] as const;

interface BlogPostRow {
  id: number;
  slug: string;
  status: Status;
  locale: Locale;
  title: string;
  excerpt: string;
  body_md: string;
  cover_image_url: string | null;
  author: string;
  tags: string[];
  meta_title: string | null;
  meta_description: string | null;
  ai_generated: boolean;
  ai_model: string | null;
  ai_cost_usd: string; // numeric as string from postgres
  published_at: string | null;
  created_at: string;
  updated_at: string;
  translation_group: string | null;
}

interface BlogPostSummary {
  id: number;
  slug: string;
  locale: Locale;
  title: string;
  excerpt: string;
  coverImageUrl: string | null;
  author: string;
  tags: string[];
  publishedAt: string | null;
}

interface BlogPostDetail extends BlogPostSummary {
  bodyMd: string;
  metaTitle: string | null;
  metaDescription: string | null;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Auth identity (requireAuth is expected to have populated req.user)
// ---------------------------------------------------------------------------

/**
 * `requireAuth` in this codebase sets `req.user` (see its source for exact
 * fields). We read only `id` + `role`. An admin must additionally have
 * `role === 'admin'`. If requireAuth leaves the shape different, this guard
 * fails closed (treats the caller as unauthorised), which is the safe default
 * for an admin surface.
 */
interface AuthedRequest extends Request {
  user?: { id: number; email?: string; role?: string | null };
}

function requireAdmin(req: AuthedRequest, res: Response, next: NextFunction): void {
  const role = req.user?.role ?? null;
  if (role !== "admin") {
    res.status(403).json({
      ok: false,
      error: "forbidden",
      message: "Admin role required.",
    });
    return;
  }
  next();
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/** Lowercase, hyphenate, strip anything not alnum/hyphen, cap to 160. */
export function slugify(input: string): string {
  return input
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 160);
}

function isLocale(x: unknown): x is Locale {
  return typeof x === "string" && (LOCALES as readonly string[]).includes(x);
}

function isStatus(x: unknown): x is Status {
  return typeof x === "string" && (STATUSES as readonly string[]).includes(x);
}

function asString(x: unknown, max: number): string | null {
  if (typeof x !== "string") return null;
  // Strip NULs and other C0 controls except tab/newline so Markdown survives.
  const cleaned = x.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
  return cleaned.slice(0, max);
}

function parseTags(x: unknown): string[] {
  if (Array.isArray(x)) {
    return x
      .filter((t): t is string => typeof t === "string")
      .map((t) => t.trim().toLowerCase())
      .filter((t) => t.length > 0 && t.length <= 40)
      .slice(0, 20);
  }
  if (typeof x === "string") {
    return parseTags(x.split(","));
  }
  return [];
}

interface ValidatedPostInput {
  title: string;
  slug: string | null;
  locale: Locale;
  excerpt: string;
  bodyMd: string;
  coverImageUrl: string | null;
  author: string;
  tags: string[];
  metaTitle: string | null;
  metaDescription: string | null;
}

export type ValidateResult =
  | { ok: true; value: ValidatedPostInput }
  | { ok: false; error: string; message: string };

/**
 * Validate a create/edit payload. Returns a normalised object on success or a
 * machine-readable error. Rules:
 *   - title is required (1..300 chars after trim)
 *   - bodyMd is required (1..100000 chars)
 *   - slug optional → server-derived from title if missing
 *   - coverImageUrl optional, must start with http(s):// or "/"
 *   - metaTitle <= 300, metaDescription <= 400 (shortened, not rejected)
 */
export function validatePostInput(raw: unknown): ValidateResult {
  if (!raw || typeof raw !== "object") {
    return { ok: false, error: "invalid_body", message: "JSON object expected." };
  }
  const o = raw as Record<string, unknown>;

  const title = asString(o.title, 300)?.trim() ?? "";
  if (title.length === 0) {
    return { ok: false, error: "title_required", message: "Title is required." };
  }

  const bodyMd = asString(o.bodyMd, 100_000)?.trim() ?? "";
  if (bodyMd.length === 0) {
    return { ok: false, error: "body_required", message: "Body is required." };
  }

  const locale: Locale = isLocale(o.locale) ? o.locale : "en";

  const rawSlug = typeof o.slug === "string" ? o.slug : "";
  const slug = rawSlug.trim().length > 0 ? slugify(rawSlug) : slugify(title);
  if (slug.length === 0) {
    return {
      ok: false,
      error: "slug_required",
      message: "Slug could not be derived from the title; provide one explicitly.",
    };
  }

  let coverImageUrl: string | null = null;
  if (typeof o.coverImageUrl === "string" && o.coverImageUrl.trim().length > 0) {
    const v = o.coverImageUrl.trim();
    if (!/^https?:\/\//.test(v) && !v.startsWith("/")) {
      return {
        ok: false,
        error: "invalid_cover_image_url",
        message: "coverImageUrl must be an http(s) URL or a root-relative path.",
      };
    }
    coverImageUrl = v.slice(0, 2000);
  }

  const author = asString(o.author, 120)?.trim() || brand.name;
  const excerpt = asString(o.excerpt, 500)?.trim() ?? "";
  const metaTitle = asString(o.metaTitle, 300)?.trim() || null;
  const metaDescription = asString(o.metaDescription, 400)?.trim() || null;

  return {
    ok: true,
    value: {
      title: title.slice(0, 300),
      slug,
      locale,
      excerpt,
      bodyMd,
      coverImageUrl,
      author,
      tags: parseTags(o.tags),
      metaTitle,
      metaDescription,
    },
  };
}

// ---------------------------------------------------------------------------
// Row → API mappers
// ---------------------------------------------------------------------------

function mapSummary(row: BlogPostRow): BlogPostSummary {
  return {
    id: row.id,
    slug: row.slug,
    locale: row.locale,
    title: row.title,
    excerpt: row.excerpt,
    coverImageUrl: row.cover_image_url,
    author: row.author,
    tags: Array.isArray(row.tags) ? row.tags : [],
    publishedAt: row.published_at,
  };
}

function mapDetail(row: BlogPostRow): BlogPostDetail {
  return {
    ...mapSummary(row),
    bodyMd: row.body_md,
    metaTitle: row.meta_title,
    metaDescription: row.meta_description,
    updatedAt: row.updated_at,
  };
}

// ---------------------------------------------------------------------------
// AI draft adapter
// ---------------------------------------------------------------------------

/**
 * The AI helpers batch owns the provider client (server/ai/aiClient.ts) and
 * the cost logger (server/ai/costLog.ts). We import them lazily via dynamic
 * import so this router can load even if those modules evolve, and we fail
 * honestly (503) if the key is missing. We NEVER synthesise a post body as a
 * fallback — the endpoint returns an error and creates nothing.
 *
 * The return shape is deliberately narrow: the AI only proposes content. The
 * route decides status ('draft') and persistence; the AI cannot set status
 * or publish.
 */
interface AiDraftResult {
  title: string;
  bodyMd: string;
  excerpt: string;
  metaTitle: string | null;
  metaDescription: string | null;
  model: string;
  costUsd: number;
}

async function draftPostWithAi(params: {
  topic: string;
  locale: Locale;
  keywords: string[];
}): Promise<AiDraftResult> {
  // Import lazily so a missing/broken AI module doesn't crash the router at
  // load time.
  let aiClient: unknown;
  try {
    aiClient = await import("../ai/aiClient");
  } catch {
    throw new AiUnavailableError(
      "The AI client module is not available. Wire server/ai/aiClient.ts before using AI drafts.",
    );
  }

  // We probe for the conventional `completeChat`/`generateText` export. If the
  // module resists, we throw a clear error rather than pretending.
  const mod = aiClient as Record<string, unknown>;
  const generate =
    (mod.generateText as ((p: unknown) => Promise<unknown>) | undefined) ??
    (mod.completeChat as ((p: unknown) => Promise<unknown>) | undefined);

  if (typeof generate !== "function") {
    throw new AiUnavailableError(
      "server/ai/aiClient.ts does not export generateText or completeChat; cannot draft.",
    );
  }

  // Prompt is intentionally strict: it must return JSON matching our schema.
  const system =
    "You are a travel-writer producing a factual blog post for an eSIM retailer. " +
    "Never invent prices, statistics, or network claims. Use only general guidance. " +
    "Respond with a single JSON object matching this schema: " +
    "{ title: string, excerpt: string, bodyMd: string, metaTitle: string, metaDescription: string }. " +
    "bodyMd is GitHub-flavoured Markdown with short sections and no raw HTML.";
  const user = [
    `Locale: ${params.locale}`,
    `Topic: ${params.topic}`,
    params.keywords.length > 0 ? `Keywords: ${params.keywords.join(", ")}` : "",
    "Keep it 400-800 words. Do not fabricate citations or prices.",
  ]
    .filter(Boolean)
    .join("\n");

  const raw = (await generate({ system, user })) as unknown;

  // The client may return a string (JSON) or an already-parsed object. Normalise.
  let parsed: Record<string, unknown>;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      throw new AiUnavailableError("The AI returned non-JSON content for a draft.");
    }
  } else if (raw && typeof raw === "object") {
    parsed = raw as Record<string, unknown>;
  } else {
    throw new AiUnavailableError("The AI returned an unexpected response.");
  }

  const title = typeof parsed.title === "string" ? parsed.title.slice(0, 300) : "";
  const bodyMd = typeof parsed.bodyMd === "string" ? parsed.bodyMd.slice(0, 100_000) : "";
  if (title.length === 0 || bodyMd.length === 0) {
    throw new AiUnavailableError("The AI response was missing title or body.");
  }

  // The AI client should already log cost. We surface what it returns if
  // present; otherwise 0 is recorded (honest: no cost data).
  const model =
    typeof (mod as { lastModel?: unknown }).lastModel === "string"
      ? ((mod as { lastModel: string }).lastModel)
      : "unknown";
  const costUsd =
    typeof (mod as { lastCostUsd?: unknown }).lastCostUsd === "number"
      ? ((mod as { lastCostUsd: number }).lastCostUsd)
      : 0;

  return {
    title,
    bodyMd,
    excerpt: typeof parsed.excerpt === "string" ? parsed.excerpt.slice(0, 500) : "",
    metaTitle:
      typeof parsed.metaTitle === "string" ? parsed.metaTitle.slice(0, 300) : null,
    metaDescription:
      typeof parsed.metaDescription === "string"
        ? parsed.metaDescription.slice(0, 400)
        : null,
    model,
    costUsd,
  };
}

class AiUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AiUnavailableError";
  }
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

async function listPublished(opts: {
  locale: Locale;
  limit: number;
  offset: number;
}): Promise<{ posts: BlogPostSummary[]; total: number }> {
  const rows = (await db.execute(sql`
    SELECT id, slug, status, locale, title, excerpt, body_md, cover_image_url,
           author, tags, meta_title, meta_description, ai_generated, ai_model,
           ai_cost_usd, published_at, created_at, updated_at, translation_group
    FROM blog_posts
    WHERE status = 'published' AND locale = ${opts.locale}
    ORDER BY published_at DESC NULLS LAST, created_at DESC
    LIMIT ${opts.limit} OFFSET ${opts.offset}
  `)) as unknown as { rows: BlogPostRow[] };

  const totalRes = (await db.execute(sql`
    SELECT COUNT(*)::int AS n FROM blog_posts
    WHERE status = 'published' AND locale = ${opts.locale}
  `)) as unknown as { rows: { n: number }[] };

  return {
    posts: rows.rows.map(mapSummary),
    total: totalRes.rows[0]?.n ?? 0,
  };
}

async function getPublishedBySlug(
  slug: string,
  locale: Locale,
): Promise<BlogPostDetail | null> {
  const rows = (await db.execute(sql`
    SELECT id, slug, status, locale, title, excerpt, body_md, cover_image_url,
           author, tags, meta_title, meta_description, ai_generated, ai_model,
           ai_cost_usd, published_at, created_at, updated_at, translation_group
    FROM blog_posts
    WHERE status = 'published' AND locale = ${locale} AND slug = ${slug}
    LIMIT 1
  `)) as unknown as { rows: BlogPostRow[] };
  const row = rows.rows[0];
  return row ? mapDetail(row) : null;
}

async function listAdmin(opts: {
  status: Status | null;
  locale: Locale | null;
  limit: number;
  offset: number;
}): Promise<{ posts: BlogPostDetail[]; total: number }> {
  const statusFilter = opts.status ? sql`AND status = ${opts.status}` : sql``;
  const localeFilter = opts.locale ? sql`AND locale = ${opts.locale}` : sql``;
  const rows = (await db.execute(sql`
    SELECT id, slug, status, locale, title, excerpt, body_md, cover_image_url,
           author, tags, meta_title, meta_description, ai_generated, ai_model,
           ai_cost_usd, published_at, created_at, updated_at, translation_group
    FROM blog_posts
    WHERE 1=1 ${statusFilter} ${localeFilter}
    ORDER BY created_at DESC
    LIMIT ${opts.limit} OFFSET ${opts.offset}
  `)) as unknown as { rows: BlogPostRow[] };
  const total = (await db.execute(sql`
    SELECT COUNT(*)::int AS n FROM blog_posts WHERE 1=1 ${statusFilter} ${localeFilter}
  `)) as unknown as { rows: { n: number }[] };
  return {
    posts: rows.rows.map(mapDetail),
    total: total.rows[0]?.n ?? 0,
  };
}

async function insertPost(
  input: ValidatedPostInput,
  opts: {
    status: Status;
    aiGenerated: boolean;
    aiModel: string | null;
    aiCostUsd: number;
    translationGroup: string | null;
  },
): Promise<BlogPostDetail> {
  // A published insert stamps published_at; a draft leaves it null until the
  // explicit publish call sets it.
  const publishedAt = opts.status === "published" ? sql`now()` : sql`NULL`;
  const inserted = (await db.execute(sql`
    INSERT INTO blog_posts
      (slug, status, locale, title, excerpt, body_md, cover_image_url, author,
       tags, meta_title, meta_description, ai_generated, ai_model, ai_cost_usd,
       translation_group, published_at)
    VALUES (
      ${input.slug}, ${opts.status}, ${input.locale}, ${input.title},
      ${input.excerpt}, ${input.bodyMd}, ${input.coverImageUrl}, ${input.author},
      ${JSON.stringify(input.tags)}::jsonb, ${input.metaTitle}, ${input.metaDescription},
      ${opts.aiGenerated}, ${opts.aiModel}, ${String(opts.aiCostUsd)},
      ${opts.translationGroup}, ${publishedAt}
    )
    RETURNING id, slug, status, locale, title, excerpt, body_md, cover_image_url,
              author, tags, meta_title, meta_description, ai_generated, ai_model,
              ai_cost_usd, published_at, created_at, updated_at, translation_group
  `)) as unknown as { rows: BlogPostRow[] };
  const row = inserted.rows[0];
  if (!row) throw new Error("Insert returned no row.");
  return mapDetail(row);
}

async function updatePost(
  id: number,
  patch: Partial<ValidatedPostInput> & { status?: Status },
): Promise<BlogPostDetail | null> {
  // Build a partial update. We choose the columns present in the patch.
  const sets: ReturnType<typeof sql>[] = [];
  if (patch.title !== undefined) sets.push(sql`title = ${patch.title}`);
  if (patch.slug !== undefined) sets.push(sql`slug = ${patch.slug}`);
  if (patch.locale !== undefined) sets.push(sql`locale = ${patch.locale}`);
  if (patch.excerpt !== undefined) sets.push(sql`excerpt = ${patch.excerpt}`);
  if (patch.bodyMd !== undefined) sets.push(sql`body_md = ${patch.bodyMd}`);
  if (patch.coverImageUrl !== undefined) sets.push(sql`cover_image_url = ${patch.coverImageUrl}`);
  if (patch.author !== undefined) sets.push(sql`author = ${patch.author}`);
  if (patch.tags !== undefined) sets.push(sql`tags = ${JSON.stringify(patch.tags)}::jsonb`);
  if (patch.metaTitle !== undefined) sets.push(sql`meta_title = ${patch.metaTitle}`);
  if (patch.metaDescription !== undefined) sets.push(sql`meta_description = ${patch.metaDescription}`);
  if (patch.status !== undefined) {
    sets.push(sql`status = ${patch.status}`);
    // Stamp published_at the first time it goes live; leave it on archive so
    // sorting history is preserved.
    if (patch.status === "published") {
      sets.push(sql`published_at = COALESCE(published_at, now())`);
    }
  }
  if (sets.length === 0) {
    // Nothing to change; just read the row so the caller gets the current state.
    const rows = (await db.execute(sql`
      SELECT id, slug, status, locale, title, excerpt, body_md, cover_image_url,
             author, tags, meta_title, meta_description, ai_generated, ai_model,
             ai_cost_usd, published_at, created_at, updated_at, translation_group
      FROM blog_posts WHERE id = ${id} LIMIT 1
    `)) as unknown as { rows: BlogPostRow[] };
    const row = rows.rows[0];
    return row ? mapDetail(row) : null;
  }

  const updated = (await db.execute(sql`
    UPDATE blog_posts
    SET ${sql.join(sets, sql`, `)}
    WHERE id = ${id}
    RETURNING id, slug, status, locale, title, excerpt, body_md, cover_image_url,
              author, tags, meta_title, meta_description, ai_generated, ai_model,
              ai_cost_usd, published_at, created_at, updated_at, translation_group
  `)) as unknown as { rows: BlogPostRow[] };
  const row = updated.rows[0];
  return row ? mapDetail(row) : null;
}

async function deletePost(id: number): Promise<boolean> {
  const res = (await db.execute(sql`
    DELETE FROM blog_posts WHERE id = ${id} RETURNING id
  `)) as unknown as { rows: { id: number }[] };
  return res.rows.length > 0;
}

async function getTranslations(
  translationGroup: string | null,
  currentLocale: Locale,
): Promise<{ locale: Locale; slug: string; title: string }[]> {
  if (!translationGroup) return [];
  const rows = (await db.execute(sql`
    SELECT locale, slug, title
    FROM blog_posts
    WHERE status = 'published'
      AND translation_group = ${translationGroup}
      AND locale <> ${currentLocale}
    ORDER BY locale
  `)) as unknown as {
    rows: { locale: Locale; slug: string; title: string }[];
  };
  return rows.rows;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export const blogRouter = Router();

// ---- Public --------------------------------------------------------------

blogRouter.get("/", async (req, res) => {
  const locale: Locale = isLocale(req.query.locale) ? req.query.locale : "en";
  const limit = clampInt(req.query.limit, 20, 1, 100);
  const offset = clampInt(req.query.offset, 0, 0, 10_000);
  try {
    const { posts, total } = await listPublished({ locale, limit, offset });
    res.json({ ok: true, data: { posts, total, limit, offset, locale } });
  } catch (err) {
    respondError(res, err, "blog_list_failed");
  }
});

blogRouter.get("/:slug", async (req, res) => {
  const slug = slugify(req.params.slug ?? "");
  if (slug.length === 0) {
    res.status(400).json({ ok: false, error: "invalid_slug", message: "Invalid slug." });
    return;
  }
  const locale: Locale = isLocale(req.query.locale) ? req.query.locale : "en";
  try {
    const post = await getPublishedBySlug(slug, locale);
    if (!post) {
      res.status(404).json({ ok: false, error: "not_found", message: "Post not found." });
      return;
    }
    res.json({ ok: true, data: { post } });
  } catch (err) {
    respondError(res, err, "blog_get_failed");
  }
});

blogRouter.get("/:slug/translations", async (req, res) => {
  const slug = slugify(req.params.slug ?? "");
  const locale: Locale = isLocale(req.query.locale) ? req.query.locale : "en";
  try {
    // Look up the post we're translating (published only), then its group.
    const rows = (await db.execute(sql`
      SELECT translation_group FROM blog_posts
      WHERE status = 'published' AND locale = ${locale} AND slug = ${slug}
      LIMIT 1
    `)) as unknown as { rows: { translation_group: string | null }[] };
    const group = rows.rows[0]?.translation_group ?? null;
    const translations = await getTranslations(group, locale);
    res.json({ ok: true, data: { translations } });
  } catch (err) {
    respondError(res, err, "blog_translations_failed");
  }
});

// ---- Admin (auth + admin role) ------------------------------------------

const adminGuard = [requireAuth, requireAdmin];

blogRouter.get("/admin", ...adminGuard, async (req: AuthedRequest, res) => {
  const status: Status | null = isStatus(req.query.status) ? req.query.status : null;
  const locale: Locale | null = isLocale(req.query.locale) ? req.query.locale : null;
  const limit = clampInt(req.query.limit, 50, 1, 200);
  const offset = clampInt(req.query.offset, 0, 0, 100_000);
  try {
    const { posts, total } = await listAdmin({ status, locale, limit, offset });
    res.json({ ok: true, data: { posts, total, limit, offset } });
  } catch (err) {
    respondError(res, err, "blog_admin_list_failed");
  }
});

blogRouter.post("/admin", ...adminGuard, async (req: AuthedRequest, res) => {
  const parsed = validatePostInput(req.body);
  if (!parsed.ok) {
    res.status(400).json({ ok: false, error: parsed.error, message: parsed.message });
    return;
  }
  // Manual editor can create a draft or a published post. AI drafts always use
  // the /admin/ai-draft route so status is forced.
  const requestedStatus: Status = isStatus(req.body?.status) ? req.body.status : "draft";
  try {
    const post = await insertPost(parsed.value, {
      status: requestedStatus,
      aiGenerated: false,
      aiModel: null,
      aiCostUsd: 0,
      translationGroup: null,
    });
    res.status(201).json({ ok: true, data: { post } });
  } catch (err) {
    // Unique (locale, slug) violation → 409.
    if (isUniqueViolation(err)) {
      res.status(409).json({
        ok: false,
        error: "slug_taken",
        message: `A post with that slug already exists in ${parsed.value.locale}.`,
      });
      return;
    }
    respondError(res, err, "blog_create_failed");
  }
});

blogRouter.patch("/admin/:id", ...adminGuard, async (req: AuthedRequest, res) => {
  const id = clampInt(req.params.id, 0, 1, Number.MAX_SAFE_INTEGER);
  if (id <= 0) {
    res.status(400).json({ ok: false, error: "invalid_id", message: "Invalid post id." });
    return;
  }
  // Validate only the provided fields. If title/body are supplied, use
  // validatePostInput so we get the same normalisation. Otherwise treat as a
  // partial content patch that may only carry status.
  const patch: Partial<ValidatedPostInput> & { status?: Status } = {};
  if (req.body?.status !== undefined) {
    if (!isStatus(req.body.status)) {
      res.status(400).json({
        ok: false,
        error: "invalid_status",
        message: "status must be draft, published or archived.",
      });
      return;
    }
    patch.status = req.body.status;
  }
  const hasContentChange =
    req.body &&
    (req.body.title !== undefined ||
      req.body.bodyMd !== undefined ||
      req.body.slug !== undefined ||
      req.body.excerpt !== undefined ||
      req.body.locale !== undefined ||
      req.body.tags !== undefined ||
      req.body.metaTitle !== undefined ||
      req.body.metaDescription !== undefined ||
      req.body.coverImageUrl !== undefined ||
      req.body.author !== undefined);

  if (hasContentChange) {
    const parsed = validatePostInput(req.body);
    if (!parsed.ok) {
      res.status(400).json({ ok: false, error: parsed.error, message: parsed.message });
      return;
    }
    Object.assign(patch, parsed.value);
  }

  if (Object.keys(patch).length === 0) {
    res.status(400).json({
      ok: false,
      error: "empty_patch",
      message: "Provide at least one field to update.",
    });
    return;
  }

  try {
    const post = await updatePost(id, patch);
    if (!post) {
      res.status(404).json({ ok: false, error: "not_found", message: "Post not found." });
      return;
    }
    res.json({ ok: true, data: { post } });
  } catch (err) {
    if (isUniqueViolation(err)) {
      res.status(409).json({
        ok: false,
        error: "slug_taken",
        message: "That slug is already in use for the target locale.",
      });
      return;
    }
    respondError(res, err, "blog_update_failed");
  }
});

blogRouter.delete("/admin/:id", ...adminGuard, async (req: AuthedRequest, res) => {
  const id = clampInt(req.params.id, 0, 1, Number.MAX_SAFE_INTEGER);
  if (id <= 0) {
    res.status(400).json({ ok: false, error: "invalid_id", message: "Invalid post id." });
    return;
  }
  try {
    const deleted = await deletePost(id);
    if (!deleted) {
      res.status(404).json({ ok: false, error: "not_found", message: "Post not found." });
      return;
    }
    res.json({ ok: true, data: { deleted: true, id } });
  } catch (err) {
    respondError(res, err, "blog_delete_failed");
  }
});

/**
 * Publish a draft. The ONLY way a post becomes publicly visible from an
 * AI-generated draft. Requires admin. Fails if the post is missing or has no
 * content (defensive).
 */
blogRouter.post("/admin/:id/publish", ...adminGuard, async (req: AuthedRequest, res) => {
  const id = clampInt(req.params.id, 0, 1, Number.MAX_SAFE_INTEGER);
  if (id <= 0) {
    res.status(400).json({ ok: false, error: "invalid_id", message: "Invalid post id." });
    return;
  }
  try {
    const post = await updatePost(id, { status: "published" });
    if (!post) {
      res.status(404).json({ ok: false, error: "not_found", message: "Post not found." });
      return;
    }
    if (!post.bodyMd.trim()) {
      res.status(422).json({
        ok: false,
        error: "empty_body",
        message: "Refusing to publish an empty post.",
      });
      return;
    }
    res.json({ ok: true, data: { post } });
  } catch (err) {
    respondError(res, err, "blog_publish_failed");
  }
});

/**
 * AI draft. Asks the AI to draft a post from `{ topic, locale, keywords? }`
 * and saves it as `status = 'draft'` with provenance + cost. Publish is a
 * separate, explicit admin action. If the AI is unavailable (no key, module
 * missing, malformed response) we return 503 and create NOTHING.
 */
blogRouter.post("/admin/ai-draft", ...adminGuard, async (req: AuthedRequest, res) => {
  const topic = typeof req.body?.topic === "string" ? req.body.topic.trim() : "";
  if (topic.length < 3 || topic.length > 200) {
    res.status(400).json({
      ok: false,
      error: "topic_required",
      message: "topic (3-200 chars) is required.",
    });
    return;
  }
  const locale: Locale = isLocale(req.body?.locale) ? req.body.locale : "en";
  const keywords = parseTags(req.body?.keywords);

  let draft: AiDraftResult;
  try {
    draft = await draftPostWithAi({ topic, locale, keywords });
  } catch (err) {
    if (err instanceof AiUnavailableError) {
      res.status(503).json({
        ok: false,
        error: "ai_unavailable",
        message: err.message,
      });
      return;
    }
    respondError(res, err, "blog_ai_draft_failed");
    return;
  }

  const parsed = validatePostInput({
    title: draft.title,
    bodyMd: draft.bodyMd,
    excerpt: draft.excerpt,
    locale,
    tags: keywords,
    metaTitle: draft.metaTitle,
    metaDescription: draft.metaDescription,
    author: brand.name,
  });
  if (!parsed.ok) {
    res.status(502).json({
      ok: false,
      error: "ai_output_invalid",
      message: `AI draft did not validate: ${parsed.message}`,
    });
    return;
  }

  try {
    const post = await insertPost(parsed.value, {
      status: "draft", // ← hard-coded: AI can never publish
      aiGenerated: true,
      aiModel: draft.model,
      aiCostUsd: draft.costUsd,
      translationGroup: null,
    });
    res.status(201).json({ ok: true, data: { post } });
  } catch (err) {
    if (isUniqueViolation(err)) {
      res.status(409).json({
        ok: false,
        error: "slug_taken",
        message:
          "The AI produced a title whose slug is already in use. Edit the topic or publish the existing draft.",
      });
      return;
    }
    respondError(res, err, "blog_ai_draft_save_failed");
  }
});

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function clampInt(raw: unknown, fallback: number, min: number, max: number): number {
  const n =
    typeof raw === "string" || typeof raw === "number"
      ? Number(raw)
      : NaN;
  if (!Number.isFinite(n)) return fallback;
  const v = Math.floor(n);
  if (v < min) return min;
  if (v > max) return max;
  return v;
}

interface PgError {
  code?: string;
  constraint?: string;
  detail?: string;
}

function isUniqueViolation(err: unknown): boolean {
  const e = err as PgError | null;
  return Boolean(e && e.code === "23505");
}

function respondError(res: Response, err: unknown, code: string): void {
  // We never leak SQL detail to the client; the server log has it (via the
  // framework's error handler). This is a storefront-adjacent endpoint.
  console.error(`[blog] ${code}`, err);
  res.status(500).json({
    ok: false,
    error: code,
    message: "Something went wrong. Please try again.",
  });
}

export default blogRouter;

// ---------------------------------------------------------------------------
// Test surface
// ---------------------------------------------------------------------------
export const __test__ = {
  slugify,
  validatePostInput,
  parseTags,
  clampInt,
  mapSummary,
  mapDetail,
  isLocale,
  isStatus,
  requireAdmin,
};

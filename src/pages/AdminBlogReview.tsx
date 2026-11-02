/**
 * Admin blog / AI-draft review — /admin/blog.
 *
 * Two-state page:
 *   1. List view — every post grouped by status (draft / pending_review /
 *      published / archived). Drafts and AI-generated posts that are awaiting
 *      review are surfaced first with a "Needs review" badge.
 *   2. Editor view — for a selected post: editable title, slug, locale,
 *      excerpt, body (markdown), plus the AI draft metadata (generated at,
 *      model, prompt summary). Two explicit actions:
 *        - "Save draft"          → PUT  /api/admin/blog/posts/:id
 *        - "Publish" / "Unpublish" → POST /api/admin/blog/posts/:id/publish
 *                                    POST /api/admin/blog/posts/:id/unpublish
 *      A post that came from the AI drafter (isAiGenerated=true and
 *      status='pending_review') cannot be published without an explicit
 *      "Approve AI draft" click that flips it to draft first — the server
 *      enforces this approval rule; the UI mirrors it so the button state is
 *      honest.
 *
 * Endpoints (server/routes/admin.ts + server/routes/blog.ts):
 *   GET  /api/admin/blog/posts?status=<all|draft|pending_review|published|archived>
 *        → { posts: BlogPostSummary[] }   (Maybe<…> — unavailable reasons render)
 *   GET  /api/admin/blog/posts/:id
 *        → { post: BlogPost }
 *   PUT  /api/admin/blog/posts/:id
 *        body: { title, slug, locale, excerpt, bodyMarkdown }
 *        → { post: BlogPost }
 *   POST /api/admin/blog/posts/:id/publish   → { post: BlogPost }
 *   POST /api/admin/blog/posts/:id/unpublish → { post: BlogPost }
 *   POST /api/admin/blog/posts/:id/approve   → { post: BlogPost }
 *        (flips pending_review → draft so it can be published)
 *   POST /api/admin/blog/draft
 *        body: { topic, country?, locale }
 *        → { post: BlogPost }  (status='pending_review', isAiGenerated=true)
 *
 * HONESTY RULES
 * -------------
 *   - Nothing is auto-published. Every publish goes through a click.
 *   - The AI draft endpoint is invoked only via an explicit user action, and
 *     any failure is surfaced verbatim — we never silently retry.
 *   - Post list is grouped by server-declared status; unknown status values
 *     render as "unknown (raw)" so operational states stay visible.
 *
 * Test selectors
 * --------------
 *   data-testid="admin-blog"
 *   data-testid="admin-blog-filter-<status>"
 *   data-testid="admin-blog-refresh"
 *   data-testid="admin-blog-row-<id>"
 *   data-testid="admin-blog-row-status-<id>"   (data-post-status attr)
 *   data-testid="admin-blog-needs-review"
 *   data-testid="admin-blog-editor"
 *   data-testid="admin-blog-title"
 *   data-testid="admin-blog-slug"
 *   data-testid="admin-blog-locale"
 *   data-testid="admin-blog-excerpt"
 *   data-testid="admin-blog-body"
 *   data-testid="admin-blog-save"
 *   data-testid="admin-blog-publish"
 *   data-testid="admin-blog-unpublish"
 *   data-testid="admin-blog-approve-ai"
 *   data-testid="admin-blog-ai-topic"
 *   data-testid="admin-blog-ai-country"
 *   data-testid="admin-blog-ai-locale"
 *   data-testid="admin-blog-ai-generate"
 *   data-testid="admin-blog-error"
 *   data-testid="admin-blog-saved"
 */
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { brand, type SupportedLocale } from "../brand.config";
import type { Maybe } from "../services/adminMetrics";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BlogStatus = "draft" | "pending_review" | "published" | "archived";

export interface BlogPostSummary {
  id: number;
  title: string;
  slug: string;
  locale: SupportedLocale;
  status: BlogStatus;
  isAiGenerated: boolean;
  updatedAt: string;
  publishedAt: string | null;
}

export interface BlogPost extends BlogPostSummary {
  excerpt: string;
  bodyMarkdown: string;
  aiModel?: string | null;
  aiGeneratedAt?: string | null;
  aiPromptSummary?: string | null;
}

// ---------------------------------------------------------------------------
// Fetch plumbing (mirrors AdminDashboard)
// ---------------------------------------------------------------------------

class BlogApiError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  constructor(code: string, httpStatus: number, message: string) {
    super(message);
    this.name = "BlogApiError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

interface ApiOk<T> {
  ok: true;
  data: T;
}
interface ApiErr {
  ok: false;
  error: string;
  message: string;
}

async function call<T>(
  fetchImpl: Fetcher,
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
): Promise<T> {
  const init: RequestInit = {
    method,
    credentials: "include",
    headers: { Accept: "application/json" },
  };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    (init.headers as Record<string, string>)["Content-Type"] = "application/json";
  }
  const res = await fetchImpl(path, init);
  const json = (await res.json().catch(() => ({}))) as ApiOk<T> | ApiErr | Record<string, unknown>;
  if (!res.ok || !("ok" in json) || (json as ApiErr).ok === false) {
    const err = json as Partial<ApiErr>;
    throw new BlogApiError(
      err.error ?? "request_failed",
      res.status,
      err.message ?? `Request failed (HTTP ${res.status}).`,
    );
  }
  return (json as ApiOk<T>).data;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type StatusFilter = BlogStatus | "all";

const STATUS_FILTERS: { key: StatusFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "pending_review", label: "Needs review" },
  { key: "draft", label: "Drafts" },
  { key: "published", label: "Published" },
  { key: "archived", label: "Archived" },
];

function formatTimestamp(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function isKnownStatus(s: string): s is BlogStatus {
  return s === "draft" || s === "pending_review" || s === "published" || s === "archived";
}

function statusBadgeClass(s: string): string {
  switch (s) {
    case "pending_review":
      return "bg-amber-50 text-amber-900 ring-amber-200";
    case "draft":
      return "bg-slate-100 text-slate-700 ring-slate-200";
    case "published":
      return "bg-emerald-50 text-emerald-800 ring-emerald-200";
    case "archived":
      return "bg-slate-50 text-slate-500 ring-slate-200";
    default:
      return "bg-rose-50 text-rose-800 ring-rose-200";
  }
}

// ---------------------------------------------------------------------------
// List view
// ---------------------------------------------------------------------------

type ListState =
  | { status: "loading" }
  | { status: "ready"; value: Maybe<BlogPostSummary[]> }
  | { status: "error"; code: string; message: string };

function PostList({
  fetchImpl,
  filter,
  selectedId,
  onSelect,
  onReloadToken,
}: {
  fetchImpl: Fetcher;
  filter: StatusFilter;
  selectedId: number | null;
  onSelect: (id: number) => void;
  onReloadToken: number;
}): JSX.Element {
  const [state, setState] = useState<ListState>({ status: "loading" });

  const load = useCallback(() => {
    setState({ status: "loading" });
    call<{ posts: Maybe<BlogPostSummary[]> }>(
      fetchImpl,
      "GET",
      `/api/admin/blog/posts?status=${filter}`,
    )
      .then((d) => setState({ status: "ready", value: d.posts }))
      .catch((err: unknown) =>
        setState({
          status: "error",
          code: err instanceof BlogApiError ? err.code : "request_failed",
          message: err instanceof Error ? err.message : "Could not load posts.",
        }),
      );
  }, [fetchImpl, filter]);

  useEffect(() => {
    load();
  }, [load, onReloadToken]);

  if (state.status === "loading") {
    return (
      <div className="mt-3 space-y-2" aria-busy>
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-16 animate-pulse rounded-xl bg-slate-100" />
        ))}
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <p
        role="alert"
        className="mt-3 rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-800 ring-1 ring-rose-200"
        data-testid="admin-blog-error"
        data-error-code={state.code}
      >
        {state.message}
      </p>
    );
  }

  if (!state.value.available) {
    return (
      <p className="mt-3 rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-800 ring-1 ring-rose-200">
        Couldn't load posts ({state.value.reason}).
      </p>
    );
  }

  if (state.value.value.length === 0) {
    return (
      <p className="mt-3 rounded-xl bg-slate-50 px-3 py-2 text-sm text-slate-600 ring-1 ring-slate-200">
        No posts match this filter yet.
      </p>
    );
  }

  return (
    <ul className="mt-3 divide-y divide-slate-100 overflow-hidden rounded-2xl ring-1 ring-slate-200 bg-white">
      {state.value.value.map((p) => {
        const active = p.id === selectedId;
        const needsReview = p.status === "pending_review";
        return (
          <li
            key={p.id}
            data-testid={`admin-blog-row-${p.id}`}
            data-post-status={p.status}
            className={active ? "bg-brand-50" : ""}
          >
            <button
              type="button"
              onClick={() => onSelect(p.id)}
              className="flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-slate-50"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold text-slate-900">{p.title}</p>
                <p className="truncate text-[11px] text-slate-500">
                  /{p.locale}/{p.slug} · updated {formatTimestamp(p.updatedAt)}
                </p>
              </div>
              <div className="flex flex-col items-end gap-1">
                <span
                  className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold ring-1 ${statusBadgeClass(p.status)}`}
                  data-testid={`admin-blog-row-status-${p.id}`}
                >
                  {isKnownStatus(p.status) ? p.status.replace(/_/g, " ") : `unknown (${p.status})`}
                </span>
                {needsReview && p.isAiGenerated && (
                  <span
                    className="inline-flex items-center rounded-full bg-fuchsia-50 px-2 py-0.5 text-[10px] font-semibold text-fuchsia-800 ring-1 ring-fuchsia-200"
                    data-testid="admin-blog-needs-review"
                  >
                    AI · needs review
                  </span>
                )}
              </div>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Editor view
// ---------------------------------------------------------------------------

type EditorState =
  | { status: "loading" }
  | { status: "ready"; post: BlogPost }
  | { status: "error"; code: string; message: string; httpStatus: number };

function Editor({
  fetchImpl,
  id,
  onMutated,
}: {
  fetchImpl: Fetcher;
  id: number;
  onMutated: () => void;
}): JSX.Element {
  const [state, setState] = useState<EditorState>({ status: "loading" });
  const [reloadNonce, setReloadNonce] = useState(0);

  // Form draft state (initialised when a post loads)
  const [title, setTitle] = useState("");
  const [slug, setSlug] = useState("");
  const [locale, setLocale] = useState<SupportedLocale>("en");
  const [excerpt, setExcerpt] = useState("");
  const [body, setBody] = useState("");

  const [busy, setBusy] = useState<null | "save" | "publish" | "unpublish" | "approve">(null);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    call<{ post: BlogPost }>(fetchImpl, "GET", `/api/admin/blog/posts/${id}`)
      .then((d) => {
        if (cancelled) return;
        setState({ status: "ready", post: d.post });
        setTitle(d.post.title);
        setSlug(d.post.slug);
        setLocale(d.post.locale);
        setExcerpt(d.post.excerpt);
        setBody(d.post.bodyMarkdown);
        setSavedAt(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState({
          status: "error",
          code: err instanceof BlogApiError ? err.code : "request_failed",
          httpStatus: err instanceof BlogApiError ? err.httpStatus : 0,
          message: err instanceof Error ? err.message : "Could not load this post.",
        });
      });
    return () => {
      cancelled = true;
    };
  }, [fetchImpl, id, reloadNonce]);

  async function save(): Promise<void> {
    setBusy("save");
    setError(null);
    try {
      await call<{ post: BlogPost }>(fetchImpl, "PUT", `/api/admin/blog/posts/${id}`, {
        title,
        slug,
        locale,
        excerpt,
        bodyMarkdown: body,
      });
      setSavedAt(new Date().toISOString());
      onMutated();
    } catch (err) {
      setError({
        code: err instanceof BlogApiError ? err.code : "request_failed",
        message: err instanceof Error ? err.message : "Could not save.",
      });
    } finally {
      setBusy(null);
    }
  }

  async function transition(action: "publish" | "unpublish" | "approve"): Promise<void> {
    setBusy(action);
    setError(null);
    try {
      await call<{ post: BlogPost }>(fetchImpl, "POST", `/api/admin/blog/posts/${id}/${action}`);
      setSavedAt(new Date().toISOString());
      onMutated();
      setReloadNonce((n) => n + 1);
    } catch (err) {
      setError({
        code: err instanceof BlogApiError ? err.code : "request_failed",
        message: err instanceof Error ? err.message : "Action failed.",
      });
    } finally {
      setBusy(null);
    }
  }

  if (state.status === "loading") {
    return (
      <div className="space-y-3" aria-busy>
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-24 animate-pulse rounded-2xl bg-slate-100" />
        ))}
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <p
        role="alert"
        className="rounded-2xl bg-rose-50 px-4 py-3 text-sm text-rose-800 ring-1 ring-rose-200"
        data-testid="admin-blog-error"
        data-error-code={state.code}
      >
        {state.message}
      </p>
    );
  }

  const post = state.post;
  const canPublish =
    post.status === "draft" || post.status === "archived" || post.status === "published";
  const canUnpublish = post.status === "published";
  const canApproveAi = post.status === "pending_review" && post.isAiGenerated;

  return (
    <div className="space-y-4" data-testid="admin-blog-editor" data-post-id={post.id}>
      {/* Meta row */}
      <div className="rounded-2xl bg-white p-4 ring-1 ring-slate-200">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <p className="text-xs uppercase tracking-wide text-slate-500">Post</p>
            <p className="text-sm font-semibold text-slate-900">
              #{post.id} ·{" "}
              <span
                className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold ring-1 ${statusBadgeClass(post.status)}`}
              >
                {isKnownStatus(post.status) ? post.status.replace(/_/g, " ") : post.status}
              </span>
            </p>
          </div>
          <p className="text-[11px] text-slate-500">
            {post.publishedAt ? `Published ${formatTimestamp(post.publishedAt)}` : "Not published"}
          </p>
        </div>
        {post.isAiGenerated && (
          <div className="mt-3 rounded-xl bg-fuchsia-50 px-3 py-2 text-xs text-fuchsia-900 ring-1 ring-fuchsia-200">
            <p className="font-semibold">AI-generated draft</p>
            <p className="mt-0.5">
              Model: {post.aiModel ?? "—"} · generated {formatTimestamp(post.aiGeneratedAt ?? null)}
            </p>
            {post.aiPromptSummary && (
              <p className="mt-1 italic text-fuchsia-800">"{post.aiPromptSummary}"</p>
            )}
          </div>
        )}
      </div>

      {error && (
        <p
          role="alert"
          className="rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-800 ring-1 ring-rose-200"
          data-testid="admin-blog-error"
          data-error-code={error.code}
        >
          {error.message}
        </p>
      )}
      {savedAt && (
        <p
          className="rounded-xl bg-emerald-50 px-3 py-2 text-sm text-emerald-800 ring-1 ring-emerald-200"
          data-testid="admin-blog-saved"
        >
          Saved at {new Date(savedAt).toLocaleTimeString()}.
        </p>
      )}

      {/* Form */}
      <form
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          void save();
        }}
        className="space-y-3 rounded-2xl bg-white p-4 ring-1 ring-slate-200"
        noValidate
      >
        <label className="block text-sm">
          <span className="font-medium text-slate-800">Title</span>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            disabled={busy !== null}
            className="mt-1 w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-200 disabled:opacity-60"
            data-testid="admin-blog-title"
          />
        </label>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-sm">
            <span className="font-medium text-slate-800">Slug</span>
            <input
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              disabled={busy !== null}
              className="mt-1 w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-200 disabled:opacity-60"
              data-testid="admin-blog-slug"
            />
          </label>
          <label className="block text-sm">
            <span className="font-medium text-slate-800">Locale</span>
            <select
              value={locale}
              onChange={(e) => setLocale(e.target.value as SupportedLocale)}
              disabled={busy !== null}
              className="mt-1 w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-200 disabled:opacity-60"
              data-testid="admin-blog-locale"
            >
              {brand.locales.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="block text-sm">
          <span className="font-medium text-slate-800">Excerpt</span>
          <textarea
            value={excerpt}
            onChange={(e) => setExcerpt(e.target.value)}
            rows={2}
            disabled={busy !== null}
            className="mt-1 w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-200 disabled:opacity-60"
            data-testid="admin-blog-excerpt"
          />
        </label>
        <label className="block text-sm">
          <span className="font-medium text-slate-800">Body (Markdown)</span>
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={16}
            disabled={busy !== null}
            className="mt-1 w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 font-mono text-xs outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-200 disabled:opacity-60"
            data-testid="admin-blog-body"
          />
        </label>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <button
            type="submit"
            disabled={busy !== null}
            className="rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-800 hover:bg-slate-50 disabled:opacity-60"
            data-testid="admin-blog-save"
          >
            {busy === "save" ? "Saving…" : "Save draft"}
          </button>
          {canApproveAi && (
            <button
              type="button"
              onClick={() => void transition("approve")}
              disabled={busy !== null}
              className="rounded-xl bg-fuchsia-600 px-4 py-2 text-sm font-semibold text-white hover:bg-fuchsia-700 disabled:opacity-60"
              data-testid="admin-blog-approve-ai"
            >
              {busy === "approve" ? "Approving…" : "Approve AI draft"}
            </button>
          )}
          {canUnpublish && (
            <button
              type="button"
              onClick={() => void transition("unpublish")}
              disabled={busy !== null}
              className="rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-800 hover:bg-slate-50 disabled:opacity-60"
              data-testid="admin-blog-unpublish"
            >
              {busy === "unpublish" ? "Unpublishing…" : "Unpublish"}
            </button>
          )}
          {canPublish && !canUnpublish && (
            <button
              type="button"
              onClick={() => void transition("publish")}
              disabled={busy !== null}
              className="rounded-xl bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-60"
              data-testid="admin-blog-publish"
            >
              {busy === "publish" ? "Publishing…" : "Publish"}
            </button>
          )}
        </div>
      </form>
    </div>
  );
}

// ---------------------------------------------------------------------------
// AI draft generator
// ---------------------------------------------------------------------------

function AiDraftGenerator({
  fetchImpl,
  onCreated,
}: {
  fetchImpl: Fetcher;
  onCreated: (id: number) => void;
}): JSX.Element {
  const [topic, setTopic] = useState("");
  const [country, setCountry] = useState("");
  const [locale, setLocale] = useState<SupportedLocale>("en");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);

  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (topic.trim().length < 4) {
      setError({ code: "invalid_topic", message: "Topic must be at least 4 characters." });
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { post } = await call<{ post: BlogPost }>(fetchImpl, "POST", "/api/admin/blog/draft", {
        topic: topic.trim(),
        country: country.trim() || undefined,
        locale,
      });
      setTopic("");
      setCountry("");
      onCreated(post.id);
    } catch (err) {
      setError({
        code: err instanceof BlogApiError ? err.code : "request_failed",
        message: err instanceof Error ? err.message : "AI draft failed.",
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      className="rounded-2xl bg-white p-5 ring-1 ring-slate-200"
      aria-labelledby="admin-ai-draft-heading"
    >
      <h2 id="admin-ai-draft-heading" className="text-base font-bold text-slate-900">
        Draft with AI
      </h2>
      <p className="mt-1 text-xs text-slate-500">
        Drafts land in the <strong>Needs review</strong> bucket. They cannot be
        published until you approve them.
      </p>
      <form onSubmit={(e) => void handleSubmit(e)} className="mt-3 space-y-3" noValidate>
        {error && (
          <p
            role="alert"
            className="rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-800 ring-1 ring-rose-200"
            data-testid="admin-blog-error"
            data-error-code={error.code}
          >
            {error.message}
          </p>
        )}
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="block text-sm sm:col-span-2">
            <span className="font-medium text-slate-800">Topic</span>
            <input
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              placeholder="e.g. Staying online in Bangkok for 5 days"
              disabled={busy}
              className="mt-1 w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-200 disabled:opacity-60"
              data-testid="admin-blog-ai-topic"
            />
          </label>
          <label className="block text-sm">
            <span className="font-medium text-slate-800">Country (optional)</span>
            <input
              value={country}
              onChange={(e) => setCountry(e.target.value)}
              placeholder="th"
              disabled={busy}
              className="mt-1 w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-200 disabled:opacity-60"
              data-testid="admin-blog-ai-country"
            />
          </label>
          <label className="block text-sm">
            <span className="font-medium text-slate-800">Locale</span>
            <select
              value={locale}
              onChange={(e) => setLocale(e.target.value as SupportedLocale)}
              disabled={busy}
              className="mt-1 w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-200 disabled:opacity-60"
              data-testid="admin-blog-ai-locale"
            >
              {brand.locales.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="flex justify-end">
          <button
            type="submit"
            disabled={busy}
            className="rounded-xl bg-fuchsia-600 px-4 py-2 text-sm font-semibold text-white hover:bg-fuchsia-700 disabled:opacity-60"
            data-testid="admin-blog-ai-generate"
          >
            {busy ? "Drafting…" : "Draft with AI"}
          </button>
        </div>
      </form>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export interface AdminBlogReviewProps {
  fetcher?: Fetcher;
}

export function AdminBlogReview({ fetcher }: AdminBlogReviewProps = {}): JSX.Element {
  const fetchImpl: Fetcher = fetcher ?? ((url, init) => fetch(url, init));
  const [filter, setFilter] = useState<StatusFilter>("pending_review");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  const triggerReload = useCallback(() => setReloadToken((n) => n + 1), []);

  return (
    <main className="mx-auto w-full max-w-5xl px-4 pb-16 pt-6" data-testid="admin-blog">
      <header className="mb-6">
        <p className="text-xs uppercase tracking-wide text-slate-500">
          {brand.name} · Admin
        </p>
        <h1 className="mt-1 text-2xl font-extrabold text-slate-900">Blog &amp; AI drafts</h1>
        <p className="mt-1 max-w-2xl text-sm text-slate-600">
          Review AI-written drafts, edit, then publish. Nothing goes live without
          a click.
        </p>
      </header>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)]">
        <section aria-labelledby="admin-blog-list-heading">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 id="admin-blog-list-heading" className="text-base font-bold text-slate-900">
              Posts
            </h2>
            <button
              type="button"
              onClick={triggerReload}
              className="rounded-lg border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
              data-testid="admin-blog-refresh"
            >
              Refresh
            </button>
          </div>

          <div className="mt-3 inline-flex flex-wrap rounded-xl bg-slate-100 p-0.5" role="group">
            {STATUS_FILTERS.map((f) => (
              <button
                key={f.key}
                type="button"
                onClick={() => setFilter(f.key)}
                className={`rounded-lg px-2.5 py-1.5 text-xs font-semibold ${
                  filter === f.key
                    ? "bg-white text-slate-900 shadow-sm"
                    : "text-slate-600 hover:text-slate-900"
                }`}
                data-testid={`admin-blog-filter-${f.key}`}
                aria-pressed={filter === f.key}
              >
                {f.label}
              </button>
            ))}
          </div>

          <PostList
            fetchImpl={fetchImpl}
            filter={filter}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onReloadToken={reloadToken}
          />
        </section>

        <section aria-labelledby="admin-blog-editor-heading" className="space-y-4">
          <h2 id="admin-blog-editor-heading" className="text-base font-bold text-slate-900">
            {selectedId == null ? "Editor" : "Edit post"}
          </h2>
          {selectedId == null ? (
            <p className="rounded-2xl bg-slate-50 px-4 py-6 text-sm text-slate-600 ring-1 ring-slate-200">
              Select a post on the left to review or edit it.
            </p>
          ) : (
            <Editor fetchImpl={fetchImpl} id={selectedId} onMutated={triggerReload} />
          )}

          <AiDraftGenerator
            fetchImpl={fetchImpl}
            onCreated={(id) => {
              setFilter("pending_review");
              setSelectedId(id);
              triggerReload();
            }}
          />
        </section>
      </div>

      <nav className="mt-8 flex flex-wrap gap-3 text-sm">
        <a
          href="/admin"
          className="rounded-xl border border-slate-300 bg-white px-4 py-2 font-medium text-slate-700 hover:bg-slate-50"
        >
          Dashboard
        </a>
        <a
          href="/admin/orders"
          className="rounded-xl border border-slate-300 bg-white px-4 py-2 font-medium text-slate-700 hover:bg-slate-50"
        >
          Orders
        </a>
        <a
          href="/admin/settings"
          className="rounded-xl border border-slate-300 bg-white px-4 py-2 font-medium text-slate-700 hover:bg-slate-50"
        >
          Settings
        </a>
        <a
          href="/admin/data-tables"
          className="rounded-xl border border-slate-300 bg-white px-4 py-2 font-medium text-slate-700 hover:bg-slate-50"
        >
          Data tables
        </a>
        <a
          href="/admin/payouts"
          className="rounded-xl border border-slate-300 bg-white px-4 py-2 font-medium text-slate-700 hover:bg-slate-50"
        >
          Payouts
        </a>
      </nav>
    </main>
  );
}

export const __test__ = {
  statusBadgeClass,
  isKnownStatus,
  formatTimestamp,
  call,
  BlogApiError,
};

export default AdminBlogReview;

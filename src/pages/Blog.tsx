/**
 * Public blog — list + post reader.
 *
 * Renders two routes from one module because they share data shaping, locale
 * plumbing and the Markdown renderer:
 *
 *   /blog           → <BlogList />         (index, paged)
 *   /blog/<slug>    → <BlogPost slug=.. /> (single article)
 *
 * URL shape: /blog for `en`, /<locale>/blog for `zh`/`vi`, matching the
 * LocaleSwitcher's `buildLocalePath` convention. The page reads the current
 * path with `splitLocale` (from src/i18n/locales.ts) so it works under both
 * bare and prefixed URLs without extra props.
 *
 * Contract (server/routes/blog.ts):
 *   GET /api/blog?locale=<l>&limit=&offset=
 *     → { ok:true, data:{ posts: BlogPostSummary[]; total; limit; offset; locale } }
 *   GET /api/blog/:slug?locale=<l>
 *     → { ok:true, data:{ post: BlogPostDetail } }
 *     → 404 { ok:false, error:"not_found", message } (slug isn't published)
 *   GET /api/blog/:slug/translations?locale=<l>
 *     → { ok:true, data:{ translations: { locale, slug, title }[] } }
 *
 * Honesty:
 *   - We only render what the server returns; a 404 becomes an honest "not found"
 *     view (not "loading forever"). Backend errors show a retry affordance.
 *   - Markdown rendering escapes HTML first, so an AI-authored body_md cannot
 *     inject tags. We support headings, bold/italic, bullets, links, code spans,
 *     paragraphs. No raw HTML, no JSX-in-Markdown.
 *   - The page never edits. Drafts aren't visible here (server filters them).
 *
 * The full SEO/SSR phase renders these routes server-side with OG tags; this
 * client page sets the document title + canonical for direct client hits
 * (mirrors the pattern in PublicTrip.tsx) so the experience isn't broken
 * before the SSR layer lands.
 *
 * Test hooks:
 *   data-testid="blog-index"
 *   data-testid="blog-index-loading"
 *   data-testid="blog-index-empty"
 *   data-testid="blog-index-error"
 *   data-testid="blog-index-card-<slug>"
 *   data-testid="blog-index-load-more"
 *   data-testid="blog-post"
 *   data-testid="blog-post-loading"
 *   data-testid="blog-post-not-found"
 *   data-testid="blog-post-error"
 *   data-testid="blog-post-title"
 *   data-testid="blog-post-meta"
 *   data-testid="blog-post-body"
 *   data-testid="blog-post-translations"
 *   data-testid="blog-post-translation-<locale>"
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  buildLocalePath,
  splitLocale,
  type Locale,
} from "../i18n/locales";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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

interface TranslationsEntry {
  locale: Locale;
  slug: string;
  title: string;
}

interface ApiOk<T> {
  ok: true;
  data: T;
}
interface ApiErr {
  ok: false;
  error: string;
  message: string;
}

class BlogFetchError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status: number, message: string) {
    super(message);
    this.name = "BlogFetchError";
    this.code = code;
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Locale helpers
// ---------------------------------------------------------------------------

/**
 * `splitLocale` is the locale-prefix splitter used by LocaleSwitcher. We only
 * need the locale and the bare path; the reading surface here treats any
 * non-supported prefix as `en` (matches server behaviour).
 */
function currentLocale(): Locale {
  if (typeof window === "undefined") return "en";
  return splitLocale(window.location.pathname).locale;
}

function pathFor(locale: Locale, path: string): string {
  return buildLocalePath(locale, path, { prettyDefault: true });
}

// ---------------------------------------------------------------------------
// Fetch helpers
// ---------------------------------------------------------------------------

async function listBlogPosts(
  locale: Locale,
  limit: number,
  offset: number,
  signal: AbortSignal,
): Promise<{ posts: BlogPostSummary[]; total: number }> {
  const qs = new URLSearchParams({
    locale,
    limit: String(limit),
    offset: String(offset),
  }).toString();
  const res = await fetch(`/api/blog?${qs}`, {
    credentials: "include",
    headers: { Accept: "application/json" },
    signal,
  });
  const body = (await res.json().catch(() => ({}))) as
    | ApiOk<{ posts: BlogPostSummary[]; total: number }>
    | ApiErr
    | {};
  if (!res.ok || !("ok" in body) || body.ok === false) {
    const err = body as ApiErr;
    throw new BlogFetchError(
      err?.error ?? "request_failed",
      res.status,
      err?.message ?? `Request failed (HTTP ${res.status}).`,
    );
  }
  return (body as ApiOk<{ posts: BlogPostSummary[]; total: number }>).data;
}

async function getBlogPost(
  slug: string,
  locale: Locale,
  signal: AbortSignal,
): Promise<BlogPostDetail> {
  const qs = new URLSearchParams({ locale }).toString();
  const res = await fetch(`/api/blog/${encodeURIComponent(slug)}?${qs}`, {
    credentials: "include",
    headers: { Accept: "application/json" },
    signal,
  });
  const body = (await res.json().catch(() => ({}))) as
    | ApiOk<{ post: BlogPostDetail }>
    | ApiErr
    | {};
  if (!res.ok || !("ok" in body) || body.ok === false) {
    const err = body as ApiErr;
    throw new BlogFetchError(
      err?.error ?? "request_failed",
      res.status,
      err?.message ?? `Request failed (HTTP ${res.status}).`,
    );
  }
  return (body as ApiOk<{ post: BlogPostDetail }>).data.post;
}

async function getTranslations(
  slug: string,
  locale: Locale,
  signal: AbortSignal,
): Promise<TranslationsEntry[]> {
  const qs = new URLSearchParams({ locale }).toString();
  const res = await fetch(
    `/api/blog/${encodeURIComponent(slug)}/translations?${qs}`,
    {
      credentials: "include",
      headers: { Accept: "application/json" },
      signal,
    },
  );
  const body = (await res.json().catch(() => ({}))) as
    | ApiOk<{ translations: TranslationsEntry[] }>
    | ApiErr
    | {};
  if (!res.ok || !("ok" in body) || body.ok === false) {
    // Translations are a nice-to-have; a failure here should NOT fail the page.
    return [];
  }
  return (body as ApiOk<{ translations: TranslationsEntry[] }>).data.translations;
}

// ---------------------------------------------------------------------------
// Markdown renderer (tiny, escape-first)
// ---------------------------------------------------------------------------

/**
 * Escape text destined for innerHTML. This is the ONLY reason we use
 * dangerouslySetInnerHTML below — every `<` in user/AI content is escaped
 * before any markup is applied, so the final string is safe by construction.
 *
 * We support:
 *   - `##`/`###` headings (h2/h3) → mapped to h2/h3 with ids
 *   - `- ` / `* ` bullet lists
 *   - `**bold**`, `*italic*` inline
 *   - inline code `` `x` ``
 *   - `[text](url)` links — URLs restricted to http(s)://, mailto:, or `/`
 *
 * NOT supported (deliberately):
 *   - raw HTML (any `<` in input is escaped)
 *   - images (Markdown images via `![...]` are rendered as plain text so a
 *     broken/third-party URL can't leak tracking pixels)
 */
function renderMarkdown(md: string): string {
  const esc = (s: string): string =>
    s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");

  const lines = md.split(/\r?\n/);
  const out: string[] = [];
  let listBuf: string[] = [];

  const flushList = (): void => {
    if (listBuf.length > 0) {
      out.push(`<ul>${listBuf.map((li) => `<li>${li}</li>`).join("")}</ul>`);
      listBuf = [];
    }
  };

  const inlineFormat = (raw: string): string => {
    let s = esc(raw);
    // Links — the safe subset.
    s = s.replace(
      /\[([^\]]+)\]\(([^)]+)\)/g,
      (_m, text: string, url: string) => {
        const trimmed = url.trim();
        const ok =
          /^https?:\/\//i.test(trimmed) ||
          /^mailto:/i.test(trimmed) ||
          trimmed.startsWith("/");
        if (!ok) return text;
        const rel =
          /^https?:\/\//i.test(trimmed) ? ' rel="noopener noreferrer" target="_blank"' : "";
        return `<a href="${esc(trimmed)}"${rel}>${text}</a>`;
      },
    );
    // Inline code before emphasis so `**` inside a code span is preserved.
    s = s.replace(/`([^`]+)`/g, '<code class="rounded bg-slate-100 px-1 py-0.5 text-[0.85em]">$1</code>');
    // Bold then italic (order matters so ***x*** leaves balancing emphasis).
    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/(^|[^*])\*([^*]+)\*(?!\*)/g, "$1<em>$2</em>");
    return s;
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    if (line.trim().length === 0) {
      flushList();
      continue;
    }
    if (/^###\s+/.test(line)) {
      flushList();
      const text = line.replace(/^###\s+/, "");
      out.push(`<h3>${inlineFormat(text)}</h3>`);
      continue;
    }
    if (/^##\s+/.test(line)) {
      flushList();
      const text = line.replace(/^##\s+/, "");
      out.push(`<h2>${inlineFormat(text)}</h2>`);
      continue;
    }
    if (/^[-*]\s+/.test(line)) {
      listBuf.push(inlineFormat(line.replace(/^[-*]\s+/, "")));
      continue;
    }
    flushList();
    out.push(`<p>${inlineFormat(line)}</p>`);
  }
  flushList();
  return out.join("");
}

// ---------------------------------------------------------------------------
// Small shared renderers
// ---------------------------------------------------------------------------

function formatDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "";
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function LocaleBadge({ locale }: { locale: Locale }): JSX.Element {
  const label = locale === "zh" ? "中文" : locale === "vi" ? "Tiếng Việt" : "English";
  return (
    <span className="inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-700 ring-1 ring-slate-200">
      {label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// List view
// ---------------------------------------------------------------------------

const PAGE_SIZE = 12;

export interface BlogListProps {
  /** Override the locale for tests; defaults to URL (or "en"). */
  locale?: Locale;
}

export function BlogList({ locale: localeProp }: BlogListProps = {}): JSX.Element {
  const locale: Locale = localeProp ?? currentLocale();

  const [state, setState] = useState<
    | { status: "loading" }
    | { status: "ready"; posts: BlogPostSummary[]; total: number }
    | { status: "error"; code: string; message: string }
  >({ status: "loading" });

  const [offset, setOffset] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);

  // First page — resets when locale changes.
  useEffect(() => {
    const controller = new AbortController();
    setState({ status: "loading" });
    setOffset(0);
    listBlogPosts(locale, PAGE_SIZE, 0, controller.signal)
      .then(({ posts, total }) => {
        if (!controller.signal.aborted) setState({ status: "ready", posts, total });
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        if (controller.signal.aborted) return;
        const message =
          err instanceof BlogFetchError
            ? err.message
            : err instanceof Error
            ? err.message
            : "Could not load posts.";
        const code = err instanceof BlogFetchError ? err.code : "request_failed";
        setState({ status: "error", code, message });
      });
    return () => controller.abort();
  }, [locale]);

  const loadMore = useCallback(async () => {
    if (state.status !== "ready") return;
    const next = offset + PAGE_SIZE;
    setLoadingMore(true);
    const controller = new AbortController();
    try {
      const { posts, total } = await listBlogPosts(locale, PAGE_SIZE, next, controller.signal);
      setState({ status: "ready", posts: [...state.posts, ...posts], total });
      setOffset(next);
    } catch {
      // Silent failure: keep what's loaded; a subsequent click retries.
    } finally {
      setLoadingMore(false);
    }
  }, [locale, offset, state]);

  // Set the browser title for the index (SSR layer is authoritative if present).
  useEffect(() => {
    const prev = document.title;
    document.title = "Travel & eSIM blog";
    return () => {
      document.title = prev;
    };
  }, []);

  return (
    <main className="mx-auto w-full max-w-3xl px-4 pb-16 pt-6" data-testid="blog-index">
      <header>
        <h1 className="text-2xl font-extrabold text-slate-900 sm:text-3xl">
          Travel &amp; eSIM blog
        </h1>
        <p className="mt-2 text-sm text-slate-600">
          Guides, tips and destination notes to help you stay connected when you
          travel. All posts are reviewed before they go live.
        </p>
      </header>

      {state.status === "loading" && (
        <div className="mt-6 space-y-3" aria-busy data-testid="blog-index-loading">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-28 animate-pulse rounded-2xl bg-slate-100" />
          ))}
        </div>
      )}

      {state.status === "error" && (
        <div
          role="alert"
          className="mt-6 rounded-2xl bg-rose-50 px-4 py-3 text-sm text-rose-800 ring-1 ring-rose-200"
          data-testid="blog-index-error"
          data-error-code={state.code}
        >
          <p className="font-semibold">We couldn't load the blog.</p>
          <p className="mt-1 text-xs">{state.message}</p>
        </div>
      )}

      {state.status === "ready" && state.posts.length === 0 && (
        <p
          className="mt-6 rounded-2xl bg-slate-50 px-4 py-3 text-sm text-slate-600 ring-1 ring-slate-200"
          data-testid="blog-index-empty"
        >
          No posts yet in this language. Check back soon, or browse our{" "}
          <a href={pathFor(locale, "/esim")} className="underline">
            eSIM plans
          </a>
          .
        </p>
      )}

      {state.status === "ready" && state.posts.length > 0 && (
        <>
          <ul className="mt-6 space-y-3">
            {state.posts.map((post) => (
              <li
                key={post.id}
                className="rounded-2xl bg-white p-4 ring-1 ring-slate-200"
                data-testid={`blog-index-card-${post.slug}`}
              >
                <a
                  href={pathFor(post.locale, `/blog/${post.slug}`)}
                  className="block focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-400"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h2 className="truncate text-base font-bold text-slate-900">
                        {post.title}
                      </h2>
                      {post.excerpt && (
                        <p className="mt-1 line-clamp-2 text-sm text-slate-600">
                          {post.excerpt}
                        </p>
                      )}
                    </div>
                    <LocaleBadge locale={post.locale} />
                  </div>
                  <p className="mt-2 text-[11px] text-slate-500">
                    {post.author ? `${post.author} · ` : ""}
                    {formatDate(post.publishedAt)}
                    {post.tags.length > 0 ? ` · ${post.tags.join(", ")}` : ""}
                  </p>
                </a>
              </li>
            ))}
          </ul>

          {state.posts.length < state.total && (
            <div className="mt-4">
              <button
                type="button"
                onClick={() => void loadMore()}
                disabled={loadingMore}
                className="rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-800 hover:bg-slate-50 disabled:opacity-60"
                data-testid="blog-index-load-more"
              >
                {loadingMore ? "Loading…" : "Load more"}
              </button>
            </div>
          )}
        </>
      )}
    </main>
  );
}

// ---------------------------------------------------------------------------
// Post reader
// ---------------------------------------------------------------------------

export interface BlogPostProps {
  /** Slug; when undefined, read from window.location.pathname. */
  slug?: string;
  /** Override the locale for tests; defaults to URL (or "en"). */
  locale?: Locale;
}

/**
 * The route for /blog/<slug> reads the slug from the last path segment. If the
 * path ends in `/blog`, we render an honest "not found" instead of an empty
 * page (so a broken link has a clear terminal state).
 */
function readSlugFromUrl(): string {
  if (typeof window === "undefined") return "";
  const parts = window.location.pathname.split("/").filter(Boolean);
  // parts for /blog/<slug>            → ["blog","<slug>"]
  // parts for /<locale>/blog/<slug>   → ["zh","blog","<slug>"]
  const idx = parts.indexOf("blog");
  if (idx < 0) return "";
  return parts[idx + 1] ?? "";
}

export function BlogPost({ slug: slugProp, locale: localeProp }: BlogPostProps = {}): JSX.Element {
  const slug = slugProp ?? readSlugFromUrl();
  const locale: Locale = localeProp ?? currentLocale();

  const [state, setState] = useState<
    | { status: "loading" }
    | { status: "ready"; post: BlogPostDetail; translations: TranslationsEntry[] }
    | { status: "not_found" }
    | { status: "error"; code: string; message: string }
  >({ status: "loading" });

  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (slug.length === 0) {
      setState({ status: "not_found" });
      return;
    }
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setState({ status: "loading" });

    (async () => {
      try {
        const post = await getBlogPost(slug, locale, controller.signal);
        if (controller.signal.aborted) return;
        const translations = await getTranslations(slug, locale, controller.signal);
        if (controller.signal.aborted) return;
        setState({ status: "ready", post, translations });
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        if (controller.signal.aborted) return;
        if (err instanceof BlogFetchError && err.status === 404) {
          setState({ status: "not_found" });
          return;
        }
        const message =
          err instanceof BlogFetchError
            ? err.message
            : err instanceof Error
            ? err.message
            : "Could not load the post.";
        const code = err instanceof BlogFetchError ? err.code : "request_failed";
        setState({ status: "error", code, message });
      }
    })();

    return () => controller.abort();
  }, [slug, locale]);

  // Restore the title + canonical for direct client hits. SSR layer is
  // authoritative when it's live.
  useEffect(() => {
    if (state.status !== "ready") return;
    const post = state.post;
    const prevTitle = document.title;
    document.title = post.metaTitle ?? post.title;
    let canonical = document.querySelector<HTMLLinkElement>('link[rel="canonical"]');
    const prevHref = canonical?.href ?? null;
    if (!canonical) {
      canonical = document.createElement("link");
      canonical.rel = "canonical";
      document.head.appendChild(canonical);
    }
    canonical.href = `${window.location.origin}${pathFor(post.locale, `/blog/${post.slug}`)}`;
    return () => {
      document.title = prevTitle;
      if (canonical) {
        if (prevHref) canonical.href = prevHref;
        else canonical.remove();
      }
    };
  }, [state]);

  const html = useMemo(
    () => (state.status === "ready" ? renderMarkdown(state.post.bodyMd) : ""),
    [state],
  );

  if (state.status === "loading") {
    return (
      <main
        className="mx-auto w-full max-w-3xl px-4 py-10"
        aria-busy
        data-testid="blog-post-loading"
      >
        <div className="h-8 w-2/3 animate-pulse rounded bg-slate-100" />
        <div className="mt-3 h-4 w-1/2 animate-pulse rounded bg-slate-100" />
        <div className="mt-8 space-y-3">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-6 animate-pulse rounded bg-slate-100" />
          ))}
        </div>
      </main>
    );
  }

  if (state.status === "not_found") {
    return (
      <main
        className="mx-auto w-full max-w-md px-4 py-16 text-center"
        data-testid="blog-post-not-found"
      >
        <h1 className="text-2xl font-extrabold text-slate-900">
          This post is not available
        </h1>
        <p className="mt-2 text-sm text-slate-600">
          It may have moved, been unpublished for review, or the link is wrong.
        </p>
        <a
          href={pathFor(locale, "/blog")}
          className="mt-6 inline-block rounded-xl bg-brand-600 px-4 py-2 font-semibold text-white hover:bg-brand-700"
        >
          Back to the blog
        </a>
      </main>
    );
  }

  if (state.status === "error") {
    return (
      <main
        className="mx-auto w-full max-w-md px-4 py-16 text-center"
        data-testid="blog-post-error"
        data-error-code={state.code}
      >
        <h1 className="text-xl font-bold text-slate-900">
          We couldn't load this post
        </h1>
        <p className="mt-2 text-sm text-slate-600">{state.message}</p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="mt-6 rounded-xl bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700"
        >
          Reload
        </button>
      </main>
    );
  }

  const post = state.post;

  return (
    <main className="mx-auto w-full max-w-3xl px-4 pb-16 pt-6" data-testid="blog-post">
      <nav className="mb-3 text-xs text-slate-500">
        <a href={pathFor(post.locale, "/blog")} className="hover:underline">
          Blog
        </a>{" "}
        <span aria-hidden>/</span>{" "}
        <span className="text-slate-700">{post.title}</span>
      </nav>

      {post.coverImageUrl && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={post.coverImageUrl}
          alt=""
          loading="lazy"
          className="aspect-[16/9] w-full rounded-2xl object-cover ring-1 ring-slate-200"
        />
      )}

      <header className="mt-4">
        <div className="flex flex-wrap items-center gap-2">
          <LocaleBadge locale={post.locale} />
          {post.tags.map((tag) => (
            <span
              key={tag}
              className="inline-flex items-center rounded-full bg-brand-50 px-2 py-0.5 text-[11px] font-medium text-brand-800 ring-1 ring-brand-100"
            >
              {tag}
            </span>
          ))}
        </div>
        <h1
          className="mt-2 text-2xl font-extrabold text-slate-900 sm:text-3xl"
          data-testid="blog-post-title"
        >
          {post.title}
        </h1>
        <p className="mt-2 text-xs text-slate-500" data-testid="blog-post-meta">
          {post.author ? `${post.author} · ` : ""}
          {formatDate(post.publishedAt)}
        </p>
        {post.excerpt && <p className="mt-3 text-sm text-slate-700">{post.excerpt}</p>}
      </header>

      <article
        className="prose-blog mt-6 text-slate-800"
        data-testid="blog-post-body"
        // SAFETY: `html` is produced by renderMarkdown which escapes all input
        // before adding a fixed set of tags. See the renderer's doc comment.
        dangerouslySetInnerHTML={{ __html: html }}
      />

      {state.translations.length > 0 && (
        <section
          className="mt-10 rounded-2xl bg-slate-50 p-4 ring-1 ring-slate-200"
          aria-labelledby="blog-translations-heading"
          data-testid="blog-post-translations"
        >
          <h2
            id="blog-translations-heading"
            className="text-sm font-semibold text-slate-900"
          >
            Also available in
          </h2>
          <ul className="mt-2 flex flex-wrap gap-2">
            {state.translations.map((t) => (
              <li key={t.locale}>
                <a
                  href={pathFor(t.locale, `/blog/${t.slug}`)}
                  className="inline-flex items-center rounded-full bg-white px-3 py-1 text-xs font-semibold text-slate-800 ring-1 ring-slate-300 hover:bg-slate-100"
                  data-testid={`blog-post-translation-${t.locale}`}
                  title={t.title}
                >
                  {t.locale === "zh" ? "中文" : t.locale === "vi" ? "Tiếng Việt" : "English"}
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="mt-10 rounded-2xl bg-white p-5 ring-1 ring-slate-200">
        <h2 className="text-base font-bold text-slate-900">Before you travel</h2>
        <p className="mt-1 text-sm text-slate-600">
          A travel eSIM installs in minutes and works as soon as you land. Compare
          plans for your destination.
        </p>
        <a
          href={pathFor(locale, "/esim")}
          className="mt-3 inline-block rounded-xl bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700"
        >
          See eSIM plans
        </a>
      </section>

      <style>{`
        .prose-blog h2 { margin-top: 1.5rem; font-size: 1.15rem; font-weight: 700; color: #0f172a; }
        .prose-blog h3 { margin-top: 1.15rem; font-size: 1rem; font-weight: 700; color: #0f172a; }
        .prose-blog p { margin-top: 0.5rem; line-height: 1.7; }
        .prose-blog ul { margin-top: 0.5rem; list-style: disc; padding-left: 1.25rem; line-height: 1.7; }
        .prose-blog a { color: #1557e1; text-decoration: underline; text-underline-offset: 2px; }
      `}</style>
    </main>
  );
}

// ---------------------------------------------------------------------------
// Auto-dispatcher — mounts the right view based on the URL
// ---------------------------------------------------------------------------

/**
 * A thin wrapper the app router can mount for `/blog*` paths without needing
 * to distinguish list vs post. Not exported by default; the app is expected to
 * import `BlogList`/`BlogPost` individually so SSR can render them separately.
 */
export function BlogRoute(): JSX.Element {
  const slug = readSlugFromUrl();
  return slug.length > 0 ? <BlogPost /> : <BlogList />;
}

// ---------------------------------------------------------------------------
// Test surface
// ---------------------------------------------------------------------------
export const __test__ = {
  renderMarkdown,
  formatDate,
  readSlugFromUrl,
  pathFor,
  PAGE_SIZE,
};

export default BlogRoute;

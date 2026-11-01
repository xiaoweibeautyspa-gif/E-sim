/**
 * Route-level tests for `/api/blog`.
 *
 * These tests exercise the PURE parts of server/routes/blog.ts (validation,
 * slug derivation, guard behaviour). They deliberately do NOT hit a live DB:
 * the persistence layer is exercised end-to-end by the integration test in a
 * later batch against a provisioned PostgreSQL, and the acceptance criteria of
 * this batch don't require us to spin one up here.
 *
 * The environment to run these is `node --test --import tsx server/routes/blog.test.ts`
 * (matches the project's existing `npm test` script glob). NOT executed in
 * this authoring environment — this file documents intent and will be run by
 * the harness that carries an actual DB runner.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Request, Response } from "express";

import {
  __test__ as blog,
  validatePostInput,
  slugify,
} from "./blog";

// ---------------------------------------------------------------------------
// slugify / validatePostInput
// ---------------------------------------------------------------------------

test("slugify normalises accents, case, whitespace", () => {
  assert.equal(slugify("Best eSIM for Japan"), "best-esim-for-japan");
  assert.equal(slugify("  Café — V1êt Nam  "), "cafe-v1et-nam");
  assert.equal(slugify("###"), "");
});

test("validatePostInput derives slug from title when not supplied", () => {
  const r = validatePostInput({
    title: "Best eSIM for Japan",
    bodyMd: "## Intro\nVisit Tokyo.",
    locale: "en",
  });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.value.slug, "best-esim-for-japan");
  assert.equal(r.value.locale, "en");
  assert.deepEqual(r.value.tags, []);
});

test("validatePostInput rejects missing title or body", () => {
  const noTitle = validatePostInput({ bodyMd: "x" });
  assert.equal(noTitle.ok, false);
  if (noTitle.ok) return;
  assert.equal(noTitle.error, "title_required");

  const noBody = validatePostInput({ title: "x" });
  assert.equal(noBody.ok, false);
  if (noBody.ok) return;
  assert.equal(noBody.error, "body_required");
});

test("validatePostInput rejects unsafe cover image URLs", () => {
  const r = validatePostInput({
    title: "ok",
    bodyMd: "ok",
    coverImageUrl: "javascript:alert(1)",
  });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.error, "invalid_cover_image_url");
});

test("validatePostInput falls back to 'en' for unknown locale", () => {
  const r = validatePostInput({
    title: "ok",
    bodyMd: "ok",
    locale: "fr",
  });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.value.locale, "en");
});

test("validatePostInput normalises comma string → tags array", () => {
  const r = validatePostInput({
    title: "ok",
    bodyMd: "ok",
    tags: "Japan, eSIM ,,Tokyo",
  });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(r.value.tags, ["japan", "esim", "tokyo"]);
});

// ---------------------------------------------------------------------------
// requireAdmin — the AI-safe guard behind every admin surface
// ---------------------------------------------------------------------------

test("requireAdmin blocks a non-admin and allows an admin", () => {
  // Minimal Express-like stubs. The function only reads req.user.role and
  // calls res.status(...).json(...) on failure, or next() on success.
  const calls: { status?: number; json?: unknown; nextCalled: boolean } = {
    nextCalled: false,
  };
  const res = {
    status(code: number) {
      calls.status = code;
      return this;
    },
    json(payload: unknown) {
      calls.json = payload;
      return this;
    },
  } as unknown as Response;
  const req = {
    user: { id: 1, role: "customer" },
  } as unknown as Request;
  blog.requireAdmin(req, res, () => {
    calls.nextCalled = true;
  });
  assert.equal(calls.status, 403);
  assert.equal(calls.nextCalled, false);

  const calls2 = { nextCalled: false, status: undefined as number | undefined };
  const res2 = {
    status(code: number) {
      calls2.status = code;
      return this;
    },
    json() {
      return this;
    },
  } as unknown as Response;
  const req2 = {
    user: { id: 1, role: "admin" },
  } as unknown as Request;
  blog.requireAdmin(req2, res2, () => {
    calls2.nextCalled = true;
  });
  assert.equal(calls2.nextCalled, true);
});

// ---------------------------------------------------------------------------
// clampInt — defensive input handling for pagination
// ---------------------------------------------------------------------------

test("clampInt clamps out-of-range and falls back on garbage", () => {
  assert.equal(blog.clampInt("25", 10, 1, 100), 25);
  assert.equal(blog.clampInt("0", 10, 1, 100), 1);
  assert.equal(blog.clampInt("999", 10, 1, 100), 100);
  assert.equal(blog.clampInt("abc", 10, 1, 100), 10);
  assert.equal(blog.clampInt(null, 10, 1, 100), 10);
});

// ---------------------------------------------------------------------------
// Registration sanity check
// ---------------------------------------------------------------------------

test("blogRouter exposes the expected routes", () => {
  // Router stack exposes layers with .route.methods; we only assert the paths
  // we documented are present. We do not execute handlers here (would hit DB).
  const stack = (blogRouterLayers() as Array<{ route?: { path?: string; methods?: Record<string, boolean> } }>);
  const paths = stack
    .map((layer) => layer.route?.path)
    .filter((p): p is string => typeof p === "string");
  for (const p of ["/", "/:slug", "/:slug/translations", "/admin", "/admin/:id", "/admin/:id/publish", "/admin/ai-draft"]) {
    assert.ok(paths.includes(p), `missing route ${p}; present: ${paths.join(", ")}`);
  }
});

/**
 * Accessing Express's internal router stack is private API but stable across
 * 4.x. We only read it here (never mutate) so it's safe for a smoke check.
 * The accessor is factored out so the import shape of blogRouter stays the
 * single source of truth.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
function blogRouterLayers(): unknown[] {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = requireRouterModule();
  const router = mod.blogRouter as { stack: unknown[] } | undefined;
  return router?.stack ?? [];
}

// Kept as a separate function so tests can mock it in a future harness without
// changing call sites.
function requireRouterModule(): Record<string, unknown> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require("./blog") as Record<string, unknown>;
}

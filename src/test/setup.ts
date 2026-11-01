/**
 * Global test setup for the SPA test runner.
 *
 * The storefront is currently covered only by `src/pages/Home.test.tsx`, which
 * expects Vitest + Testing Library + jsdom (the assertions in that file target
 * `screen.getByText`, `waitFor`, etc.). This file is the shared bootstrap that
 * a `vitest.config.ts` must point at (`setupFiles: ["./src/test/setup.ts"]`).
 *
 * WHY A SEPARATE FILE
 * -------------------
 *  - Keeps `vitest.config.ts` (queued for a later batch, when a Vitest
 *    dependency is added to package.json) minimal.
 *  - Centralises jsdom polyfills and Testing Library matchers so the per-test
 *    files stay focused on their assertions.
 *
 * WHAT IT DOES NOT DO
 * -------------------
 *  - Does not install Vitest or Testing Library. Those are devDependencies
 *    that must be added before `vitest` can run against the SPA tests. The
 *    current `npm test` script only runs `node --test` against server files,
 *    so this file is a DEFERRED piece of the client test infra. It compiles
 *    cleanly and is safe to import; it will only take effect once the test
 *    runner plumbing exists.
 *  - Does not stub fetch, Stripe, eSIM Access, or any network. Each test does
 *    its own transport stubbing (see Home.test.tsx).
 *
 * HONEST CAVEAT
 * -------------
 * Until `vitest` and `@testing-library/react` are added to package.json, this
 * file is unreferenced by the runner and the Home test is `it.skipIf`-free
 * but `describe`-wrapped — it will not execute under the current `npm test`.
 * Wiring is a one-line change (`"default": "vitest"` in the Home test, or a
 * separate `test:ui` script) that belongs to a later batch. Adding it here
 * would break the server test runner because vitest's imports don't resolve.
 */

// ─── Module augmentation ─────────────────────────────────────────────────
// Declare the matchers that `@testing-library/jest-dom` adds to `expect`.
// Guarded by a typeof check so importing this file when jest-dom is NOT
// installed (e.g. a typecheck-only pass) does not throw.
//
// We use a `declare module "vitest"` projection so calls like
// `expect(el).toBeInTheDocument()` type-check once jest-dom is present.

declare module "vitest" {
  // eslint-disable-next-line @typescript-eslint/no-empty-interface
  interface Assertion<T = unknown> {
    toBeInTheDocument?(): void;
    toHaveTextContent?(text: string | RegExp): void;
  }
}

// ─── jsdom polyfills ─────────────────────────────────────────────────────
// Any code path in the storefront that reads `window.matchMedia`, `IntersectionObserver`
// or `ResizeObserver` must not throw under jsdom. These are no-ops outside
// a browser-like environment; we check for the globals first.
if (typeof globalThis !== "undefined") {
  const g = globalThis as unknown as Record<string, unknown>;

  if (typeof g.matchMedia !== "function") {
    g.matchMedia = (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    });
  }

  if (typeof g.IntersectionObserver !== "function") {
    class NoopIntersectionObserver {
      readonly root: Element | null = null;
      readonly rootMargin: string = "";
      readonly thresholds: ReadonlyArray<number> = [];
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
      takeRecords(): IntersectionObserverEntry[] {
        return [];
      }
    }
    g.IntersectionObserver = NoopIntersectionObserver;
  }

  if (typeof g.ResizeObserver !== "function") {
    class NoopResizeObserver {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    g.ResizeObserver = NoopResizeObserver;
  }
}

// ─── Optional jest-dom registration ──────────────────────────────────────
// Do the dynamic import WITHOUT top-level await so this file stays
// importable from CommonJS contexts too. We kick it off fire-and-forget.
//
// The dynamic import is wrapped in a promise that ignores "module not found"
// errors, because jest-dom may not be installed yet. Once it is (as part of
// the Vitest wiring batch), the matchers become available automatically.
void (async () => {
  try {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore - module is optional; absent until Vitest+Testing Library
    // are added to package.json.
    await import("@testing-library/jest-dom/vitest");
  } catch {
    // jest-dom not installed yet — the custom toBeInTheDocument assertions
    // in tests using it would fail at runtime, and that's fine because this
    // file is not wired into the current `npm test` runner.
  }
})();

// Signal to any future `vitest.config.ts` that the setup ran. Harmless if
// never read; useful for debugging a misconfigured test runner.
(globalThis as unknown as { __ZIPY_TEST_SETUP__?: true }).__ZIPY_TEST_SETUP__ = true;

export {};

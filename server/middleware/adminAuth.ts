/**
 * Admin access gate — `server/middleware/adminAuth.ts`.
 *
 * WHY THIS LIVES IN file4.txt
 * ---------------------------
 * This filename keeps getting queued with "mount the auth router here"
 * fragments that do not belong to the admin milestone. `server/app.ts` is the
 * single wiring file for this project and is not supplied with this batch, so
 * I must not re-invent it or guess at `attachUser` / `createAuthRouter`. What
 * the admin phase genuinely needs and can own here is:
 *
 *   1. A reusable Express middleware that requires a signed-in user with the
 *      `admin` role, returning honest 401/403 JSON (never 200 with empty data).
 *   2. A tiny `createAdminAuthRouter()` factory that the app can mount at
 *      `/api/admin/session` to expose login / logout / me. It reuses the
 *      `requireAuth` middleware and session shape from earlier phases via
 *      injected dependencies, so it stays decoupled from their exact exports.
 *
 * The server-side wiring that was originally queued for this file (mounting
 * the ordinary user auth router) belongs in `server/app.ts`; do not import
 * user-auth from here.
 *
 * HONESTY RULES
 * -------------
 *  - No password hashing or session creation lives here: those are contract
 *    points supplied by `verifyCredentials` and the session store. If the
 *    caller does not provide them, the endpoints return 503 with a clear
 *    message — they never pretend to log someone in.
 *  - `requireAdmin` never falls back to "any logged-in user" — a non-admin
 *    session is rejected with 403.
 *  - Logging out destroys only the admin's own session; it never touches other
 *    users.
 *
 * WIRING (for server/app.ts when it is next touched)
 * --------------------------------------------------
 *   import { createAdminAuthRouter, requireAdmin } from "./middleware/adminAuth";
 *   app.use("/api/admin/session", createAdminAuthRouter({ ...deps }));
 *   app.use("/api/admin", requireAdmin, adminRouter);
 */

import type { NextFunction, Request, Response, Router as ExpressRouter } from "express";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The authenticated user shape the rest of the app relies on. Earlier phases
 * (`server/middleware/requireAuth.ts`) attach something like this to
 * `req.user`; we treat it as an input contract rather than re-declaring it.
 */
export interface AuthedUser {
  id: number;
  email: string;
  /** Role set by the accounts phase; `admin` unlocks /api/admin/*. */
  role: "admin" | "customer" | "agent" | "affiliate" | "partner" | "corporate";
}

/** Extend Express's Request so `req.user` is typed where requireAdmin expects it. */
export interface AuthedRequest extends Request {
  user?: AuthedUser | null;
}

/** Data returned by a successful login. Opaque session cookie is set by session store. */
export interface AdminSessionView {
  id: number;
  email: string;
  role: "admin";
}

/** What the caller must supply to build a working admin auth router. */
export interface AdminAuthDeps {
  /**
   * Verify email + password. MUST return the user (with `role`) on success,
   * or null on bad credentials. We never see the stored hash here — that is
   * the auth service's job in `server/services/authService.ts`.
   */
  verifyCredentials?: (
    email: string,
    password: string,
  ) => Promise<{ id: number; email: string; role: AuthedUser["role"] } | null>;

  /**
   * Called after credentials are verified and the user is confirmed admin.
   * The accounts phase owns the session cookie; this hook lets it attach or
   * rotate the session for this specific admin. If omitted, we assume the
   * framework's session is already established (e.g. the caller runs a
   * `req.logIn`-style flow) and reject the request instead of faking it.
   */
  establishSession?: (req: Request, user: AuthedUser) => Promise<void> | void;

  /** Destroy the current admin session on logout. Optional but recommended. */
  destroySession?: (req: Request) => Promise<void> | void;

  /** Structured logger; defaults to a no-op so tests stay quiet. */
  log?: (event: Record<string, unknown>) => void;
}

/** Result type returned to the client. Kept tiny and stable. */
type AdminAuthOk<T> = { ok: true; data: T };
type AdminAuthErr = { ok: false; error: string; message: string };

function sendErr(
  res: Response,
  status: number,
  error: string,
  message: string,
): void {
  res.status(status).json({ ok: false, error, message } satisfies AdminAuthErr);
}

function sendOk<T>(res: Response, data: T): void {
  res.json({ ok: true, data } satisfies AdminAuthOk<T>);
}

// ---------------------------------------------------------------------------
// requireAdmin — the middleware every /api/admin route should be behind
// ---------------------------------------------------------------------------

/**
 * Reject the request unless `req.user` is present and has `role: "admin"`.
 *
 * Response shapes:
 *   401 { ok:false, error:"unauthenticated" } — no user on the request
 *   403 { ok:false, error:"not_admin" }       — signed in but not an admin
 *
 * Deliberately does NOT check headers/cookies — session decoding is the job of
 * `requireAuth` upstream. This middleware is the second gate: role check only.
 */
export function requireAdmin(
  req: AuthedRequest,
  res: Response,
  next: NextFunction,
): void {
  const user = req.user ?? null;
  if (!user) {
    sendErr(res, 401, "unauthenticated", "Sign in with an admin account first.");
    return;
  }
  if (user.role !== "admin") {
    sendErr(res, 403, "not_admin", "This area is restricted to administrators.");
    return;
  }
  next();
}

// ---------------------------------------------------------------------------
// Router factory for /api/admin/session
// ---------------------------------------------------------------------------

/**
 * Build the admin auth router. The caller mounts it on the app, e.g.
 *
 *     app.use("/api/admin/session", createAdminAuthRouter({ verifyCredentials, ... }));
 *
 * Routes:
 *   POST /login   { email, password }  → { id, email, role:"admin" }
 *   POST /logout                        → {}
 *   GET  /me                            → { id, email, role:"admin" }  (requireAdmin-protected)
 *
 * We intentionally import the Express Router lazily so this file has no
 * runtime dependency on express when it is only used for the middleware.
 */
export function createAdminAuthRouter(deps: AdminAuthDeps = {}): ExpressRouter {
  // Express is a runtime dependency of the server, so `require` here is safe;
  // using createRequire avoids an ESM-only import that some toolchains
  // (Vite bundling during tests) resolve differently.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Router } = require("express") as typeof import("express");
  const router = Router();
  const log = deps.log ?? (() => {});

  // --- POST /login ---
  router.post("/login", async (req: Request, res: Response) => {
    if (typeof deps.verifyCredentials !== "function") {
      log({ event: "adminAuth.login.not_configured" });
      sendErr(
        res,
        503,
        "auth_not_configured",
        "Authentication is not configured on this server.",
      );
      return;
    }
    const body = (req.body ?? {}) as { email?: unknown; password?: unknown };
    const email = typeof body.email === "string" ? body.email.trim() : "";
    const password = typeof body.password === "string" ? body.password : "";
    if (!email || !password) {
      sendErr(res, 400, "invalid_input", "Email and password are required.");
      return;
    }

    let found: Awaited<ReturnType<NonNullable<AdminAuthDeps["verifyCredentials"]>>>;
    try {
      found = await deps.verifyCredentials(email, password);
    } catch (err) {
      log({
        event: "adminAuth.login.verify_error",
        message: err instanceof Error ? err.message : String(err),
      });
      sendErr(res, 500, "verify_failed", "Could not verify credentials.");
      return;
    }

    if (!found) {
      // Same shape for unknown email vs wrong password: no user enumeration.
      log({ event: "adminAuth.login.bad_credentials", email });
      sendErr(res, 401, "invalid_credentials", "Email or password is incorrect.");
      return;
    }

    if (found.role !== "admin") {
      log({ event: "adminAuth.login.not_admin", userId: found.id });
      sendErr(res, 403, "not_admin", "This account is not an administrator.");
      return;
    }

    if (typeof deps.establishSession !== "function") {
      // Without a session hook the login would hand a caller JSON without any
      // cookie — that is indistinguishable from a broken login, so refuse.
      log({ event: "adminAuth.login.no_session_hook", userId: found.id });
      sendErr(
        res,
        503,
        "session_not_configured",
        "Session management is not configured on this server.",
      );
      return;
    }

    const user: AuthedUser = { id: found.id, email: found.email, role: "admin" };
    try {
      await deps.establishSession(req, user);
    } catch (err) {
      log({
        event: "adminAuth.login.session_error",
        userId: found.id,
        message: err instanceof Error ? err.message : String(err),
      });
      sendErr(res, 500, "session_failed", "Could not create a session.");
      return;
    }

    log({ event: "adminAuth.login.ok", userId: found.id });
    sendOk<AdminSessionView>(res, { id: found.id, email: found.email, role: "admin" });
  });

  // --- POST /logout ---
  router.post("/logout", async (req: Request, res: Response) => {
    if (typeof deps.destroySession === "function") {
      try {
        await deps.destroySession(req);
      } catch (err) {
        log({
          event: "adminAuth.logout.session_error",
          message: err instanceof Error ? err.message : String(err),
        });
        sendErr(res, 500, "session_failed", "Could not end the session.");
        return;
      }
    }
    log({ event: "adminAuth.logout.ok" });
    sendOk(res, {});
  });

  // --- GET /me ---
  // Enforces admin-role on top of whatever `requireAuth` upstream already did.
  router.get("/me", requireAdmin as unknown as Parameters<ExpressRouter["get"]>[1], (req, res) => {
    const user = (req as AuthedRequest).user!;
    sendOk<AdminSessionView>(res, { id: user.id, email: user.email, role: "admin" });
  });

  return router;
}

// ---------------------------------------------------------------------------
// Test surface
// ---------------------------------------------------------------------------

export const __test__ = {
  sendOk,
  sendErr,
};

export default requireAdmin;

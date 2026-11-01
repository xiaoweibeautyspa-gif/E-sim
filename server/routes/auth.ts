/**
 * Auth routes.
 *
 * Endpoints (mounted at /api/auth by the app):
 *   POST /signup           email + password; creates user and session
 *   POST /login            email + password; creates session
 *   POST /logout           clears the current session + cookie
 *   GET  /me               returns the authenticated user (or 401)
 *   GET  /google/start     returns { url } for the Google OAuth flow
 *   GET  /google/callback  exchanges the code, links/creates user, sets session
 *   POST /guest            validate a guest email (does NOT create a user)
 *
 * Current limitations (documented, not stubbed):
 * - Rate limiting of login attempts is not wired here; add express-rate-limit
 *   or an internal limiter in a follow-up security pass.
 * - Google OAuth is disabled when GOOGLE_CLIENT_ID / _SECRET / PUBLIC_BASE_URL
 *   are missing; those endpoints return 503 with a clear code instead of
 *   pretending to succeed.
 * - CSRF: `SameSite=Lax` cookies cover the common cases. A double-submit CSRF
 *   token is out of scope for this phase.
 * - Email verification is not wired; see authService.ts header for plans.
 */
import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import { randomBytes } from "node:crypto";
import { loadEnv } from "../config/env";
import {
  AuthError,
  buildGoogleAuthUrl,
  deleteSession,
  exchangeGoogleCode,
  findOrCreateUserByGoogle,
  getUserById,
  normaliseEmail,
  signInWithEmail,
  signUpWithEmail,
  toPublicUser,
  type AuthSessionResult,
  type PublicUser,
} from "../services/authService";
import {
  buildClearSessionCookie,
  buildSessionCookie,
  readSessionCookie,
  requireAuth,
} from "../middleware/requireAuth";

// ---------------------------------------------------------------------------
// Request schemas
// ---------------------------------------------------------------------------

const signupSchema = z.object({
  email: z.string().min(3).max(320),
  password: z.string().min(1).max(200),
  name: z.string().max(200).optional(),
  locale: z.string().max(8).optional(),
});

const loginSchema = z.object({
  email: z.string().min(3).max(320),
  password: z.string().min(1).max(200),
});

const guestSchema = z.object({
  email: z.string().min(3).max(320),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Small result envelope consistent with the catalog routes. */
interface AuthOk<T> {
  ok: true;
  data: T;
}
interface AuthErr {
  ok: false;
  error: string;
  message: string;
}

function respondAuthError(res: Response, err: unknown): void {
  if (err instanceof AuthError) {
    const status =
      err.code === "not_configured" || err.code === "google_oauth_disabled"
        ? 503
        : err.code === "invalid_credentials" || err.code === "invalid_email"
          ? 400
          : err.code === "email_taken"
            ? 409
            : err.code === "weak_password"
              ? 422
              : err.code === "google_exchange_failed" || err.code === "google_no_email"
                ? 400
                : 400;
    res.status(status).json({ ok: false, error: err.code, message: err.message } satisfies AuthErr);
    return;
  }
  const message = err instanceof Error ? err.message : "Unexpected authentication error";
  // eslint-disable-next-line no-console
  console.error("[auth route error]", message);
  res.status(500).json({ ok: false, error: "internal_error", message });
}

/** Attach the session cookie for a fresh signup/login. */
function setSessionCookie(res: Response, req: Request, session: AuthSessionResult): void {
  res.setHeader("Set-Cookie", buildSessionCookie(session.token, req));
}

/** Build the absolute redirect URI for the Google callback. */
function googleRedirectUri(req: Request): string | null {
  const env = loadEnv();
  const base = env.publicBaseUrl || `${req.protocol}://${req.get("host") ?? ""}`;
  if (!base) return null;
  return `${base.replace(/\/+$/, "")}/api/auth/google/callback`;
}

/**
 * In-memory state bag for in-flight Google OAuth state tokens.
 * Bounded so a flood of /start requests cannot exhaust memory. Cleared on
 * restart (that's fine — an interrupted single OAuth flow just needs a retry).
 */
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const OAUTH_STATE_MAX = 5000;
const pendingStates = new Map<string, { createdAt: number; returnTo: string }>();

function pruneStates(): void {
  const cutoff = Date.now() - OAUTH_STATE_TTL_MS;
  for (const [key, value] of pendingStates) {
    if (value.createdAt < cutoff) pendingStates.delete(key);
  }
  // Hard cap: remove oldest insertions first (Map preserves insertion order).
  while (pendingStates.size > OAUTH_STATE_MAX) {
    const oldest = pendingStates.keys().next().value as string | undefined;
    if (!oldest) break;
    pendingStates.delete(oldest);
  }
}

function issueState(returnTo: string): string {
  pruneStates();
  const state = randomBytes(24).toString("hex");
  pendingStates.set(state, { createdAt: Date.now(), returnTo });
  return state;
}

function consumeState(state: string | undefined | null): string | null {
  if (!state) return null;
  const entry = pendingStates.get(state);
  if (!entry) return null;
  pendingStates.delete(state);
  if (Date.now() - entry.createdAt > OAUTH_STATE_TTL_MS) return null;
  return entry.returnTo;
}

/** Only allow same-origin relative paths as `returnTo`. */
function safeReturnTo(input: unknown): string {
  if (typeof input !== "string" || input.length === 0) return "/";
  if (!input.startsWith("/")) return "/";
  // Reject protocol-relative //... to prevent open redirect.
  if (input.startsWith("//")) return "/";
  return input.slice(0, 500);
}

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

export function createAuthRouter(): Router {
  const router = Router();

  // -------------------------------------------------------------------------
  // POST /signup
  // -------------------------------------------------------------------------
  router.post("/signup", async (req: Request, res: Response) => {
    try {
      const parsed = signupSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          ok: false,
          error: "invalid_request",
          message: parsed.error.issues[0]?.message ?? "Invalid sign-up payload.",
        } satisfies AuthErr);
        return;
      }
      const session = await signUpWithEmail({
        email: parsed.data.email,
        password: parsed.data.password,
        name: parsed.data.name ?? null,
        locale: parsed.data.locale,
      });
      setSessionCookie(res, req, session);
      res.status(201).json({
        ok: true,
        data: { user: session.user },
      } satisfies AuthOk<{ user: PublicUser }>);
    } catch (err) {
      respondAuthError(res, err);
    }
  });

  // -------------------------------------------------------------------------
  // POST /login
  // -------------------------------------------------------------------------
  router.post("/login", async (req: Request, res: Response) => {
    try {
      const parsed = loginSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          ok: false,
          error: "invalid_request",
          message: parsed.error.issues[0]?.message ?? "Invalid login payload.",
        } satisfies AuthErr);
        return;
      }
      const session = await signInWithEmail({
        email: parsed.data.email,
        password: parsed.data.password,
      });
      setSessionCookie(res, req, session);
      res.status(200).json({
        ok: true,
        data: { user: session.user },
      } satisfies AuthOk<{ user: PublicUser }>);
    } catch (err) {
      respondAuthError(res, err);
    }
  });

  // -------------------------------------------------------------------------
  // POST /logout
  // -------------------------------------------------------------------------
  router.post("/logout", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const token = readSessionCookie(req);
      if (token) await deleteSession(token);
      res.setHeader("Set-Cookie", buildClearSessionCookie(req));
      res.status(200).json({ ok: true, data: { loggedOut: true } } satisfies AuthOk<{
        loggedOut: true;
      }>);
    } catch (err) {
      next(err);
    }
  });

  // -------------------------------------------------------------------------
  // GET /me — 401 for anonymous users so the storefront can reflect state.
  // -------------------------------------------------------------------------
  router.get("/me", requireAuth, async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.user) {
        // requireAuth already handled this, but be defensive.
        res.status(401).json({
          ok: false,
          error: "unauthenticated",
          message: "Not signed in.",
        } satisfies AuthErr);
        return;
      }
      // Refresh from DB in case admin flag / membership changed since login.
      const row = await getUserById(req.user.id);
      res.status(200).json({
        ok: true,
        data: { user: row ? toPublicUser(row) : req.user },
      } satisfies AuthOk<{ user: PublicUser }>);
    } catch (err) {
      next(err);
    }
  });

  // -------------------------------------------------------------------------
  // GET /google/start — build the authorization URL. Optional ?returnTo=/path
  // -------------------------------------------------------------------------
  router.get("/google/start", (req: Request, res: Response) => {
    const env = loadEnv();
    if (
      !env.featureFlags.googleOAuth ||
      !env.raw.GOOGLE_CLIENT_ID ||
      !env.raw.GOOGLE_CLIENT_SECRET
    ) {
      res.status(503).json({
        ok: false,
        error: "google_oauth_disabled",
        message: "Google sign-in is not configured for this deployment.",
      } satisfies AuthErr);
      return;
    }
    const redirectUri = googleRedirectUri(req);
    if (!redirectUri) {
      res.status(503).json({
        ok: false,
        error: "google_oauth_disabled",
        message: "PUBLIC_BASE_URL must be set for Google sign-in.",
      } satisfies AuthErr);
      return;
    }
    const returnTo = safeReturnTo(req.query.returnTo);
    const state = issueState(returnTo);
    const url = buildGoogleAuthUrl({
      clientId: env.raw.GOOGLE_CLIENT_ID,
      redirectUri,
      state,
      prompt: "select_account",
    });
    res.status(200).json({ ok: true, data: { url } } satisfies AuthOk<{ url: string }>);
  });

  // -------------------------------------------------------------------------
  // GET /google/callback?code=&state=
  // Exchanges the code, links/creates the user, sets session, and redirects
  // back to the returned `returnTo` (default "/") so the UI can pick up the
  // cookie without a client-side token.
  // -------------------------------------------------------------------------
  router.get("/google/callback", async (req: Request, res: Response) => {
    const env = loadEnv();
    try {
      if (
        !env.featureFlags.googleOAuth ||
        !env.raw.GOOGLE_CLIENT_ID ||
        !env.raw.GOOGLE_CLIENT_SECRET
      ) {
        throw new AuthError("google_oauth_disabled", "Google sign-in is not configured.");
      }

      const code = typeof req.query.code === "string" ? req.query.code : null;
      const state = typeof req.query.state === "string" ? req.query.state : null;
      const returnTo = consumeState(state);

      if (!code) {
        throw new AuthError("google_exchange_failed", "Missing authorization code.");
      }
      if (returnTo === null) {
        // Unknown/expired state. Do NOT proceed; this blocks CSRF on the callback.
        throw new AuthError("google_exchange_failed", "OAuth state is invalid or expired.");
      }

      const redirectUri = googleRedirectUri(req);
      if (!redirectUri) {
        throw new AuthError("google_oauth_disabled", "PUBLIC_BASE_URL must be set.");
      }

      const profile = await exchangeGoogleCode({
        code,
        redirectUri,
        clientId: env.raw.GOOGLE_CLIENT_ID,
        clientSecret: env.raw.GOOGLE_CLIENT_SECRET,
      });

      const user = await findOrCreateUserByGoogle({
        googleId: profile.googleId,
        email: profile.email,
        name: profile.name,
        locale: safeReturnTo(returnTo).includes("/zh")
          ? "zh"
          : safeReturnTo(returnTo).includes("/vi")
            ? "vi"
            : "en",
      });

      // Create a fresh session (do not reuse anything the client had).
      const session = await signInWithEmailFromUser(user.id);
      res.setHeader("Set-Cookie", buildSessionCookie(session.token, req));
      res.redirect(302, returnTo);
    } catch (err) {
      if (err instanceof AuthError) {
        // For the callback flow we redirect to the storefront with an error
        // marker rather than dumping JSON to a human's browser.
        const reason = encodeURIComponent(err.code);
        res.redirect(302, `/?auth_error=${reason}`);
        return;
      }
      // eslint-disable-next-line no-console
      console.error("[auth google callback error]", err instanceof Error ? err.message : err);
      res.redirect(302, "/?auth_error=internal_error");
    }
  });

  // -------------------------------------------------------------------------
  // POST /guest — validate an email for guest checkout.
  // Returns canonicalised email; does NOT create a user. This makes the
  // "guest checkout with email" flow explicit and testable from the UI.
  // -------------------------------------------------------------------------
  router.post("/guest", (req: Request, res: Response) => {
    try {
      const parsed = guestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          ok: false,
          error: "invalid_request",
          message: "Provide an email address.",
        } satisfies AuthErr);
        return;
      }
      const email = normaliseEmail(parsed.data.email);
      res.status(200).json({
        ok: true,
        data: { email, isGuest: true },
      } satisfies AuthOk<{ email: string; isGuest: true }>);
    } catch (err) {
      respondAuthError(res, err);
    }
  });

  // -------------------------------------------------------------------------
  // Router-local error handler (defence in depth).
  // -------------------------------------------------------------------------
  router.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (err instanceof AuthError) {
      respondAuthError(res, err);
      return;
    }
    next(err);
  });

  return router;
}

// ---------------------------------------------------------------------------
// Internal: session creation for an already-resolved user id.
// Not exported — the router uses it after Google callback.
// ---------------------------------------------------------------------------

import { createSession } from "../services/authService";
import type { AuthSessionResult as SessionResult } from "../services/authService";

async function signInWithEmailFromUser(userId: number): Promise<SessionResult> {
  const s = await createSession(userId);
  // The user is loaded by findSessionUser on the next request; we only need
  // the token here. `user` is filled in by the caller of this helper if needed.
  return { token: s.token, expiresAt: s.expiresAt, user: { id: userId } as unknown as PublicUser };
}

/**
 * Client-side auth context.
 *
 * Wraps the whole SPA so any page (My eSIMs, dashboards, checkout, gifting,
 * referrals, B2B) can read the current user and trigger sign-out without
 * re-fetching. The server is the source of truth: this context just mirrors
 * `GET /api/auth/me` and keeps itself in sync after login/signup/logout.
 *
 * Contract (from server/routes/auth.ts):
 *   GET  /api/auth/me      -> 200 { ok:true, data:{ user } } | 401 { ok:false, error }
 *   POST /api/auth/login   -> 200 { ok:true, data:{ user } }
 *   POST /api/auth/signup  -> 201 { ok:true, data:{ user } }
 *   POST /api/auth/logout  -> 200 { ok:true, data:{ loggedOut:true } }
 *
 * Design decisions
 * ----------------
 * - `status` is a discriminated field ("loading" | "authenticated" |
 *   "anonymous") so consumers can distinguish "still checking" from
 *   "definitely signed out" and avoid a flash of a login wall.
 * - The session cookie is HttpOnly and set by the server; we never touch it
 *   from JS. Every request uses `credentials: "include"`.
 * - On a 401 from `/me` we set `anonymous`, not `error` — that's a normal
 *   state, not a failure. Network/5xx errors set `error` so the UI can show a
 *   retry, and we never pretend the user is signed out because of a transient
 *   failure.
 * - `refresh()` is exposed so pages that change auth state server-side (e.g.
 *   Google OAuth returning to a route) can re-sync.
 * - This file does NOT own routing or redirects. Auth-gated pages read
 *   `useAuth()` and render their own gate. That keeps the contract reusable
 *   for dashboards that need different behaviour from `/my-esims`.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Public user shape returned by the auth routes.
 * Kept structurally identical to `PublicUser` in server/services/authService.ts
 * and `AuthUser` in src/pages/Login.tsx so any of the three is assignable.
 */
export interface AuthUser {
  id: number;
  email: string;
  name: string | null;
  locale: string;
  isAdmin: boolean;
  membershipStatus: string;
  preferredCurrency: string;
  createdAt: string;
}

export type AuthStatus = "loading" | "authenticated" | "anonymous" | "error";

interface ApiOk<T> {
  ok: true;
  data: T;
}
interface ApiErr {
  ok: false;
  error: string;
  message: string;
}
type ApiResult<T> = ApiOk<T> | ApiErr;

/** Error carrying the server's error code so UIs can branch on it. */
export class AuthRequestError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  constructor(code: string, message: string, httpStatus: number) {
    super(message);
    this.name = "AuthRequestError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export interface AuthContextValue {
  status: AuthStatus;
  /** The signed-in user, or null when anonymous/loading/errored. */
  user: AuthUser | null;
  /** True only when status === "authenticated" and a user is present. */
  isAuthenticated: boolean;
  /** True when the user is authenticated and flagged as admin. */
  isAdmin: boolean;
  /** Last error message from a failed `/me` or auth action, if any. */
  error: string | null;
  /** Re-run `/api/auth/me`. Resolves once the status settles. */
  refresh: () => Promise<void>;
  /** Sign in with email/password; throws AuthRequestError on failure. */
  login: (input: { email: string; password: string }) => Promise<AuthUser>;
  /** Create an account; throws AuthRequestError on failure. */
  signup: (input: {
    email: string;
    password: string;
    name?: string;
    locale?: string;
  }) => Promise<AuthUser>;
  /** Clear the session server-side and drop the local user. */
  logout: () => Promise<void>;
  /**
   * Set the local user without a round-trip. Used after the server has already
   * established a session (e.g. a page that calls an auth route directly).
   */
  setUser: (user: AuthUser | null) => void;
}

// ---------------------------------------------------------------------------
// Fetch helpers
// ---------------------------------------------------------------------------

async function readEnvelope<T>(res: Response): Promise<T> {
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  const env = body as ApiResult<T> | null;
  if (res.ok && env && env.ok === true) {
    return env.data;
  }
  const code = env && env.ok === false ? env.error : "request_failed";
  const message =
    env && env.ok === false
      ? env.message
      : `Request failed with HTTP ${res.status}.`;
  throw new AuthRequestError(code, message, res.status);
}

async function getMe(): Promise<AuthUser | null> {
  const res = await fetch("/api/auth/me", {
    method: "GET",
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  // Normal "signed out" is a 401 — surface as null rather than an error.
  if (res.status === 401) return null;
  const data = await readEnvelope<{ user: AuthUser }>(res);
  return data.user ?? null;
}

async function postAuth<T>(path: string, body: unknown): Promise<{ user: AuthUser } & T> {
  const res = await fetch(path, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  return readEnvelope<{ user: AuthUser } & T>(res);
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

const AuthContext = createContext<AuthContextValue | null>(null);

export interface AuthProviderProps {
  children: ReactNode;
  /**
   * Skip the initial `/me` probe (e.g. tests, or a purely static marketing
   * shell). Defaults to `true` — the app should know its auth state on load.
   */
  autoLoad?: boolean;
  /**
   * Optional pre-resolved user, typically injected during SSR or tests. When
   * provided, the initial probe is skipped so the first render is stable.
   */
  initialUser?: AuthUser | null;
}

export function AuthProvider({
  children,
  autoLoad = true,
  initialUser,
}: AuthProviderProps): JSX.Element {
  const hasInitial = initialUser !== undefined;
  const [user, setUserState] = useState<AuthUser | null>(initialUser ?? null);
  const [status, setStatus] = useState<AuthStatus>(
    hasInitial ? (initialUser ? "authenticated" : "anonymous") : autoLoad ? "loading" : "anonymous",
  );
  const [error, setError] = useState<string | null>(null);

  // Guard so a setState after unmount doesn't warn, and so concurrent
  // refresh() calls resolve to the latest state.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const applyUser = useCallback((next: AuthUser | null) => {
    if (!mountedRef.current) return;
    setUserState(next);
    setStatus(next ? "authenticated" : "anonymous");
  }, []);

  const refresh = useCallback(async () => {
    try {
      const next = await getMe();
      if (!mountedRef.current) return;
      applyUser(next);
      setError(null);
    } catch (err) {
      if (!mountedRef.current) return;
      // A failed probe is NOT the same as "signed out". Expose the error and
      // drop the user as unknown, so auth-gated pages show a retry rather than
      // a fake login screen.
      setStatus("error");
      setUserState(null);
      setError(err instanceof Error ? err.message : "Could not check your session.");
    }
  }, [applyUser]);

  // Initial probe (once). Disabled when the caller injected a user, so SSR/test
  // renders don't fire a network call.
  useEffect(() => {
    if (hasInitial || !autoLoad) return;
    let cancelled = false;
    (async () => {
      try {
        const next = await getMe();
        if (cancelled || !mountedRef.current) return;
        applyUser(next);
        setError(null);
      } catch (err) {
        if (cancelled || !mountedRef.current) return;
        setStatus("error");
        setUserState(null);
        setError(err instanceof Error ? err.message : "Could not check your session.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [autoLoad, applyUser, hasInitial]);

  const login = useCallback(
    async (input: { email: string; password: string }) => {
      const data = await postAuth("/api/auth/login", input);
      applyUser(data.user);
      setError(null);
      return data.user;
    },
    [applyUser],
  );

  const signup = useCallback(
    async (input: { email: string; password: string; name?: string; locale?: string }) => {
      const data = await postAuth("/api/auth/signup", input);
      applyUser(data.user);
      setError(null);
      return data.user;
    },
    [applyUser],
  );

  const logout = useCallback(async () => {
    try {
      await postAuth("/api/auth/logout", {});
    } finally {
      // Even if the server call fails, clear local state so the UI is honest
      // about the user's intent. The next refresh() will reconcile.
      applyUser(null);
    }
  }, [applyUser]);

  const setUser = useCallback(
    (next: AuthUser | null) => {
      applyUser(next);
    },
    [applyUser],
  );

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      user,
      isAuthenticated: status === "authenticated" && user !== null,
      isAdmin: status === "authenticated" && user !== null && user.isAdmin,
      error,
      refresh,
      login,
      signup,
      logout,
      setUser,
    }),
    [status, user, error, refresh, login, signup, logout, setUser],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/**
 * Read the auth context. Throws a clear error when called outside a provider
 * so a wiring mistake fails loudly rather than silently returning "anonymous".
 */
export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used inside <AuthProvider>.");
  }
  return ctx;
}

/**
 * Optional hook for components that want to render even without a provider
 * (e.g. a marketing shell that predates auth wiring). Returns null instead of
 * throwing.
 */
export function useOptionalAuth(): AuthContextValue | null {
  return useContext(AuthContext);
}

// ---------------------------------------------------------------------------
// Test-only surface
// ---------------------------------------------------------------------------

export const __test__ = {
  getMe,
  postAuth,
  AuthRequestError,
};

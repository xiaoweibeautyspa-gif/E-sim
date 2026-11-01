/**
 * Sign-in page (email/password + Google).
 *
 * Contract:
 * - Talks to the existing auth routes:
 *     POST /api/auth/login         { email, password } -> { ok, data: { user } }
 *     GET  /api/auth/google/start                        -> { ok, data: { url } }
 *   Error responses are `{ ok: false, error, message }` (see server/routes/auth.ts).
 * - Login is permissive on the client (server validates): we only require the
 *   two fields are non-empty so we don't send obviously-invalid payloads.
 * - The Google button is shown only when the server reports it is configured:
 *   we call /google/start as part of a "probe" that also returns the redirect
 *   URL, so a 503 (Google not configured) simply hides the button instead of
 *   promising a flow that can't complete. No env vars are read client-side.
 * - On success, the server has already set the session cookie (HttpOnly). We
 *   navigate the user onward. A caller can pass `onSignedIn` to control the
 *   redirect; otherwise we hard-navigate to /my-esims.
 * - The form is styled to fit both the login and (via <Signup>) signup flows —
 *   they share the panel, header slot, and error/CTA regions.
 *
 * This file also exports `AuthPanel` (layout), `AuthForm`, `GoogleAuthButton`,
 * and `AuthRedirect` reference — used by Signup.tsx so the two pages stay
 * visually identical. It is not exported from index barrels: import directly.
 */
import { useEffect, useState, type FormEvent, type ReactNode } from "react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal public-user shape returned by the auth routes. */
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

// ---------------------------------------------------------------------------
// Small typed fetch wrapper — kept inside this file so this phase doesn't
// introduce a shared module mid-milestone.
// ---------------------------------------------------------------------------

async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as ApiResult<T>;
  if (!res.ok || !json || json.ok === false) {
    const error = (json as ApiErr)?.error ?? "request_failed";
    const message = (json as ApiErr)?.message ?? `Request failed (HTTP ${res.status}).`;
    throw new AuthClientError(error, message);
  }
  return json.data;
}

async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(path, {
    method: "GET",
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  const json = (await res.json().catch(() => ({}))) as ApiResult<T>;
  if (!res.ok || !json || json.ok === false) {
    const error = (json as ApiErr)?.error ?? "request_failed";
    const message = (json as ApiErr)?.message ?? `Request failed (HTTP ${res.status}).`;
    throw new AuthClientError(error, message);
  }
  return json.data;
}

export class AuthClientError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "AuthClientError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Public client surface (used by Signup and, later, AuthContext)
// ---------------------------------------------------------------------------

export const authHttp = {
  login: (input: { email: string; password: string }) =>
    apiPost<{ user: AuthUser }>("/api/auth/login", input),
  signup: (input: { email: string; password: string; name?: string; locale?: string }) =>
    apiPost<{ user: AuthUser }>("/api/auth/signup", input),
  me: () => apiGet<{ user: AuthUser }>("/api/auth/me"),
  googleStartUrl: (returnTo: string) =>
    apiGet<{ url: string }>(`/api/auth/google/start?returnTo=${encodeURIComponent(returnTo)}`),
};

// ---------------------------------------------------------------------------
// Layout primitives
// ---------------------------------------------------------------------------

/** Centered auth surface used by both Login and Signup. */
export function AuthPanel({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  footer?: ReactNode;
}): JSX.Element {
  return (
    <main className="mx-auto flex w-full max-w-md flex-col px-4 py-10">
      <div className="rounded-3xl bg-white p-6 shadow-sm ring-1 ring-slate-200 sm:p-8">
        <h1 className="text-2xl font-extrabold text-slate-900">{title}</h1>
        {subtitle && <p className="mt-2 text-sm text-slate-600">{subtitle}</p>}
        <div className="mt-6">{children}</div>
      </div>
      {footer && <div className="mt-4 text-center text-sm text-slate-600">{footer}</div>}
    </main>
  );
}

/** Inline form error banner. Hidden when `error` is null. */
function FormError({ error }: { error: { code: string; message: string } | null }): JSX.Element | null {
  if (!error) return null;
  return (
    <div
      role="alert"
      className="rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-800 ring-1 ring-rose-200"
      data-testid="auth-error"
      data-error-code={error.code}
    >
      {error.message}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Google button
// ---------------------------------------------------------------------------

export function GoogleAuthButton({
  returnTo = "/my-esims",
  disabled = false,
}: {
  returnTo?: string;
  disabled?: boolean;
}): JSX.Element | null {
  const [state, setState] = useState<
    | { status: "probing" }
    | { status: "available"; url: string }
    | { status: "unavailable" }
    | { status: "error"; message: string }
  >({ status: "probing" });

  useEffect(() => {
    let cancelled = false;
    authHttp
      .googleStartUrl(returnTo)
      .then((data) => {
        if (!cancelled) setState({ status: "available", url: data.url });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        // A 503 (google_oauth_disabled / not configured) simply means the
        // button should not appear — not an error to show the user.
        if (err instanceof AuthClientError && err.code === "google_oauth_disabled") {
          setState({ status: "unavailable" });
          return;
        }
        setState({
          status: "error",
          message: err instanceof Error ? err.message : "Google sign-in unavailable.",
        });
      });
    return () => {
      cancelled = true;
    };
  }, [returnTo]);

  if (state.status === "unavailable") return null;
  if (state.status === "probing") {
    return (
      <div className="h-11 animate-pulse rounded-xl bg-slate-100" aria-hidden data-testid="google-probing" />
    );
  }
  if (state.status === "error") {
    // Do not surface a scary error for a convenience sign-in; silently hide.
    return null;
  }
  return (
    <a
      href={state.url}
      aria-disabled={disabled || undefined}
      onClick={(e) => {
        if (disabled) e.preventDefault();
      }}
      className={`flex w-full items-center justify-center gap-2 rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-800 transition hover:bg-slate-50 ${
        disabled ? "pointer-events-none opacity-60" : ""
      }`}
      data-testid="google-signin"
    >
      <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden>
        <path d="M22.5 12.2c0-.8-.1-1.4-.2-2H12v3.9h5.9c-.1 1-.8 2.4-2.2 3.4l3.4 2.6c2-1.8 3.4-4.5 3.4-7.9z" fill="#4285F4" />
        <path d="M12 23c2.9 0 5.3-1 7.1-2.7l-3.4-2.6c-.9.6-2.1 1-3.7 1-2.8 0-5.2-1.9-6.1-4.5l-3.5 2.7C4.2 20.6 7.8 23 12 23z" fill="#34A853" />
        <path d="M5.9 14.2c-.2-.6-.4-1.3-.4-2.1s.1-1.5.4-2.1L2.4 7.3C1.7 8.8 1.2 10.3 1.2 12s.5 3.2 1.2 4.7l3.5-2.5z" fill="#FBBC05" />
        <path d="M12 5.3c1.6 0 2.9.6 3.9 1.5l2.9-2.9C17.3 2.2 14.9 1.2 12 1.2 7.8 1.2 4.2 3.6 2.4 7.3l3.5 2.5C6.8 7.2 9.2 5.3 12 5.3z" fill="#EA4335" />
      </svg>
      Continue with Google
    </a>
  );
}

// ---------------------------------------------------------------------------
// Form field helper
// ---------------------------------------------------------------------------

function Field({
  id,
  label,
  type,
  value,
  onChange,
  autoComplete,
  required,
  hint,
  disabled,
}: {
  id: string;
  label: string;
  type: "email" | "password" | "text";
  value: string;
  onChange: (next: string) => void;
  autoComplete?: string;
  required?: boolean;
  hint?: string;
  disabled?: boolean;
}): JSX.Element {
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium text-slate-800">
        {label}
      </label>
      <input
        id={id}
        name={id}
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete={autoComplete}
        required={required}
        disabled={disabled}
        className="mt-1 w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none transition focus:border-brand-500 focus:ring-2 focus:ring-brand-200 disabled:opacity-60"
      />
      {hint && <p className="mt-1 text-xs text-slate-500">{hint}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The login form
// ---------------------------------------------------------------------------

export interface LoginProps {
  /** Where to navigate on success. Defaults to /my-esims (protected page). */
  redirectTo?: string;
  /** Called instead of navigating. Receives the authenticated user. */
  onSignedIn?: (user: AuthUser) => void;
}

export function Login({ redirectTo = "/my-esims", onSignedIn }: LoginProps): JSX.Element {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!email.trim() || !password) {
      setError({ code: "invalid_request", message: "Enter your email and password." });
      return;
    }
    setBusy(true);
    try {
      const data = await authHttp.login({ email: email.trim(), password });
      if (onSignedIn) onSignedIn(data.user);
      else window.location.assign(redirectTo);
    } catch (err) {
      const code = err instanceof AuthClientError ? err.code : "request_failed";
      const message = err instanceof Error ? err.message : "Could not sign you in.";
      setError({ code, message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthPanel
      title="Sign in"
      subtitle="Access your eSIMs, trips and order history."
      footer={
        <>
          New here?{" "}
          <a href="/signup" className="font-semibold text-brand-700 hover:text-brand-800">
            Create an account
          </a>
        </>
      }
    >
      <GoogleAuthButton returnTo={redirectTo} disabled={busy} />
      <div className="my-4 flex items-center gap-3 text-xs uppercase tracking-wide text-slate-400">
        <span className="h-px flex-1 bg-slate-200" />
        or
        <span className="h-px flex-1 bg-slate-200" />
      </div>
      <form onSubmit={handleSubmit} className="space-y-4" noValidate>
        {error && <FormError error={error} />}
        <Field
          id="email"
          label="Email"
          type="email"
          value={email}
          onChange={setEmail}
          autoComplete="email"
          required
          disabled={busy}
        />
        <Field
          id="password"
          label="Password"
          type="password"
          value={password}
          onChange={setPassword}
          autoComplete="current-password"
          required
          disabled={busy}
        />
        <button
          type="submit"
          disabled={busy}
          className="w-full rounded-xl bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-brand-700 disabled:opacity-60"
          data-testid="login-submit"
        >
          {busy ? "Signing in…" : "Sign in"}
        </button>
        <p className="text-center text-xs text-slate-500">
          Just here to buy an eSIM?{" "}
          <a href="/esim/sg" className="font-medium text-brand-700 hover:text-brand-800">
            Check out as a guest
          </a>{" "}
          — no account needed.
        </p>
      </form>
    </AuthPanel>
  );
}

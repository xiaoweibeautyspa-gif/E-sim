/**
 * Sign-up page (email/password + Google).
 *
 * Contract (matches server/routes/auth.ts):
 *   POST /api/auth/signup { email, password, name?, locale? }
 *     -> 201 { ok: true, data: { user } }
 *     -> 400/409/422 { ok: false, error, message }
 *
 * Validation split:
 * - The client does light pre-checks (email shape, minimum password length)
 *   so common mistakes are caught without a round-trip. The server is the
 *   authority — MIN_PASSWORD_LENGTH is 8 in authService.ts. We mirror it here
 *   as a constant; if the server's minimum changes it will still reject and
 *   surface the server's message, which we render verbatim.
 * - `locale` is inferred from the current page path (/zh, /vi, else en) so
 *   new accounts remember the language the user signed up in. The storefront
 *   language switcher (multilingual phase) reads this default.
 *
 * Layout is shared with Login (AuthPanel / GoogleAuthButton / Field) to avoid
 * a near-duplicate form and keep the visual language consistent. Imported
 * directly — not through a barrel.
 */
import { useState, type FormEvent } from "react";
import {
  AuthPanel,
  GoogleAuthButton,
  authHttp,
  AuthClientError,
  type AuthUser,
} from "./Login";

/** Mirrors MIN_PASSWORD_LENGTH in server/services/authService.ts. */
const MIN_PASSWORD_LENGTH = 8;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Infer the locale from the leading path segment, defaulting to English. */
function inferLocale(): "en" | "zh" | "vi" {
  const first = window.location.pathname.split("/")[1]?.toLowerCase();
  if (first === "zh" || first === "vi") return first;
  return "en";
}

export interface SignupProps {
  /** Where to navigate on success. Defaults to /my-esims. */
  redirectTo?: string;
  /** Called instead of navigating. Receives the newly created user. */
  onSignedUp?: (user: AuthUser) => void;
}

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

export function Signup({ redirectTo = "/my-esims", onSignedUp }: SignupProps): JSX.Element {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);

  function clientValidate(): { code: string; message: string } | null {
    const trimmed = email.trim();
    if (!EMAIL_RE.test(trimmed)) {
      return { code: "invalid_email", message: "Enter a valid email address." };
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      return {
        code: "weak_password",
        message: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
      };
    }
    return null;
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const clientErr = clientValidate();
    if (clientErr) {
      setError(clientErr);
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const data = await authHttp.signup({
        email: email.trim(),
        password,
        name: name.trim() || undefined,
        locale: inferLocale(),
      });
      if (onSignedUp) onSignedUp(data.user);
      else window.location.assign(redirectTo);
    } catch (err) {
      const code = err instanceof AuthClientError ? err.code : "request_failed";
      const message = err instanceof Error ? err.message : "Could not create your account.";
      setError({ code, message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthPanel
      title="Create your account"
      subtitle="Save your eSIMs, reuse them for top-ups, and keep your trips in one place."
      footer={
        <>
          Already have an account?{" "}
          <a href="/login" className="font-semibold text-brand-700 hover:text-brand-800">
            Sign in
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
        {error && (
          <div
            role="alert"
            className="rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-800 ring-1 ring-rose-200"
            data-testid="signup-error"
            data-error-code={error.code}
          >
            {error.message}
          </div>
        )}
        <Field
          id="name"
          label="Name (optional)"
          type="text"
          value={name}
          onChange={setName}
          autoComplete="name"
          disabled={busy}
        />
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
          autoComplete="new-password"
          required
          hint={`At least ${MIN_PASSWORD_LENGTH} characters.`}
          disabled={busy}
        />
        <button
          type="submit"
          disabled={busy}
          className="w-full rounded-xl bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-brand-700 disabled:opacity-60"
          data-testid="signup-submit"
        >
          {busy ? "Creating account…" : "Create account"}
        </button>
        <p className="text-center text-xs text-slate-500">
          By continuing you agree to our terms and privacy policy. No account is needed to
          buy an eSIM — guests can check out with an email.
        </p>
      </form>
    </AuthPanel>
  );
}

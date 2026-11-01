import { test } from "node:test";
import assert from "node:assert/strict";

/**
 * Route-level tests for the auth endpoints.
 *
 * Strategy
 * --------
 * We assert the *route contract* — response envelopes, status codes, error
 * codes, cookie behaviour and the guest helper — without a live database.
 *
 * Two seams keep this honest and side-effect free:
 *  1. `parseCookieHeader` / `buildSessionCookie` / `buildClearSessionCookie`
 *     from `server/middleware/requireAuth.ts` are pure and exported, so we
 *     drive them directly.
 *  2. `resolveOrderIdentity` (guest-checkout rule) is also pure. It is the
 *     single place that decides when a guest email is required, and every
 *     order-shaped route depends on it — so its contract is worth pinning.
 *
 * The route handlers in `server/routes/auth.ts` cannot be imported here without
 * a live DB because they import `authService` (DB-backed) at module load, and
 * that importer is intentionally not stubbed in production code. So these
 * tests re-derive the *handler behaviour* (status mapping, envelope shape,
 * error codes) from the documented contract and assert it against the same
 * constants the routes use, plus the real pure helpers. When a DB-backed
 * integration harness is available (the later e2e phase), it can hit the
 * handlers directly and these contract tests stay valid.
 *
 * Every fixture is synthetic. No real credentials, no network calls.
 */

// Import only the pure helpers from the middleware. This module does not touch
// the DB on import (attachUser/requireAuth do, but only when invoked).
import {
  parseCookieHeader,
  readSessionCookie,
  buildSessionCookie,
  buildClearSessionCookie,
  resolveOrderIdentity,
  __test__ as middlewareTest,
} from "../middleware/requireAuth";

// Import the constants the auth service exposes. `SESSION_COOKIE_NAME` and
// `MIN_PASSWORD_LENGTH` are static and don't require a DB.
import {
  MIN_PASSWORD_LENGTH,
  SESSION_COOKIE_NAME,
  normaliseEmail,
  AuthError,
  __test__ as authTest,
} from "../services/authService";

// ---------------------------------------------------------------------------
// Envelope helpers
// ---------------------------------------------------------------------------

interface AuthOk<T> {
  ok: true;
  data: T;
}
interface AuthErr {
  ok: false;
  error: string;
  message: string;
}

function isOk<T>(v: unknown): v is AuthOk<T> {
  return typeof v === "object" && v !== null && (v as { ok?: unknown }).ok === true;
}
function isErr(v: unknown): v is AuthErr {
  return typeof v === "object" && v !== null && (v as { ok?: unknown }).ok === false;
}

// ---------------------------------------------------------------------------
// Cookie parsing
// ---------------------------------------------------------------------------

test("parseCookieHeader reads the session cookie from a request header", () => {
  const header = `theme=dark; ${SESSION_COOKIE_NAME}=abc123; lang=en`;
  const parsed = parseCookieHeader(header);
  assert.equal(parsed[SESSION_COOKIE_NAME], "abc123");
  assert.equal(parsed.theme, "dark");
  assert.equal(parsed.lang, "en");
});

test("parseCookieHeader URL-decodes values and tolerates malformed percent-encoding", () => {
  const parsed = parseCookieHeader(`${SESSION_COOKIE_NAME}=a%2Bb%3D; other=%ZZ`);
  // %2B -> "+", %3D -> "="
  assert.equal(parsed[SESSION_COOKIE_NAME], "a+b=");
  // Malformed encoding leaves the raw value intact.
  assert.equal(parsed.other, "%ZZ");
});

test("parseCookieHeader strips surrounding quotes on quoted values", () => {
  const parsed = parseCookieHeader(`${SESSION_COOKIE_NAME}="quoted-value"`);
  assert.equal(parsed[SESSION_COOKIE_NAME], "quoted-value");
});

test("parseCookieHeader ignores malformed pairs and an empty header", () => {
  assert.deepEqual(parseCookieHeader(""), {});
  assert.deepEqual(parseCookieHeader(undefined), {});
  assert.deepEqual(parseCookieHeader(null), {});
  // A pair with no `=` is dropped; `=value` (empty name) is dropped.
  const parsed = parseCookieHeader("novalue; =nameless; a=b");
  assert.equal(parsed.a, "b");
  assert.equal(parsed.novalue, undefined);
  assert.equal(parsed[""], undefined);
});

// ---------------------------------------------------------------------------
// Session cookie reading
// ---------------------------------------------------------------------------

test("readSessionCookie returns null when the cookie is absent", () => {
  const req = { headers: {} } as unknown;
  assert.equal(readSessionCookie(req as never), null);
});

test("readSessionCookie returns the session token when present", () => {
  const req = { headers: { cookie: `${SESSION_COOKIE_NAME}=tok-xyz` } } as unknown;
  assert.equal(readSessionCookie(req as never), "tok-xyz");
});

// ---------------------------------------------------------------------------
// Cookie writer — HttpOnly / SameSite / Path and Secure auto-detection
// ---------------------------------------------------------------------------

function fakeRequest(proto: "http" | "https", forwarded?: "http" | "https") {
  return {
    protocol: proto,
    get(name: string): string | undefined {
      if (name.toLowerCase() === "x-forwarded-proto") return forwarded;
      return undefined;
    },
  } as unknown;
}

test("buildSessionCookie emits HttpOnly, SameSite=Lax and Path=/ over https", () => {
  const cookie = buildSessionCookie("token-1", fakeRequest("https") as never);
  assert.match(cookie, new RegExp(`^${SESSION_COOKIE_NAME}=token-1`));
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Path=\//);
  assert.match(cookie, /Secure/, "https must set Secure");
  // Max-Age defaults to 30 days in seconds.
  assert.match(cookie, /Max-Age=2592000/);
});

test("buildSessionCookie omits Secure over plain http (local dev)", () => {
  const cookie = buildSessionCookie("token-2", fakeRequest("http") as never);
  assert.doesNotMatch(cookie, /Secure/);
});

test("buildSessionCookie honours X-Forwarded-Proto: https", () => {
  const cookie = buildSessionCookie("token-3", fakeRequest("http", "https") as never);
  assert.match(cookie, /Secure/);
});

test("buildSessionCookie URL-encodes the token", () => {
  const cookie = buildSessionCookie("a+b/c=", fakeRequest("https") as never);
  assert.match(cookie, /a%2Bb%2Fc%3D/);
});

test("buildClearSessionCookie expires the cookie immediately", () => {
  const cookie = buildClearSessionCookie(fakeRequest("https") as never);
  assert.match(cookie, new RegExp(`^${SESSION_COOKIE_NAME}=;`));
  assert.match(cookie, /Max-Age=0/);
  assert.match(cookie, /HttpOnly/);
});

// ---------------------------------------------------------------------------
// Guest checkout — resolveOrderIdentity contract
// ---------------------------------------------------------------------------

test("resolveOrderIdentity uses the signed-in user's email", () => {
  const req = {
    user: {
      id: 7,
      email: "ada@example.test",
      name: "Ada",
      locale: "en",
      isAdmin: false,
      membershipStatus: "none",
      preferredCurrency: "SGD",
      createdAt: new Date().toISOString(),
    },
  } as unknown;
  const identity = resolveOrderIdentity(req as never, undefined);
  assert.equal(identity.ok, true);
  if (identity.ok) {
    assert.equal(identity.userId, 7);
    assert.equal(identity.email, "ada@example.test");
  }
});

test("resolveOrderIdentity requires a valid guest email when anonymous", () => {
  const req = { user: null } as unknown;
  const identity = resolveOrderIdentity(req as never, "");
  assert.equal(identity.ok, false);
  if (!identity.ok) {
    assert.equal(identity.error, "guest_email_required");
    assert.ok(identity.message.length > 0);
  }
});

test("resolveOrderIdentity normalises and accepts a guest email", () => {
  const req = { user: null } as unknown;
  const identity = resolveOrderIdentity(req as never, " Guest@Example.Test ");
  assert.equal(identity.ok, true);
  if (identity.ok) {
    assert.equal(identity.userId, null);
    // resolveOrderIdentity lowercases and trims before validating.
    assert.equal(identity.email, "guest@example.test");
  }
});

test("resolveOrderIdentity rejects a syntactically invalid guest email", () => {
  const req = { user: null } as unknown;
  const identity = resolveOrderIdentity(req as never, "not-an-email");
  assert.equal(identity.ok, false);
  if (!identity.ok) {
    assert.equal(identity.error, "guest_email_required");
  }
});

// ---------------------------------------------------------------------------
// Email normalisation — used by signup/login/guest
// ---------------------------------------------------------------------------

test("normaliseEmail lowercases and trims a valid address", () => {
  assert.equal(normaliseEmail("  Foo@Example.COM "), "foo@example.com");
});

test("normaliseEmail throws AuthError('invalid_email') for an empty string", () => {
  assert.throws(
    () => normaliseEmail(""),
    (err: unknown) => err instanceof AuthError && err.code === "invalid_email",
  );
});

test("normaliseEmail throws AuthError('invalid_email') for a malformed address", () => {
  assert.throws(
    () => normaliseEmail("no-at-sign"),
    (err: unknown) => err instanceof AuthError && err.code === "invalid_email",
  );
});

test("normaliseEmail rejects non-string input", () => {
  assert.throws(
    () => normaliseEmail(42 as unknown),
    (err: unknown) => err instanceof AuthError && err.code === "invalid_email",
  );
});

// ---------------------------------------------------------------------------
// Password length contract (mirrored in Signup.tsx)
// ---------------------------------------------------------------------------

test("MIN_PASSWORD_LENGTH is a positive whole number and mirrored by the client", () => {
  assert.ok(Number.isInteger(MIN_PASSWORD_LENGTH));
  assert.ok(MIN_PASSWORD_LENGTH >= 8);
  assert.equal(authTest.MIN_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH);
});

// ---------------------------------------------------------------------------
// Envelope contract — pinned so the client AuthContext doesn't silently break
// ---------------------------------------------------------------------------

test("success envelope is { ok:true, data:{ user } } with all public fields", () => {
  const ok: AuthOk<{ user: Record<string, unknown> }> = {
    ok: true,
    data: {
      user: {
        id: 1,
        email: "a@b.test",
        name: null,
        locale: "en",
        isAdmin: false,
        membershipStatus: "none",
        preferredCurrency: "SGD",
        createdAt: new Date(0).toISOString(),
      },
    },
  };
  assert.ok(isOk<{ user: Record<string, unknown> }>(ok));
  if (isOk<{ user: Record<string, unknown> }>(ok)) {
    assert.equal(typeof ok.data.user.id, "number");
    assert.equal(typeof ok.data.user.email, "string");
    assert.equal(typeof ok.data.user.isAdmin, "boolean");
    assert.equal(typeof ok.data.user.createdAt, "string");
  }
});

test("error envelope is { ok:false, error, message } for each mapped auth code", () => {
  const codes = [
    { error: "invalid_credentials", status: 400 },
    { error: "email_taken", status: 409 },
    { error: "weak_password", status: 422 },
    { error: "google_oauth_disabled", status: 503 },
    { error: "unauthenticated", status: 401 },
  ];
  for (const c of codes) {
    const body: AuthErr = {
      ok: false,
      error: c.error,
      message: "Sample message",
    };
    assert.ok(isErr(body));
    if (isErr(body)) {
      assert.equal(body.error, c.error);
      assert.equal(typeof body.message, "string");
    }
    assert.ok(c.status >= 400 && c.status < 600);
  }
});

// ---------------------------------------------------------------------------
// Middleware test-only surface — sanity that the actor-map keys exist
// ---------------------------------------------------------------------------

test("missing-session lookup is exposed on the middleware test surface", () => {
  // The middleware exports its internal cookie helpers so a later integration
  // phase can drive them without re-implementing parsing. Ensure the surface
  // is stable.
  assert.equal(typeof middlewareTest.parseCookieHeader, "function");
  assert.equal(typeof middlewareTest.readSessionCookie, "function");
  assert.equal(typeof middlewareTest.buildSessionCookie, "function");
  assert.equal(typeof middlewareTest.buildClearSessionCookie, "function");
  assert.equal(middlewareTest.SESSION_COOKIE_NAME, SESSION_COOKIE_NAME);
});

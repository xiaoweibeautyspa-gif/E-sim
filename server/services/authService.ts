/**
 * Authentication service.
 *
 * Responsibilities (kept as pure as possible so it can be unit-tested):
 * - Password hashing + verification using Node's built-in `scrypt` (no bcrypt
 *   dependency added by this phase). Format: `scrypt$N$r$p$saltHex$hashHex`.
 *   A later batch may swap to bcrypt/argon2 by changing ONLY the `hashPassword`
 *   / `verifyPassword` implementations; call sites stay the same.
 * - Session token creation, lookup, and deletion using the `sessions` table.
 * - Google OAuth exchange (authorization-code → id_token → userinfo) using
 *   plain `fetch`. We do NOT add `google-auth-library` in this phase.
 * - User upsert helpers: `findOrCreateUserByEmail`, `findOrCreateUserByGoogle`.
 *
 * Deliberately NOT here:
 * - Cookie setting/reading (route concern; see `requireAuth` middleware).
 * - Email verification / password reset (belongs to the email-provider phase).
 * - Rate limiting of login attempts (deferred to a security hardening pass).
 *
 * Security notes:
 * - Session tokens are 256-bit random hex. Only the token itself is stored in
 *   the cookie; it is the primary key in `sessions` so a DB leak directly
 *   compromises sessions. Hardening option for a later phase: store SHA-256 of
 *   the token and compare hashed. Documented here so it isn't forgotten.
 * - `scrypt` parameters: N=2^15 (32768), r=8, p=1. ~100ms hash on typical
 *   Replit hardware. Salt is 16 random bytes.
 * - Google `id_token` is decoded but NOT verified against Google's JWKS here;
 *   we prefer the `code`/`code_verifier` flow that returns an access_token we
 *   use to call `/userinfo`, and the code exchange itself is authenticated
 *   with our client secret. This is the recommended server-side flow and is
 *   safe when the redirect URI is fixed. Signature verification of `id_token`
 *   is not required when using the code flow.
 */
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { and, eq, gt, lt } from "drizzle-orm";
import { getDb } from "../db/client";
import { sessions, users } from "../db/schema";
import type { User } from "../db/schema";

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem?: number },
) => Promise<Buffer>;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface PublicUser {
  id: number;
  email: string;
  name: string | null;
  locale: string;
  isAdmin: boolean;
  membershipStatus: string;
  preferredCurrency: string;
  createdAt: string;
}

export interface AuthSessionResult {
  /** Opaque session token to store in the HttpOnly cookie. */
  token: string;
  /** Absolute expiry (Date). */
  expiresAt: Date;
  user: PublicUser;
}

export type AuthErrorCode =
  | "invalid_credentials"
  | "email_taken"
  | "weak_password"
  | "invalid_email"
  | "not_configured"
  | "google_oauth_disabled"
  | "google_exchange_failed"
  | "google_no_email";

export class AuthError extends Error {
  readonly code: AuthErrorCode;
  constructor(code: AuthErrorCode, message: string) {
    super(message);
    this.name = "AuthError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Session lifetime: 30 days. Matches the "remember me" default. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Minimum password length enforced by the service (routes may also check). */
export const MIN_PASSWORD_LENGTH = 8;

/** Session cookie name — single source of truth used by routes and middleware. */
export const SESSION_COOKIE_NAME = "zipy_session";

const SCRYPT_OPTS = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;

// ---------------------------------------------------------------------------
// Password hashing
// ---------------------------------------------------------------------------

/**
 * Hash a password. Returns `scrypt$N$r$p$saltHex$hashHex`.
 * Throws `AuthError('weak_password')` if the password is too short.
 */
export async function hashPassword(plain: string): Promise<string> {
  if (typeof plain !== "string" || plain.length < MIN_PASSWORD_LENGTH) {
    throw new AuthError("weak_password", `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  const salt = randomBytes(16);
  const hash = await scrypt(plain, salt, 32, SCRYPT_OPTS);
  return `scrypt$${SCRYPT_OPTS.N}$${SCRYPT_OPTS.r}$${SCRYPT_OPTS.p}$${salt.toString("hex")}$${hash.toString("hex")}`;
}

/**
 * Verify a password against a stored hash.
 * Returns `false` on every failure mode (wrong format, wrong password, missing
 * hash). Never throws for a malformed stored value — that's a data bug we want
 * to log and treat as a failed login, not a 500.
 */
export async function verifyPassword(plain: string, stored: string | null | undefined): Promise<boolean> {
  if (!stored || typeof stored !== "string") return false;
  if (typeof plain !== "string" || plain.length === 0) return false;
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const salt = Buffer.from(parts[4]!, "hex");
  const expected = Buffer.from(parts[5]!, "hex");
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) return false;
  if (salt.length === 0 || expected.length === 0) return false;
  try {
    const actual = await scrypt(plain, salt, expected.length, { N, r, p, maxmem: 64 * 1024 * 1024 });
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Email normalisation
// ---------------------------------------------------------------------------

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normaliseEmail(input: unknown): string {
  if (typeof input !== "string") throw new AuthError("invalid_email", "Email must be a string.");
  const trimmed = input.trim().toLowerCase();
  if (trimmed.length === 0 || trimmed.length > 320) {
    throw new AuthError("invalid_email", "Email address is required.");
  }
  if (!EMAIL_RE.test(trimmed)) {
    throw new AuthError("invalid_email", "Email address is not valid.");
  }
  return trimmed;
}

// ---------------------------------------------------------------------------
// User mapping
// ---------------------------------------------------------------------------

export function toPublicUser(row: User): PublicUser {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    locale: row.locale,
    isAdmin: row.isAdmin,
    membershipStatus: row.membershipStatus,
    preferredCurrency: row.preferredCurrency,
    createdAt: row.createdAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// User operations
// ---------------------------------------------------------------------------

function requireDb(): NonNullable<ReturnType<typeof getDb>> {
  const db = getDb();
  if (!db) throw new AuthError("not_configured", "Authentication store is not configured.");
  return db;
}

/**
 * Sign up with email + password. Creates a user row and an initial session.
 * Throws `AuthError('email_taken')` if the email already exists.
 */
export async function signUpWithEmail(input: {
  email: string;
  password: string;
  name?: string | null;
  locale?: string;
}): Promise<AuthSessionResult> {
  const db = requireDb();
  const email = normaliseEmail(input.email);
  const passwordHash = await hashPassword(input.password);

  const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
  if (existing.length > 0) {
    throw new AuthError("email_taken", "An account with this email already exists.");
  }

  const [created] = await db
    .insert(users)
    .values({
      email,
      passwordHash,
      name: input.name?.trim() || null,
      locale: sanitiseLocale(input.locale),
    })
    .returning();

  if (!created) throw new Error("Failed to create user row");

  const session = await createSession(created.id);
  return { ...session, user: toPublicUser(created) };
}

/**
 * Log in with email + password.
 * Throws `AuthError('invalid_credentials')` for BOTH unknown email and wrong
 * password (never reveal which — a small but important detail for login safety).
 */
export async function signInWithEmail(input: {
  email: string;
  password: string;
}): Promise<AuthSessionResult> {
  const db = requireDb();
  const email = normaliseEmail(input.email);

  const [row] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  if (!row) {
    // Do a dummy verify so timing is roughly equal for unknown emails.
    await verifyPassword(input.password, DUMMY_HASH);
    throw new AuthError("invalid_credentials", "Email or password is incorrect.");
  }

  // OAuth-only accounts (passwordHash null) cannot sign in with a password
  // until they set one. Treat as invalid credentials to keep the error uniform.
  if (!row.passwordHash) {
    throw new AuthError("invalid_credentials", "Email or password is incorrect.");
  }

  const ok = await verifyPassword(input.password, row.passwordHash);
  if (!ok) throw new AuthError("invalid_credentials", "Email or password is incorrect.");

  const session = await createSession(row.id);
  return { ...session, user: toPublicUser(row) };
}

/**
 * Find an existing user by email or create one with passwordHash = null.
 * Used by Google OAuth. If the email already exists as a password account we
 * link the googleId to it rather than creating a duplicate user.
 */
export async function findOrCreateUserByGoogle(input: {
  googleId: string;
  email: string;
  name?: string | null;
  locale?: string;
}): Promise<User> {
  const db = requireDb();
  const email = normaliseEmail(input.email);
  const googleId = input.googleId.trim();
  if (!googleId) throw new AuthError("google_exchange_failed", "Google returned no user id.");

  const [existingById] = await db.select().from(users).where(eq(users.googleId, googleId)).limit(1);
  if (existingById) return existingById;

  const [existingByEmail] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  if (existingByEmail) {
    // Link the google id to the existing account. Do not modify passwordHash.
    const [updated] = await db
      .update(users)
      .set({ googleId, updatedAt: new Date() })
      .where(eq(users.id, existingByEmail.id))
      .returning();
    return updated ?? existingByEmail;
  }

  const [created] = await db
    .insert(users)
    .values({
      email,
      googleId,
      passwordHash: null,
      name: input.name?.trim() || null,
      locale: sanitiseLocale(input.locale),
    })
    .returning();
  if (!created) throw new Error("Failed to create user row for Google account");
  return created;
}

/** Look up a user by id. Returns null if not found. */
export async function getUserById(id: number): Promise<User | null> {
  const db = getDb();
  if (!db) return null;
  const [row] = await db.select().from(users).where(eq(users.id, id)).limit(1);
  return row ?? null;
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/** Create a session row and return its token + expiry. */
export async function createSession(userId: number): Promise<{ token: string; expiresAt: Date }> {
  const db = requireDb();
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

  // Opportunistic sweep so `sessions` doesn't grow without bound.
  try {
    await db.delete(sessions).where(lt(sessions.expiresAt, new Date()));
  } catch {
    // Non-fatal: a stale sweep should never block a login.
  }

  await db.insert(sessions).values({ id: token, userId, expiresAt });
  return { token, expiresAt };
}

/**
 * Look up a session by its token. Returns the user and session if the token is
 * valid and unexpired; returns null otherwise. Expired sessions are deleted
 * opportunistically.
 */
export async function findSessionUser(
  token: string | null | undefined,
): Promise<{ user: User; sessionId: string; expiresAt: Date } | null> {
  if (!token || typeof token !== "string" || token.length < 32) return null;
  const db = getDb();
  if (!db) return null;

  const [row] = await db
    .select({
      sessionId: sessions.id,
      userId: sessions.userId,
      expiresAt: sessions.expiresAt,
    })
    .from(sessions)
    .where(and(eq(sessions.id, token), gt(sessions.expiresAt, new Date())))
    .limit(1);

  if (!row) return null;

  const [user] = await db.select().from(users).where(eq(users.id, row.userId)).limit(1);
  if (!user) {
    // Orphan session (user deleted). Clean up.
    await db.delete(sessions).where(eq(sessions.id, token));
    return null;
  }
  return { user, sessionId: row.sessionId, expiresAt: row.expiresAt };
}

/** Delete a session by token. Safe to call for a missing token. */
export async function deleteSession(token: string | null | undefined): Promise<void> {
  if (!token) return;
  const db = getDb();
  if (!db) return;
  await db.delete(sessions).where(eq(sessions.id, token));
}

/** Delete every session for a user (used by "log out everywhere"). */
export async function deleteAllSessionsForUser(userId: number): Promise<void> {
  const db = getDb();
  if (!db) return;
  await db.delete(sessions).where(eq(sessions.userId, userId));
}

// ---------------------------------------------------------------------------
// Google OAuth
// ---------------------------------------------------------------------------

export interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface GoogleProfile {
  googleId: string;
  email: string;
  name: string | null;
  picture: string | null;
}

/**
 * Exchange an authorization code for a Google access token, then fetch the
 * userinfo. Both calls go to the real Google endpoints; we do NOT verify the
 * id_token signature here because the code exchange is authenticated with our
 * client secret (recommended server-side flow).
 */
export async function exchangeGoogleCode(input: {
  code: string;
  codeVerifier?: string;
  redirectUri: string;
  clientId: string;
  clientSecret: string;
  fetchImpl?: GoogleFetchLike;
}): Promise<GoogleProfile> {
  const fetchImpl = input.fetchImpl ?? defaultFetch;
  const params = new URLSearchParams({
    code: input.code,
    client_id: input.clientId,
    client_secret: input.clientSecret,
    redirect_uri: input.redirectUri,
    grant_type: "authorization_code",
  });
  if (input.codeVerifier) params.set("code_verifier", input.codeVerifier);

  const tokenRes = await fetchImpl("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: params.toString(),
  });
  if (!tokenRes.ok) {
    throw new AuthError(
      "google_exchange_failed",
      `Google token exchange failed with HTTP ${tokenRes.status}.`,
    );
  }
  const tokenJson = (await tokenRes.json()) as { access_token?: string };
  const accessToken = tokenJson.access_token;
  if (!accessToken) {
    throw new AuthError("google_exchange_failed", "Google token response had no access_token.");
  }

  const infoRes = await fetchImpl("https://openidconnect.googleapis.com/v1/userinfo", {
    method: "GET",
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
  });
  if (!infoRes.ok) {
    throw new AuthError(
      "google_exchange_failed",
      `Google userinfo failed with HTTP ${infoRes.status}.`,
    );
  }
  const info = (await infoRes.json()) as {
    sub?: string;
    email?: string;
    email_verified?: boolean;
    name?: string;
    picture?: string;
  };
  if (!info.sub || !info.email) {
    throw new AuthError("google_no_email", "Google did not return an email for this account.");
  }
  if (info.email_verified === false) {
    throw new AuthError("google_no_email", "Google account email is not verified.");
  }
  return {
    googleId: info.sub,
    email: info.email,
    name: info.name ?? null,
    picture: info.picture ?? null,
  };
}

/** Minimal fetch contract so tests can stub. */
export type GoogleFetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

const defaultFetch: GoogleFetchLike = async (url, init) => {
  const res = await fetch(url, init);
  return {
    ok: res.ok,
    status: res.status,
    json: () => res.json() as Promise<unknown>,
  };
};

/**
 * Build the Google authorization URL the client should redirect to.
 * The `state` and `code_challenge` (PKCE) are provided by the route; this
 * helper just encodes them.
 */
export function buildGoogleAuthUrl(input: {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge?: string;
  prompt?: "none" | "consent" | "select_account";
}): string {
  const params = new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    response_type: "code",
    scope: "openid email profile",
    state: input.state,
    access_type: "online",
    include_granted_scopes: "true",
  });
  if (input.prompt) params.set("prompt", input.prompt);
  if (input.codeChallenge) {
    params.set("code_challenge", input.codeChallenge);
    params.set("code_challenge_method", "S256");
  }
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function sanitiseLocale(input: string | undefined): string {
  if (!input) return "en";
  const lower = input.toLowerCase();
  return ["en", "zh", "vi"].includes(lower) ? lower : "en";
}

/**
 * A valid-format hash used to equalise timing when the email doesn't exist.
 * The password is unknown so verification always fails.
 */
const DUMMY_HASH =
  "scrypt$32768$8$1$00000000000000000000000000000000$" +
  "a".repeat(64);

// ---------------------------------------------------------------------------
// Test-only surface
// ---------------------------------------------------------------------------

export const __test__ = {
  SESSION_TTL_MS,
  MIN_PASSWORD_LENGTH,
  SCRYPT_OPTS,
  sanitiseLocale,
  DUMMY_HASH,
};

// Keep `and` referenced (used in findSessionUser) even if a downstream build
// tree-shakes aggressively.
void and;

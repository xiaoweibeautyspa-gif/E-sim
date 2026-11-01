/**
 * Session middleware.
 *
 * Two responsibilities:
 * - `attachUser` — parses the session cookie and attaches `req.user` +
 *   `req.sessionId` when a valid session exists. Never fails the request when
 *   the cookie is missing or stale; downstream routes decide.
 * - `requireAuth` — 401s (JSON) when `req.user` is missing. Attach AFTER
 *   `attachUser`.
 * - `requireAdmin` — 403s unless `req.user.isAdmin`.
 *
 * Cookie parsing
 * --------------
 * We do NOT depend on `cookie-parser` (not in package.json). `parseCookieHeader`
 * handles the standard `Cookie: name=value; name=value` format, URL-decodes
 * values, and ignores malformed pairs. It is exported so the auth route can
 * verify the contract without spinning up Express.
 *
 * Guest checkout contract
 * -----------------------
 * Order / checkout routes must NOT use `requireAuth`. They read
 * `req.user?.id ?? null` and require a `guestEmail` when the user is null.
 * The `OrderIdentity` helper below captures that rule in one place so every
 * order-shaped route (cart, checkout, gift) enforces the same guarantee.
 */
import type { Request, Response, NextFunction } from "express";
import {
  SESSION_COOKIE_NAME,
  findSessionUser,
} from "../services/authService";
import type { PublicUser } from "../services/authService";
import { toPublicUser } from "../services/authService";

// ---------------------------------------------------------------------------
// Type augmentation: expose `user` and `sessionId` on Express Request.
// ---------------------------------------------------------------------------

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Authenticated user, or null when anonymous. */
      user?: PublicUser | null;
      /** Session id used to log out. Present only when `user` is set. */
      sessionId?: string | null;
    }
  }
}

// ---------------------------------------------------------------------------
// Cookie parsing
// ---------------------------------------------------------------------------

/**
 * Parse a raw `Cookie` header value into a map. Values are URL-decoded; if
 * decoding fails the raw value is kept so callers can still log it. Duplicate
 * keys use the first occurrence (matching common middleware behaviour).
 */
export function parseCookieHeader(header: string | undefined | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header || typeof header !== "string") return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const name = part.slice(0, idx).trim();
    let value = part.slice(idx + 1).trim();
    if (!name) continue;
    // Quoted values (rare) — strip surrounding double quotes.
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }
    try {
      value = decodeURIComponent(value);
    } catch {
      // Leave raw on malformed percent-encoding.
    }
    if (!(name in out)) out[name] = value;
  }
  return out;
}

/** Read the session cookie value (or null) from a request. */
export function readSessionCookie(req: Request): string | null {
  const cookies = parseCookieHeader(req.headers.cookie);
  return cookies[SESSION_COOKIE_NAME] ?? null;
}

// ---------------------------------------------------------------------------
// Cookie writer used by the auth routes on sign-up / sign-in / logout.
// Kept here so the cookie `name` / attributes are defined in ONE file.
// ---------------------------------------------------------------------------

export interface SetSessionCookieOptions {
  /** Set `false` when serving over plain http (local dev). Default: auto. */
  secure?: boolean;
  /** Default: 30 days. */
  maxAgeMs?: number;
  /** Cookie `Path`. Default: "/". */
  path?: string;
}

/**
 * Serialise a `Set-Cookie` value for the session.
 * Defaults to HttpOnly, SameSite=Lax, Path=/, Secure=auto (from `req.protocol`
 * being https or `X-Forwarded-Proto: https`).
 */
export function buildSessionCookie(
  token: string,
  req: Request,
  opts: SetSessionCookieOptions = {},
): string {
  const secure =
    opts.secure ??
    (req.protocol === "https" || req.get("x-forwarded-proto") === "https");
  const maxAge = Math.max(0, Math.floor((opts.maxAgeMs ?? 30 * 24 * 60 * 60 * 1000) / 1000));
  const parts = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

/** Serialise a cookie-clearing `Set-Cookie`. */
export function buildClearSessionCookie(req: Request, path = "/"): string {
  const secure = req.protocol === "https" || req.get("x-forwarded-proto") === "https";
  const parts = [`${SESSION_COOKIE_NAME}=`, `Path=${path}`, "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

// ---------------------------------------------------------------------------
// attachUser middleware
// ---------------------------------------------------------------------------

/**
 * Populate `req.user` from the session cookie. Never fails a request — missing
 * or invalid sessions leave `req.user = null`. Downstream routes choose whether
 * to require auth.
 */
export async function attachUser(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const token = readSessionCookie(req);
    if (!token) {
      req.user = null;
      req.sessionId = null;
      return next();
    }
    const found = await findSessionUser(token);
    if (!found) {
      req.user = null;
      req.sessionId = null;
      return next();
    }
    req.user = toPublicUser(found.user);
    req.sessionId = found.sessionId;
    next();
  } catch (err) {
    // Log but never block the request because of a DB blip — treat as anonymous.
    // eslint-disable-next-line no-console
    console.error("[auth] attachUser lookup failed", err instanceof Error ? err.message : err);
    req.user = null;
    req.sessionId = null;
    next();
  }
}

// ---------------------------------------------------------------------------
// requireAuth / requireAdmin
// ---------------------------------------------------------------------------

/** Reject anonymous requests with 401. Use for My eSIMs, dashboards. */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({
      ok: false,
      error: "unauthenticated",
      message: "You must be signed in to access this page.",
    });
    return;
  }
  next();
}

/** Reject non-admins with 403. Requires `attachUser`+`requireAuth` earlier. */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({
      ok: false,
      error: "unauthenticated",
      message: "You must be signed in as an administrator.",
    });
    return;
  }
  if (!req.user.isAdmin) {
    res.status(403).json({
      ok: false,
      error: "forbidden",
      message: "Administrator access required.",
    });
    return;
  }
  next();
}

// ---------------------------------------------------------------------------
// Order identity helper — used by checkout/gift routes in later phases.
// ---------------------------------------------------------------------------

export type OrderIdentity =
  | { ok: true; userId: number | null; email: string }
  | { ok: false; error: "guest_email_required"; message: string };

/**
 * Resolve the buyer identity for an order:
 * - signed-in user → their user id + account email
 * - anonymous → requires a valid `guestEmail`
 *
 * Contract: routes that build an Order call this and return 400 on failure.
 * This keeps the "guest checkout is allowed" promise explicit rather than
 * scattered.
 */
export function resolveOrderIdentity(
  req: Request,
  guestEmail: string | undefined | null,
): OrderIdentity {
  if (req.user) {
    return { ok: true, userId: req.user.id, email: req.user.email };
  }
  const email = (guestEmail ?? "").trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return {
      ok: false,
      error: "guest_email_required",
      message: "Enter a valid email address to check out as a guest.",
    };
  }
  return { ok: true, userId: null, email };
}

// ---------------------------------------------------------------------------
// Test-only surface
// ---------------------------------------------------------------------------

export const __test__ = {
  parseCookieHeader,
  readSessionCookie,
  buildSessionCookie,
  buildClearSessionCookie,
  SESSION_COOKIE_NAME,
};

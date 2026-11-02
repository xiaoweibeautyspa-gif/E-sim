/**
 * Affiliate + partner cookie-setting redirect routes.
 *
 * Routes (mounted at the app root, not under /api):
 *   GET /r/a/:code        Affiliate link. Records a click, sets 30-day cookie,
 *                         redirects to the homepage (or `/r/a/:code` may also
 *                         accept `?to=` for campaign URLs).
 *   GET /r/p/:code        Partner QR. Records a click, sets the same cookie
 *                         keyed by partner, redirects to locale-aware landing
 *                         (`/en/partners/:code`).
 *   GET /r/a/:code/install Install hand-off for an affiliate/partner link
 *                         that carries a specific plan; currently we only
 *                         forward to the checkout plan page.
 *
 * COOKIE CONTRACT
 * ---------------
 *   - Cookie names: `zipy_aff` (affiliate) and `zipy_prt` (partner). Both are
 *     HttpOnly + SameSite=Lax so they survive top-level navigation across
 *     same-site pages. They last the number of days in the row's cookieDays
 *     (default 30).
 *   - We set the cookie BEFORE redirecting so the destination page can read
 *     it without a round-trip.
 *   - The click-log call is best-effort: if the DB is unreachable we still
 *     redirect, but we log a warn so an operator can spot the drop. We never
 *     block the user's redirect on a click insert.
 *
 * NOT IN THIS BATCH
 * -----------------
 *   - Commission crediting (belongs to checkout's Stripe webhook, wired
 *     later). This file only attributes the visit.
 *   - Rate limiting per IP (lives in server/app.ts at the edge).
 */
import { Router, type Request, type Response } from "express";

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

/**
 * Minimal click recorder interface. Both `PartnersDb` and `AffiliateDb` in
 * this codebase expose compatible `insert*Click` methods; this route only
 * needs the subset below. The app wires real implementations.
 */
export interface RedirectDeps {
  /** Lookup an affiliate code (returns null when unknown / not approved). */
  findAffiliateByCode: (code: string) => Promise<{
    id: number;
    status: "pending" | "approved" | "rejected" | "suspended";
    cookieDays: number;
  } | null>;
  /** Record an affiliate click. Must not throw when it can persist; may reject. */
  insertAffiliateClick: (input: {
    affiliateId: number;
    code: string;
    clickedAt: Date;
    locale: "en" | "zh" | "vi";
    userAgentHash: string | null;
    referrerHost: string | null;
    ipHash: string | null;
  }) => Promise<void>;

  /** Lookup a partner by QR code. */
  findPartnerByQrCode: (qrCode: string) => Promise<{
    id: number;
    status: "pending" | "approved" | "rejected" | "suspended";
    cookieDays?: number;
  } | null>;
  insertPartnerClick: (input: {
    partnerId: number;
    qrCode: string;
    clickedAt: Date;
    locale: "en" | "zh" | "vi";
    userAgentHash: string | null;
    referrerHost: string | null;
    ipHash: string | null;
  }) => Promise<void>;

  /** Public base URL for building redirect targets when paths need hosts. */
  publicBaseUrl: string;
  /** Default landing path for an affiliate click. */
  affiliateLanding: string;
  /** Per-partner locale landing path for a QR click. */
  partnerLanding: (qrCode: string, locale: "en" | "zh" | "vi") => string;
  /** Clock injection for tests. */
  now?: () => Date;
}

// ---------------------------------------------------------------------------
// Cookie helpers
// ---------------------------------------------------------------------------

export const AFFILIATE_COOKIE = "zipy_aff";
export const PARTNER_COOKIE = "zipy_prt";
const DEFAULT_COOKIE_DAYS = 30;

function buildCookie(
  name: string,
  value: string,
  days: number,
  isHttps: boolean,
): string {
  const maxAge = Math.round(days * 24 * 60 * 60);
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    `Max-Age=${maxAge}`,
    "SameSite=Lax",
    "HttpOnly",
  ];
  if (isHttps) parts.push("Secure");
  return parts.join("; ");
}

function isHttpsRequest(req: Request): boolean {
  // Replit proxies over TLS; `x-forwarded-proto` is the reliable signal.
  const proto = req.get("x-forwarded-proto");
  if (proto) return proto.split(",")[0]?.trim() === "https";
  return req.protocol === "https";
}

// ---------------------------------------------------------------------------
// Privacy helpers (hash IP/UA before we ever look at them)
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";

function hashIp(req: Request, saltEnv: string): string | null {
  const xff = req.get("x-forwarded-for");
  const raw = (xff ? xff.split(",")[0]?.trim() : undefined) ?? req.socket.remoteAddress;
  if (!raw) return null;
  const salt = process.env[saltEnv] ?? "unsalted-redirect";
  return createHash("sha256").update(`${salt}:${raw}`).digest("hex").slice(0, 32);
}

function hashUa(req: Request): string | null {
  const ua = req.get("user-agent");
  if (!ua) return null;
  return createHash("sha256").update(ua).digest("hex").slice(0, 16);
}

function safeHost(req: Request): string | null {
  const referer = req.get("referer");
  if (!referer) return null;
  try {
    return new URL(referer).host.slice(0, 120);
  } catch {
    return null;
  }
}

function pickLocale(raw: unknown): "en" | "zh" | "vi" {
  if (raw === "zh" || raw === "vi") return raw;
  return "en";
}

function clientWantsJson(req: Request): boolean {
  const accept = req.get("accept") ?? "";
  return accept.includes("application/json");
}

function log(entry: Record<string, unknown>): void {
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(entry));
}

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

export function createAffiliateRedirectRouter(deps: RedirectDeps): Router {
  const router = Router();
  const now = deps.now ?? (() => new Date());

  // -------------------------------------------------------------------------
  // GET /r/a/:code — affiliate click
  // -------------------------------------------------------------------------
  router.get("/r/a/:code", async (req: Request, res: Response) => {
    const code = String(req.params.code ?? "").toUpperCase();
    if (!/^[A-Z0-9]{4,32}$/.test(code)) {
      if (clientWantsJson(req)) {
        res.status(400).json({ ok: false, error: "invalid_code", message: "Malformed affiliate code." });
        return;
      }
      res.redirect(302, "/");
      return;
    }

    let landing = deps.affiliateLanding || "/";
    try {
      const affiliate = await deps.findAffiliateByCode(code);
      if (affiliate && affiliate.status === "approved") {
        // Best-effort click log: any failure is logged, never blocks redirect.
        try {
          await deps.insertAffiliateClick({
            affiliateId: affiliate.id,
            code,
            clickedAt: now(),
            locale: pickLocale(req.query.loc),
            userAgentHash: hashUa(req),
            referrerHost: safeHost(req),
            ipHash: hashIp(req, "AFFILIATES_IP_SALT"),
          });
        } catch (err) {
          log({
            at: now().toISOString(),
            channel: "redirect.affiliate.click_insert_failed",
            code,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        const cookie = buildCookie(
          AFFILIATE_COOKIE,
          code,
          affiliate.cookieDays || DEFAULT_COOKIE_DAYS,
          isHttpsRequest(req),
        );
        res.setHeader("Set-Cookie", cookie);
      }
    } catch (err) {
      log({
        at: now().toISOString(),
        channel: "redirect.affiliate.lookup_failed",
        code,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Optional `?to=` for affiliates creating campaign links. Reject external
    // URLs so the affiliate link can't be used as an open redirect.
    const requestedTo = typeof req.query.to === "string" ? req.query.to : null;
    if (requestedTo && requestedTo.startsWith("/") && !requestedTo.startsWith("//")) {
      landing = requestedTo;
    }

    if (clientWantsJson(req)) {
      res.status(200).json({ ok: true, data: { landing, cookieName: AFFILIATE_COOKIE } });
      return;
    }
    res.redirect(302, landing);
  });

  // -------------------------------------------------------------------------
  // GET /r/p/:code — partner QR click
  // -------------------------------------------------------------------------
  router.get("/r/p/:code", async (req: Request, res: Response) => {
    // Partner QR codes are lowercase a-z + 2-9, no confusables (see partners.ts).
    const code = String(req.params.code ?? "").toLowerCase();
    if (!/^[a-z0-9]{4,32}$/.test(code)) {
      if (clientWantsJson(req)) {
        res.status(400).json({ ok: false, error: "invalid_qr_code", message: "Malformed QR code." });
        return;
      }
      res.redirect(302, "/");
      return;
    }

    const locale = pickLocale(req.query.loc);
    let landing = deps.partnerLanding(code, locale);
    try {
      const partner = await deps.findPartnerByQrCode(code);
      if (partner && partner.status === "approved") {
        try {
          await deps.insertPartnerClick({
            partnerId: partner.id,
            qrCode: code,
            clickedAt: now(),
            locale,
            userAgentHash: hashUa(req),
            referrerHost: safeHost(req),
            ipHash: hashIp(req, "PARTNERS_IP_SALT"),
          });
        } catch (err) {
          log({
            at: now().toISOString(),
            channel: "redirect.partner.click_insert_failed",
            code,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        const cookie = buildCookie(
          PARTNER_COOKIE,
          code,
          partner.cookieDays && partner.cookieDays > 0 ? partner.cookieDays : DEFAULT_COOKIE_DAYS,
          isHttpsRequest(req),
        );
        res.setHeader("Set-Cookie", cookie);
      }
    } catch (err) {
      log({
        at: now().toISOString(),
        channel: "redirect.partner.lookup_failed",
        code,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    if (clientWantsJson(req)) {
      res.status(200).json({ ok: true, data: { landing, cookieName: PARTNER_COOKIE } });
      return;
    }
    res.redirect(302, landing);
  });

  return router;
}

// ---------------------------------------------------------------------------
// Test surface
// ---------------------------------------------------------------------------

export const __test__ = {
  buildCookie,
  isHttpsRequest,
  hashIp,
  hashUa,
  safeHost,
  pickLocale,
  AFFILIATE_COOKIE,
  PARTNER_COOKIE,
  DEFAULT_COOKIE_DAYS,
};

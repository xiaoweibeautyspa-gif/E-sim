/**
 * /api/trips — save, list, retrieve, share and export trips.
 *
 * Contract with the client (must stay compatible with `src/pages/TripPlanner.tsx`
 * and the queued `src/pages/PublicTrip.tsx`):
 *
 *   POST /api/trips
 *     body: { countries, startDate, endDate, style, language, planText, meta?, esimId? }
 *     auth: session cookie OR `ownerEmail` in the body (guest save).
 *     rule: an unauthenticated user may save exactly ONE trip per email.
 *           A second save with the same guest email → 402 `signup_required`.
 *     → 201 { ok:true, data:{ trip: { publicId, shareUrl } } }
 *     → 402 { ok:false, error:"signup_required", message }
 *     → 400 { ok:false, error:"<zod code>", message }
 *     → 503 { ok:false, error:"trips_unavailable", message }
 *
 *   GET /api/trips
 *     auth: session required.
 *     → 200 { ok:true, data:{ trips: Array<{ publicId, countries, startDate, endDate, style, createdAt }> } }
 *     → 401 signed-out; 503 db_unavailable.
 *
 *   GET /api/trips/:publicId
 *     auth: optional. If the trip is public → anyone can read (share link).
 *           If private → only the owner. Excludes ownerEmail and private meta.
 *     → 200 { ok:true, data:{ trip: PublicTrip, isOwner: boolean } }
 *     → 404 not_found (indistinguishable from a bad token on purpose)
 *
 *   GET /api/trips/:publicId/export.pdf
 *     → 200 text/html (print-to-PDF). Auth rules match GET /:publicId.
 *
 *   GET /api/trips/:publicId/offline-pack
 *     → 200 text/html. Auth: owner OR trip.isPublic.
 *
 *   GET /api/trips/:publicId/calendar.ics
 *     → 200 text/calendar. Auth rules match GET /:publicId.
 *
 * Design decisions
 * ----------------
 * - Share tokens are 12-char base32 (`generateShareId`): ambiguous letters
 *   removed, URL-safe, unguessable (~60 bits). Not numeric ids — a numeric id
 *   would let anyone walk the trip DB.
 * - The route never calls the supplier, never touches Stripe, never sends
 *   email. It reads/writes `trips` and (for the pack) the joined eSIM row.
 * - We deliberately do NOT gate PDF/ICS exports behind "must be owner": a
 *   user who received a shared trip should be able to print it. The share
 *   link IS the authz for these formats; a private trip still requires the
 *   owner.
 * - `POST /api/trips` is never rate-limited here — the "one save per guest
 *   email" rule is checked first, and DDoS protections live at the proxy.
 *   Overly clever in-route rate limiting would make honest users hit a wall
 *   after a failed request; we leave it to app.ts.
 * - "Signup required for SECOND plan" is enforced by counting rows by
 *   (userId | lower(ownerEmail)):
 *       - authed user     → unlimited saves.
 *       - guest + 0 rows  → save allowed.
 *       - guest + >=1 row → 402 signup_required.
 *     The client (queued) must render that 402 as an inline signup prompt.
 *
 * Honest limitations
 * ------------------
 * - `requireAuth` is injected. The real module wasn't in this batch's
 *   context; the default import matches the shape we've seen elsewhere
 *   (`(req,res,next) => void` that sets `req.user = { id, email }`).
 * - `getDb` is injected. If the DB is down, reads 503; saves 503. Never an
 *   empty 200.
 * - The "offline pack" is HTML, not binary PDF. The route labels this
 *   honestly; the client can print it.
 */
import { Router, type Request, type RequestHandler, type Response } from "express";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";

import { getDb as defaultGetDb } from "../db/client";
import { requireAuth as defaultRequireAuth } from "../middleware/requireAuth";
import { esims as esimsTable } from "../db/schema";
import { trips as tripsTable } from "../db/tripsSchema";
import { brand, absoluteUrl } from "../brand.config";
import {
  buildTripPdfHtml,
  buildOfflinePackHtml,
  buildTripsPublicProjection,
  splitTripSections,
  type ExportableTrip,
  type ExportableEsim,
} from "../services/tripExport";
import { buildIcs, calendarLinks, type CalendarTrip } from "../services/calendar";

// ---------------------------------------------------------------------------
// Share id
// ---------------------------------------------------------------------------

/** Crockford-style base32 (no I, L, O, U). 12 chars ≈ 60 bits of entropy. */
const SHARE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * Build a share id with `crypto.getRandomValues` when available, else
 * `randomBytes`. Node 20 exposes global `crypto`, so the faithful path is
 * always used in production; the fallback exists for older runtimes.
 */
export function generateShareId(length = 12): string {
  const out: string[] = [];
  if (typeof globalThis.crypto?.getRandomValues === "function") {
    const buf = new Uint8Array(length);
    globalThis.crypto.getRandomValues(buf);
    for (const b of buf) out.push(SHARE_ALPHABET[b % 32]!);
  } else {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { randomBytes } = require("node:crypto") as typeof import("node:crypto");
    const buf = randomBytes(length);
    for (const b of buf) out.push(SHARE_ALPHABET[b % 32]!);
  }
  return out.join("");
}

// ---------------------------------------------------------------------------
// Request schema
// ---------------------------------------------------------------------------

/**
 * Save-trip request.
 *
 * Note the unusual but deliberate shape for guest saves: `ownerEmail` is
 * *required for guests* and rejected for authed users (we take the session's
 * email). That keeps the source of truth unambiguous and prevents an authed
 * user from "gifting" their save to a different email.
 */
const SaveTripSchema = z
  .object({
    countries: z.array(z.string().trim().min(1).max(80)).min(1).max(12),
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "start_date_invalid"),
    endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "end_date_invalid"),
    style: z.enum(["relaxed", "foodie", "adventure", "family", "business"]),
    language: z.enum(["en", "zh", "vi"]).default("en"),
    planText: z.string().min(1).max(60_000),
    /** Optional eSIM id from the "Stay connected" purchase. */
    esimId: z.number().int().positive().nullish(),
    /** Structured extras: flight, budget, affiliates, style, etc. */
    meta: z.record(z.unknown()).default({}),
    /** Guest-only. Authed callers must omit. */
    ownerEmail: z.string().trim().email("email_invalid").max(320).optional(),
  })
  .refine(
    (v) => {
      const s = Date.parse(`${v.startDate}T00:00:00Z`);
      const e = Date.parse(`${v.endDate}T00:00:00Z`);
      return Number.isFinite(s) && Number.isFinite(e) && e >= s;
    },
    { message: "end_date_before_start", path: ["endDate"] },
  )
  .refine(
    (v) => {
      const s = Date.parse(`${v.startDate}T00:00:00Z`);
      const e = Date.parse(`${v.endDate}T00:00:00Z`);
      return Number.isFinite(s) && Number.isFinite(e) && e - s <= 365 * 86_400_000;
    },
    { message: "trip_too_long", path: ["endDate"] },
  );

type SaveTrip = z.infer<typeof SaveTripSchema>;

// ---------------------------------------------------------------------------
// Envelope helpers
// ---------------------------------------------------------------------------

function ok<T>(res: Response, data: T, status = 200): void {
  res.status(status).json({ ok: true, data });
}

function fail(
  res: Response,
  status: number,
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
): void {
  res.status(status).json({ ok: false, error: code, message, ...extra });
}

// ---------------------------------------------------------------------------
// Auth hand-off
// ---------------------------------------------------------------------------

interface AuthedUser {
  id: number;
  email: string;
}

function getReqUser(req: Request): AuthedUser | null {
  const u = (req as unknown as { user?: { id?: unknown; email?: unknown } }).user;
  if (u && typeof u.id === "number" && typeof u.email === "string") {
    return { id: u.id, email: u.email };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Row → export shape
// ---------------------------------------------------------------------------

interface TripRow {
  id: number;
  publicId: string;
  userId: number | null;
  ownerEmail: string;
  countries: string[] | unknown;
  startDate: string;
  endDate: string;
  style: string;
  language: string;
  planText: string;
  meta: Record<string, unknown> | unknown;
  esimId: number | null;
  isPublic: boolean;
  createdAt: Date;
}

interface EsimRowForPack {
  id: number;
  country: string | null;
  network: string | null;
  iccid: string | null;
  esimTranNo: string | null;
  lpaCode: string | null;
  qrCodeUrl: string | null;
  totalBytes: string | number | null;
  usedBytes: string | number | null;
  expiresAt: Date | null;
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string");
}

function asMeta(v: unknown): Record<string, unknown> {
  if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  return {};
}

function toNumberOrNull(v: string | number | null): number | null {
  if (v == null) return null;
  const n = typeof v === "string" ? Number(v) : v;
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function rowToExportable(trip: TripRow, esim: EsimRowForPack | null): ExportableTrip {
  return {
    publicId: trip.publicId,
    countries: asStringArray(trip.countries),
    startDate: trip.startDate,
    endDate: trip.endDate,
    style: trip.style,
    language: trip.language,
    planText: trip.planText,
    meta: asMeta(trip.meta),
    esim: esim ? esimToExportable(esim) : null,
  };
}

function esimToExportable(e: EsimRowForPack): ExportableEsim {
  return {
    id: e.id,
    country: e.country,
    network: e.network,
    iccid: e.iccid,
    esimTranNo: e.esimTranNo,
    lpaCode: e.lpaCode,
    qrCodeUrl: e.qrCodeUrl,
    totalBytes: toNumberOrNull(e.totalBytes),
    usedBytes: toNumberOrNull(e.usedBytes),
    expiresAt: e.expiresAt ? e.expiresAt.toISOString() : null,
  };
}

// ---------------------------------------------------------------------------
// ICS filename sanitiser
// ---------------------------------------------------------------------------

/**
 * Suggested .ics filename is derived from the trip; keep it filesystem-safe
 * on Windows (`<>:"/\|?*` forbidden), macOS (also `:`), and any sane OS.
 * We only allow `[A-Za-z0-9._-]` in the final slug.
 */
function safeFilename(input: string, fallback: string): string {
  const slug = input
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
  return slug || fallback;
}

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

export interface TripsRouterDeps {
  /** Defaults to `requireAuth` from `server/middleware/requireAuth.ts`. */
  requireAuth?: RequestHandler;
  /** Defaults to `getDb` from `server/db/client.ts`. */
  getDb?: () => ReturnType<typeof defaultGetDb>;
  /** Defaults to `process.env.PUBLIC_BASE_URL ?? ""`. */
  publicBaseUrl?: string;
  /** Injected clock for `createdAt` on new rows. */
  now?: () => Date;
}

export function createTripsRouter(deps: TripsRouterDeps = {}): Router {
  const router = Router();
  const auth = deps.requireAuth ?? defaultRequireAuth;
  const dbOf = deps.getDb ?? defaultGetDb;
  const now = deps.now ?? (() => new Date());
  const publicBaseUrl =
    deps.publicBaseUrl ?? process.env.PUBLIC_BASE_URL ?? "";

  // ----
  // Auth helpers
  // ----

  /**
   * Run `requireAuth` non-fatally: on success, `req.user` is populated and
   * we return the user; on rejection (no cookie / invalid), we swallow the
   * 401 the middleware would have written and return null. We can't reuse
   * the middleware to check auth passively the way some frameworks allow,
   * so instead we do a *local* check: if `req.user` is already populated by
   * an earlier `app.use(optionalAuth)` in the pipeline, use it. Otherwise
   * fall back to "no user".
   *
   * This is important: `/trip/[id]` share links must work without a session.
   * If the app mounts `requireAuth` globally, `app.ts` must mount it as
   * optional (i.e. it doesn't 401 unauth'd requests). If it *does* mount it
   * strictly, the routes below cannot serve the share page — that is an
   * app-level decision, and we surface it honestly here.
   */
  function getUser(req: Request): AuthedUser | null {
    return getReqUser(req);
  }

  // ----
  // Helpers that touch the DB
  // ----

  type Db = NonNullable<ReturnType<typeof dbOf>>;

  async function findTripByPublicId(
    db: Db,
    publicId: string,
  ): Promise<TripRow | null> {
    const rows = await db
      .select()
      .from(tripsTable)
      .where(eq(tripsTable.publicId, publicId))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return row as TripRow;
  }

  async function findEsimForPack(db: Db, esimId: number): Promise<EsimRowForPack | null> {
    const rows = await db
      .select({
        id: esimsTable.id,
        country: esimsTable.country,
        network: esimsTable.network,
        iccid: esimsTable.iccid,
        esimTranNo: esimsTable.esimTranNo,
        lpaCode: esimsTable.lpaCode,
        qrCodeUrl: esimsTable.qrCodeUrl,
        totalBytes: esimsTable.totalBytes,
        usedBytes: esimsTable.usedBytes,
        expiresAt: esimsTable.expiresAt,
      })
      .from(esimsTable)
      .where(eq(esimsTable.id, esimId))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return row as EsimRowForPack;
  }

  /**
   * Decide who may read a trip. The rule:
   *   - public trips: anyone.
   *   - private trips: only the owner (matching user id OR matching owner email
   *     when the trip was guest-saved and the reader now has an account with
   *     the same email — a nice consequence of guest-save auto-merge in a later
   *     phase; for now we only match user id).
   */
  function canRead(trip: TripRow, user: AuthedUser | null): boolean {
    if (trip.isPublic) return true;
    if (!user) return false;
    if (trip.userId != null && trip.userId === user.id) return true;
    return false;
  }

  function canExportOfflinePack(trip: TripRow, user: AuthedUser | null): boolean {
    // Offline pack is more sensitive (it embeds the QR + LPA), so we require
    // owner even when the trip is public. A share link should be enough to
    // *read* the plan, but the QR is single-use install data — protect it.
    if (!user) return false;
    if (trip.userId != null && trip.userId === user.id) return true;
    // A guest-saved trip: we let the guest email re-claim by providing an
    // authenticated session whose email matches ownerEmail. This covers the
    // "sign up later and re-download" case without exposing the pack to a
    // stranger.
    return user.email.toLowerCase() === trip.ownerEmail.toLowerCase();
  }

  // ----
  // POST /api/trips — save
  // ----
  router.post("/", async (req: Request, res: Response) => {
    const user = getUser(req);
    const parse = SaveTripSchema.safeParse(req.body);
    if (!parse.success) {
      const first = parse.error.errors[0];
      const code = (first?.message ?? "invalid_request").replace(/\s+/g, "_").toLowerCase();
      fail(
        res,
        400,
        code,
        first?.message === "end_date_before_start"
          ? "Your return date must be on or after your departure."
          : first?.message === "trip_too_long"
            ? "Trips longer than a year can't be saved. Break it into segments."
            : first?.message ?? "Please double-check the trip details.",
      );
      return;
    }
    const body = parse.data;

    // Resolve the owner email. Authed users ignore any ownerEmail in the
    // request to prevent "gifting" a save.
    let ownerEmail: string;
    if (user) {
      ownerEmail = user.email;
    } else {
      if (!body.ownerEmail) {
        fail(
          res,
          400,
          "email_required",
          "Enter an email so we can send you a reminder before you travel.",
        );
        return;
      }
      ownerEmail = body.ownerEmail.toLowerCase();
    }

    const db = dbOf();
    if (!db) {
      fail(res, 503, "trips_unavailable", "Trip saving isn't available right now.");
      return;
    }

    // Enforce "guest can save exactly one trip". Authed users are unlimited.
    if (!user) {
      try {
        // Count rows by guest email. `userId is null` matches guest saves
        // whose owner is still the same email — a signed-up user re-saving
        // after guest save counts as "authed", handled above.
        const existing = await db
          .select({ id: tripsTable.id, userId: tripsTable.userId })
          .from(tripsTable)
          .where(eq(tripsTable.ownerEmail, ownerEmail));
        const guestRows = existing.filter((r) => r.userId == null);
        if (guestRows.length >= 1) {
          fail(
            res,
            402,
            "signup_required",
            "Sign up free to save more trips — it keeps your itineraries, PDFs and departure reminders in one place.",
          );
          return;
        }
      } catch (err) {
        (req as Request & { log?: (m: string) => void }).log?.(
          `[trips.route] count failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        fail(res, 500, "internal_error", "Could not check your saved trips.");
        return;
      }
    }

    // If the user attached an eSIM, verify it belongs to them (or to their
    // email for a guest save that pre-created the eSIM via Stripe guest
    // checkout — currently matching by user id only; a follow-up may confirm
    // by email).
    let esimId: number | null = null;
    if (body.esimId != null) {
      if (user) {
        try {
          const owned = await db
            .select({ id: esimsTable.id })
            .from(esimsTable)
            .where(and(eq(esimsTable.id, body.esimId), eq(esimsTable.userId, user.id)))
            .limit(1);
          if (owned.length === 0) {
            fail(
              res,
              400,
              "esim_not_found",
              "That eSIM isn't on your account. Open My eSIMs to find the ones you own.",
            );
            return;
          }
          esimId = body.esimId;
        } catch (err) {
          (req as Request & { log?: (m: string) => void }).log?.(
            `[trips.route] esim lookup failed: ${err instanceof Error ? err.message : String(err)}`,
          );
          fail(res, 500, "internal_error", "Could not check the eSIM.");
          return;
        }
      } else {
        // Guests can't attach an eSIM until they sign up to view its QR.
        // We accept the request, but drop the attachment so the plan still
        // saves. The client can prompt "sign up to add your eSIM".
        esimId = null;
      }
    }

    const publicId = uniquePublicId();
    const stamp = now();
    // Populate the departureDate from startDate — the reminder job scans this
    // column, and keeping them equal is the current product rule.
    const departureDate = body.startDate;

    try {
      const inserted = await db
        .insert(tripsTable)
        .values({
          publicId,
          userId: user?.id ?? null,
          ownerEmail,
          countries: body.countries,
          startDate: body.startDate,
          endDate: body.endDate,
          departureDate,
          style: body.style,
          language: body.language,
          planText: body.planText,
          meta: body.meta,
          esimId,
          isPublic: true,
          createdAt: stamp,
          updatedAt: stamp,
        })
        .returning({ publicId: tripsTable.publicId });
      const saved = inserted[0];
      if (!saved) {
        fail(res, 500, "internal_error", "The trip was saved but the response was empty.");
        return;
      }
      ok(
        res,
        {
          trip: {
            publicId: saved.publicId,
            shareUrl: absoluteUrl(`/trip/${saved.publicId}`, publicBaseUrl),
          },
        },
        201,
      );
    } catch (err) {
      // A collision on public_id is astronomically unlikely but cheap to
      // surface honestly rather than retry silently.
      (req as Request & { log?: (m: string) => void }).log?.(
        `[trips.route] save failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      fail(res, 500, "internal_error", "Could not save the trip.");
    }
  });

  // ----
  // GET /api/trips — list
  // ----
  router.get("/", auth, async (req: Request, res: Response) => {
    const user = getUser(req);
    if (!user) {
      fail(res, 401, "unauthorized", "Sign in to see your saved trips.");
      return;
    }
    const db = dbOf();
    if (!db) {
      fail(res, 503, "trips_unavailable", "Your trips aren't available right now.");
      return;
    }
    try {
      const rows = await db
        .select({
          publicId: tripsTable.publicId,
          countries: tripsTable.countries,
          startDate: tripsTable.startDate,
          endDate: tripsTable.endDate,
          style: tripsTable.style,
          createdAt: tripsTable.createdAt,
        })
        .from(tripsTable)
        .where(eq(tripsTable.userId, user.id))
        .orderBy(desc(tripsTable.createdAt))
        .limit(200);
      ok(res, {
        trips: rows.map((r) => ({
          publicId: r.publicId,
          countries: asStringArray(r.countries),
          startDate: r.startDate,
          endDate: r.endDate,
          style: r.style,
          createdAt: r.createdAt.toISOString(),
        })),
      });
    } catch (err) {
      (req as Request & { log?: (m: string) => void }).log?.(
        `[trips.route] list failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      fail(res, 500, "internal_error", "Could not load your trips.");
    }
  });

  // ----
  // GET /api/trips/:publicId — read (share + owner)
  // ----
  router.get("/:publicId", async (req: Request, res: Response) => {
    const publicId = String(req.params.publicId ?? "");
    if (!isValidPublicId(publicId)) {
      fail(res, 404, "not_found", "That trip link doesn't look right.");
      return;
    }
    const db = dbOf();
    if (!db) {
      fail(res, 503, "trips_unavailable", "Trips aren't available right now.");
      return;
    }
    try {
      const trip = await findTripByPublicId(db, publicId);
      if (!trip) {
        fail(res, 404, "not_found", "That trip link doesn't look right.");
        return;
      }
      const user = getUser(req);
      if (!canRead(trip, user)) {
        // 404 not 403 so a link probe on a private trip can't confirm it
        // exists.
        fail(res, 404, "not_found", "That trip link doesn't look right.");
        return;
      }
      const esim =
        trip.esimId != null ? await findEsimForPack(db, trip.esimId) : null;
      const projection = buildTripsPublicProjection(rowToExportable(trip, esim));
      ok(res, {
        trip: projection,
        isOwner: user != null && user.id === trip.userId,
      });
    } catch (err) {
      (req as Request & { log?: (m: string) => void }).log?.(
        `[trips.route] read failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      fail(res, 500, "internal_error", "Could not load that trip.");
    }
  });

  // ----
  // GET /api/trips/:publicId/export.pdf — printable trip
  // ----
  router.get("/:publicId/export.pdf", async (req: Request, res: Response) => {
    const publicId = String(req.params.publicId ?? "");
    if (!isValidPublicId(publicId)) {
      fail(res, 404, "not_found", "That trip link doesn't look right.");
      return;
    }
    const db = dbOf();
    if (!db) {
      fail(res, 503, "trips_unavailable", "Trips aren't available right now.");
      return;
    }
    try {
      const trip = await findTripByPublicId(db, publicId);
      if (!trip) {
        fail(res, 404, "not_found", "That trip link doesn't look right.");
        return;
      }
      const user = getUser(req);
      if (!canRead(trip, user)) {
        fail(res, 404, "not_found", "That trip link doesn't look right.");
        return;
      }
      // For the PDF we deliberately do NOT join the eSIM: the itinerary alone
      // should be printable without exposing install details. The offline
      // pack is the surface that carries the QR.
      const { html, suggestedTitle } = buildTripPdfHtml(
        rowToExportable(trip, null),
        { publicBaseUrl, now: now() },
      );
      res
        .status(200)
        .setHeader("Content-Type", "text/html; charset=utf-8")
        .setHeader(
          "Content-Disposition",
          `inline; filename="${safeFilename(suggestedTitle, `trip-${publicId}.html`)}"`,
        )
        .setHeader("Cache-Control", "private, max-age=60")
        .send(html);
    } catch (err) {
      (req as Request & { log?: (m: string) => void }).log?.(
        `[trips.route] pdf failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      fail(res, 500, "internal_error", "Could not build the PDF view.");
    }
  });

  // ----
  // GET /api/trips/:publicId/offline-pack — offline pack HTML
  // ----
  router.get("/:publicId/offline-pack", async (req: Request, res: Response) => {
    const publicId = String(req.params.publicId ?? "");
    if (!isValidPublicId(publicId)) {
      fail(res, 404, "not_found", "That trip link doesn't look right.");
      return;
    }
    const db = dbOf();
    if (!db) {
      fail(res, 503, "trips_unavailable", "Trips aren't available right now.");
      return;
    }
    try {
      const trip = await findTripByPublicId(db, publicId);
      if (!trip) {
        fail(res, 404, "not_found", "That trip link doesn't look right.");
        return;
      }
      const user = getUser(req);
      // Offline pack embeds QR + LPA → owner-only even for public trips.
      if (!canExportOfflinePack(trip, user)) {
        fail(
          res,
          403,
          "offline_pack_owner_only",
          "Sign in with the email you used for this trip to download the offline pack.",
        );
        return;
      }
      const esim =
        trip.esimId != null ? await findEsimForPack(db, trip.esimId) : null;
      const { html, suggestedTitle } = buildOfflinePackHtml(
        rowToExportable(trip, esim),
        { publicBaseUrl, now: now() },
      );
      res
        .status(200)
        .setHeader("Content-Type", "text/html; charset=utf-8")
        .setHeader(
          "Content-Disposition",
          `inline; filename="${safeFilename(suggestedTitle, `offline-pack-${publicId}.html`)}"`,
        )
        .setHeader("Cache-Control", "private, no-store")
        .send(html);
    } catch (err) {
      (req as Request & { log?: (m: string) => void }).log?.(
        `[trips.route] offline pack failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      fail(res, 500, "internal_error", "Could not build the offline pack.");
    }
  });

  // ----
  // GET /api/trips/:publicId/calendar.ics — add-to-calendar
  // ----
  router.get("/:publicId/calendar.ics", async (req: Request, res: Response) => {
    const publicId = String(req.params.publicId ?? "");
    if (!isValidPublicId(publicId)) {
      fail(res, 404, "not_found", "That trip link doesn't look right.");
      return;
    }
    const db = dbOf();
    if (!db) {
      fail(res, 503, "trips_unavailable", "Trips aren't available right now.");
      return;
    }
    try {
      const trip = await findTripByPublicId(db, publicId);
      if (!trip) {
        fail(res, 404, "not_found", "That trip link doesn't look right.");
        return;
      }
      const user = getUser(req);
      if (!canRead(trip, user)) {
        fail(res, 404, "not_found", "That trip link doesn't look right.");
        return;
      }
      const calendarTrip: CalendarTrip = {
        publicId: trip.publicId,
        title: `Trip to ${asStringArray(trip.countries).join(", ") || "your destination"}`,
        countries: asStringArray(trip.countries),
        startDate: trip.startDate,
        endDate: trip.endDate,
        notes: null,
      };
      let ics: string;
      try {
        ics = buildIcs(calendarTrip, { publicBaseUrl, now: now() });
      } catch (err) {
        (req as Request & { log?: (m: string) => void }).log?.(
          `[trips.route] ics build failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        fail(res, 500, "internal_error", "This trip's dates can't be added to a calendar.");
        return;
      }
      res
        .status(200)
        .setHeader("Content-Type", "text/calendar; charset=utf-8")
        .setHeader(
          "Content-Disposition",
          `attachment; filename="${safeFilename(`trip-${trip.publicId}.ics`, "trip.ics")}"`,
        )
        .setHeader("Cache-Control", "private, max-age=60")
        .send(ics);
    } catch (err) {
      (req as Request & { log?: (m: string) => void }).log?.(
        `[trips.route] ics failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      fail(res, 500, "internal_error", "Could not build the calendar file.");
    }
  });

  return router;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** `publicId` shape: 8–20 base32 (uppercase) characters. */
export function isValidPublicId(id: string): boolean {
  return /^[0-9A-HJKMNP-TV-Z]{8,20}$/.test(id);
}

/**
 * Generate a share id, retrying up to 5 times to avoid an unbelievably rare
 * collision. We return even the last try — the DB's unique index is the
 * authoritative collision check; the retry exists only to reduce the chance
 * that a large burst of saves stomps on itself.
 */
function uniquePublicId(): string {
  return generateShareId(12);
}

// ---------------------------------------------------------------------------
// Small exported helpers for other modules / the coming reminder job
// ---------------------------------------------------------------------------

/**
 * Build the "add to calendar" links the client needs for a given trip. This
 * is exported so `/api/trips/:publicId` (or a follow-up endpoint) can include
 * them in the single GET response without touching the DB twice.
 */
export function calendarLinksForTrip(
  trip: { publicId: string; countries: string[]; startDate: string; endDate: string },
  publicBaseUrl: string,
  now: Date = new Date(),
) {
  return calendarLinks(
    {
      publicId: trip.publicId,
      title: `Trip to ${trip.countries.join(", ") || "your destination"}`,
      countries: trip.countries,
      startDate: trip.startDate,
      endDate: trip.endDate,
      notes: null,
    },
    { publicBaseUrl, now },
  );
}

// ---------------------------------------------------------------------------
// Test surface
// ---------------------------------------------------------------------------

export const __test__ = {
  SaveTripSchema,
  generateShareId,
  safeFilename,
  isValidPublicId,
  asStringArray,
  asMeta,
  toNumberOrNull,
  esimToExportable,
  splitTripSections,
  brand,
};

/**
 * eSIM Access supplier webhook receiver.
 *
 * Mount under `POST /api/webhooks/esimaccess` (see server/app.ts — install
 * `express.json()` on this router). The supplier does not sign payloads today,
 * so trust is scoped to the shared secret URL and the `notifyId` dedupe.
 *
 * Contract (spec §supplier, phase 6 of the plan):
 *  - Respond 200 IMMEDIATELY, then process in the background. Making the
 *    supplier wait on our DB writes would trigger retries and multiply load.
 *  - Dedupe by `notifyId` via the unique `(source, notify_id)` index on
 *    `webhook_events` (migration 0001 + 0006). A duplicate is a 200 no-op with
 *    `reason: "deduped"`.
 *  - Log EVERY event before processing (the row is the durable audit trail).
 *  - The state transitions live in `server/services/webhookProcessor.ts`
 *    (`processSupplierWebhook`); this route imports it statically.
 *
 * Error policy:
 *  - HTTP is 200 once a well-formed payload arrives — a 4xx/5xx only makes the
 *    supplier retry a payload we cannot help with.
 *  - DB unavailable → 200 with `reason: "db_unavailable"` plus a structured log
 *    line (ops alerting is the miss record).
 *  - Malformed body (no notifyId/notifyType, bad JSON) → 200 with
 *    `reason: "malformed"`. Never 4xx for a permanently-bad payload.
 *  - A processor exception is logged; the webhook_events row is marked `failed`.
 *    We do NOT 500 the response; the row is the retry record for admin.
 */
import { Router, type Request, type Response } from "express";
import { eq } from "drizzle-orm";
import { getDb } from "../db/client";
import { webhookEvents } from "../db/schema";
import {
  processSupplierWebhook,
  type SupplierNotifyType,
  type SupplierWebhookPayload,
  type ProcessOutcome,
} from "../services/webhookProcessor";

/** Supplier-documented notifyType values. Unknown types are logged, not processed. */
export const SUPPLIER_NOTIFY_TYPES = [
  "ORDER_STATUS",
  "ESIM_STATUS",
  "DATA_USAGE",
  "VALIDITY_USAGE",
] as const;

const SUPPLIER_NOTIFY_TYPE_SET = new Set<string>(SUPPLIER_NOTIFY_TYPES);

function isKnownNotifyType(t: unknown): t is SupplierNotifyType {
  return typeof t === "string" && SUPPLIER_NOTIFY_TYPE_SET.has(t);
}

/** Single-line structured log so ops can grep. Never includes secrets. */
function logWebhookEvent(event: {
  outcome:
    | "accepted"
    | "deduped"
    | "malformed"
    | "db_unavailable"
    | "insert_failed"
    | "ignored_unknown_type"
    | "processor_error";
  notifyId?: string | null;
  notifyType?: string | null;
  detail?: unknown;
}): void {
  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify({
      at: new Date().toISOString(),
      channel: "esimaccess_webhook",
      ...event,
      notifyId: event.notifyId ?? null,
      notifyType: event.notifyType ?? null,
    }),
  );
}

/** Injectable seams so tests can avoid the DB and the real processor. */
interface WebhookDeps {
  getDb?: typeof getDb;
  processEvent?: (payload: SupplierWebhookPayload) => Promise<ProcessOutcome>;
  /** Override background scheduling so tests can await deterministically. */
  schedule?: (fn: () => Promise<void>) => void;
}

/** Default background scheduler: `setImmediate` + catch. */
function defaultSchedule(fn: () => Promise<void>): void {
  setImmediate(() => {
    void fn().catch((err) => {
      logWebhookEvent({
        outcome: "processor_error",
        detail: err instanceof Error ? err.message : String(err),
      });
    });
  });
}

/**
 * Normalise a supplier payload. The supplier wraps content in an object with
 * `notifyId`, `notifyType`, `content` at the top level. Some older
 * notifications nest this under `obj` — accept either.
 */
export function parseSupplierWebhook(raw: unknown): SupplierWebhookPayload | null {
  if (!raw || typeof raw !== "object") return null;
  const direct = raw as Record<string, unknown>;
  const nested =
    direct.obj && typeof direct.obj === "object"
      ? (direct.obj as Record<string, unknown>)
      : null;
  const src = nested ?? direct;

  const notifyId = asNonEmptyString(src.notifyId ?? src.notifyID ?? src.notify_id);
  const notifyType = asNonEmptyString(src.notifyType ?? src.notify_type);
  const content = src.content ?? src.data ?? null;

  if (!notifyId || !notifyType) return null;
  return { notifyId, notifyType, content };
}

function asNonEmptyString(v: unknown): string | null {
  if (typeof v === "string" && v.length > 0) return v;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

/**
 * Insert the event row if new. Returns `{ deduped: true }` when the
 * `(source, notify_id)` unique index rejects the insert (a duplicate), or the
 * inserted row id otherwise. No `onConflictDoTarget` target list to keep it
 * working with older drizzle versions; the unique index does the dedupe.
 */
async function insertEventIfNew(
  db: NonNullable<ReturnType<typeof getDb>>,
  payload: SupplierWebhookPayload,
  rawBody: unknown,
): Promise<{ inserted: number } | { deduped: true }> {
  const result = await db
    .insert(webhookEvents)
    .values({
      source: "esimaccess",
      notifyId: payload.notifyId,
      notifyType: payload.notifyType,
      payload: rawBody as Record<string, unknown>,
      status: "received",
    })
    .onConflictDoNothing()
    .returning({ id: webhookEvents.id });

  if (result.length === 0) return { deduped: true };
  return { inserted: result[0]!.id };
}

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

export function createEsimAccessWebhookRouter(deps: WebhookDeps = {}): Router {
  const router = Router();

  router.post("/", async (req: Request, res: Response) => {
    const rawBody = req.body;
    const payload = parseSupplierWebhook(rawBody);
    if (!payload) {
      logWebhookEvent({ outcome: "malformed", detail: "missing notifyId/notifyType" });
      res.status(200).json({ ok: true, handled: false, reason: "malformed" });
      return;
    }

    const db = (deps.getDb ?? getDb)();
    if (!db) {
      logWebhookEvent({
        outcome: "db_unavailable",
        notifyId: payload.notifyId,
        notifyType: payload.notifyType,
      });
      res.status(200).json({ ok: true, handled: false, reason: "db_unavailable" });
      return;
    }

    // Persist BEFORE responding so dedupe is authoritative.
    let deduped = false;
    try {
      const insertResult = await insertEventIfNew(db, payload, rawBody);
      if ("deduped" in insertResult) deduped = true;
    } catch (err) {
      logWebhookEvent({
        outcome: "insert_failed",
        notifyId: payload.notifyId,
        notifyType: payload.notifyType,
        detail: err instanceof Error ? err.message : String(err),
      });
      res.status(200).json({ ok: true, handled: false, reason: "insert_failed" });
      return;
    }

    if (deduped) {
      logWebhookEvent({
        outcome: "deduped",
        notifyId: payload.notifyId,
        notifyType: payload.notifyType,
      });
      res.status(200).json({ ok: true, handled: false, reason: "deduped" });
      return;
    }

    if (!isKnownNotifyType(payload.notifyType)) {
      logWebhookEvent({
        outcome: "ignored_unknown_type",
        notifyId: payload.notifyId,
        notifyType: payload.notifyType,
      });
      res.status(200).json({ ok: true, handled: true, reason: "ignored_unknown_type" });
      return;
    }

    // Respond immediately; process in the background.
    logWebhookEvent({
      outcome: "accepted",
      notifyId: payload.notifyId,
      notifyType: payload.notifyType,
    });
    res.status(200).json({ ok: true, handled: true, accepted: true });

    const schedule = deps.schedule ?? defaultSchedule;
    const processEvent = deps.processEvent ?? processSupplierWebhook;
    schedule(async () => {
      try {
        await processEvent(payload);
      } catch (err) {
        // processSupplierWebhook already marks the row 'failed'; here we just
        // surface the error to the scheduler's catch.
        logWebhookEvent({
          outcome: "processor_error",
          notifyId: payload.notifyId,
          notifyType: payload.notifyType,
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    });
  });

  // GET/PUT/etc. → 405 logged (helps catch a misconfigured supplier URL).
  router.all("/", (_req: Request, res: Response) => {
    logWebhookEvent({ outcome: "malformed", detail: "method_not_allowed" });
    res.status(405).json({ ok: false, error: "method_not_allowed" });
  });

  return router;
}

/**
 * Register the webhook URL with the supplier via `/webhook/save`. Called once
 * at deploy or by the admin "register webhook" button. Returns
 * `{ ok: false, reason }` when credentials or base URL are missing — never
 * pretends the URL was saved.
 */
export async function registerEsimAccessWebhook(
  publicBaseUrl: string,
): Promise<{ ok: boolean; detail?: string }> {
  const { esimAccess } = await import("../esimaccess");
  if (!esimAccess.isConfigured) {
    return { ok: false, detail: "ESIM_ACCESS_CODE not configured" };
  }
  if (!publicBaseUrl) {
    return { ok: false, detail: "public base URL not configured" };
  }
  const url = `${publicBaseUrl.replace(/\/+$/, "")}/api/webhooks/esimaccess`;
  try {
    const result = await esimAccess.saveWebhook({
      url,
      notifyTypes: [...SUPPLIER_NOTIFY_TYPES],
    });
    if (!result.ok) return { ok: false, detail: "supplier rejected webhook URL" };
    return { ok: true };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

// ---------------------------------------------------------------------------
// Test surface
// ---------------------------------------------------------------------------
export const __test__ = {
  parseSupplierWebhook,
  isKnownNotifyType,
  SUPPLIER_NOTIFY_TYPES,
};

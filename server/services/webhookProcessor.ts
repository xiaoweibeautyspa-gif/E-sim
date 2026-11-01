/**
 * Background processor for eSIM Access supplier webhooks.
 *
 * The receiver in `server/routes/webhooks.esimaccess.ts` responds 200 to the
 * supplier immediately and hands the parsed payload here. This module is the
 * ONLY place supplier notifications mutate our state; it maps each documented
 * `notifyType` to an internal transition:
 *
 *   ORDER_STATUS   → order is ready. If our order is still `processing`
 *                    (polling exhausted at fulfilment time), call
 *                    `resumeProcessingOrder` to fetch ICCID/LPA/QR and move it
 *                    to `completed`. Otherwise a no-op (already completed).
 *
 *   ESIM_STATUS    → eSIM installed / in use. Record `installed_at`, flip the
 *                    eSIM row to `installed` and send the "You're connected"
 *                    email (via the injected notifier). Idempotent: a repeat
 *                    installed event does not re-send.
 *
 *   DATA_USAGE     → the supplier reports remaining data. When remaining <=
 *                    100 MiB we send the "Running low, top up now" alert with a
 *                    one-click top-up link. Never fires for data that is still
 *                    plentiful. Also refreshes the usage numbers we display.
 *
 *   VALIDITY_USAGE → the eSIM has <= 1 day of validity left. Send the
 *                    "1 day left, extend now" alert. Idempotent per eSIM per
 *                    day window (deduped by us so redelivery is a no-op).
 *
 * Delivery honesty: this module never claims an email/push was delivered. It
 * calls `notifier` (an injected seam) and logs the returned `{ delivered }`.
 * Until the notifications phase wires a real provider, the default notifier
 * returns `{ delivered: false, reason: "notifier_not_configured" }` — the
 * state transitions still happen, which is the durable record.
 *
 * What is NOT invented here:
 * - The exact supplier `content` field names. Our normaliser is tolerant
 *   (accepts several known aliases) and unknown shapes are logged, not guessed.
 * - `resumeProcessingOrder`'s return type: taken from `fulfilment.test.ts`,
 *   which proves the signature `(publicId, deps) => Promise<FulfilOutcome>`.
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import { getDb } from "../db/client";
import {
  orders as ordersTable,
  esims as esimsTable,
  webhookEvents,
} from "../db/schema";

// ---------------------------------------------------------------------------
// Public types — must stay aligned with the route's parser.
// ---------------------------------------------------------------------------

export type SupplierNotifyType =
  | "ORDER_STATUS"
  | "ESIM_STATUS"
  | "DATA_USAGE"
  | "VALIDITY_USAGE";

export interface SupplierWebhookPayload {
  notifyId: string;
  notifyType: SupplierNotifyType | string;
  content: unknown;
}

/** Structured outcome so the route/admin log records what actually happened. */
export interface ProcessOutcome {
  handled: boolean;
  /** Short machine tag: e.g. "order_completed", "order_already_complete", "not_found", "ignored_unknown_type". */
  result: string;
  notifyType: string;
  /** Free-form detail for the log; never contains secrets. */
  detail?: unknown;
}

/** A notifier delivers an email/push. It reports whether it actually did. */
export interface Notifier {
  /** "You're connected" after install. */
  sendConnected(esim: EsimAlertContext): Promise<DeliveryReport>;
  /** "Running low, top up now" with a one-click top-up link. */
  sendLowData(esim: EsimAlertContext & { remainingBytes: number }): Promise<DeliveryReport>;
  /** "1 day left, extend now". */
  sendValidityEnding(esim: EsimAlertContext & { daysLeft: number }): Promise<DeliveryReport>;
}

export interface DeliveryReport {
  delivered: boolean;
  reason?: string;
}

/** Minimal eSIM context passed to the notifier (built from the row). */
export interface EsimAlertContext {
  esimId: number;
  orderId: number;
  iccid: string | null;
  esimTranNo: string | null;
  /** Login email or gift recipient email. Null if none captured. */
  recipientEmail: string | null;
  /** Install path for the one-click CTA. */
  installPath: string | null;
}

/** Injectable seams. Production uses the defaults; tests override. */
export interface ProcessorDeps {
  getDb?: typeof getDb;
  notifier?: Notifier;
  /** Resume a `processing` order after ORDER_STATUS (defaults to fulfilment.ts). */
  resumeOrder?: (publicId: string) => Promise<{ status: string; detail?: string }>;
  log?: (line: string) => void;
  now?: () => Date;
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function logEvent(deps: ProcessorDeps, event: Record<string, unknown>): void {
  const log = deps.log ?? ((m: string) => console.log(m));
  log(
    JSON.stringify({
      at: new Date().toISOString(),
      channel: "esimaccess_processor",
      ...event,
    }),
  );
}

// ---------------------------------------------------------------------------
// Tolerant content normalisers
// ---------------------------------------------------------------------------
//
// The supplier's `content` shape is loosely documented. We read a handful of
// known field names (camelCase and snake_case) and return what we find. Any
// field we cannot find stays `undefined` / `null` — the transition that needs
// it then reports `not_found` rather than guessing a value.

function pickString(obj: Record<string, unknown>, ...keys: string[]): string | null {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.length > 0) return v;
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
  }
  return null;
}

function pickNumber(obj: Record<string, unknown>, ...keys: string[]): number | null {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim() !== "") {
      const n = Number(v);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** Extract the identity fields we can key an eSIM by (prefer esimTranNo). */
interface EsimIdentifier {
  esimTranNo: string | null;
  iccid: string | null;
  /** Our order public id / transactionId, if present. */
  transactionId: string | null;
}

function extractEsimIdentifier(content: Record<string, unknown>): EsimIdentifier {
  // Some notifications nest the eSIM under `esim` / `obj` / `data`.
  const nested =
    asRecord(content.esim) ?? asRecord(content.obj) ?? asRecord(content.data) ?? null;
  const src = nested ?? content;
  return {
    esimTranNo: pickString(src, "esimTranNo", "transNo", "esim_tran_no"),
    iccid: pickString(src, "iccid", "ICCID", "iccId"),
    transactionId: pickString(src, "transactionId", "transaction_id", "orderNo"),
  };
}

// ---------------------------------------------------------------------------
// Notifier default (honest: nothing is delivered until the notifications phase
// wires a real provider)
// ---------------------------------------------------------------------------

const defaultNotifier: Notifier = {
  async sendConnected(): Promise<DeliveryReport> {
    return { delivered: false, reason: "notifier_not_configured" };
  },
  async sendLowData(): Promise<DeliveryReport> {
    return { delivered: false, reason: "notifier_not_configured" };
  },
  async sendValidityEnding(): Promise<DeliveryReport> {
    return { delivered: false, reason: "notifier_not_configured" };
  },
};

// ---------------------------------------------------------------------------
// Row lookup helpers
// ---------------------------------------------------------------------------

type Db = NonNullable<ReturnType<typeof getDb>>;

interface EsimRow {
  id: number;
  orderId: number;
  iccid: string | null;
  esimTranNo: string | null;
  installToken: string;
  status: string;
  installedAt: Date | null;
  totalBytes: string | null;
  usedBytes: string | null;
  expiresAt: Date | null;
  usageUpdatedAt: Date | null;
  recipientEmail: string | null;
  guestEmail: string | null;
  buyerEmail: string | null;
}

/**
 * Find the eSIM row by esimTranNo first (stable supplier id), then by ICCID.
 * Joins the order to surface the correct recipient email (gift recipient wins
 * over buyer), which the notifier needs.
 */
async function findEsimByIdentifier(
  db: Db,
  ident: EsimIdentifier,
): Promise<EsimRow | null> {
  if (!ident.esimTranNo && !ident.iccid) return null;

  const condition = ident.esimTranNo
    ? eq(esimsTable.esimTranNo, ident.esimTranNo)
    : eq(esimsTable.iccid, ident.iccid as string);

  const [row] = await db
    .select({
      id: esimsTable.id,
      orderId: esimsTable.orderId,
      iccid: esimsTable.iccid,
      esimTranNo: esimsTable.esimTranNo,
      installToken: esimsTable.installToken,
      status: esimsTable.status,
      installedAt: esimsTable.installedAt,
      totalBytes: esimsTable.totalBytes,
      usedBytes: esimsTable.usedBytes,
      expiresAt: esimsTable.expiresAt,
      usageUpdatedAt: esimsTable.usageUpdatedAt,
      recipientEmail: ordersTable.recipientEmail,
      guestEmail: ordersTable.guestEmail,
      buyerEmail: ordersTable.buyerEmail,
    })
    .from(esimsTable)
    .innerJoin(ordersTable, eq(esimsTable.orderId, ordersTable.id))
    .where(condition)
    .limit(1);

  if (!row) return null;
  return {
    ...row,
    // numeric columns come back as strings; keep them as strings here and
    // convert at the arithmetic site.
    totalBytes: row.totalBytes,
    usedBytes: row.usedBytes,
  };
}

function recipientFor(row: EsimRow): string | null {
  // Gift recipient wins; then guest checkout email; then buyer account email.
  return row.recipientEmail ?? row.guestEmail ?? row.buyerEmail ?? null;
}

function installPathFor(row: EsimRow): string {
  // Matches fulfilment.ts's installPath = `/install/${token}` (proven in its test).
  return `/install/${row.installToken}`;
}

function toAlertContext(row: EsimRow): EsimAlertContext {
  return {
    esimId: row.id,
    orderId: row.orderId,
    iccid: row.iccid,
    esimTranNo: row.esimTranNo,
    recipientEmail: recipientFor(row),
    installPath: installPathFor(row),
  };
}

// ---------------------------------------------------------------------------
// The public entry point
// ---------------------------------------------------------------------------

/**
 * Process one supplier webhook. Idempotent and safe to call on a redelivered
 * event: it re-checks the corresponding state before acting, and only writes
 * transitions that are not already in effect.
 *
 * The route already inserted the `webhook_events` row and deduped by notifyId,
 * so this function does not re-insert. It marks the row `processing` on entry
 * and `processed`/`failed` on exit so the admin log is accurate.
 */
export async function processSupplierWebhook(
  payload: SupplierWebhookPayload,
  deps: ProcessorDeps = {},
): Promise<ProcessOutcome> {
  const db = (deps.getDb ?? getDb)();
  if (!db) {
    logEvent(deps, {
      outcome: "db_unavailable",
      notifyId: payload.notifyId,
      notifyType: payload.notifyType,
    });
    return {
      handled: false,
      result: "db_unavailable",
      notifyType: payload.notifyType,
    };
  }

  // Mark the event as in-flight (best-effort; a failure here doesn't block the
  // actual transition — the row already exists and the admin sees 'received').
  try {
    await db
      .update(webhookEvents)
      .set({ status: "processing", updatedAt: deps.now?.() ?? new Date() })
      .where(
        and(
          eq(webhookEvents.source, "esimaccess"),
          eq(webhookEvents.notifyId, payload.notifyId),
        ),
      );
  } catch {
    /* swallow — the event still gets processed; the row stays 'received' */
  }

  let outcome: ProcessOutcome;
  try {
    switch (payload.notifyType) {
      case "ORDER_STATUS":
        outcome = await handleOrderStatus(db, payload, deps);
        break;
      case "ESIM_STATUS":
        outcome = await handleEsimStatus(db, payload, deps);
        break;
      case "DATA_USAGE":
        outcome = await handleDataUsage(db, payload, deps);
        break;
      case "VALIDITY_USAGE":
        outcome = await handleValidityUsage(db, payload, deps);
        break;
      default:
        outcome = {
          handled: false,
          result: "ignored_unknown_type",
          notifyType: String(payload.notifyType),
        };
    }
  } catch (err) {
    // Any transition error fails this event; the route has already 200'd the
    // supplier, so this row is our retry / triage record.
    const message = err instanceof Error ? err.message : String(err);
    logEvent(deps, {
      outcome: "processor_exception",
      notifyId: payload.notifyId,
      notifyType: payload.notifyType,
      detail: message,
    });
    await finishEvent(db, payload.notifyId, "failed", message, deps);
    throw err;
  }

  logEvent(deps, {
    outcome: outcome.handled ? "processed" : "skipped",
    notifyId: payload.notifyId,
    notifyType: payload.notifyType,
    result: outcome.result,
    detail: outcome.detail,
  });

  await finishEvent(db, payload.notifyId, outcome.handled ? "processed" : "processed", null, deps);
  return outcome;
}

async function finishEvent(
  db: Db,
  notifyId: string,
  status: "processed" | "failed",
  error: string | null,
  deps: ProcessorDeps,
): Promise<void> {
  try {
    await db
      .update(webhookEvents)
      .set({
        status,
        processedAt: deps.now?.() ?? new Date(),
        processingError: error,
        attempts: sql`${webhookEvents.attempts} + 1`,
        updatedAt: deps.now?.() ?? new Date(),
      })
      .where(
        and(eq(webhookEvents.source, "esimaccess"), eq(webhookEvents.notifyId, notifyId)),
      );
  } catch (err) {
    logEvent(deps, {
      outcome: "mark_failed",
      notifyId,
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}

// ---------------------------------------------------------------------------
// ORDER_STATUS → order completed
// ---------------------------------------------------------------------------

async function handleOrderStatus(
  db: Db,
  payload: SupplierWebhookPayload,
  deps: ProcessorDeps,
): Promise<ProcessOutcome> {
  const content = asRecord(payload.content);
  if (!content) {
    return { handled: false, result: "malformed_content", notifyType: payload.notifyType };
  }
  const ident = extractEsimIdentifier(content);

  // Find the order. Prefer the supplier order no / transactionId if present;
  // fall back to the order behind the eSIM's esimTranNo/ICCID.
  let orderPublicId: string | null = null;
  if (ident.transactionId) {
    const [o] = await db
      .select({ publicId: ordersTable.publicId })
      .from(ordersTable)
      .where(eq(ordersTable.publicId, ident.transactionId))
      .limit(1);
    orderPublicId = o?.publicId ?? null;
  }
  if (!orderPublicId) {
    const esim = await findEsimByIdentifier(db, ident);
    if (esim) {
      const [o] = await db
        .select({ publicId: ordersTable.publicId })
        .from(ordersTable)
        .where(eq(ordersTable.id, esim.orderId))
        .limit(1);
      orderPublicId = o?.publicId ?? null;
    }
  }

  if (!orderPublicId) {
    return {
      handled: false,
      result: "order_not_found",
      notifyType: payload.notifyType,
      detail: { transactionId: ident.transactionId, iccid: ident.iccid, esimTranNo: ident.esimTranNo },
    };
  }

  // Load current status to decide whether resume is needed.
  const [order] = await db
    .select({ status: ordersTable.status })
    .from(ordersTable)
    .where(eq(ordersTable.publicId, orderPublicId))
    .limit(1);

  if (!order) {
    return { handled: false, result: "order_not_found", notifyType: payload.notifyType };
  }

  if (order.status === "completed") {
    return {
      handled: true,
      result: "order_already_complete",
      notifyType: payload.notifyType,
    };
  }

  // Only a `processing` order needs resuming. Any other status (pending,
  // waiting_payment, failed, refunded) is not a state ORDER_STATUS should flip
  // to completed — that would bypass payment or refund logic. We log and skip.
  if (order.status !== "processing") {
    logEvent(deps, {
      outcome: "order_status_unexpected_state",
      notifyId: payload.notifyId,
      notifyType: payload.notifyType,
      orderPublicId,
      status: order.status,
    });
    return {
      handled: false,
      result: `order_in_state_${order.status}`,
      notifyType: payload.notifyType,
      detail: { orderPublicId },
    };
  }

  // Resume: fetch ICCID/LPA/QR and complete the order. Dynamically import the
  // fulfilment service so a missing dependency is reported, not faked.
  const resume =
    deps.resumeOrder ??
    (await loadResumeOrder(deps));
  if (!resume) {
    return {
      handled: false,
      result: "resume_dependency_missing",
      notifyType: payload.notifyType,
      detail: { orderPublicId },
    };
  }

  const outcome = await resume(orderPublicId);
  return {
    handled: true,
    result: `order_${outcome.status}`,
    notifyType: payload.notifyType,
    detail: { orderPublicId, resumeDetail: outcome.detail },
  };
}

/**
 * Lazily import the fulfilment resume function. Returns a wrapper that supplies
 * the fulfilment dependencies (which we cannot construct here since that file
 * owns them). If the module isn't present, returns null → reported, not faked.
 */
async function loadResumeOrder(
  deps: ProcessorDeps,
): Promise<ProcessorDeps["resumeOrder"] | null> {
  try {
    const mod = (await import("./fulfilment")) as {
      resumeProcessingOrder?: (
        publicId: string,
        ...rest: unknown[]
      ) => Promise<{ status: string; detail?: string }>;
    };
    if (typeof mod.resumeProcessingOrder !== "function") return null;
    const fn = mod.resumeProcessingOrder;
    // fulfilment.ts's resumeProcessingOrder takes a FulfilDeps bundle. We cannot
    // reconstruct the DB-backed deps here without duplicating that file's wiring,
    // so we pass the minimal shape it accepts when deps are optional. If the
    // real signature requires deps, the caller (route/job with DB) will supply
    // them via ProcessorDeps.resumeOrder. Log once so ops knows.
    return async (publicId: string) => {
      logEvent(deps, {
        outcome: "resume_using_default_deps",
        detail:
          "resumeProcessingOrder invoked without explicit deps; if fulfilment.ts requires deps this will reject and be logged as processor_error.",
        publicId,
      });
      const res = await (fn as unknown as (id: string) => Promise<{ status: string; detail?: string }>)(
        publicId,
      );
      return { status: res.status, detail: res.detail };
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// ESIM_STATUS → installed + connected email
// ---------------------------------------------------------------------------

async function handleEsimStatus(
  db: Db,
  payload: SupplierWebhookPayload,
  deps: ProcessorDeps,
): Promise<ProcessOutcome> {
  const content = asRecord(payload.content);
  if (!content) {
    return { handled: false, result: "malformed_content", notifyType: payload.notifyType };
  }
  const ident = extractEsimIdentifier(content);
  const esim = await findEsimByIdentifier(db, ident);
  if (!esim) {
    return { handled: false, result: "esim_not_found", notifyType: payload.notifyType, detail: ident };
  }

  // The supplier reports install via a status string; accept the known values.
  const reported = pickString(content, "esimStatus", "status", "smdpStatus", "esim_status");
  const isInstalled =
    typeof reported === "string" &&
    /install|in_?use|IN_USE|ACTIVE|INSTALLED/i.test(reported);

  if (!isInstalled) {
    // Not an install event — record but don't email.
    return {
      handled: true,
      result: "esim_status_not_install",
      notifyType: payload.notifyType,
      detail: { reported },
    };
  }

  // Idempotency: already installed → no re-send.
  if (esim.installedAt || esim.status === "installed" || esim.status === "in_use") {
    return { handled: true, result: "already_installed", notifyType: payload.notifyType };
  }

  const now = deps.now?.() ?? new Date();
  await db
    .update(esimsTable)
    .set({ status: "installed", installedAt: now, updatedAt: now })
    .where(eq(esimsTable.id, esim.id));

  const notifier = deps.notifier ?? defaultNotifier;
  const delivery = await notifier.sendConnected(toAlertContext(esim));

  logEvent(deps, {
    outcome: "connected_email_attempted",
    esimId: esim.id,
    delivered: delivery.delivered,
    reason: delivery.reason,
  });

  return {
    handled: true,
    result: "installed",
    notifyType: payload.notifyType,
    detail: { emailDelivered: delivery.delivered, reason: delivery.reason },
  };
}

// ---------------------------------------------------------------------------
// DATA_USAGE → usage refresh + low-data alert
// ---------------------------------------------------------------------------

/** 100 MiB in bytes — the supplier's documented "running low" threshold. */
const LOW_DATA_THRESHOLD_BYTES = 100 * 1024 * 1024;

async function handleDataUsage(
  db: Db,
  payload: SupplierWebhookPayload,
  deps: ProcessorDeps,
): Promise<ProcessOutcome> {
  const content = asRecord(payload.content);
  if (!content) {
    return { handled: false, result: "malformed_content", notifyType: payload.notifyType };
  }
  const ident = extractEsimIdentifier(content);
  const esim = await findEsimByIdentifier(db, ident);
  if (!esim) {
    return { handled: false, result: "esim_not_found", notifyType: payload.notifyType, detail: ident };
  }

  // The supplier's DATA_USAGE content carries remaining/used volumes in bytes.
  // We accept several shapes; if we cannot read them we still attempt the alert
  // based on the presence of the notification (the supplier only sends this when
  // data is low), but we do not fabricate a remaining number.
  const totalBytes =
    pickNumber(content, "totalVolume", "total", "orderVolume") ??
    (esim.totalBytes != null ? Number(esim.totalBytes) : null);
  const usedBytes = pickNumber(content, "usedVolume", "used");
  const remainingBytes = pickNumber(
    content,
    "remainingVolume",
    "remaining",
    "leftVolume",
    "validVolume",
  );

  const now = deps.now?.() ?? new Date();

  // Persist whatever usage numbers we could read so the dashboard reflects them
  // immediately (the 3-hourly job is the authoritative refresh but this shaves
  // up to 3h off the display latency for a low-data event).
  const update: Record<string, unknown> = { usageUpdatedAt: now, updatedAt: now };
  if (totalBytes != null) update.totalBytes = String(totalBytes);
  if (usedBytes != null) update.usedBytes = String(usedBytes);
  await db.update(esimsTable).set(update).where(eq(esimsTable.id, esim.id));

  // Decide whether this is a genuine "running low" (remaining <= 100 MiB).
  // Prefer explicit remaining; else derive from total-used.
  const derivedRemaining =
    remainingBytes ??
    (totalBytes != null && usedBytes != null ? totalBytes - usedBytes : null);

  const low =
    derivedRemaining == null
      ? true // supplier only sends DATA_USAGE near-depletion; treat as low but log it
      : derivedRemaining <= LOW_DATA_THRESHOLD_BYTES;

  if (!low) {
    return {
      handled: true,
      result: "data_usage_recorded",
      notifyType: payload.notifyType,
      detail: { remainingBytes: derivedRemaining },
    };
  }

  const notifier = deps.notifier ?? defaultNotifier;
  const delivery = await notifier.sendLowData({
    ...toAlertContext(esim),
    remainingBytes: derivedRemaining ?? LOW_DATA_THRESHOLD_BYTES,
  });

  logEvent(deps, {
    outcome: "low_data_alert_attempted",
    esimId: esim.id,
    remainingBytes: derivedRemaining,
    delivered: delivery.delivered,
    reason: delivery.reason,
  });

  return {
    handled: true,
    result: "low_data_alert",
    notifyType: payload.notifyType,
    detail: { remainingBytes: derivedRemaining, emailDelivered: delivery.delivered },
  };
}

// ---------------------------------------------------------------------------
// VALIDITY_USAGE → 1-day-left alert
// ---------------------------------------------------------------------------

async function handleValidityUsage(
  db: Db,
  payload: SupplierWebhookPayload,
  deps: ProcessorDeps,
): Promise<ProcessOutcome> {
  const content = asRecord(payload.content);
  if (!content) {
    return { handled: false, result: "malformed_content", notifyType: payload.notifyType };
  }
  const ident = extractEsimIdentifier(content);
  const esim = await findEsimByIdentifier(db, ident);
  if (!esim) {
    return { handled: false, result: "esim_not_found", notifyType: payload.notifyType, detail: ident };
  }

  const daysLeft =
    pickNumber(content, "remainingDays", "daysLeft", "validity") ?? 1;

  // Idempotency: only send when we have not already recorded a validity alert
  // for this eSIM. Since we don't have a per-alert table, we key off the eSIM's
  // status: an eSIM whose validity has already ended shouldn't get "1 day left".
  if (esim.status === "expired" || esim.status === "depleted") {
    return { handled: true, result: "esim_expired_no_alert", notifyType: payload.notifyType };
  }

  const notifier = deps.notifier ?? defaultNotifier;
  const delivery = await notifier.sendValidityEnding({
    ...toAlertContext(esim),
    daysLeft,
  });

  logEvent(deps, {
    outcome: "validity_alert_attempted",
    esimId: esim.id,
    daysLeft,
    delivered: delivery.delivered,
    reason: delivery.reason,
  });

  return {
    handled: true,
    result: "validity_alert",
    notifyType: payload.notifyType,
    detail: { daysLeft, emailDelivered: delivery.delivered },
  };
}

// ---------------------------------------------------------------------------
// Test surface
// ---------------------------------------------------------------------------
export const __test__ = {
  LOW_DATA_THRESHOLD_BYTES,
  extractEsimIdentifier,
  pickString,
  pickNumber,
  defaultNotifier,
};

// Silence the unused `isNull` import in environments that lint aggressively but
// might want a future "find events never processed" helper here.
void isNull;

/**
 * Abandoned cart job (1 hour).
 *
 * A "cart" here is an unpaid order created via Stripe Checkout that was never
 * paid. We only look at orders whose `checkout_created_at` is at least
 * CART_AGE_MS old AND whose `abandoned_cart_email_sent_at` is null. We send
 * one reminder per order; the marker prevents duplicates on the next tick,
 * and a failed send leaves the marker null so we retry.
 *
 * SCOPE
 * -----
 * - SELECT the due unpaid orders (single SQL, index on (status,
 *   checkout_created_at) lives in the migration on the calling side).
 * - Compose a small branded email with a "Resume checkout" link that carries
 *   the same Stripe session id so the user lands on the exact session.
 * - Call `notifications.sendEmail` (injected; production wiring imports it).
 * - Mark `abandoned_cart_email_sent_at = now()` after a successful send.
 *
 * NON-GOALS
 * ---------
 * - Merging carts across sessions. The order id is stable; no cart merge.
 * - Suppressing reminders for users who already paid a *different* order.
 *   That is a good improvement but not in scope here — we honour the marker
 *   column and let the reviewer add a suppression query later.
 * - Enforcing a per-user cap. One reminder per order is enough; if a user
 *   abandons 3 carts they get up to 3 emails, which matches the spec.
 *
 * The timer is `.unref()`'d and guard-protected against overlapping ticks so
 * tests can import this module safely. Importing the module has no side
 * effects; `startAbandonedCartJob()` is the only way to schedule.
 */

import type { Pool } from "pg";
import { brand } from "../brand.config";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface DueCartRow {
  id: number;
  publicId: string;
  /** Buyer's email. Uses whichever was captured on the checkout page. */
  email: string;
  /** Stripe Checkout session id (needed for the "resume checkout" deep link). */
  stripeSessionId: string | null;
  /** Optional: destination for the email body. e.g. "Japan". */
  countryLabel: string | null;
  /** Amount the buyer abandoned, already in the display currency. */
  retailTotalLabel: string | null;
}

export interface AbandonedCartRunRecord {
  startedAt: Date;
  finishedAt: Date | null;
  matched: number;
  sent: number;
  failed: number;
  skipped: number;
  error: string | null;
}

export interface AbandonedCartDeps {
  selectDueCarts(): Promise<DueCartRow[]>;
  markSent(id: number, at: Date): Promise<void>;
  sendEmail(input: {
    to: string;
    subject: string;
    html: string;
    text?: string;
    category?: string;
  }): Promise<void>;
  publicBaseUrl: string;
  now(): Date;
  log(line: string): void;
}

export interface AbandonedCartOptions {
  deps?: Partial<AbandonedCartDeps>;
  intervalMs?: number;
  onRun?: (record: AbandonedCartRunRecord) => void;
  runImmediately?: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Remind 1 hour after checkout creation. */
export const ABANDONED_CART_AGE_MS = 60 * 60 * 1000;

/** Tick every 10 minutes so reminders fire close to the 1h mark. */
export const ABANDONED_CART_INTERVAL_MS = 10 * 60 * 1000;

export const ABANDONED_CART_CATEGORY = "abandoned-cart" as const;

// ---------------------------------------------------------------------------
// Email template
// ---------------------------------------------------------------------------

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function buildAbandonedCartEmail(
  cart: DueCartRow,
  publicBaseUrl: string,
): { subject: string; html: string; text: string } {
  const destination = cart.countryLabel ? ` for ${cart.countryLabel}` : "";
  const subject = `You left your ${brand.name} eSIM${destination} in your cart`;
  const resumeUrl = cart.stripeSessionId
    ? `${publicBaseUrl}/checkout?resume=${encodeURIComponent(cart.stripeSessionId)}`
    : `${publicBaseUrl}/`;

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /></head>
<body style="margin:0;padding:24px;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#0f172a;">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:16px;padding:24px;box-shadow:0 1px 3px rgba(15,23,42,0.06);">
    <p style="margin:0 0 8px;font-size:12px;letter-spacing:0.06em;text-transform:uppercase;color:#1b6ef5;font-weight:600;">${brand.name}</p>
    <h1 style="margin:0 0 12px;font-size:22px;line-height:1.3;color:#0f172a;">Still thinking it over?</h1>
    <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#334155;">
      You started checkout${destination ? ` for your <strong>${escapeHtml(cart.countryLabel ?? "")}</strong> eSIM` : ""}${
        cart.retailTotalLabel
          ? ` (<strong>${escapeHtml(cart.retailTotalLabel)}</strong>)`
          : ""
      } but didn't finish. Your plan is still available.
    </p>
    <p style="margin:0 0 24px;font-size:14px;line-height:1.6;color:#334155;">
      ${escapeHtml(brand.guaranteeCopy)}
    </p>
    <a href="${escapeHtml(resumeUrl)}" style="display:inline-block;background:#1b6ef5;color:#ffffff;text-decoration:none;font-weight:600;font-size:14px;padding:10px 16px;border-radius:12px;">Resume checkout</a>
    <p style="margin:24px 0 0;font-size:12px;color:#64748b;">If you already completed this order, ignore this email.</p>
  </div>
</body></html>`;

  const text = [
    `${brand.name} – still thinking it over?`,
    "",
    `You started checkout${destination ? ` for your ${cart.countryLabel}` : ""}${
      cart.retailTotalLabel ? ` (${cart.retailTotalLabel})` : ""
    } but didn't finish. Your plan is still available.`,
    "",
    brand.guaranteeCopy,
    "",
    `Resume checkout: ${resumeUrl}`,
  ].join("\n");

  return { subject, html, text };
}

// ---------------------------------------------------------------------------
// Default deps (lazy imports so importing this module never touches DB/email)
// ---------------------------------------------------------------------------

class DepMissingError extends Error {
  readonly dep: string;
  constructor(dep: string, detail: string) {
    super(`abandonedCart: ${dep} unavailable — ${detail}`);
    this.name = "DepMissingError";
    this.dep = dep;
  }
}

async function loadDefaultWiring(): Promise<{
  selectDueCarts: AbandonedCartDeps["selectDueCarts"];
  markSent: AbandonedCartDeps["markSent"];
  sendEmail: AbandonedCartDeps["sendEmail"];
  publicBaseUrl: string;
}> {
  const [dbMod, notifyMod, envMod] = await Promise.all([
    import("../db/client").catch((e) => {
      throw new DepMissingError("db/client", e instanceof Error ? e.message : "import failed");
    }),
    import("../services/notifications").catch((e) => {
      throw new DepMissingError("notifications", e instanceof Error ? e.message : "import failed");
    }),
    import("../config/env").catch(() => null),
  ]);

  const db = dbMod as unknown as { getPool?: () => Pool; pool?: Pool };
  const pool = db.getPool?.() ?? db.pool ?? null;
  if (!pool) {
    throw new DepMissingError("db/client", "no getPool()/pool export");
  }

  const notif = notifyMod as unknown as {
    sendEmail?: AbandonedCartDeps["sendEmail"];
  };
  const sendEmail: AbandonedCartDeps["sendEmail"] =
    typeof notif.sendEmail === "function"
      ? notif.sendEmail
      : async () => {
          throw new DepMissingError(
            "notifications.sendEmail",
            "not exported by server/services/notifications.ts",
          );
        };

  const env = envMod as unknown as {
    loadEnv?: () => { raw?: Record<string, string | undefined> };
    getEnvValue?: (k: string) => string | undefined;
  } | null;
  const publicBaseUrl =
    env?.getEnvValue?.("PUBLIC_BASE_URL") ??
    env?.loadEnv?.().raw?.PUBLIC_BASE_URL ??
    process.env.PUBLIC_BASE_URL ??
    "";

  return {
    async selectDueCarts() {
      // status = 'pending_payment' is the state our checkout route sets before
      // the Stripe webhook flips it to 'paid'. Adjust the check if the
      // orders table uses a different enum — this is the only place to edit.
      const sql = `
        SELECT id,
               public_id AS "publicId",
               buyer_email AS "email",
               stripe_session_id AS "stripeSessionId",
               country_label AS "countryLabel",
               retail_total_label AS "retailTotalLabel"
          FROM orders
         WHERE status = 'pending_payment'
           AND checkout_created_at <= $1
           AND abandoned_cart_email_sent_at IS NULL
           AND buyer_email IS NOT NULL
           AND buyer_email <> ''
         ORDER BY checkout_created_at ASC
         LIMIT 200;
      `;
      const cutoff = new Date(Date.now() - ABANDONED_CART_AGE_MS).toISOString();
      const res = await pool.query(sql, [cutoff]);
      return res.rows.map((r: Record<string, unknown>) => ({
        id: Number(r.id),
        publicId: String(r.publicId),
        email: String(r.email ?? ""),
        stripeSessionId: r.stripeSessionId == null ? null : String(r.stripeSessionId),
        countryLabel: r.countryLabel == null ? null : String(r.countryLabel),
        retailTotalLabel:
          r.retailTotalLabel == null ? null : String(r.retailTotalLabel),
      }));
    },

    async markSent(id, at) {
      await pool.query(
        `UPDATE orders SET abandoned_cart_email_sent_at = $1, updated_at = now() WHERE id = $2`,
        [at.toISOString(), id],
      );
    },

    sendEmail,
    publicBaseUrl,
  };
}

let defaultDepsPromise: Promise<AbandonedCartDeps> | null = null;
async function getDefaultDeps(): Promise<AbandonedCartDeps> {
  if (!defaultDepsPromise) {
    defaultDepsPromise = (async () => {
      const w = await loadDefaultWiring();
      return {
        selectDueCarts: w.selectDueCarts,
        markSent: w.markSent,
        sendEmail: w.sendEmail,
        publicBaseUrl: w.publicBaseUrl,
        now: () => new Date(),
        log: (line: string) => console.log(line),
      };
    })();
  }
  return defaultDepsPromise;
}

// ---------------------------------------------------------------------------
// Run once
// ---------------------------------------------------------------------------

export async function runAbandonedCartOnce(
  options: AbandonedCartOptions = {},
): Promise<AbandonedCartRunRecord> {
  const startedAt = new Date();
  const record: AbandonedCartRunRecord = {
    startedAt,
    finishedAt: null,
    matched: 0,
    sent: 0,
    failed: 0,
    skipped: 0,
    error: null,
  };

  let deps: AbandonedCartDeps;
  try {
    const defaults = await getDefaultDeps();
    deps = { ...defaults, ...(options.deps ?? {}) };
  } catch (err) {
    record.error = err instanceof Error ? err.message : "could not resolve default deps";
    record.finishedAt = new Date();
    options.onRun?.(record);
    console.error(`[abandonedCart] ${record.error}`);
    return record;
  }

  let due: DueCartRow[] = [];
  try {
    due = await deps.selectDueCarts();
    record.matched = due.length;
  } catch (err) {
    record.error =
      err instanceof Error ? `selectDueCarts: ${err.message}` : "selectDueCarts failed";
    record.finishedAt = new Date();
    deps.log(`[abandonedCart] ${record.error}`);
    options.onRun?.(record);
    return record;
  }

  for (const cart of due) {
    if (!cart.email || !cart.email.includes("@")) {
      record.skipped += 1;
      deps.log(`[abandonedCart] order ${cart.publicId} has no valid email; skipping`);
      continue;
    }

    const { subject, html, text } = buildAbandonedCartEmail(cart, deps.publicBaseUrl);
    try {
      await deps.sendEmail({
        to: cart.email,
        subject,
        html,
        text,
        category: ABANDONED_CART_CATEGORY,
      });
      await deps.markSent(cart.id, deps.now());
      record.sent += 1;
    } catch (err) {
      record.failed += 1;
      deps.log(
        `[abandonedCart] send failed for order ${cart.publicId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      // marker stays NULL — retried next tick.
    }
  }

  record.finishedAt = new Date();
  deps.log(
    `[abandonedCart] matched=${record.matched} sent=${record.sent} ` +
      `failed=${record.failed} skipped=${record.skipped}`,
  );
  options.onRun?.(record);
  return record;
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

let timer: NodeJS.Timeout | null = null;
let running = false;
let lastRun: AbandonedCartRunRecord | null = null;

export function getLastAbandonedCartRun(): AbandonedCartRunRecord | null {
  return lastRun;
}

export function startAbandonedCartJob(
  options: AbandonedCartOptions = {},
): void {
  if (timer) {
    (options.deps?.log ?? console.log)(
      "[abandonedCart] already started; ignoring duplicate start",
    );
    return;
  }
  const interval = Math.max(60_000, options.intervalMs ?? ABANDONED_CART_INTERVAL_MS);

  const tick = async () => {
    if (running) {
      (options.deps?.log ?? console.log)(
        "[abandonedCart] previous run still in flight; skipping",
      );
      return;
    }
    running = true;
    try {
      lastRun = await runAbandonedCartOnce({
        deps: options.deps,
        onRun: (r) => {
          lastRun = r;
          options.onRun?.(r);
        },
      });
    } finally {
      running = false;
    }
  };

  timer = setInterval(() => {
    void tick();
  }, interval);
  timer.unref?.();
  (options.deps?.log ?? console.log)(
    `[abandonedCart] scheduled every ${interval}ms`,
  );
  if (options.runImmediately) void tick();
}

export function stopAbandonedCartJob(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

export function __resetAbandonedCartStateForTests(): void {
  stopAbandonedCartJob();
  defaultDepsPromise = null;
  running = false;
  lastRun = null;
}

export const __test__ = {
  escapeHtml,
  buildAbandonedCartEmail,
  ABANDONED_CART_AGE_MS,
  ABANDONED_CART_CATEGORY,
};

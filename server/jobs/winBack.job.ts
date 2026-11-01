/**
 * Win-back job (after 90 days inactive).
 *
 * "Inactive" is defined as: the buyer has at least one PAID order in their
 * history, has NOT had a paid order in the last 90 days, and has NOT been
 * sent a win-back email for their current inactivity window. The
 * `win_back_email_sent_at` marker on `users` is compared against the user's
 * last paid order so a returning buyer becomes eligible again 90 days after
 * *that* order — not permanently once they've received one email.
 *
 * Guests without an account row:
 * - We do NOT spam guests at an email-only cadence. If a user row exists,
 *   we honour the marker. If not (guest checkout), we skip: win-back is
 *   account-holder retention, not guest email farming.
 *
 * SCOPE
 * -----
 * - SELECT eligible users (single query; index on `orders(buyer_email,
 *   created_at)` and `users(win_back_email_sent_at)` on the migration side).
 * - Send a branded "we miss you" email with a small percentage-off code
 *   (the code generator is admin-owned; here we just build the URL to the
 *   homepage, and the marketing copy invites them to check current offers).
 *   We do NOT invent a discount code — the email intentionally omits one so
 *   it isn't a fake promise.
 * - Push channel is not used (retention is email cadence).
 *
 * Scheduler semantics mirror the other lifecycle jobs.
 */

import type { Pool } from "pg";
import { brand } from "../brand.config";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DueWinBackRow {
  userId: number;
  email: string;
  displayName: string | null;
  /** The user's most recent paid order (for the personalisation blurb). */
  lastCountryLabel: string | null;
  lastOrderAt: Date;
  /** Days since last paid order (computed on the SQL side so tests see it). */
  daysInactive: number;
}

export interface WinBackRunRecord {
  startedAt: Date;
  finishedAt: Date | null;
  matched: number;
  sent: number;
  failed: number;
  skipped: number;
  error: string | null;
}

export interface WinBackDeps {
  selectDueUsers(): Promise<DueWinBackRow[]>;
  markSent(userId: number, at: Date): Promise<void>;
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

export interface WinBackOptions {
  deps?: Partial<WinBackDeps>;
  intervalMs?: number;
  onRun?: (record: WinBackRunRecord) => void;
  runImmediately?: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** 90 days of inactivity grows back eligible again after the next order. */
export const WIN_BACK_INACTIVE_DAYS = 90;

/** Daily tick. */
export const WIN_BACK_INTERVAL_MS = 24 * 60 * 60 * 1000;

export const WIN_BACK_CATEGORY = "win-back" as const;

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

export function buildWinBackEmail(
  row: DueWinBackRow,
  publicBaseUrl: string,
): { subject: string; html: string; text: string } {
  const name = row.displayName?.trim() || "there";
  const subjectFrom = row.lastCountryLabel
    ? `Heading somewhere new? Start from where you left off`
    : `Ready for your next trip?`;
  const subject = `${brand.name} – ${subjectFrom}`;
  const homeUrl = `${publicBaseUrl}/`;
  const plannerUrl = `${publicBaseUrl}/trip-planner`;

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /></head>
<body style="margin:0;padding:24px;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#0f172a;">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:16px;padding:24px;box-shadow:0 1px 3px rgba(15,23,42,0.06);">
    <p style="margin:0 0 8px;font-size:12px;letter-spacing:0.06em;text-transform:uppercase;color:#1b6ef5;font-weight:600;">${brand.name}</p>
    <h1 style="margin:0 0 12px;font-size:22px;line-height:1.3;color:#0f172a;">Hi ${escapeHtml(name)}, it's been a while</h1>
    <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#334155;">
      ${
        row.lastCountryLabel
          ? `Last trip: <strong>${escapeHtml(row.lastCountryLabel)}</strong>. Ready for the next one?`
          : "Ready for the next one?"
      }
      Our travel planner can build a day-by-day plan in seconds and recommend the right eSIM for wherever you're headed.
    </p>
    <a href="${escapeHtml(plannerUrl)}" style="display:inline-block;background:#1b6ef5;color:#ffffff;text-decoration:none;font-weight:600;font-size:14px;padding:10px 16px;border-radius:12px;margin:0 8px 8px 0;">Plan a trip</a>
    <a href="${escapeHtml(homeUrl)}" style="display:inline-block;background:#ffffff;color:#1b6ef5;text-decoration:none;font-weight:600;font-size:14px;padding:10px 16px;border-radius:12px;border:1px solid #1b6ef5;margin:0 0 8px 0;">Browse eSIMs</a>
    <p style="margin:24px 0 0;font-size:12px;color:#64748b;">
      Don't want these emails? You can unsubscribe from your account page.
    </p>
  </div>
</body></html>`;

  const text = [
    `${brand.name} – hi ${name}, it's been a while`,
    "",
    row.lastCountryLabel
      ? `Last trip: ${row.lastCountryLabel}. Ready for the next one?`
      : "Ready for the next one?",
    "Our travel planner can build a day-by-day plan in seconds:",
    plannerUrl,
    "",
    `Browse eSIMs: ${homeUrl}`,
  ].join("\n");

  return { subject, html, text };
}

// ---------------------------------------------------------------------------
// Default deps
// ---------------------------------------------------------------------------

class DepMissingError extends Error {
  readonly dep: string;
  constructor(dep: string, detail: string) {
    super(`winBack: ${dep} unavailable — ${detail}`);
    this.name = "DepMissingError";
    this.dep = dep;
  }
}

async function loadDefaultWiring(): Promise<{
  selectDueUsers: WinBackDeps["selectDueUsers"];
  markSent: WinBackDeps["markSent"];
  sendEmail: WinBackDeps["sendEmail"];
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
  if (!pool) throw new DepMissingError("db/client", "no getPool()/pool export");

  const notif = notifyMod as unknown as {
    sendEmail?: WinBackDeps["sendEmail"];
  };
  const sendEmail: WinBackDeps["sendEmail"] =
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
    async selectDueUsers() {
      // The user must have a paid order older than 90 days, no paid order in
      // the last 90 days, and the win-back marker (if set) must predate
      // their last paid order — i.e. they've come back once and are now
      // inactive again. Guests without a users row are excluded.
      const sql = `
        WITH paid AS (
          SELECT LOWER(buyer_email) AS email,
                 MAX(created_at)    AS last_paid_at,
                 (SELECT country_label
                    FROM orders o2
                   WHERE LOWER(o2.buyer_email) = LOWER(o.buyer_email)
                     AND o2.status = 'paid'
                   ORDER BY o2.created_at DESC
                   LIMIT 1)         AS last_country_label
            FROM orders o
           WHERE status = 'paid'
             AND buyer_email IS NOT NULL
           GROUP BY LOWER(buyer_email)
        )
        SELECT u.id                                         AS "userId",
               u.email                                      AS "email",
               u.display_name                               AS "displayName",
               p.last_country_label                         AS "lastCountryLabel",
               p.last_paid_at                               AS "lastOrderAt",
               EXTRACT(EPOCH FROM (now() - p.last_paid_at)) / 86400.0
                                                            AS "daysInactive"
          FROM users u
          JOIN paid p ON LOWER(p.email) = LOWER(u.email)
         WHERE p.last_paid_at <= now() - ($1 || ' days')::interval
           AND (
                 u.win_back_email_sent_at IS NULL
                 OR u.win_back_email_sent_at < p.last_paid_at
               )
           AND u.email IS NOT NULL
           AND u.email <> ''
         ORDER BY p.last_paid_at ASC
         LIMIT 200;
      `;
      const res = await pool.query(sql, [String(WIN_BACK_INACTIVE_DAYS)]);
      return res.rows.map((r: Record<string, unknown>) => ({
        userId: Number(r.userId),
        email: String(r.email ?? ""),
        displayName: r.displayName == null ? null : String(r.displayName),
        lastCountryLabel:
          r.lastCountryLabel == null ? null : String(r.lastCountryLabel),
        lastOrderAt: new Date(String(r.lastOrderAt)),
        daysInactive: Number(r.daysInactive ?? 0),
      }));
    },

    async markSent(userId, at) {
      await pool.query(
        `UPDATE users SET win_back_email_sent_at = $1, updated_at = now() WHERE id = $2`,
        [at.toISOString(), userId],
      );
    },

    sendEmail,
    publicBaseUrl,
  };
}

let defaultDepsPromise: Promise<WinBackDeps> | null = null;
async function getDefaultDeps(): Promise<WinBackDeps> {
  if (!defaultDepsPromise) {
    defaultDepsPromise = (async () => {
      const w = await loadDefaultWiring();
      return {
        selectDueUsers: w.selectDueUsers,
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

export async function runWinBackOnce(
  options: WinBackOptions = {},
): Promise<WinBackRunRecord> {
  const startedAt = new Date();
  const record: WinBackRunRecord = {
    startedAt,
    finishedAt: null,
    matched: 0,
    sent: 0,
    failed: 0,
    skipped: 0,
    error: null,
  };

  let deps: WinBackDeps;
  try {
    const defaults = await getDefaultDeps();
    deps = { ...defaults, ...(options.deps ?? {}) };
  } catch (err) {
    record.error = err instanceof Error ? err.message : "could not resolve default deps";
    record.finishedAt = new Date();
    options.onRun?.(record);
    console.error(`[winBack] ${record.error}`);
    return record;
  }

  let due: DueWinBackRow[] = [];
  try {
    due = await deps.selectDueUsers();
    record.matched = due.length;
  } catch (err) {
    record.error =
      err instanceof Error ? `selectDueUsers: ${err.message}` : "selectDueUsers failed";
    record.finishedAt = new Date();
    deps.log(`[winBack] ${record.error}`);
    options.onRun?.(record);
    return record;
  }

  for (const row of due) {
    if (!row.email || !row.email.includes("@")) {
      record.skipped += 1;
      deps.log(`[winBack] user ${row.userId} has no valid email; skipping`);
      continue;
    }
    const { subject, html, text } = buildWinBackEmail(row, deps.publicBaseUrl);
    try {
      await deps.sendEmail({
        to: row.email,
        subject,
        html,
        text,
        category: WIN_BACK_CATEGORY,
      });
      await deps.markSent(row.userId, deps.now());
      record.sent += 1;
    } catch (err) {
      record.failed += 1;
      deps.log(
        `[winBack] send failed for user ${row.userId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  record.finishedAt = new Date();
  deps.log(
    `[winBack] matched=${record.matched} sent=${record.sent} ` +
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
let lastRun: WinBackRunRecord | null = null;

export function getLastWinBackRun(): WinBackRunRecord | null {
  return lastRun;
}

export function startWinBackJob(options: WinBackOptions = {}): void {
  if (timer) {
    (options.deps?.log ?? console.log)(
      "[winBack] already started; ignoring duplicate start",
    );
    return;
  }
  const interval = Math.max(60_000, options.intervalMs ?? WIN_BACK_INTERVAL_MS);

  const tick = async () => {
    if (running) {
      (options.deps?.log ?? console.log)(
        "[winBack] previous run still in flight; skipping",
      );
      return;
    }
    running = true;
    try {
      lastRun = await runWinBackOnce({
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
    `[winBack] scheduled every ${interval}ms`,
  );
  if (options.runImmediately) void tick();
}

export function stopWinBackJob(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

export function __resetWinBackStateForTests(): void {
  stopWinBackJob();
  defaultDepsPromise = null;
  running = false;
  lastRun = null;
}

export const __test__ = {
  escapeHtml,
  buildWinBackEmail,
  WIN_BACK_INACTIVE_DAYS,
  WIN_BACK_CATEGORY,
};

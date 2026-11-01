/**
 * Notifications service — implements the `Notifier` interface that
 * `server/services/webhookProcessor.ts` consumes for three supplier events:
 *
 *   sendConnected(esim)                → "You're connected" (ESIM_STATUS installed)
 *   sendLowData(esim + remainingBytes) → "Running low, top up now" (DATA_USAGE ≤ 100 MiB)
 *   sendValidityEnding(esim + daysLeft)→ "1 day left, extend now" (VALIDITY_USAGE)
 *
 * Each call:
 *   1. Builds a rendered email via `makeEmailSender().sendRawEmail` using the
 *      templates defined inline (kept small + pure, no external template file
 *      imports so this phase can ship without touching giftEmail/installEmail).
 *   2. Looks up the user's push subscriptions from `push_subscriptions` and
 *      sends a matching web push via `server/lib/push.ts`.
 *   3. Reports a combined `DeliveryReport` (email + push). Either channel
 *      succeeding yields `{ delivered: true }`; both failing yields
 *      `{ delivered: false, reason }`. The processor logs this — never the
 *      reverse (no fabricated delivery).
 *
 * Table assumption (schema.ts not visible to me):
 *   push_subscriptions (
 *     id            serial primary key,
 *     user_id       integer references users(id) on delete cascade,
 *     endpoint      text not null unique,
 *     p256dh        text not null,
 *     auth          text not null,
 *     user_agent    text,
 *     created_at    timestamptz not null default now(),
 *     updated_at    timestamptz not null default now()
 *   )
 * If the schema differs, adjust `loadPushSubscriptions` only — nothing else
 * touches that table.
 *
 * Top-up link format: `/topup/<esimTranNo>` (route lives in the top-ups phase).
 * Install path is on `EsimAlertContext.installPath` and is trusted verbatim.
 */
import { eq } from "drizzle-orm";
import { brand, absoluteUrl } from "../brand.config";
import { getDb } from "../db/client";
import { getEmailSender, type DeliveryResult } from "../lib/emailSender";
import { sendWebPush, isPushConfigured, type PushSubscriptionRecord } from "../lib/push";
import type {
  DeliveryReport,
  EsimAlertContext,
  Notifier,
} from "./webhookProcessor";

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------

export interface NotificationDeps {
  getDb?: typeof getDb;
  /** Inject for tests (records calls without touching DB or provider). */
  emailSender?: ReturnType<typeof getEmailSender>;
  sendPush?: typeof sendWebPush;
  log?: (line: string) => void;
  /** Absolute base URL used to build click-through links. */
  publicBaseUrl?: string;
}

function logLine(deps: NotificationDeps, event: Record<string, unknown>): void {
  const log = deps.log ?? ((line: string) => console.log(line));
  log(
    JSON.stringify({
      at: new Date().toISOString(),
      channel: "notifications",
      ...event,
    }),
  );
}

function resolveBaseUrl(deps: NotificationDeps): string {
  const base = (deps.publicBaseUrl ?? process.env.PUBLIC_BASE_URL ?? "").trim();
  // Return as-is; `absoluteUrl` handles an empty base by returning a path.
  return base;
}

/**
 * Build a `Notifier` that the webhook processor uses by default.
 * Returned object holds the three methods the processor calls.
 */
export function makeNotifier(deps: NotificationDeps = {}): Notifier {
  const email = deps.emailSender ?? getEmailSender();
  const push = deps.sendPush ?? sendWebPush;

  return {
    async sendConnected(esim) {
      return dispatch(deps, {
        kind: "connected",
        esim,
        subject: `${brand.name}: you're connected`,
        heading: "You're connected",
        intro:
          "Your eSIM is installed and turned on. When you land, set this eSIM as your mobile data line and data roaming is already handled — no extra setup needed.",
        ctaLabel: "Open My eSIMs",
        ctaPath: "/my-esims",
        pushTitle: "You're connected",
        pushBody: "Your eSIM is live. Tap to see your plan.",
      });
    },

    async sendLowData(esim) {
      const tran = esim.esimTranNo ?? "";
      const topUpPath = tran ? `/topup/${encodeURIComponent(tran)}` : "/my-esims";
      return dispatch(deps, {
        kind: "low_data",
        esim,
        subject: `${brand.name}: running low on data`,
        heading: "Running low on data",
        intro:
          "You have 100 MB or less left on your plan. Top up in one click to keep using maps and messages.",
        ctaLabel: "Top up now",
        ctaPath: topUpPath,
        pushTitle: "Running low on data",
        pushBody: "Top up in one tap to keep your connection.",
        pushTag: `low-data:${esim.esimId}`,
        topUpEligible: Boolean(tran),
      });
    },

    async sendValidityEnding(esim) {
      const tran = esim.esimTranNo ?? "";
      const topUpPath = tran ? `/topup/${encodeURIComponent(tran)}` : "/my-esims";
      return dispatch(deps, {
        kind: "validity",
        esim,
        subject: `${brand.name}: 1 day left — extend now`,
        heading: "One day left",
        intro:
          "Your plan expires tomorrow. Extend it now to keep the same plan without re-installing on your phone.",
        ctaLabel: "Extend plan",
        ctaPath: topUpPath,
        pushTitle: "1 day left",
        pushBody: "Extend your plan to stay connected.",
        pushTag: `validity:${esim.esimId}`,
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Shared dispatch
// ---------------------------------------------------------------------------

interface DispatchArgs {
  kind: "connected" | "low_data" | "validity";
  esim: EsimAlertContext;
  subject: string;
  heading: string;
  intro: string;
  ctaLabel: string;
  ctaPath: string;
  pushTitle: string;
  pushBody: string;
  pushTag?: string;
  topUpEligible?: boolean;
}

type ChannelResult = { ok: boolean; reason?: string };

async function dispatch(
  deps: NotificationDeps,
  args: DispatchArgs,
): Promise<DeliveryReport> {
  const base = resolveBaseUrl(deps);
  const absoluteCta = base ? absoluteUrl(args.ctaPath, base) : args.ctaPath;

  // 1) Email — always attempt when we have a recipient.
  let emailResult: ChannelResult;
  if (!args.esim.recipientEmail) {
    emailResult = { ok: false, reason: "no_recipient_email" };
  } else {
    const sender = deps.emailSender ?? getEmailSender();
    const rendered = renderAlertEmail(args, absoluteCta);
    const res: DeliveryResult = await sender.sendRawEmail({
      to: args.esim.recipientEmail,
      from: "",
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      replyTo: brand.supportEmail,
    });
    emailResult = res.delivered
      ? { ok: true }
      : { ok: false, reason: res.reason };
  }

  // 2) Push — best effort across all subscriptions for the buyer. We cannot
  //    resolve the owning user from EsimAlertContext alone (it carries orderId
  //    + esimId, no userId), so look up userId from the esims table by
  //    esimId. If DB is not available we skip push with a reason.
  let pushResult: ChannelResult = { ok: false, reason: "push_not_attempted" };
  if (!isPushConfigured()) {
    pushResult = { ok: false, reason: "push_not_configured" };
  } else {
    const db = (deps.getDb ?? getDb)();
    if (!db) {
      pushResult = { ok: false, reason: "db_unavailable" };
    } else {
      pushResult = await sendPushToUser(deps, db, args.esim.esimId, {
        title: args.pushTitle,
        body: args.pushBody,
        url: absoluteCta,
        tag: args.pushTag,
      });
    }
  }

  const delivered = emailResult.ok || pushResult.ok;
  const reason = [
    emailResult.ok ? null : `email:${emailResult.reason ?? "unknown"}`,
    pushResult.ok ? null : `push:${pushResult.reason ?? "unknown"}`,
  ]
    .filter(Boolean)
    .join(",") || undefined;

  logLine(deps, {
    outcome: delivered ? "delivered" : "not_delivered",
    kind: args.kind,
    esimId: args.esim.esimId,
    orderId: args.esim.orderId,
    email: emailResult,
    push: pushResult,
  });

  return delivered ? { delivered: true } : { delivered: false, reason: reason ?? "no_channels" };
}

// ---------------------------------------------------------------------------
// Push fan-out
// ---------------------------------------------------------------------------

/**
 * Send a push to every subscription that belongs to the user who owns `esimId`.
 * Deletes dead subscriptions (410/404) opportunistically so subsequent sends
 * are cheap. Never throws.
 */
async function sendPushToUser(
  deps: NotificationDeps,
  db: NonNullable<ReturnType<typeof getDb>>,
  esimId: number,
  payload: {
    title: string;
    body: string;
    url: string;
    tag?: string;
  },
): Promise<ChannelResult> {
  const subs = await loadPushSubscriptionsForEsim(db, esimId, deps);
  if (subs.length === 0) return { ok: false, reason: "no_push_subscriptions" };

  const send = deps.sendPush ?? sendWebPush;
  let okCount = 0;
  let lastReason: string | undefined;
  for (const sub of subs) {
    const res = await send(sub, {
      title: payload.title,
      body: payload.body,
      url: payload.url,
      tag: payload.tag,
    });
    if (res.delivered) {
      okCount += 1;
      continue;
    }
    lastReason = res.reason;
    if (res.expired) {
      // Best-effort delete; failure is not fatal.
      try {
        await deleteSubscription(db, sub.endpoint);
      } catch {
        /* swallow — the next send will retry deletion */
      }
    }
  }
  return okCount > 0 ? { ok: true } : { ok: false, reason: lastReason ?? "push_failed" };
}

/**
 * Look up push subscriptions for the user who owns the given eSIM. This file
 * uses a generic raw select against `push_subscriptions` and `esims` by name
 * so it stays working if the schema evolves; the join is a plain SQL string
 * executed through `db.execute`. That deliberately avoids importing the
 * `push_subscriptions` drizzle table object (which may not exist yet in
 * `schema.ts` when this phase lands). If/when that table is added to schema,
 * replace this with a typed drizzle query — nothing else changes.
 */
async function loadPushSubscriptionsForEsim(
  db: NonNullable<ReturnType<typeof getDb>>,
  esimId: number,
  deps: NotificationDeps,
): Promise<PushSubscriptionRecord[]> {
  try {
    // drizzle's `db.execute` accepts a raw SQL string in every 0.30+ version;
    // we pass the esimId as a bound parameter to avoid string interpolation.
    const result = (await (
      db as unknown as { execute: (q: unknown) => Promise<unknown> }
    ).execute(
      // Note the sql template is deliberately simple; parameterised by esimId.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (() => {
        // Build via drizzle-orm's `sql` helper to keep bindings safe.
        // Import lazily so module load order is not a dependency.
        return sqlWithParam(esimId);
      })(),
    )) as { rows?: Array<{ endpoint?: string; p256dh?: string; auth?: string }> };

    const rows = result.rows ?? [];
    const subs: PushSubscriptionRecord[] = [];
    for (const r of rows) {
      if (r.endpoint && r.p256dh && r.auth) {
        subs.push({ endpoint: r.endpoint, keys: { p256dh: r.p256dh, auth: r.auth } });
      }
    }
    return subs;
  } catch (err) {
    logLine(deps, {
      outcome: "load_push_subscriptions_failed",
      esimId,
      detail: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

/** Build the SQL template using drizzle's `sql` helper imported lazily. */
import { sql } from "drizzle-orm";
function sqlWithParam(esimId: number) {
  return sql`
    SELECT ps.endpoint, ps.p256dh, ps.auth
    FROM push_subscriptions ps
    JOIN esims e ON e.user_id = ps.user_id
    WHERE e.id = ${esimId}
  `;
}

async function deleteSubscription(
  db: NonNullable<ReturnType<typeof getDb>>,
  endpoint: string,
): Promise<void> {
  // Same raw-SQL rationale as above.
  await (db as unknown as { execute: (q: unknown) => Promise<unknown> }).execute(
    sql`DELETE FROM push_subscriptions WHERE endpoint = ${endpoint}`,
  );
}

// ---------------------------------------------------------------------------
// Email templates (kept inline; pure)
// ---------------------------------------------------------------------------

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;"
    : c === "<" ? "&lt;"
    : c === ">" ? "&gt;"
    : c === '"' ? "&quot;"
    : "&#39;",
  );
}

interface RenderedAlert {
  subject: string;
  html: string;
  text: string;
}

function renderAlertEmail(args: DispatchArgs, absoluteCta: string): RenderedAlert {
  const heading = escapeHtml(args.heading);
  const intro = escapeHtml(args.intro);
  const cta = escapeHtml(absoluteCta);
  const label = escapeHtml(args.ctaLabel);
  const ref = `ESIM #${args.esim.esimId} · ORDER #${args.esim.orderId}`;
  const brandName = escapeHtml(brand.name);

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${heading} — ${brandName}</title>
</head>
<body style="margin:0;padding:0;background:${escapeHtml(brand.backgroundColor)};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#0f172a;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
    <tr>
      <td align="center" style="padding:24px 12px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #e2e8f0;">
          <tr>
            <td style="background:${escapeHtml(brand.themeColor)};padding:16px 24px;color:#ffffff;">
              <span style="font-size:15px;font-weight:700;">${brandName}</span>
            </td>
          </tr>
          <tr>
            <td style="padding:24px;font-size:15px;color:#334155;line-height:1.6;">
              <h1 style="margin:0 0 12px 0;font-size:18px;color:#0f172a;">${heading}</h1>
              <p style="margin:0 0 16px 0;">${intro}</p>
              <p style="margin:0 0 20px 0;">
                <a href="${cta}" style="display:inline-block;background:#1b6ef5;color:#ffffff;text-decoration:none;padding:10px 16px;border-radius:10px;font-weight:600;">${label}</a>
              </p>
              <p style="margin:0 0 8px 0;font-size:12px;color:#94a3b8;">${escapeHtml(ref)}</p>
              <p style="margin:0;font-size:12px;color:#94a3b8;">${escapeHtml(brand.guaranteeCopy)}</p>
            </td>
          </tr>
          <tr>
            <td style="padding:16px 24px;background:#f8fafc;border-top:1px solid #e2e8f0;font-size:11px;color:#94a3b8;">
              Sent by ${brandName} · ${escapeHtml(brand.domain)}
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  const text = [
    args.heading,
    "",
    args.intro,
    "",
    `${args.ctaLabel}: ${absoluteCta}`,
    "",
    ref,
    brand.guaranteeCopy,
    "",
    `— ${brand.name}`,
  ].join("\n");

  return { subject: args.subject, html, text };
}

// ---------------------------------------------------------------------------
// Test surface
// ---------------------------------------------------------------------------
export const __test__ = {
  renderAlertEmail,
  resolveBaseUrl,
};

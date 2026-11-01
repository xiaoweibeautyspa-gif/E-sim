/**
 * Web Push (VAPID) wrapper — the single place we send browser push.
 *
 * Design notes
 * ------------
 * - Keys come from Replit Secrets:
 *     VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (e.g. mailto:support@…).
 *   They are read lazily so tests and cold boots don't require them.
 * - This module NEVER fabricates success. If the keys are missing we return
 *   `{ delivered: false, reason: "push_not_configured" }`. If a subscription is
 *   dead (410/404 from the push service) we report `reason: "expired"` so the
 *   caller can delete the row.
 * - Transport is injectable for tests. The default uses `web-push` if installed
 *   (dynamic import so the package is optional in local dev) and returns
 *   `push_library_missing` if it isn't.
 * - We do not log the subscription endpoint or keys (may include a user token).
 */
import { brand } from "../brand.config";

export interface PushSubscriptionRecord {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface PushPayload {
  title: string;
  body: string;
  /** Deep link opened on click, e.g. "/my-esims". */
  url: string;
  /** Small icon URL under /public (optional). */
  icon?: string;
  /** Short tag lets the OS coalesce notifications (e.g. "low-data:<esimId>"). */
  tag?: string;
  /** Extra data echoed back to the service worker click handler. */
  data?: Record<string, string | number | null>;
}

export type PushDelivery =
  | { delivered: true; status: number; expired: false }
  | { delivered: false; status: number | null; reason: string; expired: boolean };

export interface PushDeps {
  publicKey?: string;
  privateKey?: string;
  subject?: string;
  /** Inject a transport for tests; default uses `web-push`. */
  sendFn?: (sub: PushSubscriptionRecord, payload: string) => Promise<{
    statusCode?: number;
  }>;
  log?: (line: string) => void;
}

interface ResolvedVapid {
  publicKey: string;
  privateKey: string;
  subject: string;
}

/** Resolve VAPID config from deps or env. Returns null when incomplete. */
function resolveVapid(deps: PushDeps): ResolvedVapid | null {
  const publicKey = (deps.publicKey ?? process.env.VAPID_PUBLIC_KEY ?? "").trim();
  const privateKey = (deps.privateKey ?? process.env.VAPID_PRIVATE_KEY ?? "").trim();
  const subject =
    (deps.subject ?? process.env.VAPID_SUBJECT ?? `mailto:${brand.supportEmail}`).trim();
  if (!publicKey || !privateKey) return null;
  return { publicKey, privateKey, subject };
}

/** Lazy-load `web-push`; returns null if not installed. */
async function loadWebPush(): Promise<{
  setVapidDetails: (subject: string, pub: string, priv: string) => void;
  sendNotification: (
    sub: { endpoint: string; keys: { p256dh: string; auth: string } },
    payload: string,
  ) => Promise<{ statusCode?: number }>;
} | null> {
  try {
    // Optional dep: present in production install; if absent we degrade.
    const mod = (await import("web-push")) as unknown as {
      default?: {
        setVapidDetails: (subject: string, pub: string, priv: string) => void;
        sendNotification: (
          sub: { endpoint: string; keys: { p256dh: string; auth: string } },
          payload: string,
        ) => Promise<{ statusCode?: number }>;
      };
      setVapidDetails?: (subject: string, pub: string, priv: string) => void;
      sendNotification?: (
        sub: { endpoint: string; keys: { p256dh: string; auth: string } },
        payload: string,
      ) => Promise<{ statusCode?: number }>;
    };
    const impl = mod.default ?? (mod as NonNullable<typeof mod.default | typeof mod>);
    if (!impl || typeof (impl as { sendNotification?: unknown }).sendNotification !== "function") {
      return null;
    }
    return impl as NonNullable<typeof mod.default>;
  } catch {
    return null;
  }
}

function isExpiredStatus(status: number | undefined): boolean {
  return status === 404 || status === 410;
}

/**
 * Send one push to one subscription. Never throws; maps errors to reasons.
 * `reason` values: push_not_configured, push_library_missing, expired,
 *                    transport_error:<msg>, status_<code>.
 */
export async function sendWebPush(
  subscription: PushSubscriptionRecord,
  payload: PushPayload,
  deps: PushDeps = {},
): Promise<PushDelivery> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const vapid = resolveVapid(deps);
  if (!vapid) {
    return { delivered: false, status: null, reason: "push_not_configured", expired: false };
  }

  const body = JSON.stringify({
    title: payload.title,
    body: payload.body,
    url: payload.url,
    icon: payload.icon ?? "/icons/icon-192.png",
    tag: payload.tag ?? null,
    data: payload.data ?? {},
  });

  // Custom sendFn (tests). Still respects "not configured" above.
  if (deps.sendFn) {
    try {
      const res = await deps.sendFn(subscription, body);
      const status = res.statusCode ?? 200;
      const expired = isExpiredStatus(status);
      if (status >= 200 && status < 300) {
        return { delivered: true, status, expired: false };
      }
      return {
        delivered: false,
        status,
        reason: expired ? "expired" : `status_${status}`,
        expired,
      };
    } catch (err) {
      return {
        delivered: false,
        status: null,
        reason: `transport_error:${err instanceof Error ? err.message : String(err)}`,
        expired: false,
      };
    }
  }

  const webpush = await loadWebPush();
  if (!webpush) {
    return { delivered: false, status: null, reason: "push_library_missing", expired: false };
  }
  try {
    webpush.setVapidDetails(vapid.subject, vapid.publicKey, vapid.privateKey);
    const res = await webpush.sendNotification(
      { endpoint: subscription.endpoint, keys: subscription.keys },
      body,
    );
    const status = res.statusCode ?? 201;
    log(
      JSON.stringify({
        at: new Date().toISOString(),
        channel: "web_push",
        outcome: "sent",
        status,
        tag: payload.tag ?? null,
      }),
    );
    return { delivered: true, status, expired: false };
  } catch (err) {
    const status = (err as { statusCode?: number } | null)?.statusCode;
    const expired = isExpiredStatus(status);
    const reason =
      expired
        ? "expired"
        : `transport_error:${err instanceof Error ? err.message : String(err)}`;
    log(
      JSON.stringify({
        at: new Date().toISOString(),
        channel: "web_push",
        outcome: "failed",
        status: status ?? null,
        reason,
      }),
    );
    return { delivered: false, status: status ?? null, reason, expired };
  }
}

/** True when VAPID keys are present (used by route to gate subscription UI). */
export function isPushConfigured(env: { publicKey?: string; privateKey?: string } = {}): boolean {
  const pub = (env.publicKey ?? process.env.VAPID_PUBLIC_KEY ?? "").trim();
  const priv = (env.privateKey ?? process.env.VAPID_PRIVATE_KEY ?? "").trim();
  return Boolean(pub && priv);
}

export const __test__ = { resolveVapid, isExpiredStatus };

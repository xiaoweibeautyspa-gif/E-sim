/**
 * usePush — client-side web-push wiring for the storefront PWA.
 *
 * WHAT IT DOES
 * ------------
 * 1. Registers the service worker (`/sw.js`) that `src/pwa/sw.ts` compiles to.
 * 2. Asks the server for the VAPID public key (`GET /api/push/public-key`).
 *    If the server has no VAPID keys configured it returns 503 and we surface
 *    an honest `unavailable` state — we never invent a key.
 * 3. On user action (`subscribe`) requests notification permission, calls
 *    `pushManager.subscribe`, and POSTs the subscription to
 *    `POST /api/push/subscribe`.
 * 4. `unsubscribe` removes the subscription both locally and server-side.
 *
 * CONTRACT WITH THE SERVER
 * ------------------------
 *   GET  /api/push/public-key   → 200 { ok:true, data:{ publicKey: string } }
 *                               | 503 { ok:false, error:"push_unconfigured", message }
 *   POST /api/push/subscribe    → 200 { ok:true }
 *        body { endpoint, keys:{ p256dh, auth }, userAgent? }
 *   POST /api/push/unsubscribe  → 200 { ok:true }
 *        body { endpoint }
 *
 * These match `server/routes/push.ts` and the `push_subscriptions` table added
 * in `server/db/migrations/0021_push_subscriptions.sql`.
 *
 * HONESTY
 * -------
 * - `permission === "denied"` is terminal; we don't re-prompt (the browser
 *   won't show the prompt again anyway).
 * - If the SW or PushManager is missing (older browser, insecure context) the
 *   hook reports `unsupported` rather than pretending success.
 * - We never log the raw subscription keys.
 *
 * Errors are surfaced through the returned `error` string; the hook never
 * throws from an effect.
 */
import { useCallback, useEffect, useRef, useState } from "react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PushStatus =
  | "unsupported" // browser lacks SW / PushManager, or insecure context
  | "unavailable" // server has no VAPID keys configured
  | "idle" // ready, not yet subscribed
  | "denied" // user blocked notifications
  | "subscribing"
  | "subscribed"
  | "unsubscribing"
  | "error";

export interface UsePushResult {
  status: PushStatus;
  /** True once the browser has an active push subscription. */
  subscribed: boolean;
  /** Human-readable error, or null. */
  error: string | null;
  /** Trigger the permission prompt + subscription. Idempotent. */
  subscribe: () => Promise<void>;
  /** Remove the subscription locally and server-side. */
  unsubscribe: () => Promise<void>;
}

interface PushSubscriptionJSONShape {
  endpoint?: string;
  keys?: { p256dh?: string; auth?: string };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Path to the compiled service worker. Matches the Vite build output config. */
const SW_URL = "/sw.js";
const SW_SCOPE = "/";

function pushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    typeof window.isSecureContext === "boolean" &&
    window.isSecureContext
  );
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData =
    typeof atob === "function"
      ? atob(base64)
      : // Fallback for environments without atob (shouldn't happen in a browser).
        "";
  const output = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i += 1) {
    output[i] = rawData.charCodeAt(i);
  }
  return output;
}

/** Get (or install) the service worker registration. */
async function ensureRegistration(): Promise<ServiceWorkerRegistration> {
  const existing = await navigator.serviceWorker.getRegistration(SW_SCOPE);
  if (existing) return existing;
  return navigator.serviceWorker.register(SW_URL, { scope: SW_SCOPE });
}

interface ApiResult<T> {
  ok: boolean;
  status: number;
  data?: T;
  error?: string;
  message?: string;
}

async function postJson<T>(
  url: string,
  body: unknown,
  signal?: AbortSignal,
): Promise<ApiResult<T>> {
  const res = await fetch(url, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  const parsed = (await res.json().catch(() => ({}))) as
    | { ok: true; data?: T }
    | { ok: false; error?: string; message?: string };
  if (parsed && parsed.ok === true) {
    return { ok: true, status: res.status, data: parsed.data };
  }
  const err = parsed && parsed.ok === false ? parsed : {};
  return {
    ok: false,
    status: res.status,
    error: (err as { error?: string }).error,
    message: (err as { message?: string }).message ?? `Request failed (HTTP ${res.status}).`,
  };
}

interface PublicKeyResult {
  ok: boolean;
  status: number;
  publicKey?: string;
  error?: string;
  message?: string;
}

async function fetchPublicKey(signal?: AbortSignal): Promise<PublicKeyResult> {
  try {
    const res = await fetch("/api/push/public-key", {
      credentials: "include",
      headers: { Accept: "application/json" },
      signal,
    });
    const parsed = (await res.json().catch(() => ({}))) as
      | { ok: true; data: { publicKey: string } }
      | { ok: false; error?: string; message?: string };
    if (res.ok && parsed && parsed.ok === true && parsed.data?.publicKey) {
      return { ok: true, status: res.status, publicKey: parsed.data.publicKey };
    }
    const err = parsed && parsed.ok === false ? parsed : {};
    return {
      ok: false,
      status: res.status,
      error: (err as { error?: string }).error ?? "public_key_unavailable",
      message:
        (err as { message?: string }).message ??
        "Push notifications aren't configured on this server.",
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: "network_error",
      message: err instanceof Error ? err.message : "Network error.",
    };
  }
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export interface UsePushOptions {
  /**
   * Set false to skip auto-detection on mount (e.g. a page that doesn't want to
   * prompt). Defaults to true — the hook only *detects*, it never prompts
   * without `subscribe()` being called.
   */
  autoDetect?: boolean;
}

export function usePush(options: UsePushOptions = {}): UsePushResult {
  const { autoDetect = true } = options;
  const [status, setStatus] = useState<PushStatus>("idle");
  const [subscribed, setSubscribed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const busyRef = useRef(false);

  const safeSet = useCallback(
    <T,>(setter: (v: T) => void, value: T) => {
      if (mountedRef.current) setter(value);
    },
    [],
  );

  // ---- Initial detection -------------------------------------------------
  useEffect(() => {
    mountedRef.current = true;
    if (!autoDetect) return;
    let cancelled = false;

    (async () => {
      if (!pushSupported()) {
        if (!cancelled) setStatus("unsupported");
        return;
      }
      // Don't fetch the public key yet; a registered SW is enough to report
      // subscription state. We only need the key when actually subscribing.
      try {
        const reg = await navigator.serviceWorker.getRegistration(SW_SCOPE);
        const existing = reg ? await reg.pushManager.getSubscription() : null;
        if (cancelled) return;
        if (existing) {
          setSubscribed(true);
          setStatus("subscribed");
        } else if (typeof Notification !== "undefined" && Notification.permission === "denied") {
          setStatus("denied");
        } else {
          setStatus("idle");
        }
      } catch (err) {
        if (!cancelled) {
          setStatus("error");
          setError(err instanceof Error ? err.message : "Could not check notification state.");
        }
      }
    })();

    return () => {
      cancelled = true;
      mountedRef.current = false;
    };
  }, [autoDetect]);

  // ---- subscribe ---------------------------------------------------------
  const subscribe = useCallback(async () => {
    if (busyRef.current) return;
    if (!pushSupported()) {
      safeSet(setStatus, "unsupported");
      return;
    }

    busyRef.current = true;
    safeSet(setError, null);
    safeSet(setStatus, "subscribing");

    try {
      // 1. Server must have VAPID keys.
      const key = await fetchPublicKey();
      if (!key.ok || !key.publicKey) {
        safeSet(setStatus, key.error === "push_unconfigured" ? "unavailable" : "error");
        safeSet(setError, key.message ?? "Push notifications aren't available.");
        return;
      }

      // 2. Request permission (if not already granted).
      if (typeof Notification === "undefined") {
        safeSet(setStatus, "unsupported");
        return;
      }
      let permission = Notification.permission;
      if (permission === "default") {
        permission = await Notification.requestPermission();
      }
      if (permission === "denied") {
        safeSet(setStatus, "denied");
        safeSet(
          setError,
          "Notifications are blocked. Enable them in your browser settings to get alerts.",
        );
        return;
      }
      if (permission !== "granted") {
        safeSet(setStatus, "idle");
        return;
      }

      // 3. Register SW and subscribe to push.
      const reg = await ensureRegistration();
      const existing = await reg.pushManager.getSubscription();
      const subscription =
        existing ??
        (await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(key.publicKey),
        }));

      // 4. Register the subscription server-side.
      const json = subscription.toJSON() as PushSubscriptionJSONShape;
      const endpoint = json.endpoint ?? subscription.endpoint;
      const p256dh = json.keys?.p256dh;
      const auth = json.keys?.auth;
      if (!endpoint || !p256dh || !auth) {
        // A subscription without keys can't be used by the server; remove it.
        await subscription.unsubscribe().catch(() => {});
        throw new Error("The browser returned an incomplete push subscription.");
      }

      const saved = await postJson("/api/push/subscribe", {
        endpoint,
        keys: { p256dh, auth },
        userAgent: typeof navigator !== "undefined" ? navigator.userAgent : undefined,
      });
      if (!saved.ok) {
        // Roll back the local subscription so state stays consistent.
        await subscription.unsubscribe().catch(() => {});
        safeSet(setStatus, saved.error === "unauthorized" ? "idle" : "error");
        safeSet(setError, saved.message ?? "Could not save your notification settings.");
        return;
      }

      safeSet(setSubscribed, true);
      safeSet(setStatus, "subscribed");
    } catch (err) {
      safeSet(setStatus, "error");
      safeSet(setError, err instanceof Error ? err.message : "Could not enable notifications.");
    } finally {
      busyRef.current = false;
    }
  }, [safeSet]);

  // ---- unsubscribe -------------------------------------------------------
  const unsubscribe = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    safeSet(setError, null);
    safeSet(setStatus, "unsubscribing");

    try {
      if (!pushSupported()) {
        safeSet(setStatus, "unsupported");
        return;
      }
      const reg = await navigator.serviceWorker.getRegistration(SW_SCOPE);
      const subscription = reg ? await reg.pushManager.getSubscription() : null;
      if (!subscription) {
        safeSet(setSubscribed, false);
        safeSet(setStatus, "idle");
        return;
      }
      const endpoint = subscription.endpoint;

      // Server-first: if the server delete fails we keep the local one so the
      // user can retry. If it succeeds (or the row was already gone) we delete
      // locally.
      const removed = await postJson("/api/push/unsubscribe", { endpoint });
      if (!removed.ok && removed.error !== "unauthorized") {
        safeSet(setStatus, "subscribed");
        safeSet(setError, removed.message ?? "Could not turn off notifications. Try again.");
        return;
      }
      await subscription.unsubscribe().catch(() => {});
      safeSet(setSubscribed, false);
      safeSet(setStatus, "idle");
    } catch (err) {
      safeSet(setStatus, "subscribed");
      safeSet(setError, err instanceof Error ? err.message : "Could not turn off notifications.");
    } finally {
      busyRef.current = false;
    }
  }, [safeSet]);

  return { status, subscribed, error, subscribe, unsubscribe };
}

// ---------------------------------------------------------------------------
// Test surface (pure helpers used by a future client test)
// ---------------------------------------------------------------------------
export const __test__ = { urlBase64ToUint8Array, pushSupported, SW_URL };

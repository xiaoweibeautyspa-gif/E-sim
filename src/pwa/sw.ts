/**
 * Service worker for the storefront PWA.
 *
 * Responsibilities
 * ----------------
 * 1. Make the app installable (fetch handler + a cached app shell).
 * 2. Receive `push` events and display notifications using the exact payload
 *    the server (`server/lib/push.ts::sendWebPush`) sends — { title, body, url,
 *    icon, tag } — with safe fallbacks.
 * 3. Handle notification clicks: focus an existing tab on the target URL if
 *    one is open, otherwise openWindow.
 * 4. Cache HTML/CSS/JS assets on install so the shell loads offline (trip-pack
 *    downloads for the trip planner are handled separately; this only covers
 *    the app shell).
 *
 * Deliberate exclusions
 * ---------------------
 * - No background sync of usage data (that's server-side).
 * - No "skipWaiting" auto-activation: we keep the old SW alive until the app
 *   asks for an update so users don't lose their current page mid-task. The
 *   registration hook (src/hooks/usePush.ts, next batch) decides when to
 *   refresh.
 */
/// <reference lib="webworker" />

type PushMessage = {
  title?: string;
  body?: string;
  url?: string;
  icon?: string;
  tag?: string;
  data?: Record<string, string | number | null>;
};

const SHELL_CACHE = "static-v1";
const SHELL_URLS = ["/", "/index.html", "/manifest.webmanifest"];

// The SW global typed loosely so this file compiles without webworker globals.
const sw = self as unknown as ServiceWorkerGlobalScope & {
  addEventListener: (type: string, handler: (event: Event) => void) => void;
  skipWaiting: () => void;
  clients: {
    claim: () => Promise<void>;
    matchAll: (opts: { type: string; includeUncontrolled?: boolean }) => Promise<
      Array<{ url: string; focus: () => Promise<unknown>; navigate?: (url: string) => Promise<unknown> }>
    >;
    openWindow: (url: string) => Promise<unknown>;
  };
  registration: { showNotification: (title: string, opts: NotificationOptions) => Promise<void> };
};

sw.addEventListener("install", (event: Event) => {
  const e = event as ExtendableEvent;
  e.waitUntil(
    (async () => {
      try {
        const cache = await caches.open(SHELL_CACHE);
        // Best-effort pre-cache; failures (e.g. /manifest.webmanifest absent
        // during local dev) are logged but must not abort install.
        await Promise.all(
          SHELL_URLS.map(async (url) => {
            try {
              await cache.add(url);
            } catch {
              /* skip missing asset */
            }
          }),
        );
      } finally {
        // Do NOT auto-activate; the app decides via postMessage.
      }
    })(),
  );
});

sw.addEventListener("activate", (event: Event) => {
  const e = event as ExtendableEvent;
  e.waitUntil(
    (async () => {
      try {
        const keys = await caches.keys();
        await Promise.all(
          keys.filter((k) => k !== SHELL_CACHE).map((k) => caches.delete(k)),
        );
      } catch {
        /* non-fatal */
      }
    })(),
  );
});

sw.addEventListener("message", (event: Event) => {
  const e = event as ExtendableMessageEvent;
  const data = e.data as { type?: string } | null;
  if (data && data.type === "SKIP_WAITING") {
    sw.skipWaiting();
  }
});

sw.addEventListener("fetch", (event: Event) => {
  const e = event as FetchEvent;
  const req = e.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  // Never cache API or webhook traffic.
  if (url.pathname.startsWith("/api/")) return;

  // Navigation requests: network-first so auth-aware pages are fresh, fall
  // back to cached shell offline.
  if (req.mode === "navigate") {
    e.respondWith(
      (async () => {
        try {
          const fresh = await fetch(req);
          return fresh;
        } catch {
          const cached = await caches.match("/index.html");
          if (cached) return cached;
          throw new Error("offline and no cached shell");
        }
      })(),
    );
    return;
  }

  // Static assets: cache-first.
  e.respondWith(
    (async () => {
      const cached = await caches.match(req);
      if (cached) return cached;
      try {
        const fresh = await fetch(req);
        if (fresh.ok) {
          const cache = await caches.open(SHELL_CACHE);
          cache.put(req, fresh.clone()).catch(() => {});
        }
        return fresh;
      } catch (err) {
        throw err;
      }
    })(),
  );
});

sw.addEventListener("push", (event: Event) => {
  const e = event as PushEvent;
  let payload: PushMessage = {};
  try {
    const text = e.data ? e.data.text() : "";
    if (text) payload = JSON.parse(text) as PushMessage;
  } catch {
    // If payload is malformed, still show a generic notification so the user
    // knows something happened rather than silently dropping.
    payload = {};
  }

  const title = payload.title || "Update";
  const body = payload.body || "Open the app to see what's new.";
  const url = payload.url || "/";

  e.waitUntil(
    sw.registration.showNotification(title, {
      body,
      icon: payload.icon || "/icons/icon-192.png",
      // `badge` is silently ignored on some platforms but harmless.
      badge: "/icons/badge-72.png",
      tag: payload.tag || undefined,
      data: { url, ...(payload.data ?? {}) },
    }),
  );
});

sw.addEventListener("notificationclick", (event: Event) => {
  const e = event as NotificationEvent;
  e.notification.close();

  const data = (e.notification.data as { url?: string } | undefined) ?? {};
  const target = data.url || "/";

  e.waitUntil(
    (async () => {
      try {
        const all = await sw.clients.matchAll({ type: "window", includeUncontrolled: true });
        // Prefer focusing an existing tab that already matches the URL; if any
        // tab is open, focus it and let the app handle in-app navigation.
        const sameOrigin = all.find((c) => {
          try {
            return new URL(c.url).origin === new URL(target, sw.location.origin).origin;
          } catch {
            return false;
          }
        });
        if (sameOrigin) {
          await sameOrigin.focus();
          if (typeof sameOrigin.navigate === "function") {
            try {
              await sameOrigin.navigate(target);
            } catch {
              /* navigation may fail cross-origin; ignore */
            }
          }
          return;
        }
        await sw.clients.openWindow(target);
      } catch {
        await sw.clients.openWindow("/");
      }
    })(),
  );
});

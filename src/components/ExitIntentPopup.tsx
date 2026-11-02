/**
 * ExitIntentPopup — offers a first-order discount when a first-time visitor
 * shows intent to leave. Off by default for returning visitors; only fires
 * once per visitor (localStorage).
 *
 * Data source (server — admin-controlled):
 *
 *   GET /api/reviews/public-config  (single endpoint for public admin toggles)
 *     → 200 { ok: true, data: {
 *             exitPopupEnabled: boolean;
 *             /** Percent or fixed amount, currency included *\/
 *             firstOrderDiscount: { code: string; type: "percent" | "fixed";
 *                                   value: number; currency: string;
 *                                   expiresAt: string | null } | null;
 *           } }
 *     → 4xx/5xx { ok: false, error, message }
 *
 *  NOTE: if the backend's endpoint differs, only `fetchConfig` needs updating
 *  — the rest of the component is transport-agnostic.
 *
 * Honesty & rules:
 *  - If `exitPopupEnabled` is false, the popup does not render and does not
 *    even attach its trigger listeners. Failure of the config fetch is
 *    treated as "off" — never as "on with a default code".
 *  - If `firstOrderDiscount` is null/empty/expired, we render the popup in a
 *    "no-code-yet" state: it shows the signup offer copy only, not a fake code.
 *  - We do not invent a discount % if the admin didn't set one.
 *  - We fire the popup at most once per visitor (localStorage key scoped by
 *    country/route path suffix so it's globally once per browser, not once per
 *    page).
 *  - The "show" trigger is mouseleave (desktop) OR a scroll-up+idle on mobile
 *    OR a dismissible timeout — this component intentionally does NOT listen
 *    to `beforeunload` because that fires on real exits (back/forward/form
 *    submits) and would be misleading.
 *
 * Accessibility:
 *  - role="dialog" aria-modal, focus moves to the close button on open, Escape
 *    closes, clicks outside close. We do not trap focus by looping everything
 *    (a discount popup is not a modal task); we just move focus sensibly and
 *    restore it on close.
 */
import { useCallback, useEffect, useId, useRef, useState } from "react";

// ---------------------------------------------------------------------------
// Types (mirror server)
// ---------------------------------------------------------------------------

export type FirstOrderDiscountType = "percent" | "fixed";

export interface FirstOrderDiscount {
  code: string;
  type: FirstOrderDiscountType;
  /** 10 = 10% off, or a fixed amount in `currency`. */
  value: number;
  currency: string;
  /** ISO timestamp; when in the past, treat as expired. */
  expiresAt: string | null;
}

export interface ExitPopupConfig {
  exitPopupEnabled: boolean;
  firstOrderDiscount: FirstOrderDiscount | null;
}

interface ApiOk<T> {
  ok: true;
  data: T;
}
interface ApiErr {
  ok: false;
  error: string;
  message: string;
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

const STORAGE_KEY = "esim-exit-intent-shown-v1";
const SESSION_ATTR = "esim-exit-intent-fired";

function hasAlreadyShown(): boolean {
  if (typeof window === "undefined") return true;
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    // Safari private mode / strict cookie blocking — don't nag.
    return true;
  }
}

function markShown(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, "1");
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// Fetcher — injectable so tests / SSR share one shape
// ---------------------------------------------------------------------------

export async function fetchConfig(
  fetchImpl: typeof fetch,
  signal: AbortSignal,
): Promise<ExitPopupConfig> {
  const res = await fetchImpl("/api/reviews/public-config", {
    credentials: "include",
    headers: { Accept: "application/json" },
    signal,
  });
  const body = (await res.json().catch(() => ({}))) as
    | ApiOk<ExitPopupConfig>
    | ApiErr
    | null;
  if (!res.ok || !body || body.ok === false) {
    throw new Error(
      (body && body.ok === false && body.message) || `Config fetch failed (HTTP ${res.status}).`,
    );
  }
  return body.data;
}

// ---------------------------------------------------------------------------
// Expiry check — kept exported for tests
// ---------------------------------------------------------------------------

export function isDiscountActive(
  d: FirstOrderDiscount | null,
  now: Date = new Date(),
): d is FirstOrderDiscount {
  if (!d) return false;
  if (!d.code || typeof d.code !== "string") return false;
  if (!Number.isFinite(d.value) || d.value <= 0) return false;
  if (d.type !== "percent" && d.type !== "fixed") return false;
  if (d.type === "percent" && d.value > 100) return false;
  if (d.expiresAt) {
    const t = Date.parse(d.expiresAt);
    if (Number.isFinite(t) && t <= now.getTime()) return false;
  }
  return true;
}

/** Human label for the discount, e.g. "10% off" or "SGD 3 off". */
export function formatDiscount(d: FirstOrderDiscount): string {
  if (d.type === "percent") {
    const v = Number.isInteger(d.value) ? d.value : Number(d.value.toFixed(1));
    return `${v}% off`;
  }
  const value = d.value.toFixed(2);
  return `${d.currency} ${value} off`;
}

// ---------------------------------------------------------------------------
// Trigger logic — exported so a test can assert the trigger fires only once
// ---------------------------------------------------------------------------

export interface ExitIntentTriggers {
  detach: () => void;
}

/**
 * Attach listeners that call `onFire` at most once (per call). A mouseleave
 * near the top of the viewport is the standard desktop signal; on mobile we
 * approximate with a fast upward scroll after a delay.
 */
export function attachExitIntentTriggers(
  target: Window,
  onFire: () => void,
): ExitIntentTriggers {
  let fired = false;
  let armedAt = Date.now();
  let lastScrollY = target.scrollY;
  let lastScrollAt = Date.now();

  function fire() {
    if (fired) return;
    fired = true;
    detachAll();
    onFire();
  }

  const handleMouseOut = (e: MouseEvent) => {
    // Only when the mouse physically leaves the top of the window.
    if (e.relatedTarget == null && e.clientY <= 0) fire();
  };

  const handleMouseLeaveDocument = (e: MouseEvent) => {
    if (e.clientY <= 0) fire();
  };

  const handleScroll = () => {
    const now = Date.now();
    const y = target.scrollY;
    const dy = y - lastScrollY;
    const dt = now - lastScrollAt;
    // Fast upward fling from deep in the page.
    if (lastScrollY > 300 && dy < -150 && dt < 400) fire();
    lastScrollY = y;
    lastScrollAt = now;
  };

  // Safety net: fire after 45s of engagement if nothing else has.
  const timeout = target.setTimeout(() => {
    if (Date.now() - armedAt >= 45_000 && target.scrollY > 100) fire();
  }, 45_000);

  target.addEventListener("mouseout", handleMouseOut);
  target.document?.addEventListener?.("mouseleave", handleMouseLeaveDocument);
  target.addEventListener("scroll", handleScroll, { passive: true });

  function detachAll() {
    target.removeEventListener("mouseout", handleMouseOut);
    target.document?.removeEventListener?.("mouseleave", handleMouseLeaveDocument);
    target.removeEventListener("scroll", handleScroll);
    target.clearTimeout(timeout);
  }

  return { detach: detachAll };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface ExitIntentPopupProps {
  /** Optional path suffix to scope dismissals; defaults to window.location.pathname. */
  scope?: string;
  /**
   * When supplied, skips fetching and uses this config directly (useful for
   * previews / tests). Production pages omit it so the server is authority.
   */
  configOverride?: ExitPopupConfig;
  /** Override fetcher for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

type State =
  | { status: "idle" }
  | { status: "ready"; config: ExitPopupConfig }
  | { status: "hidden" };

export function ExitIntentPopup({
  scope,
  configOverride,
  fetchImpl,
}: ExitIntentPopupProps): JSX.Element | null {
  const fetchFn = fetchImpl ?? fetch;
  const [state, setState] = useState<State>(
    configOverride ? { status: "ready", config: configOverride } : { status: "idle" },
  );
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const returnFocusRef = useRef<Element | null>(null);
  const headingId = useId();
  const bodyId = useId();

  // ---- Fetch config once (unless overridden).
  useEffect(() => {
    if (configOverride) return;
    const controller = new AbortController();
    fetchConfig(fetchFn, controller.signal)
      .then((config) => {
        if (controller.signal.aborted) return;
        if (!config.exitPopupEnabled) {
          setState({ status: "hidden" });
          return;
        }
        setState({ status: "ready", config });
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        // Failure means "assume off". Never guess a discount code.
        setState({ status: "hidden" });
      });
    return () => controller.abort();
  }, [configOverride, fetchFn]);

  // ---- Attach exit-intent triggers once config says we're enabled.
  useEffect(() => {
    if (state.status !== "ready") return;
    if (typeof window === "undefined") return;
    if (hasAlreadyShown()) return;

    const triggers = attachExitIntentTriggers(window, () => {
      // Double-check the flag hasn't flipped while we were waiting.
      if (hasAlreadyShown()) return;
      // Escapes double-fire from StrictMode double-mount.
      if (window.sessionStorage?.getItem(SESSION_ATTR) === "1") return;
      try {
        window.sessionStorage?.setItem(SESSION_ATTR, "1");
      } catch {
        /* ignore */
      }
      returnFocusRef.current = document.activeElement;
      setOpen(true);
    });
    return () => triggers.detach();
  }, [state]);

  // ---- Focus + Escape behaviour while open.
  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") handleDismiss();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const handleDismiss = useCallback(() => {
    markShown();
    setOpen(false);
    // Restore focus if it was inside our dialog.
    const ret = returnFocusRef.current as HTMLElement | null;
    if (ret && typeof ret.focus === "function") {
      try {
        ret.focus();
      } catch {
        /* ignore */
      }
    }
  }, []);

  const handleCopy = useCallback(async (code: string) => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      /* clipboard may be blocked; user can select the text */
    }
  }, []);

  if (state.status !== "ready" || !open) return null;

  const discount =
    state.config.firstOrderDiscount && isDiscountActive(state.config.firstOrderDiscount)
      ? state.config.firstOrderDiscount
      : null;

  const scopeLabel = scope ?? (typeof window !== "undefined" ? window.location.pathname : "/");

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/50 p-0 sm:items-center sm:p-4"
      data-testid="exit-intent-popup"
      data-scope={scopeLabel}
      data-has-discount={discount ? "true" : "false"}
      onClick={(e) => {
        if (e.target === e.currentTarget) handleDismiss();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        aria-describedby={bodyId}
        className="w-full max-w-md rounded-t-2xl bg-white p-5 shadow-2xl ring-1 ring-slate-200 sm:rounded-2xl"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2">
            <span className="flex h-9 w-9 items-center justify-center rounded-full bg-brand-100 text-brand-700">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                <path d="M12 2l3 6 7 .9-5 4.9 1.2 6.9L12 17.8 5.8 20.7 7 13.8 2 8.9 9 8z" strokeLinejoin="round" strokeLinecap="round" />
              </svg>
            </span>
            <h2 id={headingId} className="text-base font-bold text-slate-900">
              {discount ? "Before you go — take a discount" : "Before you go"}
            </h2>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={handleDismiss}
            aria-label="Close"
            className="rounded-lg p-1 text-slate-500 hover:bg-slate-100 hover:text-slate-800"
            data-testid="exit-intent-close"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
              <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        <div id={bodyId} className="mt-3">
          {discount ? (
            <>
              <p className="text-sm text-slate-700">
                Here's{" "}
                <span className="font-semibold text-brand-700">
                  {formatDiscount(discount)}
                </span>{" "}
                your first travel eSIM. Apply the code at checkout.
              </p>
              <div className="mt-3 flex items-center gap-2">
                <code
                  className="flex-1 truncate rounded-lg border border-dashed border-slate-300 bg-slate-50 px-3 py-2 text-center text-sm font-semibold tracking-wide text-slate-900"
                  data-testid="exit-intent-code"
                >
                  {discount.code}
                </code>
                <button
                  type="button"
                  onClick={() => void handleCopy(discount.code)}
                  className="rounded-lg bg-brand-600 px-3 py-2 text-xs font-semibold text-white hover:bg-brand-700"
                  data-testid="exit-intent-copy"
                >
                  {copied ? "Copied" : "Copy code"}
                </button>
              </div>
              {discount.expiresAt && (
                <p className="mt-2 text-[11px] text-slate-500">
                  Expires {new Date(discount.expiresAt).toLocaleDateString()}.
                </p>
              )}
              <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
                <a
                  href="/"
                  onClick={handleDismiss}
                  className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
                  data-testid="exit-intent-shop"
                >
                  Start shopping
                </a>
                <button
                  type="button"
                  onClick={handleDismiss}
                  className="text-xs text-slate-500 hover:text-slate-700"
                  data-testid="exit-intent-dismiss"
                >
                  No thanks
                </button>
              </div>
            </>
          ) : (
            <>
              <p className="text-sm text-slate-700">
                We don't have a public discount code right now, but you can still
                get real savings with our upfront eSIM prices. Compare plans for
                your destination before you go.
              </p>
              <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
                <a
                  href="/"
                  onClick={handleDismiss}
                  className="rounded-xl bg-brand-600 px-3 py-2 text-sm font-semibold text-white hover:bg-brand-700"
                  data-testid="exit-intent-shop"
                >
                  Browse destinations
                </a>
                <button
                  type="button"
                  onClick={handleDismiss}
                  className="text-xs text-slate-500 hover:text-slate-700"
                  data-testid="exit-intent-dismiss"
                >
                  Dismiss
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export const __test__ = {
  isDiscountActive,
  formatDiscount,
  attachExitIntentTriggers,
  fetchConfig,
  STORAGE_KEY,
  SESSION_ATTR,
};

/**
 * TopUpModal — one-click top-up flow for a single eSIM.
 *
 * Contract with the backend (server/routes/topup.ts):
 *   GET  /api/topup/options/:esimId     → { ok, data: { options, eligible, reason?, ... } }
 *   POST /api/topup/checkout            → { ok, data: { checkoutUrl, topupPublicId } }
 *
 * Design decisions
 * ----------------
 * - Never fabricate prices or options. When eligibility is false we render the
 *   reason as plain copy, mapped from the server's `TopupReason` so users see a
 *   real answer (expired, not eligible, supplier down) instead of a dead button.
 * - Pay-FIRST: the modal does not call the supplier. It only asks the server to
 *   open a Stripe Checkout session. The order is created on the Stripe webhook
 *   (server side), which is what makes refunds/retries safe.
 * - Errors carry machine-readable `code` + a human `message`; we surface the
 *   message (falling back to a per-code default) so a 503 doesn't show "null".
 * - The auto top-up block is only rendered when the parent supplies the saved
 *   settings + handler; this modal does not own auto top-up configuration, it
 *   only links to it.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatMoney, type DisplayCurrency } from "../lib/apiClient";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TopupReason =
  | "esim_not_found"
  | "esim_expired"
  | "esim_not_installed"
  | "topup_unsupported"
  | "no_options"
  | "supplier_not_configured"
  | "db_unavailable"
  | "off_session_unsupported"
  | "cap_exceeded"
  | "no_saved_card"
  | "auto_disabled"
  | "off_session_charge_failed"
  | "supplier_topup_unavailable"
  | "supplier_topup_failed"
  | "payment_not_configured"
  | "invalid_input"
  | "unauthorized";

export interface TopupOption {
  packageCode: string;
  packageName: string;
  dataGB: number | null;
  durationDays: number | null;
  /** Retail price in USD (server-side/pricing engine). */
  retailPrice: number;
  currency: string;
  networkNames: string[];
}

export interface TopupOptionsPayload {
  esimId: number;
  iccid: string | null;
  esimTranNo: string | null;
  options: TopupOption[];
  eligible: boolean;
  reason?: TopupReason;
}

export interface TopUpModalProps {
  /** eSIM being topped up (id is numeric server PK). */
  esimId: number;
  /** Display label, e.g. "Singapore — Singtel 5G". */
  esimLabel: string;
  /** Currency preference for display (server always returns USD retail). */
  currency: DisplayCurrency;
  /** Where Stripe should send the buyer on success. */
  successPath?: string;
  /** Called after a Checkout session is created (host can close the modal). */
  onCheckoutStarted?: (checkoutUrl: string) => void;
  /** Called to close. Required. */
  onClose: () => void;
  /** Optional auto top-up shortcut label (e.g. "Set up auto top-up"). */
  autoTopUpHref?: string;
  /**
   * Override fetch (tests). Defaults to global fetch.
   */
  fetchImpl?: typeof fetch;
}

// ---------------------------------------------------------------------------
// Reason → copy
// ---------------------------------------------------------------------------

const REASON_COPY: Record<TopupReason, { title: string; body: string }> = {
  esim_not_found: {
    title: "We couldn't find that eSIM",
    body: "It may have been removed from your account. Refresh My eSIMs and try again.",
  },
  esim_expired: {
    title: "This eSIM has expired",
    body: "Top-ups aren't available after a plan expires. Buy a new plan for your next trip.",
  },
  esim_not_installed: {
    title: "Install the eSIM first",
    body: "Top-ups are available after a plan is installed on your device.",
  },
  topup_unsupported: {
    title: "Top-ups aren't available for this plan",
    body: "The supplier doesn't allow top-ups on this package. You can buy a new plan instead.",
  },
  no_options: {
    title: "No top-up packages right now",
    body: "The supplier isn't offering top-ups for this eSIM at the moment. Try again later.",
  },
  supplier_not_configured: {
    title: "Top-ups are temporarily unavailable",
    body: "Our supplier isn't reachable at the moment. Please try again shortly.",
  },
  db_unavailable: {
    title: "Top-ups are temporarily unavailable",
    body: "We couldn't reach our system. Please try again in a moment.",
  },
  off_session_unsupported: {
    title: "Top-ups are temporarily unavailable",
    body: "Please try again in a moment.",
  },
  cap_exceeded: {
    title: "Monthly auto top-up cap reached",
    body: "Auto top-up is paused until next month. You can still top up manually.",
  },
  no_saved_card: {
    title: "No saved card",
    body: "Auto top-up needs a saved card. Add one at checkout.",
  },
  auto_disabled: {
    title: "Auto top-up is off",
    body: "Turn it on in My eSIMs to charge automatically when data runs low.",
  },
  off_session_charge_failed: {
    title: "We couldn't charge the saved card",
    body: "Please top up manually, or update your card in settings.",
  },
  supplier_topup_unavailable: {
    title: "Top-ups are temporarily unavailable",
    body: "Please try again shortly.",
  },
  supplier_topup_failed: {
    title: "The supplier couldn't apply the top-up",
    body: "Our team has been alerted. You won't be charged twice. Try again shortly.",
  },
  payment_not_configured: {
    title: "Payments are unavailable",
    body: "We couldn't open the payment page. Please try again shortly.",
  },
  invalid_input: {
    title: "That option isn't available",
    body: "Pick another top-up package.",
  },
  unauthorized: {
    title: "Sign in required",
    body: "Please sign in to top up this eSIM.",
  },
};

function copyForReason(reason: TopupReason | undefined): { title: string; body: string } {
  if (reason && reason in REASON_COPY) return REASON_COPY[reason];
  return {
    title: "Top-ups are unavailable for this eSIM",
    body: "Try again later, or contact support if this keeps happening.",
  };
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function formatData(gb: number | null): string {
  if (gb == null) return "Data";
  return gb >= 1 ? `${Number.isInteger(gb) ? gb : gb.toFixed(1)} GB` : `${Math.round(gb * 1024)} MB`;
}

function formatDuration(days: number | null): string | null {
  if (days == null) return null;
  return `${days} ${days === 1 ? "day" : "days"}`;
}

// ---------------------------------------------------------------------------
// Fetch helpers
// ---------------------------------------------------------------------------

interface ApiOk<T> {
  ok: true;
  data: T;
}
interface ApiErr {
  ok: false;
  error: string;
  message: string;
  code?: string;
}

async function getOptions(
  fetchImpl: typeof fetch,
  esimId: number,
  signal: AbortSignal,
): Promise<TopupOptionsPayload> {
  const res = await fetchImpl(`/api/topup/options/${esimId}`, {
    credentials: "include",
    headers: { Accept: "application/json" },
    signal,
  });
  const body = (await res.json().catch(() => ({}))) as ApiOk<TopupOptionsPayload> | ApiErr | null;
  if (!res.ok || !body || body.ok === false) {
    const reason: TopupReason =
      (body && body.ok === false && (body.code as TopupReason)) ||
      (res.status === 401 ? "unauthorized" : res.status === 503 ? "supplier_not_configured" : "invalid_input");
    throw new TopupRequestError(
      reason,
      (body && body.ok === false && body.message) || `Request failed (HTTP ${res.status}).`,
      res.status,
    );
  }
  return body.data;
}

async function startCheckout(
  fetchImpl: typeof fetch,
  esimId: number,
  packageCode: string,
  successPath: string,
): Promise<{ checkoutUrl: string; topupPublicId: string }> {
  const res = await fetchImpl("/api/topup/checkout", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      esimId,
      packageCode,
      successPath,
    }),
  });
  const body = (await res.json().catch(() => ({}))) as
    | ApiOk<{ checkoutUrl: string; topupPublicId: string }>
    | ApiErr
    | null;
  if (!res.ok || !body || body.ok === false) {
    const reason: TopupReason =
      (body && body.ok === false && (body.code as TopupReason)) ||
      (res.status === 401 ? "unauthorized" : "payment_not_configured");
    throw new TopupRequestError(
      reason,
      (body && body.ok === false && body.message) || `Checkout failed (HTTP ${res.status}).`,
      res.status,
    );
  }
  return body.data;
}

class TopupRequestError extends Error {
  readonly code: TopupReason;
  readonly httpStatus: number;
  constructor(code: TopupReason, message: string, httpStatus: number) {
    super(message);
    this.name = "TopupRequestError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

type ModalState =
  | { status: "loading" }
  | { status: "ready"; payload: TopupOptionsPayload }
  | { status: "ineligible"; payload: TopupOptionsPayload; reason: TopupReason }
  | { status: "error"; reason: TopupReason; message: string };

export function TopUpModal({
  esimId,
  esimLabel,
  currency,
  successPath = "/my-esims",
  onCheckoutStarted,
  onClose,
  autoTopUpHref,
  fetchImpl,
}: TopUpModalProps): JSX.Element {
  const fetchFn = fetchImpl ?? fetch;
  const [state, setState] = useState<ModalState>({ status: "loading" });
  const [starting, setStarting] = useState<string | null>(null);
  const [startError, setStartError] = useState<{ reason: TopupReason; message: string } | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  // Initial fetch on mount.
  useEffect(() => {
    const controller = new AbortController();
    setState({ status: "loading" });
    getOptions(fetchFn, esimId, controller.signal)
      .then((payload) => {
        if (controller.signal.aborted) return;
        if (payload.eligible && payload.options.length > 0) {
          setState({ status: "ready", payload });
        } else {
          setState({
            status: "ineligible",
            payload,
            reason: payload.reason ?? "no_options",
          });
        }
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        const reason = err instanceof TopupRequestError ? err.code : "supplier_not_configured";
        const message =
          err instanceof Error ? err.message : "Could not load top-up options.";
        setState({ status: "error", reason, message });
      });
    return () => controller.abort();
  }, [esimId, fetchFn]);

  // Esc closes the modal; focus trap is minimal (a full trap is out of scope).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const onChoose = useCallback(
    async (packageCode: string) => {
      setStarting(packageCode);
      setStartError(null);
      try {
        const res = await startCheckout(fetchFn, esimId, packageCode, successPath);
        onCheckoutStarted?.(res.checkoutUrl);
        // Redirect to Stripe Checkout. A full-page nav is intentional — the
        // Stripe session owns the subsequent state.
        window.location.assign(res.checkoutUrl);
      } catch (err: unknown) {
        const reason = err instanceof TopupRequestError ? err.code : "payment_not_configured";
        const message = err instanceof Error ? err.message : "Could not start checkout.";
        setStartError({ reason, message });
        setStarting(null);
      }
    },
    [esimId, fetchFn, onCheckoutStarted, successPath],
  );

  const header = (
    <header className="flex items-start justify-between gap-3">
      <div>
        <h2 className="text-lg font-bold text-slate-900">Top up</h2>
        <p className="mt-0.5 text-xs text-slate-500">{esimLabel}</p>
      </div>
      <button
        type="button"
        onClick={onClose}
        aria-label="Close"
        className="rounded-lg p-1 text-slate-500 hover:bg-slate-100"
        data-testid="topup-close"
      >
        <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
          <path d="M5 5l10 10M15 5l-10 10" strokeLinecap="round" />
        </svg>
      </button>
    </header>
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/50 p-0 sm:items-center sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="topup-dialog-title"
      data-testid="topup-modal"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="w-full max-w-md rounded-t-2xl bg-white p-5 shadow-xl sm:rounded-2xl"
      >
        <h2 id="topup-dialog-title" className="sr-only">
          Top up eSIM
        </h2>
        {header}

        {state.status === "loading" && (
          <div className="mt-6 space-y-3" aria-busy data-testid="topup-loading">
            <div className="h-16 animate-pulse rounded-xl bg-slate-100" />
            <div className="h-16 animate-pulse rounded-xl bg-slate-100" />
          </div>
        )}

        {state.status === "error" && (
          <div
            role="alert"
            className="mt-4 rounded-xl bg-rose-50 px-3 py-3 text-sm text-rose-800 ring-1 ring-rose-200"
            data-testid="topup-error"
            data-reason={state.reason}
          >
            <p className="font-semibold">{copyForReason(state.reason).title}</p>
            <p className="mt-1">{state.message || copyForReason(state.reason).body}</p>
          </div>
        )}

        {state.status === "ineligible" && (
          <div
            role="status"
            className="mt-4 rounded-xl bg-amber-50 px-3 py-3 text-sm text-amber-900 ring-1 ring-amber-200"
            data-testid="topup-ineligible"
            data-reason={state.reason}
          >
            <p className="font-semibold">{copyForReason(state.reason).title}</p>
            <p className="mt-1">{copyForReason(state.reason).body}</p>
          </div>
        )}

        {state.status === "ready" && (
          <>
            <p className="mt-3 text-xs text-slate-500">
              The new data is added to your existing plan. You'll enter card details
              in the next step.
            </p>
            <ul className="mt-4 space-y-2" data-testid="topup-options">
              {state.payload.options.map((opt) => {
                const busy = starting === opt.packageCode;
                const disabled = starting != null && !busy;
                return (
                  <li key={opt.packageCode}>
                    <button
                      type="button"
                      disabled={disabled || busy}
                      onClick={() => onChoose(opt.packageCode)}
                      className={`w-full rounded-xl border p-3 text-left transition ${
                        busy
                          ? "border-brand-300 bg-brand-50"
                          : disabled
                            ? "border-slate-200 bg-slate-50 text-slate-400"
                            : "border-slate-200 bg-white hover:border-brand-400 hover:bg-brand-50"
                      }`}
                      data-testid={`topup-option-${opt.packageCode}`}
                    >
                      <div className="flex items-baseline justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-semibold text-slate-900">
                            {formatData(opt.dataGB)}
                            {formatDuration(opt.durationDays) && (
                              <span className="font-normal text-slate-500">
                                {" · "}
                                {formatDuration(opt.durationDays)}
                              </span>
                            )}
                          </p>
                          {opt.networkNames.length > 0 && (
                            <p className="mt-0.5 truncate text-xs text-slate-500">
                              Runs on {opt.networkNames.slice(0, 2).join(", ")}
                            </p>
                          )}
                        </div>
                        <p className="shrink-0 text-sm font-bold text-slate-900">
                          {busy ? "Starting…" : formatMoney(opt.retailPrice, currency)}
                        </p>
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
            {startError && (
              <div
                role="alert"
                className="mt-3 rounded-xl bg-rose-50 px-3 py-2 text-xs text-rose-800 ring-1 ring-rose-200"
                data-reason={startError.reason}
                data-testid="topup-start-error"
              >
                <p className="font-semibold">{copyForReason(startError.reason).title}</p>
                <p className="mt-0.5">{startError.message}</p>
              </div>
            )}
            <div className="mt-4 flex items-center justify-between gap-3 text-xs text-slate-500">
              <span>Secure checkout · Money-back guarantee applies</span>
              {autoTopUpHref && (
                <a
                  href={autoTopUpHref}
                  className="font-medium text-brand-700 hover:text-brand-800"
                  data-testid="topup-auto-link"
                >
                  Auto top-up
                </a>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export const __test__ = { copyForReason, formatData, formatDuration };

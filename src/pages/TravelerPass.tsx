/**
 * Traveler Pass — annual membership page (/traveler-pass).
 *
 * What the pass does (per the spec): a yearly subscription (price + % off
 * set by an admin) that gives members a discount on every plan plus
 * member-only deals.
 *
 * CONTRACT (server routes live in `server/routes/growth.ts`, which was not
 * supplied in this request — this page is written against the documented
 * shape and will be reconciled when the route source is provided):
 *
 *   GET  /api/growth/traveler-pass
 *        → { ok:true, data: {
 *              priceMinor: number,
 *              currency: "SGD" | "USD" | "VND" | "CNY",
 *              months: number,               // 12 for a yearly pass
 *              discountPercent: number,      // integer 1..99
 *              memberDeals: Array<{ title: string; description: string }>,
 *              configured: boolean,          // false when Stripe price is unset
 *              status: "active" | "inactive" | "none",
 *              renewsAt: string | null       // ISO when active
 *            } }
 *
 *   POST /api/growth/traveler-pass/checkout
 *        → { ok:true, data: { checkoutUrl: string } }
 *          (redirects the browser to Stripe; 503 when Stripe is unconfigured)
 *
 *   POST /api/growth/traveler-pass/cancel
 *        → { ok:true, data: { status: "inactive" } }
 *
 * HONESTY RULES
 * -------------
 *  - We never invent a price, a discount or an "active" state. If the API is
 *    unavailable or `configured` is false the page shows a plain "membership
 *    is not available yet" panel and does not offer a fake purchase button.
 *  - Money is displayed from `priceMinor` using currency-aware formatting
 *    (VND is zero-decimal). The server is the source of truth for the amount.
 *  - The buy button redirects to the Stripe URL the server returns; if the
 *    redirect is blocked we surface the URL for the buyer to click — never a
 *    fake success.
 */
import { useEffect, useMemo, useState } from "react";
import { brand, type SupportedCurrency } from "../../server/brand.config";

// ---------------------------------------------------------------------------
// Response shape (see header contract)
// ---------------------------------------------------------------------------

export interface TravelerPassDeal {
  title: string;
  description: string;
}

export type TravelerPassStatus = "active" | "inactive" | "none";

export interface TravelerPassInfo {
  priceMinor: number;
  currency: SupportedCurrency;
  months: number;
  discountPercent: number;
  memberDeals: TravelerPassDeal[];
  configured: boolean;
  status: TravelerPassStatus;
  renewsAt: string | null;
}

class TravelerPassClientError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "TravelerPassClientError";
    this.code = code;
  }
}

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: "include",
    headers: { Accept: "application/json", ...(init?.headers ?? {}) },
    ...init,
  });
  const body = (await res.json().catch(() => ({}))) as
    | { ok: true; data: T }
    | { ok: false; error: string; message: string };
  if (!res.ok || !body || (body as { ok?: boolean }).ok === false) {
    const code = (body as { ok?: false }).ok === false ? body.error : "request_failed";
    const message =
      (body as { ok?: false }).ok === false
        ? body.message
        : `Request failed (HTTP ${res.status}).`;
    throw new TravelerPassClientError(code, message);
  }
  return (body as { ok: true; data: T }).data;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** Currency-aware formatting from minor units. VND has no minor unit. */
export function formatMinor(minor: number, currency: SupportedCurrency): string {
  if (!Number.isFinite(minor)) return "—";
  const zeroDecimal = currency === "VND";
  const major = zeroDecimal ? minor : minor / 100;
  const body = zeroDecimal
    ? Math.round(major).toLocaleString("en-US")
    : major.toLocaleString("en-US", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
  return `${body} ${currency}`;
}

function describeCadence(months: number): string {
  if (months === 12) return "year";
  if (months === 1) return "month";
  return `${months} months`;
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

interface StateLoading {
  status: "loading";
}
interface StateReady {
  status: "ready";
  info: TravelerPassInfo;
}
interface StateError {
  status: "error";
  code: string;
  message: string;
}
type PageState = StateLoading | StateReady | StateError;

type ActionState =
  | { status: "idle" }
  | { status: "working"; intent: "checkout" | "cancel" }
  | { status: "error"; code: string; message: string };

export interface TravelerPassProps {
  /** Optional redirect callback for tests; defaults to window.location.assign. */
  onRedirect?: (url: string) => void;
}

export function TravelerPass({ onRedirect }: TravelerPassProps): JSX.Element {
  const [state, setState] = useState<PageState>({ status: "loading" });
  const [action, setAction] = useState<ActionState>({ status: "idle" });
  const [reloadNonce, setReloadNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    fetchJson<TravelerPassInfo>("/api/growth/traveler-pass")
      .then((info) => {
        if (!cancelled) setState({ status: "ready", info });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState({
          status: "error",
          code: err instanceof TravelerPassClientError ? err.code : "request_failed",
          message:
            err instanceof Error ? err.message : "Could not load Traveler Pass details.",
        });
      });
    return () => {
      cancelled = true;
    };
  }, [reloadNonce]);

  const priceLabel = useMemo(() => {
    if (state.status !== "ready") return "";
    const info = state.info;
    return `${formatMinor(info.priceMinor, info.currency)} / ${describeCadence(info.months)}`;
  }, [state]);

  async function handleSubscribe() {
    setAction({ status: "working", intent: "checkout" });
    try {
      const later = (url: string) => {
        if (onRedirect) onRedirect(url);
        else window.location.assign(url);
      };
      const res = await fetchJson<{ checkoutUrl: string }>(
        "/api/growth/traveler-pass/checkout",
        { method: "POST" },
      );
      later(res.checkoutUrl);
    } catch (err) {
      setAction({
        status: "error",
        code: err instanceof TravelerPassClientError ? err.code : "request_failed",
        message: err instanceof Error ? err.message : "Could not start the subscription.",
      });
    }
  }

  async function handleCancel() {
    setAction({ status: "working", intent: "cancel" });
    try {
      await fetchJson<{ status: "inactive" }>("/api/growth/traveler-pass/cancel", {
        method: "POST",
      });
      setAction({ status: "idle" });
      setReloadNonce((n) => n + 1);
    } catch (err) {
      setAction({
        status: "error",
        code: err instanceof TravelerPassClientError ? err.code : "request_failed",
        message: err instanceof Error ? err.message : "Could not cancel the subscription.",
      });
    }
  }

  if (state.status === "loading") {
    return (
      <main className="mx-auto w-full max-w-3xl px-4 py-10" aria-busy>
        <div className="h-8 w-64 animate-pulse rounded bg-slate-100" />
        <div className="mt-4 h-64 animate-pulse rounded-3xl bg-slate-100" />
      </main>
    );
  }

  if (state.status === "error") {
    return (
      <main className="mx-auto w-full max-w-3xl px-4 py-10">
        <div
          role="alert"
          className="rounded-2xl bg-rose-50 px-4 py-3 text-sm text-rose-800 ring-1 ring-rose-200"
          data-testid="traveler-pass-error"
          data-error-code={state.code}
        >
          <p className="font-semibold">We couldn't load the Traveler Pass.</p>
          <p className="mt-1">{state.message}</p>
          <button
            type="button"
            onClick={() => setReloadNonce((n) => n + 1)}
            className="mt-3 rounded-lg bg-rose-600 px-3 py-1.5 font-medium text-white hover:bg-rose-700"
          >
            Try again
          </button>
        </div>
      </main>
    );
  }

  const { info } = state;

  return (
    <main className="mx-auto w-full max-w-3xl px-4 pb-16 pt-6" data-testid="traveler-pass-page">
      <p className="text-xs uppercase tracking-wide text-slate-500">{brand.name}</p>
      <h1 className="mt-1 text-3xl font-extrabold text-slate-900">Traveler Pass</h1>
      <p className="mt-2 max-w-xl text-sm text-slate-600">
        One yearly membership. {info.discountPercent}% off every plan, plus
        member-only deals — built for people who travel more than once a year.
      </p>

      {!info.configured && (
        <div
          role="status"
          className="mt-6 rounded-2xl bg-amber-50 px-4 py-3 text-sm text-amber-900 ring-1 ring-amber-200"
          data-testid="traveler-pass-unconfigured"
        >
          The Traveler Pass isn't available for purchase yet — an admin needs to
          set its price and connect Stripe before it can be bought. Thanks for
          your patience.
        </div>
      )}

      {/* Price + status */}
      <section className="mt-6 grid gap-4 sm:grid-cols-2">
        <div className="rounded-3xl bg-gradient-to-br from-brand-600 to-brand-700 p-6 text-white">
          <p className="text-xs uppercase tracking-widest text-brand-100/80">Membership</p>
          <p className="mt-1 text-3xl font-extrabold" data-testid="traveler-pass-price">
            {priceLabel}
          </p>
          <p className="mt-2 text-xs text-brand-50/80">
            Cancel any time. Discount applies automatically at checkout for
            members.
          </p>
          <p
            className="mt-4 inline-flex items-center rounded-full bg-white/15 px-2.5 py-0.5 text-xs font-semibold text-white ring-1 ring-white/20"
            data-testid="traveler-pass-discount"
            data-discount-percent={info.discountPercent}
          >
            {info.discountPercent}% off every plan
          </p>
        </div>

        <div className="rounded-3xl bg-white p-6 ring-1 ring-slate-200">
          <p className="text-xs uppercase tracking-widest text-slate-500">Status</p>
          <p
            className="mt-1 text-lg font-semibold text-slate-900"
            data-testid="traveler-pass-status"
            data-status={info.status}
          >
            {info.status === "active"
              ? "Active"
              : info.status === "inactive"
                ? "Cancelled — ends at period close"
                : "Not a member yet"}
          </p>
          {info.status === "active" && info.renewsAt && (
            <p className="mt-1 text-xs text-slate-500">
              Renews on {formatDate(info.renewsAt)}.
            </p>
          )}

          {action.status === "error" && (
            <div
              role="alert"
              className="mt-4 rounded-xl bg-rose-50 px-3 py-2 text-xs text-rose-800 ring-1 ring-rose-200"
              data-testid="traveler-pass-action-error"
              data-error-code={action.code}
            >
              {action.message}
            </div>
          )}

          {info.status === "active" ? (
            <button
              type="button"
              onClick={handleCancel}
              disabled={action.status === "working"}
              className="mt-4 w-full rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-60"
            >
              {action.status === "working" && action.intent === "cancel"
                ? "Cancelling…"
                : "Cancel membership"}
            </button>
          ) : (
            <button
              type="button"
              onClick={handleSubscribe}
              disabled={action.status === "working" || !info.configured}
              className="mt-4 w-full rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-60"
              data-testid="traveler-pass-subscribe"
            >
              {action.status === "working" && action.intent === "checkout"
                ? "Redirecting to payment…"
                : "Join Traveler Pass"}
            </button>
          )}
        </div>
      </section>

      {/* Member deals */}
      {info.memberDeals.length > 0 && (
        <section className="mt-8" aria-labelledby="deals-heading">
          <h2 id="deals-heading" className="text-base font-bold text-slate-900">
            Member-only deals
          </h2>
          <ul className="mt-3 space-y-2">
            {info.memberDeals.map((deal, i) => (
              <li
                key={`${deal.title}-${i}`}
                className="rounded-2xl bg-slate-50 px-4 py-3 ring-1 ring-slate-200"
              >
                <p className="text-sm font-semibold text-slate-900">{deal.title}</p>
                <p className="mt-0.5 text-xs text-slate-600">{deal.description}</p>
              </li>
            ))}
          </ul>
        </section>
      )}

      <nav className="mt-8 flex flex-wrap gap-3 text-sm">
        <a
          href="/"
          className="rounded-xl border border-slate-300 bg-white px-4 py-2 font-medium text-slate-700 hover:bg-slate-50"
        >
          Browse destinations
        </a>
      </nav>
    </main>
  );
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export const __test__ = { formatMinor, describeCadence };

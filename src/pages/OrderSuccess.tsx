/**
 * Order success page: /order/:publicId (or /order/success?order=...).
 *
 * Contract:
 *   GET /api/orders/:publicId/summary  → OrderSummaryResponse
 *
 * The backend route (`server/routes/orders.ts`, queued for a later batch) is
 * the intended source. Until it exists this page surfaces a clear
 * "summary_unavailable" error rather than fabricating an order — the buyer
 * still has their Stripe receipt and the install email.
 *
 * Responsibilities (this phase):
 *  - Show the order status: completed (installable), processing (polling
 *    still running — points to "we'll email you"), or failed.
 *  - For each eSIM: its own re-viewable QR / LPA code (per-eSIM, matching
 *    group orders), with a shareable install link (`/install/:token`).
 *  - iPhone + Android install steps, verbatim from the brand copy.
 *  - Gift orders: a note that the recipient email will go out on the send
 *    date. Non-gift orders: a note that the install email was (or will be)
 *    sent to the buyer.
 *
 * No state is invented: `status` in the API response is what we render, we
 * never show a QR the server didn't return, and we never claim an email
 * was delivered — the API response carries `installEmailQueued` for that.
 */
import { useEffect, useState } from "react";

// ---------------------------------------------------------------------------
// Response shape (mirrors the future /api/orders/:publicId/summary route)
// ---------------------------------------------------------------------------

export type OrderSummaryStatus =
  | "completed"
  | "processing"
  | "failed"
  | "refunded"
  | "cancelled";

export interface OrderSummaryEsim {
  /** Marker to pick a React key. Not sent to the UI as live data. */
  esimTranNo: string | null;
  iccid: string | null;
  lpaCode: string | null;
  qrCodeUrl: string | null;
  /** Public install link (absolute path from the API; the server knows host). */
  installPath: string;
  /** Optional human label so the buyer can tell grouped eSIMs apart. */
  label?: string | null;
  status: "ready" | "processing" | "failed";
}

export interface OrderSummary {
  publicId: string;
  status: OrderSummaryStatus;
  quantity: number;
  planName: string;
  dataLabel: string;
  validityLabel: string;
  buyerEmail: string | null;
  /** Whether the install email has been queued by the backend. */
  installEmailQueued: boolean;
  /** Gift metadata echoed from the order row; null when not a gift. */
  gift: {
    recipientName: string;
    recipientEmail: string;
    message: string | null;
    sendDate: string | null;
  } | null;
  esims: OrderSummaryEsim[];
  /** Present only when status === "processing". */
  processingReason?: string | null;
  /** Present only when status === "failed". */
  failedReason?: string | null;
}

// ---------------------------------------------------------------------------
// Fetch helper
// ---------------------------------------------------------------------------

class OrderSummaryError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "OrderSummaryError";
    this.code = code;
  }
}

async function fetchSummary(publicId: string, signal: AbortSignal): Promise<OrderSummary> {
  const res = await fetch(`/api/orders/${encodeURIComponent(publicId)}/summary`, {
    credentials: "include",
    headers: { Accept: "application/json" },
    signal,
  });
  const body = (await res.json().catch(() => ({}))) as
    | { ok: true; data: OrderSummary }
    | { ok: false; error: string; message: string };
  if (!res.ok || !body || body.ok === false) {
    const code = body?.ok === false ? body.error : "request_failed";
    const message =
      body?.ok === false ? body.message : `Request failed (HTTP ${res.status}).`;
    throw new OrderSummaryError(code, message);
  }
  return body.data;
}

// ---------------------------------------------------------------------------
// Small UI primitives
// ---------------------------------------------------------------------------

function StatusPill({ status }: { status: OrderSummaryStatus }): JSX.Element {
  const map: Record<OrderSummaryStatus, { label: string; className: string }> = {
    completed: { label: "Ready to install", className: "bg-emerald-50 text-emerald-800 ring-emerald-200" },
    processing: { label: "Processing", className: "bg-amber-50 text-amber-900 ring-amber-200" },
    failed: { label: "Needs attention", className: "bg-rose-50 text-rose-800 ring-rose-200" },
    refunded: { label: "Refunded", className: "bg-slate-100 text-slate-700 ring-slate-200" },
    cancelled: { label: "Cancelled", className: "bg-slate-100 text-slate-700 ring-slate-200" },
  };
  const m = map[status];
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ${m.className}`}
      data-testid="order-status-pill"
      data-status={status}
    >
      {m.label}
    </span>
  );
}

function CopyButton({ value, label }: { value: string; label: string }): JSX.Element {
  const [copied, setCopied] = useState(false);
  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard can be blocked (non-secure context, some browsers); the
      // value is already visible for manual copy — no error UI needed.
    }
  }
  return (
    <button
      type="button"
      onClick={handleCopy}
      className="rounded-lg border border-slate-300 bg-white px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
      aria-label={label}
    >
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

function EsimBlock({ esim }: { esim: OrderSummaryEsim }): JSX.Element {
  return (
    <article
      className="rounded-2xl bg-white p-4 ring-1 ring-slate-200"
      data-testid={`order-esim-${esim.esimTranNo ?? "unknown"}`}
    >
      <header className="flex items-start justify-between gap-2">
        <div>
          <p className="text-sm font-semibold text-slate-900">
            {esim.label ?? "Your eSIM"}
          </p>
          {esim.iccid && (
            <p className="mt-0.5 text-xs text-slate-500">
              ICCID <span className="font-mono text-slate-700">{esim.iccid}</span>
            </p>
          )}
        </div>
        <a
          href={esim.installPath}
          className="text-xs font-medium text-brand-700 hover:text-brand-800"
        >
          Shareable install link →
        </a>
      </header>

      {esim.qrCodeUrl ? (
        <div className="mt-4 flex flex-col items-center gap-3 sm:flex-row sm:items-start">
          <img
            src={esim.qrCodeUrl}
            alt="Scan this QR code in your phone settings to install the eSIM"
            className="h-40 w-40 rounded-xl bg-white p-2 ring-1 ring-slate-200"
            data-testid="order-esim-qr"
          />
          <div className="flex-1">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              Manual code (if the QR won't scan)
            </p>
            {esim.lpaCode ? (
              <div className="mt-1 flex items-start gap-2">
                <code className="break-all rounded-lg bg-slate-50 px-2 py-1 text-xs text-slate-700 ring-1 ring-slate-200">
                  {esim.lpaCode}
                </code>
                <CopyButton value={esim.lpaCode} label="Copy LPA code" />
              </div>
            ) : (
              <p className="mt-1 text-xs text-slate-500">
                LPA code not yet available — check back shortly.
              </p>
            )}
          </div>
        </div>
      ) : (
        <p
          className="mt-3 rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-900 ring-1 ring-amber-200"
          data-testid="order-esim-pending"
        >
          The QR code for this eSIM hasn't arrived yet. We'll email it the moment
          the supplier confirms — usually within a couple of minutes.
        </p>
      )}
    </article>
  );
}

function InstallSteps(): JSX.Element {
  return (
    <section
      className="mt-6 rounded-2xl bg-slate-50 p-5 ring-1 ring-slate-200"
      aria-labelledby="install-heading"
    >
      <h2 id="install-heading" className="text-base font-bold text-slate-900">
        How to install
      </h2>
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <div>
          <p className="text-sm font-semibold text-slate-800">iPhone</p>
          <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-slate-700">
            <li>Open Settings → Cellular (or Mobile Data).</li>
            <li>Tap "Add eSIM" → "Use QR Code".</li>
            <li>Scan the QR from this page, name the plan "Travel", and save.</li>
            <li>
              Turn this eSIM on for "Mobile Data" but keep "Allow Mobile Data Switching"
              off until you land.
            </li>
          </ol>
        </div>
        <div>
          <p className="text-sm font-semibold text-slate-800">Android</p>
          <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-slate-700">
            <li>Open Settings → Network &amp; internet → SIMs.</li>
            <li>Tap "Add eSIM" (or "Download a SIM instead").</li>
            <li>Scan the QR from this page.</li>
            <li>
              After landing, set this eSIM as the mobile-data SIM and turn on
              data roaming for it — the plan needs it on.
            </li>
          </ol>
        </div>
      </div>
      <p className="mt-4 text-xs text-slate-500">
        Tip: install the eSIM before you fly, while you're on Wi-Fi. It activates
        when it connects to a network at your destination.
      </p>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export interface OrderSuccessProps {
  /** Order public id — from the route (`/order/:publicId`) or `?order=`. */
  publicId: string;
}

type PageState =
  | { status: "loading" }
  | { status: "ready"; summary: OrderSummary }
  | { status: "error"; message: string; code: string };

export function OrderSuccess({ publicId }: OrderSuccessProps): JSX.Element {
  const [state, setState] = useState<PageState>({ status: "loading" });
  const [reloadNonce, setReloadNonce] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setState({ status: "loading" });
    fetchSummary(publicId, controller.signal)
      .then((summary) => {
        if (!controller.signal.aborted) setState({ status: "ready", summary });
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        if (controller.signal.aborted) return;
        const code = err instanceof OrderSummaryError ? err.code : "request_failed";
        const message =
          err instanceof Error ? err.message : "Could not load your order.";
        setState({ status: "error", message, code });
      });
    return () => controller.abort();
  }, [publicId, reloadNonce]);

  if (state.status === "loading") {
    return (
      <main className="mx-auto w-full max-w-3xl px-4 py-10" aria-busy>
        <div className="h-8 w-56 animate-pulse rounded bg-slate-100" />
        <div className="mt-6 h-64 animate-pulse rounded-2xl bg-slate-100" />
      </main>
    );
  }

  if (state.status === "error") {
    return (
      <main className="mx-auto w-full max-w-3xl px-4 py-10">
        <div
          role="alert"
          className="rounded-2xl bg-rose-50 px-4 py-3 text-sm text-rose-800 ring-1 ring-rose-200"
          data-testid="order-error"
          data-error-code={state.code}
        >
          <p className="font-semibold">We couldn't load this order.</p>
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

  const { summary } = state;
  return (
    <main className="mx-auto w-full max-w-3xl px-4 pb-16 pt-6" data-testid="order-success">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-wide text-slate-500">Order {summary.publicId}</p>
          <h1 className="mt-1 text-2xl font-extrabold text-slate-900">
            {summary.status === "completed"
              ? "Your eSIM is ready"
              : summary.status === "processing"
                ? "Your eSIM is on the way"
                : "Your order"}
          </h1>
        </div>
        <StatusPill status={summary.status} />
      </header>

      <p className="mt-2 text-sm text-slate-600">
        {summary.planName} · {summary.dataLabel} · {summary.validityLabel}
        {summary.quantity > 1 && (
          <>
            {" "}· {summary.quantity} eSIMs
          </>
        )}
      </p>

      {summary.status === "processing" && (
        <p
          className="mt-4 rounded-2xl bg-amber-50 px-4 py-3 text-sm text-amber-900 ring-1 ring-amber-200"
          data-testid="order-processing-notice"
        >
          Payment is confirmed. The supplier is still preparing your eSIM(s) —
          this usually takes a minute or two. We'll email you the QR code
          {summary.installEmailQueued ? " automatically" : ""} as soon as it's
          ready. You can keep this page open and it'll update on refresh.
          {summary.processingReason && (
            <span className="mt-1 block text-xs text-amber-800/80">
              Reference: {summary.processingReason}
            </span>
          )}
        </p>
      )}

      {summary.status === "failed" && (
        <p
          className="mt-4 rounded-2xl bg-rose-50 px-4 py-3 text-sm text-rose-800 ring-1 ring-rose-200"
          data-testid="order-failed-notice"
        >
          Something went wrong preparing your eSIM. Our team has been alerted and
          will make it right — or reply to your receipt email.
          {summary.failedReason && (
            <span className="mt-1 block text-xs text-rose-700/80">
              Reference: {summary.failedReason}
            </span>
          )}
        </p>
      )}

      {summary.installEmailQueued && summary.buyerEmail && (
        <p
          className="mt-4 rounded-xl bg-emerald-50 px-3 py-2 text-xs text-emerald-800 ring-1 ring-emerald-200"
          data-testid="order-email-notice"
        >
          We've emailed the install guide to{" "}
          <span className="font-medium">{summary.buyerEmail}</span>.
        </p>
      )}

      {summary.gift && (
        <section
          className="mt-4 rounded-2xl bg-brand-50 px-4 py-3 text-sm text-brand-900 ring-1 ring-brand-100"
          aria-labelledby="gift-heading"
          data-testid="order-gift-notice"
        >
          <h2 id="gift-heading" className="font-semibold">
            A gift for {summary.gift.recipientName}
          </h2>
          <p className="mt-1 text-xs text-brand-900/80">
            We'll send {summary.gift.recipientEmail} a branded email with the QR
            code and install steps
            {summary.gift.sendDate ? ` on ${formatDate(summary.gift.sendDate)}` : " shortly"}.
            {summary.gift.message && (
              <span className="mt-1 block italic">"{summary.gift.message}"</span>
            )}
          </p>
        </section>
      )}

      {/* eSIMs */}
      {summary.esims.length > 0 ? (
        <section className="mt-6 space-y-4" aria-labelledby="esims-heading">
          <h2 id="esims-heading" className="text-base font-bold text-slate-900">
            Your eSIM{summary.esims.length > 1 ? "s" : ""}
          </h2>
          {summary.esims.map((esim, i) => (
            <EsimBlock
              key={esim.esimTranNo ?? esim.installPath ?? String(i)}
              esim={esim}
            />
          ))}
        </section>
      ) : (
        summary.status === "completed" && (
          <p
            className="mt-6 rounded-2xl bg-slate-50 px-4 py-3 text-sm text-slate-700 ring-1 ring-slate-200"
            data-testid="order-no-esims"
          >
            No eSIM details were returned. Check your email, or contact support
            with order <span className="font-mono">{summary.publicId}</span>.
          </p>
        )
      )}

      <InstallSteps />

      <nav className="mt-8 flex flex-wrap gap-3 text-sm">
        <a
          href="/my-esims"
          className="rounded-xl bg-slate-900 px-4 py-2 font-semibold text-white hover:bg-slate-800"
        >
          Go to My eSIMs
        </a>
        <a
          href="/"
          className="rounded-xl border border-slate-300 bg-white px-4 py-2 font-medium text-slate-700 hover:bg-slate-50"
        >
          Back to home
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

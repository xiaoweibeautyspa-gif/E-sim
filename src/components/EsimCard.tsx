// src/components/EsimCard.tsx
/**
 * A single eSIM card on the My eSIMs dashboard.
 *
 * Shows country, network, status, a data-usage bar (with freshness), days left,
 * and a re-viewable QR / manual LPA code. The QR and LPA code are re-fetchable
 * per-eSIM from the server (`qrPath`), because the supplier's QR can be
 * re-shown any time while the eSIM is installed or idle — it is NOT stored in
 * the browser.
 *
 * Design decisions
 * ----------------
 * - The card is presentation + a single self-contained QR re-open interaction.
 *   It does NOT own the top-up / refund flows (later batches); a caller passes
 *   `onTopUp` / `onExtend` handlers that will be wired then. When a handler is
 *   absent the corresponding CTA is hidden rather than shown dead.
 * - `status` is the server's truth. We never upgrade a "processing" eSIM to
 *   "active" locally. Each status renders its own pill and (where relevant) a
 *   helper line.
 * - The QR is fetched only when the user opens it, so the dashboard stays
 *   light. Loading / error states are explicit; a failure says so and offers a
 *   retry rather than showing a broken image.
 * - `daysLeft` is computed server-side from the plan's validity window; the
 *   card renders it verbatim (including fractional/negative) rather than
 *   deriving its own clock, so two devices can't disagree.
 */
import { useState } from "react";
import { UsageBar, type UsageSnapshot } from "./UsageBar";

/** Server eSIM status, mirroring the state machine in webhookProcessor.ts. */
export type EsimStatus =
  | "processing" // ordered at supplier, waiting for ORDER_STATUS / QR
  | "ready" // GOT_RESOURCE, not yet installed
  | "installed" // installed on device (ESIM_STATUS)
  | "active" // connected / in use
  | "expiring" // ≤1 day validity left (VALIDITY_USAGE)
  | "expired" // validity window ended
  | "refunded"
  | "cancelled"
  | "failed";

export interface MyEsim {
  /** Stable id used for routing / API calls (server primary key as string). */
  id: string;
  /** Supplier transaction number; required for top-ups. Null until ordered. */
  esimTranNo: string | null;
  iccid: string | null;
  /** Human destination label, e.g. "Singapore". */
  country: string;
  /** Lowercase country slug for links back to the country page. */
  countrySlug: string | null;
  /** Plan display name from the catalog, e.g. "Singapore 10 GB · 30 days". */
  planName: string;
  /** Network / operator label, e.g. "Singtel 5G". Null when not yet known. */
  network: string | null;
  status: EsimStatus;
  usage: UsageSnapshot;
  /** Whole or fractional days remaining; null when not applicable / unknown. */
  daysLeft: number | null;
  /**
   * Whether this eSIM supports top-ups (supplier supportTopUpType === 2 AND not
   * expired). Server-authoritative; the card only shows the CTA when true and a
   * handler is supplied.
   */
  topUpEligible: boolean;
  /** Path that returns `{ qrCodeUrl, lpaCode }` for this eSIM. */
  qrPath: string;
}

export interface EsimCardProps {
  esim: MyEsim;
  /** Wired in a later batch; when omitted the Top up CTA is hidden. */
  onTopUp?: (esim: MyEsim) => void;
  /** Optional extend/validity CTA, wired later. */
  onExtend?: (esim: MyEsim) => void;
  /** Optional "view details" navigation. */
  detailsHref?: string;
}

// ---------------------------------------------------------------------------
// Status pill
// ---------------------------------------------------------------------------

const STATUS_META: Record<
  EsimStatus,
  { label: string; className: string; hint?: string }
> = {
  processing: {
    label: "Processing",
    className: "bg-amber-50 text-amber-900 ring-amber-200",
    hint: "We're waiting on the network to issue your QR. We'll email it shortly.",
  },
  ready: {
    label: "Ready to install",
    className: "bg-sky-50 text-sky-800 ring-sky-200",
    hint: "Open the QR below and scan it in Settings → Add eSIM.",
  },
  installed: {
    label: "Installed",
    className: "bg-indigo-50 text-indigo-800 ring-indigo-200",
    hint: "Installed on your phone. Turn it on for data when you arrive.",
  },
  active: { label: "Active", className: "bg-emerald-50 text-emerald-800 ring-emerald-200" },
  expiring: {
    label: "1 day left",
    className: "bg-amber-50 text-amber-900 ring-amber-200",
    hint: "This plan expires soon — extend it to keep your data.",
  },
  expired: { label: "Expired", className: "bg-slate-100 text-slate-700 ring-slate-200" },
  refunded: { label: "Refunded", className: "bg-slate-100 text-slate-700 ring-slate-200" },
  cancelled: { label: "Cancelled", className: "bg-slate-100 text-slate-700 ring-slate-200" },
  failed: { label: "Needs attention", className: "bg-rose-50 text-rose-800 ring-rose-200" },
};

function StatusPill({ status }: { status: EsimStatus }): JSX.Element {
  const meta = STATUS_META[status];
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ${meta.className}`}
      data-testid="esim-status-pill"
      data-status={status}
    >
      {meta.label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// QR panel (fetched on demand)
// ---------------------------------------------------------------------------

interface QrPayload {
  qrCodeUrl: string | null;
  lpaCode: string | null;
}

type QrState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; data: QrPayload }
  | { status: "error"; message: string };

async function fetchQr(path: string, signal: AbortSignal): Promise<QrPayload> {
  const res = await fetch(path, {
    credentials: "include",
    headers: { Accept: "application/json" },
    signal,
  });
  const body = (await res.json().catch(() => ({}))) as
    | { ok: true; data: QrPayload }
    | { ok: false; error: string; message: string };
  if (!res.ok || !body || body.ok === false) {
    const message =
      body?.ok === false ? body.message : `Request failed (HTTP ${res.status}).`;
    throw new Error(message);
  }
  return body.data;
}

function CopyButton({ value, label }: { value: string; label: string }): JSX.Element {
  const [copied, setCopied] = useState(false);
  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard can be blocked; the code is visible for manual copy.
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

function QrPanel({ path }: { path: string }): JSX.Element {
  const [state, setState] = useState<QrState>({ status: "idle" });
  const [nonce, setNonce] = useState(0);
  // AbortController is created per-render inside the effect; here we keep a
  // single request at a time by disabling the button while loading.

  function load() {
    setState({ status: "loading" });
    const controller = new AbortController();
    fetchQr(path, controller.signal)
      .then((data) => setState({ status: "ready", data }))
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setState({
          status: "error",
          message: err instanceof Error ? err.message : "Could not load the QR code.",
        });
      });
  }

  if (state.status === "idle") {
    return (
      <button
        type="button"
        onClick={load}
        className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
        data-testid="esim-show-qr"
      >
        Show QR code
      </button>
    );
  }

  if (state.status === "loading") {
    return (
      <div className="mt-3 h-40 w-40 animate-pulse rounded-xl bg-slate-100" aria-busy data-testid="esim-qr-loading" />
    );
  }

  if (state.status === "error") {
    return (
      <div
        role="alert"
        className="mt-3 rounded-xl bg-rose-50 px-3 py-2 text-xs text-rose-800 ring-1 ring-rose-200"
        data-testid="esim-qr-error"
      >
        <p>{state.message}</p>
        <button
          type="button"
          onClick={() => {
            setNonce((n) => n + 1);
            load();
          }}
          className="mt-2 rounded-lg bg-rose-600 px-2.5 py-1 font-medium text-white hover:bg-rose-700"
          data-key={nonce}
        >
          Try again
        </button>
      </div>
    );
  }

  const { qrCodeUrl, lpaCode } = state.data;
  return (
    <div className="mt-3 flex flex-col items-start gap-3 sm:flex-row" data-testid="esim-qr-panel">
      {qrCodeUrl ? (
        <img
          src={qrCodeUrl}
          alt="Scan this QR code in your phone settings to install the eSIM"
          className="h-40 w-40 rounded-xl bg-white p-2 ring-1 ring-slate-200"
          data-testid="esim-qr-image"
        />
      ) : (
        <p
          className="rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-900 ring-1 ring-amber-200"
          data-testid="esim-qr-missing"
        >
          The QR isn't available yet. We'll email it as soon as the network issues it.
        </p>
      )}
      {lpaCode && (
        <div className="flex-1">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
            Manual code
          </p>
          <div className="mt-1 flex items-start gap-2">
            <code className="break-all rounded-lg bg-slate-50 px-2 py-1 text-xs text-slate-700 ring-1 ring-slate-200">
              {lpaCode}
            </code>
            <CopyButton value={lpaCode} label="Copy LPA code" />
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Days-left line
// ---------------------------------------------------------------------------

function DaysLeft({ daysLeft }: { daysLeft: number | null }): JSX.Element | null {
  if (daysLeft == null) return null;
  let text: string;
  if (daysLeft <= 0) text = "No days left";
  else if (daysLeft < 1) text = "Less than a day left";
  else if (daysLeft === 1) text = "1 day left";
  else text = `${Math.floor(daysLeft)} days left`;
  return (
    <span
      className={`text-xs font-medium ${
        daysLeft <= 1 ? "text-amber-700" : "text-slate-600"
      }`}
      data-testid="esim-days-left"
    >
      {text}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Card
// ---------------------------------------------------------------------------

export function EsimCard({
  esim,
  onTopUp,
  onExtend,
  detailsHref,
}: EsimCardProps): JSX.Element {
  const meta = STATUS_META[esim.status];
  const showTopUp = esim.topUpEligible && typeof onTopUp === "function";
  const showExtend = typeof onExtend === "function" && esim.status === "expiring";

  return (
    <article
      className="rounded-2xl bg-white p-4 ring-1 ring-slate-200 sm:p-5"
      data-testid={`esim-card-${esim.id}`}
      data-status={esim.status}
    >
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-base font-bold text-slate-900" data-testid="esim-country">
            {esim.country}
          </h3>
          <p className="mt-0.5 truncate text-xs text-slate-500" data-testid="esim-plan-name">
            {esim.planName}
          </p>
        </div>
        <StatusPill status={esim.status} />
      </header>

      <dl className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-600">
        {esim.network && (
          <div className="flex items-center gap-1.5" data-testid="esim-network">
            <dt className="text-slate-400">Network</dt>
            <dd className="font-medium text-slate-700">{esim.network}</dd>
          </div>
        )}
        <div className="flex items-center gap-1.5">
          <dt className="sr-only">Time remaining</dt>
          <dd>
            <DaysLeft daysLeft={esim.daysLeft} />
          </dd>
        </div>
        {esim.iccid && (
          <div className="flex items-center gap-1.5">
            <dt className="text-slate-400">ICCID</dt>
            <dd className="font-mono text-[11px] text-slate-600">{esim.iccid}</dd>
          </div>
        )}
      </dl>

      {meta.hint && (
        <p className="mt-3 rounded-xl bg-slate-50 px-3 py-2 text-xs text-slate-600" data-testid="esim-status-hint">
          {meta.hint}
        </p>
      )}

      <div className="mt-4">
        <UsageBar usage={esim.usage} />
      </div>

      {/* Re-viewable QR */}
      {(esim.status === "ready" ||
        esim.status === "installed" ||
        esim.status === "active" ||
        esim.status === "expiring") && <QrPanel path={esim.qrPath} />}

      {(showTopUp || showExtend || detailsHref) && (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          {showTopUp && (
            <button
              type="button"
              onClick={() => onTopUp!(esim)}
              className="rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-brand-700"
              data-testid="esim-topup"
            >
              Top up
            </button>
          )}
          {showExtend && (
            <button
              type="button"
              onClick={() => onExtend!(esim)}
              className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-1.5 text-sm font-semibold text-amber-900 hover:bg-amber-100"
              data-testid="esim-extend"
            >
              Extend
            </button>
          )}
          {detailsHref && (
            <a
              href={detailsHref}
              className="text-sm font-medium text-brand-700 hover:text-brand-800"
              data-testid="esim-details"
            >
              Details →
            </a>
          )}
        </div>
      )}
    </article>
  );
}

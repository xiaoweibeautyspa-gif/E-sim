/**
 * Supplier balance guard.
 *
 * Purpose: before we call `/esim/order` we check the supplier's prepaid balance
 * via `/balance/query`. If it is below the configured safety threshold we do
 * NOT silently continue and we do NOT fake success — we:
 *   1. return a structured `{ ok: false, reason: "low_balance" }` result so the
 *      fulfilment service can persist the order and flag it in admin,
 *   2. send a one-time-per-hour alert email to the store owner (supportEmail),
 *   3. log a structured line for the admin "supplier health" surface.
 *
 * Design notes / honest limitations:
 * - The supplier balance number comes from `/balance/query` (units / 10000 = USD,
 *   normalised by the eSIM Access client). This module never invents a balance.
 * - The alert email goes through `sendOwnerAlert` which is a thin wrapper over
 *   the email sender. The email provider is wired in a later phase; until then
 *   `sendOwnerAlert` records an intent and returns `{ delivered:false }` so the
 *   caller and admin can see the alert was NOT actually delivered rather than
 *   pretending it was. The low-balance flag on the order still happens.
 * - Threshold is read from settings `supplier.lowBalanceUsd`; default 50 USD.
 *   This is deliberately conservative because an order can cost more than the
 *   per-unit price when grouped (count > 1).
 * - Rate-limited alerts: we keep an in-process timestamp so a burst of orders
 *   during a low balance does not send dozens of emails. In-process state is
 *   reset on restart — acceptable for an operational alert; the per-order admin
 *   flag is the durable signal.
 */
import { eq } from "drizzle-orm";
import { esimAccess, type EsimAccessError } from "../esimaccess";
import { getDb } from "../db/client";
import { settings } from "../db/schema";
import { brand } from "../brand.config";

/** Settings key for the low-balance threshold (USD). */
export const LOW_BALANCE_SETTING_KEY = "supplier.lowBalanceUsd";

/** Default low-balance threshold in USD when the setting is absent. */
export const DEFAULT_LOW_BALANCE_USD = 50;

/** How long to suppress repeat owner alerts for the same condition. */
const ALERT_COOLDOWN_MS = 60 * 60 * 1000;

export type BalanceCheckResult =
  | {
      ok: true;
      balanceUsd: number;
      thresholdUsd: number;
      /** True when balance is below threshold; caller should flag the order. */
      low: boolean;
    }
  | {
      ok: false;
      reason: "not_configured" | "supplier_error";
      detail: string;
      /**
       * When the check itself failed we cannot confirm the balance. Callers
       * should treat this as "do not proceed blindly" and either retry later
       * or flag for manual review — never as a green light.
       */
    };

export interface OwnerAlert {
  subject: string;
  body: string;
}

/** Injectable seams for tests; production uses the real client + DB. */
export interface BalanceGuardDeps {
  fetchBalance?: () => Promise<{ balanceUsd: number }>;
  readThresholdUsd?: () => Promise<number>;
  sendOwnerAlert?: (alert: OwnerAlert) => Promise<{ delivered: boolean; reason?: string }>;
  log?: (msg: string) => void;
  now?: () => number;
}

/** Read the low-balance threshold from settings, falling back to the default. */
export async function readLowBalanceThresholdUsd(): Promise<number> {
  const db = getDb();
  if (!db) return DEFAULT_LOW_BALANCE_USD;
  try {
    const [row] = await db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, LOW_BALANCE_SETTING_KEY))
      .limit(1);
    const n = coerceNumber(row?.value);
    return n != null && n >= 0 ? n : DEFAULT_LOW_BALANCE_USD;
  } catch {
    // A settings read failure must not block fulfilment; use the safe default.
    return DEFAULT_LOW_BALANCE_USD;
  }
}

/**
 * Perform the pre-order balance check.
 *
 * Returns `{ ok:true, low }`. When `low` is true the caller must NOT proceed as
 * if all is well — it should save the order, flag it, and surface the alert.
 * When the check itself errors (`ok:false`) the caller should treat the order
 * as not-ready-to-order (flag for review / retry later).
 */
export async function checkSupplierBalance(
  deps: BalanceGuardDeps = {},
): Promise<BalanceCheckResult> {
  const log = deps.log ?? ((m: string) => console.log(m));

  if (!esimAccess.isConfigured) {
    return {
      ok: false,
      reason: "not_configured",
      detail: "Supplier credentials (ESIM_ACCESS_CODE) are not configured.",
    };
  }

  const fetchBalance = deps.fetchBalance ?? (() => esimAccess.balance().then((b) => ({ balanceUsd: b.balanceUsd })));
  const readThreshold = deps.readThresholdUsd ?? readLowBalanceThresholdUsd;

  let balanceUsd: number;
  try {
    const b = await fetchBalance();
    balanceUsd = b.balanceUsd;
  } catch (err) {
    const e = err as EsimAccessError;
    const detail = e instanceof Error ? e.message : String(err);
    log(`[balanceGuard] balance query failed: ${detail}`);
    return { ok: false, reason: "supplier_error", detail };
  }

  const thresholdUsd = await readThreshold();
  const low = balanceUsd < thresholdUsd;
  if (low) {
    log(
      `[balanceGuard] LOW BALANCE: supplier balance $${balanceUsd.toFixed(2)} ` +
        `< threshold $${thresholdUsd.toFixed(2)}`,
    );
    void maybeSendLowBalanceAlert(balanceUsd, thresholdUsd, deps);
  }
  return { ok: true, balanceUsd, thresholdUsd, low };
}

// ---------------------------------------------------------------------------
// Owner alert (rate-limited)
// ---------------------------------------------------------------------------

let lastAlertAt = 0;

async function maybeSendLowBalanceAlert(
  balanceUsd: number,
  thresholdUsd: number,
  deps: BalanceGuardDeps,
): Promise<void> {
  const now = deps.now ? deps.now() : Date.now();
  if (now - lastAlertAt < ALERT_COOLDOWN_MS) return;
  lastAlertAt = now;

  const alert: OwnerAlert = {
    subject: `[${brand.name}] Supplier balance low: $${balanceUsd.toFixed(2)}`,
    body: [
      `The eSIM Access supplier balance is $${balanceUsd.toFixed(2)} USD,`,
      `below the configured threshold of $${thresholdUsd.toFixed(2)} USD.`,
      ``,
      `New orders will be saved and flagged in the admin queue but not fulfilled`,
      `until the supplier balance is topped up.`,
    ].join("\n"),
  };

  const send = deps.sendOwnerAlert ?? defaultSendOwnerAlert;
  try {
    const result = await send(alert);
    if (!result.delivered) {
      // Honest: the alert email was NOT delivered. The admin flag + log remain
      // the durable signal.
      (deps.log ?? console.log)(
        `[balanceGuard] owner alert not delivered: ${result.reason ?? "email provider not configured"}`,
      );
    }
  } catch (err) {
    (deps.log ?? console.log)(
      `[balanceGuard] owner alert threw: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Default owner-alert sender.
 *
 * The transactional email provider is wired in a later phase. Rather than
 * claiming an email went out, this returns `{ delivered:false }` with a reason.
 * The fulfilment service still flags the order for admin, which is the durable
 * record. Swapping in the real provider is a one-line change once it exists.
 */
async function defaultSendOwnerAlert(_alert: OwnerAlert): Promise<{ delivered: boolean; reason?: string }> {
  return { delivered: false, reason: "email provider not configured (owner alert logged only)" };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function coerceNumber(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  if (typeof value === "object") {
    const obj = value as { value?: unknown; usd?: unknown };
    const n = Number(obj.usd ?? obj.value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export const __test__ = {
  DEFAULT_LOW_BALANCE_USD,
  ALERT_COOLDOWN_MS,
  coerceNumber,
  /** Reset the in-process alert cooldown (tests only). */
  resetAlertCooldown: () => {
    lastAlertAt = 0;
  },
};

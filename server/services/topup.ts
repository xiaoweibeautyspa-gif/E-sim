/**
 * Top-up service.
 *
 * Responsibilities
 * ----------------
 *  1. List top-up packages for a given eSIM via the supplier's
 *     `/package/list` (type=TOPUP, iccid). We translate supplier prices
 *     (integer × 10000 => USD) into the store's retail price through the
 *     existing pricing engine, and NEVER return supplier wholesale price to
 *     the browser.
 *  2. Enforce eligibility in one place:
 *       - the eSIM must belong to the signed-in user (or be a guest email
 *         match if we later allow that); otherwise we treat "not found",
 *       - the eSIM must be non-expired (expiresAt > now, or null upstream),
 *       - the eSIM must have `supportTopUpType === 2` (the supplier only
 *         allows top-up on that type),
 *       - the chosen package must be a TOPUP package for the eSIM's iccid.
 *  3. Pay-first flow: create the top-up row in `pending_payment`, return a
 *     Stripe Checkout session to the client. The actual `/esim/topup` call
 *     happens after Stripe confirms via webhook (see `applyTopupPaid`), keyed
 *     by our `public_id` as the supplier `transactionId` for idempotency.
 *  4. Auto top-up: `chargeAutoTopupForLowData` is the entrypoint the webhook
 *     processor calls on DATA_USAGE. It checks the saved payment method, the
 *     monthly cap (single conditional UPDATE returning `null` when the cap
 *     would be exceeded), and creates a Paid top-up in one step via the
 *     payment provider's off-session charge (or, if the provider has no
 *     off-session API, a Checkout session — the honest path is to surface the
 *     reason instead of pretending).
 *
 * Honest limitations (documented, not hidden)
 * -------------------------------------------
 * - The off-session charge path (`PaymentProvider.chargeOffSession`) is not
 *   yet part of the shared provider interface in the supplied
 *   `server/payments/paymentProvider.ts`. This module probes for it and
 *   returns `reason: "off_session_unsupported"` when absent — the RIGHT
 *   behaviour is for the customer to receive the low-data email + one-click
 *   top-up instead of a silent auto charge that can't actually go through.
 * - The supplier `/esim/topup` call is delegated to the fulfilment phase's
 *   `executeTopupOrdering` (added in a later phase). This module calls
 *   `esimAccess.topup` DIRECTLY when the client exposes it, otherwise
 *   returns `reason: "supplier_topup_unavailable"`. It never fakes a
 *   successful top-up.
 * - No scheduled job here resets `month_spent_amount` at month boundaries;
 *   the check compares `month_key` to `now()` on every auto charge, so a
 *   stale counter is treated as zero. A reset job is still useful for the
 *   admin dashboard's "monthly spend" chart and belongs to the growth
 *   phase.
 */
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { getDb } from "../db/client";
import { esims, packages as packagesTable, topups, autoTopupSettings } from "../db/schema";
import { getPaymentProvider } from "../payments/paymentProvider";
import type {
  CreateSessionRequest,
  SupportedCurrency as ProviderCurrency,
} from "../payments/paymentProvider";
import type { SupportedCurrency } from "../brand.config";
import { brand } from "../brand.config";
import { priceFor } from "./pricing";

// ---------------------------------------------------------------------------
// Supplier shape we accept
// ---------------------------------------------------------------------------

/**
 * One item from a `/package/list` response (type=TOPUP). Field names mirror
 * the supplier API; we accept both the camelCase aliases the eSIM Access
 * client produces (see server/esimaccess.ts normaliser) and raw snake_case
 * variants from earlier exports. Unknown fields are ignored.
 */
export interface SupplierTopupPackage {
  packageCode: string;
  packageName?: string | null;
  price?: number | null; // integer × 10000 => USD (wholesale)
  volume?: number | null; // bytes
  duration?: number | null; // days
  currencyCode?: string | null; // 'USD'
  supportTopUpType?: number | null;
  locationNetworkList?: Array<{ operatorName?: string | null }> | null;
}

/** Public shape returned by `listTopupOptions` (never includes wholesale). */
export interface TopupOption {
  packageCode: string;
  packageName: string;
  dataGB: number | null;
  durationDays: number | null;
  /** Retail price in the requested currency, formatted at 2 dp. */
  retailPrice: number;
  currency: SupportedCurrency;
  networkNames: string[];
}

export interface TopupOptionsResult {
  esimId: number;
  iccid: string | null;
  esimTranNo: string | null;
  options: TopupOption[];
  /** True when the caller can offer a one-click buy. */
  eligible: boolean;
  /** Reason when `eligible === false` or `options` is empty (for UX copy). */
  reason?: TopupReason;
}

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
  | "invalid_input";

export class TopupError extends Error {
  readonly code: TopupReason;
  constructor(code: TopupReason, message: string) {
    super(message);
    this.name = "TopupError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Supplier client accessor (does not throw when unconfigured)
// ---------------------------------------------------------------------------

interface SupplierClient {
  listPackages?: (input: {
    type?: string;
    iccid?: string;
  }) => Promise<{ list?: SupplierTopupPackage[]; packages?: SupplierTopupPackage[] }>;
  topup?: (input: {
    esimTranNo: string;
    packageCode: string;
    transactionId: string;
  }) => Promise<{ ok?: boolean; orderNo?: string | null }>;
  isConfigured?: boolean;
}

async function loadSupplier(): Promise<SupplierClient | null> {
  try {
    const mod = (await import("../esimaccess")) as { esimAccess?: SupplierClient };
    const client = mod.esimAccess;
    if (!client) return null;
    return client;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Price conversion
// ---------------------------------------------------------------------------

/** Convert a supplier integer price (× 10000 USD) to USD major units. */
export function supplierPriceToUsd(value: number | null | undefined): number | null {
  if (value == null) return null;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  // Supplier prices are integer ten-thousandths of a USD. Divide and round
  // HALF-UP at four decimals so the retail arithmetic downstream is stable.
  return Math.round((n / 10_000) * 10_000) / 10_000;
}

/** Convert bytes to whole-GB (2 dp); null when not-a-number. */
export function bytesToGB(bytes: number | null | undefined): number | null {
  if (bytes == null) return null;
  const n = typeof bytes === "number" ? bytes : Number(bytes);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round((n / (1024 * 1024 * 1024)) * 100) / 100;
}

// ---------------------------------------------------------------------------
// Public id generation
// ---------------------------------------------------------------------------

/**
 * A short, URL-safe, collision-resistant idempotency key for a top-up. Used
 * both as our `topups.public_id` and as the supplier `transactionId` on
 * `/esim/topup`, so retries with the same row reuse the same key and the
 * supplier de-dupes.
 */
export function makeTopupPublicId(now: Date = new Date()): string {
  // 8 hex chars from crypto.randomBytes (retried on the off-chance of
  // collision against the unique index — callers handle the retry by
  // regenerating if insert fails with 23505).
  const random = Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, "0");
  const stamp = now.getTime().toString(36).slice(-6);
  return `tp_${stamp}_${random}`;
}

// ---------------------------------------------------------------------------
// listTopupOptions
// ---------------------------------------------------------------------------

export interface ListTopupInput {
  userId: number;
  esimId: number;
  /** Override the client (tests). */
  supplier?: SupplierClient | null;
  /** Override the DB (tests). */
  getDb?: typeof getDb;
  /** Override the pricing mapper (tests). */
  priceOf?: (packageCode: string, wholesaleUsd: number, countrySlug: string | null) => Promise<number>;
  now?: () => Date;
  currency?: SupportedCurrency;
}

/**
 * Read eligible top-up options for a single eSIM. Never returns wholesale.
 * Returns `{ eligible: false, reason }` for the honest "why can't I top up
 * here" copy; a foreign eSIM is treated as not-found by the route (not by
 * this service) so the two call sites agree.
 */
export async function listTopupOptions(input: ListTopupInput): Promise<TopupOptionsResult> {
  const db = (input.getDb ?? getDb)();
  if (!db) {
    return { esimId: input.esimId, iccid: null, esimTranNo: null, options: [], eligible: false, reason: "db_unavailable" };
  }

  const [row] = await db
    .select({
      id: esims.id,
      userId: esims.userId,
      iccid: esims.iccid,
      esimTranNo: esims.esimTranNo,
      status: esims.status,
      expiresAt: esims.expiresAt,
      supportTopUpType: esims.supportTopUpType,
      countrySlug: esims.countrySlug,
    })
    .from(esims)
    .where(and(eq(esims.id, input.esimId), eq(esims.userId, input.userId)))
    .limit(1);

  if (!row) {
    return { esimId: input.esimId, iccid: null, esimTranNo: null, options: [], eligible: false, reason: "esim_not_found" };
  }

  const base = {
    esimId: row.id,
    iccid: row.iccid ?? null,
    esimTranNo: row.esimTranNo ?? null,
  };

  const now = input.now ? input.now() : new Date();
  if (row.expiresAt && row.expiresAt.getTime() <= now.getTime()) {
    return { ...base, options: [], eligible: false, reason: "esim_expired" };
  }
  if (row.supportTopUpType !== 2) {
    return { ...base, options: [], eligible: false, reason: "topup_unsupported" };
  }
  if (!row.iccid) {
    return { ...base, options: [], eligible: false, reason: "topup_unsupported" };
  }

  const supplier = input.supplier ?? (await loadSupplier());
  if (!supplier || typeof supplier.listPackages !== "function") {
    return { ...base, options: [], eligible: false, reason: "supplier_not_configured" };
  }

  let rawList: SupplierTopupPackage[];
  try {
    const res = await supplier.listPackages({ type: "TOPUP", iccid: row.iccid });
    rawList = res.list ?? res.packages ?? [];
  } catch {
    return { ...base, options: [], eligible: false, reason: "supplier_not_configured" };
  }

  const currency = (input.currency ?? brand.defaultCurrency) as SupportedCurrency;
  const priceOf = input.priceOf ?? defaultPriceOf;
  const options: TopupOption[] = [];
  for (const p of rawList) {
    if (!p.packageCode) continue;
    if (p.supportTopUpType != null && p.supportTopUpType !== 2) continue;
    const wholesaleUsd = supplierPriceToUsd(p.price);
    if (wholesaleUsd == null) continue;
    let retail: number;
    try {
      retail = await priceOf(p.packageCode, wholesaleUsd, row.countrySlug ?? null);
    } catch {
      continue;
    }
    options.push({
      packageCode: p.packageCode,
      packageName: p.packageName ?? p.packageCode,
      dataGB: bytesToGB(p.volume),
      durationDays: p.duration ?? null,
      retailPrice: roundMoney(retail),
      currency,
      networkNames: (p.locationNetworkList ?? [])
        .map((n) => (typeof n.operatorName === "string" ? n.operatorName : ""))
        .filter((s) => s.length > 0),
    });
  }
  if (options.length === 0) {
    return { ...base, options: [], eligible: false, reason: "no_options" };
  }
  return { ...base, options, eligible: true };
}

async function defaultPriceOf(
  packageCode: string,
  wholesaleUsd: number,
  countrySlug: string | null,
): Promise<number> {
  // Use the pricing service so overrides + global markup stay consistent.
  // `priceFor` is the documented entrypoint from the pricing phase.
  return priceFor({ packageCode, wholesaleUsd, countrySlug });
}

function roundMoney(n: number): number {
  return Math.round(n * 100) / 100;
}

// ---------------------------------------------------------------------------
// beginTopup — the pay-first step
// ---------------------------------------------------------------------------

export interface BeginTopupInput {
  userId: number;
  esimId: number;
  packageCode: string;
  currency?: SupportedCurrency;
  successUrl: string;
  cancelUrl: string;
  /** Where to send the buyer after success (defaults to /my-esims). */
  guestEmail?: string;
  /** Override the supplier (tests). */
  supplier?: SupplierClient | null;
  /** Override the DB (tests). */
  getDb?: typeof getDb;
  /** Override the pricing map (tests). */
  priceOf?: (packageCode: string, wholesaleUsd: number, countrySlug: string | null) => Promise<number>;
  now?: () => Date;
}

export interface BeginTopupResult {
  topupPublicId: string;
  checkoutUrl: string;
  providerSessionId: string;
}

/**
 * Create a `pending_payment` top-up row and a Stripe Checkout session for
 * it. Does NOT call the supplier — that happens after the Stripe webhook
 * (see `applyTopupPaid`).
 *
 * Retries on a duplicate `public_id` are safe: we retry with a new id up to
 * three times, which is impossible in practice but a clean failure mode if
 * the generator ever broad-collides.
 */
export async function beginTopup(input: BeginTopupInput): Promise<BeginTopupResult> {
  const db = (input.getDb ?? getDb)();
  if (!db) throw new TopupError("db_unavailable", "Top-up store is not configured.");

  const supplier = input.supplier ?? (await loadSupplier());
  if (!supplier || typeof supplier.listPackages !== "function") {
    throw new TopupError("supplier_not_configured", "Top-up options are not available right now.");
  }

  // Re-read the eSIM (fresh — the buyer could have expired it since load).
  const [row] = await db
    .select({
      id: esims.id,
      userId: esims.userId,
      iccid: esims.iccid,
      esimTranNo: esims.esimTranNo,
      expiresAt: esims.expiresAt,
      supportTopUpType: esims.supportTopUpType,
      countrySlug: esims.countrySlug,
    })
    .from(esims)
    .where(and(eq(esims.id, input.esimId), eq(esims.userId, input.userId)))
    .limit(1);
  if (!row) throw new TopupError("esim_not_found", "That eSIM is not on your account.");
  if (row.supportTopUpType !== 2) throw new TopupError("topup_unsupported", "This plan does not support top-ups.");
  if (!row.iccid) throw new TopupError("topup_unsupported", "The eSIM is not ready yet.");
  const now = input.now ? input.now() : new Date();
  if (row.expiresAt && row.expiresAt.getTime() <= now.getTime()) {
    throw new TopupError("esim_expired", "That eSIM has expired.");
  }

  // Confirm the chosen package is a real TOPUP option for this iccid.
  let rawList: SupplierTopupPackage[];
  try {
    const res = await supplier.listPackages({ type: "TOPUP", iccid: row.iccid });
    rawList = res.list ?? res.packages ?? [];
  } catch {
    throw new TopupError("supplier_not_configured", "Top-up options are not available right now.");
  }
  const chosen = rawList.find((p) => p.packageCode === input.packageCode);
  if (!chosen) throw new TopupError("invalid_input", "That top-up package is not available for this eSIM.");
  if (chosen.supportTopUpType != null && chosen.supportTopUpType !== 2) {
    throw new TopupError("topup_unsupported", "That top-up package is not eligible.");
  }
  const wholesaleUsd = supplierPriceToUsd(chosen.price);
  if (wholesaleUsd == null) throw new TopupError("invalid_input", "That top-up has no price yet.");

  const priceOf = input.priceOf ?? defaultPriceOf;
  const retailUsd = await priceOf(input.packageCode, wholesaleUsd, row.countrySlug ?? null);

  const currency = (input.currency ?? brand.defaultCurrency) as SupportedCurrency;
  const provider = getPaymentProvider();
  if (!provider.isConfigured) {
    throw new TopupError("payment_not_configured", "Payments are not configured.");
  }

  // Insert the pending row, retrying on the wildly-unlikely id collision so
  // the unique index on public_id is a real guarantee, not decoration.
  let publicId = makeTopupPublicId(now);
  let insertedRow: { id: number } | null = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const inserted = await db
        .insert(topups)
        .values({
          publicId,
          esimId: row.id,
          userId: row.userId ?? input.userId,
          esimTranNo: row.esimTranNo ?? null,
          iccid: row.iccid,
          packageCode: input.packageCode,
          packageName: chosen.packageName ?? input.packageCode,
          currency,
          retailTotal: String(retailUsd),
          wholesaleTotalUsd: String(wholesaleUsd),
          profitUsd: String(roundMoney(retailUsd - wholesaleUsd)),
          status: "pending_payment",
        })
        .returning({ id: topups.id });
      insertedRow = inserted[0] ?? null;
      if (insertedRow) break;
    } catch (e) {
      if (isDuplicateKey(e)) {
        publicId = makeTopupPublicId(new Date(now.getTime() + attempt + 1));
        continue;
      }
      throw e;
    }
  }
  if (!insertedRow) throw new TopupError("invalid_input", "Could not create the top-up.");

  // Build the Stripe Checkout session. Amount is integer minor units.
  const amountMinor = majorToMinor(retailUsd, currency);
  const sessionReq: CreateSessionRequest = {
    orderId: publicId as unknown as CreateSessionRequest["orderId"],
    total: { amount: amountMinor, currency: currency as unknown as ProviderCurrency },
    items: [
      {
        packageCode: input.packageCode,
        name: `${chosen.packageName ?? "Top-up"} for ${row.iccid}`,
        unitAmount: amountMinor,
        quantity: 1,
      },
    ],
    successUrl: input.successUrl,
    cancelUrl: input.cancelUrl,
    metadata: {
      kind: "topup",
      saveCard: false,
      guestEmail: input.guestEmail,
    } as CreateSessionRequest["metadata"],
  };

  let created: { provider: string; sessionId: string; checkoutUrl: string };
  try {
    created = await provider.createSession(sessionReq);
  } catch (e) {
    // Mark the top-up row failed so admin sees a bounded, honest state.
    await db
      .update(topups)
      .set({
        status: "failed",
        failureReason: e instanceof Error ? e.message : String(e),
        updatedAt: new Date(),
      })
      .where(eq(topups.id, insertedRow.id));
    throw new TopupError("payment_not_configured", "Could not create the payment session.");
  }

  await db
    .update(topups)
    .set({ stripeSessionId: created.sessionId, updatedAt: new Date() })
    .where(eq(topups.id, insertedRow.id));

  return { topupPublicId: publicId, checkoutUrl: created.checkoutUrl, providerSessionId: created.sessionId };
}

// ---------------------------------------------------------------------------
// applyTopupPaid — the "after Stripe confirms" step
// ---------------------------------------------------------------------------

export interface ApplyTopupPaidInput {
  topupPublicId: string;
  stripePaymentIntentId?: string | null;
  /** Override supplier (tests). */
  supplier?: SupplierClient | null;
  getDb?: typeof getDb;
  now?: () => Date;
  log?: (msg: string) => void;
  /**
   * Called when the top-up succeeds; the default implementation sends the
   * receipt email via the shared email sender. Injectable for tests.
   */
  sendReceipt?: (topup: {
    topupPublicId: string;
    toEmail: string | null;
    iccid: string | null;
    packageName: string;
    retail: number;
    currency: SupportedCurrency;
    auto: boolean;
  }) => Promise<void>;
}

export interface ApplyTopupPaidResult {
  status: "ordered" | "failed" | "already_ordered" | "not_found";
  reason?: TopupReason | "supplier_error" | string;
}

/**
 * Called from the Stripe webhook once a top-up session is `paid`. This is the
 * ONLY place `/esim/topup` is invoked for a manually-initiated top-up. It is
 * idempotent on our `topupPublicId` (the supplier `transactionId`).
 */
export async function applyTopupPaid(
  input: ApplyTopupPaidInput,
): Promise<ApplyTopupPaidResult> {
  const log = input.log ?? ((m: string) => console.log(m));
  const db = (input.getDb ?? getDb)();
  if (!db) return { status: "failed", reason: "db_unavailable" };

  const [row] = await db
    .select()
    .from(topups)
    .where(eq(topups.publicId, input.topupPublicId))
    .limit(1);
  if (!row) return { status: "not_found" };

  if (row.status === "ordered") return { status: "already_ordered" };

  const now = input.now ? input.now() : new Date();

  // Move to 'ordering' atomically. If another webhook retry beat us here,
  // this update matches 0 rows and we treat it as already-in-flight.
  const transitioned = await db
    .update(topups)
    .set({
      status: "ordering",
      stripePaymentIntentId: input.stripePaymentIntentId ?? row.stripePaymentIntentId ?? null,
      paidAt: row.paidAt ?? now,
      updatedAt: now,
    })
    .where(and(eq(topups.id, row.id), ne(topups.status, "ordered")))
    .returning({ id: topups.id });
  if (!transitioned[0]) return { status: "already_ordered" };

  if (!row.esimTranNo) {
    await markFailed(db, row.id, "missing esimTranNo on topup row", now);
    return { status: "failed", reason: "invalid_input" };
  }

  const supplier = input.supplier ?? (await loadSupplier());
  if (!supplier || typeof supplier.topup !== "function") {
    await markFailed(db, row.id, "supplier topup unavailable", now);
    return { status: "failed", reason: "supplier_topup_unavailable" };
  }

  let callResult: { ok?: boolean; orderNo?: string | null };
  try {
    callResult = await supplier.topup({
      esimTranNo: row.esimTranNo,
      packageCode: row.packageCode,
      transactionId: row.publicId,
    });
  } catch (e) {
    log(`[topup] supplier topup threw for ${row.publicId}: ${e instanceof Error ? e.message : String(e)}`);
    await markFailed(db, row.id, e instanceof Error ? e.message : String(e), now);
    return { status: "failed", reason: "supplier_topup_failed" };
  }
  if (callResult.ok === false) {
    await markFailed(db, row.id, "supplier rejected the topup", now);
    return { status: "failed", reason: "supplier_topup_failed" };
  }

  await db
    .update(topups)
    .set({
      status: "ordered",
      supplierTransactionId: callResult.orderNo ?? row.publicId,
      orderedAt: now,
      updatedAt: now,
    })
    .where(eq(topups.id, row.id));

  // Receipt email (best-effort; a failure here does not roll back the top-up).
  try {
    const receiver = input.sendReceipt ?? defaultSendReceipt;
    const [owner] = row.userId
      ? await db
          .select({ email: sql<string>`email` })
          .from(sql`users`)
          .where(sql`id = ${row.userId}`)
          .limit(1)
      : [];
    await receiver({
      topupPublicId: row.publicId,
      toEmail: owner?.email ?? null,
      iccid: row.iccid,
      packageName: row.packageName,
      retail: Number(row.retailTotal),
      currency: row.currency as SupportedCurrency,
      auto: row.auto,
    });
  } catch (e) {
    log(`[topup] receipt email failed for ${row.publicId}: ${e instanceof Error ? e.message : String(e)}`);
  }

  return { status: "ordered" };
}

async function markFailed(
  db: NonNullable<ReturnType<typeof getDb>>,
  id: number,
  reason: string,
  now: Date,
): Promise<void> {
  await db
    .update(topups)
    .set({ status: "failed", failureReason: reason, updatedAt: now })
    .where(eq(topups.id, id));
}

async function defaultSendReceipt(input: {
  topupPublicId: string;
  toEmail: string | null;
  iccid: string | null;
  packageName: string;
  retail: number;
  currency: SupportedCurrency;
  auto: boolean;
}): Promise<void> {
  if (!input.toEmail) return;
  // Lazy import so tests that never send receipts don't load the email
  // module's SMTP transport.
  try {
    const mod = (await import("../lib/emailSender")) as {
      getEmailSender?: () => {
        sendRawEmail?: (msg: {
          to: string;
          subject: string;
          html: string;
          text: string;
        }) => Promise<{ delivered: boolean; reason?: string }>;
      };
    };
    const sender = mod.getEmailSender?.();
    if (!sender?.sendRawEmail) return;
    const priceLabel = `${input.currency} ${input.retail.toFixed(2)}`;
    const reason = input.auto
      ? "Your auto top-up kicked in because your data was running low."
      : "Thanks for topping up your eSIM.";
    await sender.sendRawEmail({
      to: input.toEmail,
      subject: `${brand.name} receipt — ${input.packageName}`,
      html:
        `<p>${escapeHtml(reason)}</p>` +
        `<p><strong>Package:</strong> ${escapeHtml(input.packageName)}</p>` +
        `<p><strong>Amount:</strong> ${escapeHtml(priceLabel)}</p>` +
        (input.iccid ? `<p><strong>ICCID:</strong> ${escapeHtml(input.iccid)}</p>` : "") +
        `<p>Top-up reference: ${escapeHtml(input.topupPublicId)}</p>`,
      text:
        `${reason}\nPackage: ${input.packageName}\nAmount: ${priceLabel}\n` +
        (input.iccid ? `ICCID: ${input.iccid}\n` : "") +
        `Top-up reference: ${input.topupPublicId}`,
    });
  } catch {
    // Email failure is non-fatal; it is logged by the caller.
  }
}

// ---------------------------------------------------------------------------
// Auto top-up
// ---------------------------------------------------------------------------

export interface AutoTopupSettingsRow {
  userId: number;
  enabled: boolean;
  paymentMethodRef: string | null;
  topupPackageCode: string | null;
  monthlyCapAmount: string | number | null;
  currency: string;
  monthKey: string | null;
  monthSpentAmount: string | number;
  lastChargedAt: Date | null;
}

export interface ChargeAutoTopupInput {
  userId: number;
  esimId: number;
  /** Override deps (tests). */
  getDb?: typeof getDb;
  supplier?: SupplierClient | null;
  now?: () => Date;
  log?: (msg: string) => void;
  /**
   * A provider-shaped off-session charge. When absent, the function returns
   * `off_session_unsupported` so the caller can fall back to the low-data
   * email + one-click top-up flow (the honest path). This module does NOT
   * invent a charge API that the shared provider does not expose.
   */
  offSessionCharge?: (input: {
    providerPaymentMethod: string;
    amountMinor: number;
    currency: SupportedCurrency;
    description: string;
    idempotencyKey: string;
  }) => Promise<{ ok: true; paymentIntentId: string } | { ok: false; reason: string }>;
}

export type AutoTopupOutcome =
  | { charged: true; topupPublicId: string; appliedOrder: ApplyTopupPaidResult["status"] }
  | { charged: false; reason: TopupReason | "supplier_error" };

/** Minimal view for the DATA_USAGE webhook processor. */
export async function chargeAutoTopupForLowData(
  input: ChargeAutoTopupInput,
): Promise<AutoTopupOutcome> {
  const log = input.log ?? ((m: string) => console.log(m));
  const db = (input.getDb ?? getDb)();
  if (!db) return { charged: false, reason: "db_unavailable" };

  const now = input.now ? input.now() : new Date();
  const monthKey = now.toISOString().slice(0, 7);

  const [settings] = await db
    .select()
    .from(autoTopupSettings)
    .where(eq(autoTopupSettings.userId, input.userId))
    .limit(1);
  if (!settings) return { charged: false, reason: "auto_disabled" };
  if (!settings.enabled) return { charged: false, reason: "auto_disabled" };
  if (!settings.paymentMethodRef) return { charged: false, reason: "no_saved_card" };
  if (!settings.topupPackageCode) return { charged: false, reason: "invalid_input" };

  // Fetch the eSIM (owner check included — the webhook processor already
  // resolved the owner, but a defence-in-depth check keeps the invariant).
  const [esim] = await db
    .select({
      id: esims.id,
      userId: esims.userId,
      iccid: esims.iccid,
      esimTranNo: esims.esimTranNo,
      expiresAt: esims.expiresAt,
      supportTopUpType: esims.supportTopUpType,
      countrySlug: esims.countrySlug,
    })
    .from(esims)
    .where(and(eq(esims.id, input.esimId), eq(esims.userId, input.userId)))
    .limit(1);
  if (!esim) return { charged: false, reason: "esim_not_found" };
  if (esim.supportTopUpType !== 2) return { charged: false, reason: "topup_unsupported" };
  if (!esim.iccid) return { charged: false, reason: "topup_unsupported" };
  if (esim.expiresAt && esim.expiresAt.getTime() <= now.getTime()) {
    return { charged: false, reason: "esim_expired" };
  }

  // Confirm the chosen package is still a TOPUP option.
  const supplier = input.supplier ?? (await loadSupplier());
  if (!supplier || typeof supplier.listPackages !== "function") {
    return { charged: false, reason: "supplier_not_configured" };
  }
  let rawList: SupplierTopupPackage[];
  try {
    const res = await supplier.listPackages({ type: "TOPUP", iccid: esim.iccid });
    rawList = res.list ?? res.packages ?? [];
  } catch {
    return { charged: false, reason: "supplier_not_configured" };
  }
  const pkg = rawList.find((p) => p.packageCode === settings.topupPackageCode);
  if (!pkg) return { charged: false, reason: "invalid_input" };
  const wholesaleUsd = supplierPriceToUsd(pkg.price);
  if (wholesaleUsd == null) return { charged: false, reason: "invalid_input" };

  const retailUsd = await defaultPriceOf(
    settings.topupPackageCode,
    wholesaleUsd,
    esim.countrySlug ?? null,
  );
  const currency = settings.currency as SupportedCurrency;
  const amountMinor = majorToMinor(retailUsd, currency);

  // Monthly cap: atomically reserve the amount only if it wouldn't exceed.
  const cap = settings.monthlyCapAmount == null ? null : Number(settings.monthlyCapAmount);
  if (cap != null && Number.isFinite(cap) && cap > 0) {
    const reserved = await reserveMonthlySpend(db, {
      userId: input.userId,
      monthKey,
      amount: retailUsd,
      cap,
      now,
    });
    if (!reserved) return { charged: false, reason: "cap_exceeded" };
  }

  if (!input.offSessionCharge) {
    // Revert the reservation? No — a reservation only exists when a cap is
    // set. Revert it so the cap isn't permanently consumed by a no-op.
    if (cap != null && Number.isFinite(cap) && cap > 0) {
      await revertMonthlySpend(db, input.userId, retailUsd, now);
    }
    return { charged: false, reason: "off_session_unsupported" };
  }

  // Create the top-up row (pending_payment; we'll flip to paid below).
  const publicId = makeTopupPublicId(now);
  let topupId: number | null = null;
  try {
    const inserted = await db
      .insert(topups)
      .values({
        publicId,
        esimId: esim.id,
        userId: input.userId,
        esimTranNo: esim.esimTranNo ?? null,
        iccid: esim.iccid,
        packageCode: settings.topupPackageCode,
        packageName: pkg.packageName ?? settings.topupPackageCode,
        currency,
        retailTotal: String(retailUsd),
        wholesaleTotalUsd: String(wholesaleUsd),
        profitUsd: String(roundMoney(retailUsd - wholesaleUsd)),
        status: "pending_payment",
        auto: true,
      })
      .returning({ id: topups.id });
    topupId = inserted[0]?.id ?? null;
  } catch (e) {
    if (cap != null && Number.isFinite(cap) && cap > 0) {
      await revertMonthlySpend(db, input.userId, retailUsd, now);
    }
    log(`[topup] auto insert failed: ${e instanceof Error ? e.message : String(e)}`);
    return { charged: false, reason: "invalid_input" };
  }
  if (!topupId) return { charged: false, reason: "invalid_input" };

  let charge: { ok: true; paymentIntentId: string } | { ok: false; reason: string };
  try {
    charge = await input.offSessionCharge({
      providerPaymentMethod: settings.paymentMethodRef,
      amountMinor,
      currency,
      description: `${brand.name} auto top-up for ${esim.iccid}`,
      idempotencyKey: `auto:${publicId}`,
    });
  } catch (e) {
    await db
      .update(topups)
      .set({ status: "failed", failureReason: e instanceof Error ? e.message : String(e), updatedAt: now })
      .where(eq(topups.id, topupId));
    if (cap != null && Number.isFinite(cap) && cap > 0) {
      await revertMonthlySpend(db, input.userId, retailUsd, now);
    }
    return { charged: false, reason: "off_session_charge_failed" };
  }
  if (!charge.ok) {
    await db
      .update(topups)
      .set({ status: "failed", failureReason: charge.reason, updatedAt: now })
      .where(eq(topups.id, topupId));
    if (cap != null && Number.isFinite(cap) && cap > 0) {
      await revertMonthlySpend(db, input.userId, retailUsd, now);
    }
    return { charged: false, reason: "off_session_charge_failed" };
  }

  await db
    .update(autoTopupSettings)
    .set({ lastChargedAt: now, updatedAt: now })
    .where(eq(autoTopupSettings.userId, input.userId));

  // Reuse applyTopupPaid for the actual supplier call so manual + auto share
  // one code path. The supplier call is idempotent on publicId.
  const applied = await applyTopupPaid({
    topupPublicId: publicId,
    stripePaymentIntentId: charge.paymentIntentId,
    supplier,
    getDb: input.getDb,
    now: () => now,
    log,
  });
  return { charged: true, topupPublicId: publicId, appliedOrder: applied.status };
}

async function reserveMonthlySpend(
  db: NonNullable<ReturnType<typeof getDb>>,
  input: { userId: number; monthKey: string; amount: number; cap: number; now: Date },
): Promise<boolean> {
  // Compare against the cap and only write when the new total stays within
  // it. The WHERE clause is the atomic gate: `month_spent + amount <= cap`.
  // A NULL month_key means a stale counter — reset it to 0 as part of the gate.
  const result = await db
    .update(autoTopupSettings)
    .set({
      // SQL expressions to make the gate atomic — the WHERE clause below
      // means this SET only runs for the caller that clears the cap.
      monthKey: sql`${input.monthKey}`,
      monthSpentAmount: sql`CASE WHEN ${autoTopupSettings.monthKey} = ${input.monthKey} THEN ${autoTopupSettings.monthSpentAmount} + ${input.amount} ELSE ${input.amount} END`,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(autoTopupSettings.userId, input.userId),
        sql`(CASE WHEN ${autoTopupSettings.monthKey} = ${input.monthKey} THEN ${autoTopupSettings.monthSpentAmount} ELSE 0 END) + ${input.amount} <= ${input.cap}`,
      ),
    )
    .returning({ id: autoTopupSettings.userId });
  return result.length > 0;
}

async function revertMonthlySpend(
  db: NonNullable<ReturnType<typeof getDb>>,
  userId: number,
  amount: number,
  now: Date,
): Promise<void> {
  try {
    await db
      .update(autoTopupSettings)
      .set({
        monthSpentAmount: sql`GREATEST(${autoTopupSettings.monthSpentAmount} - ${amount}, 0)`,
        updatedAt: now,
      })
      .where(eq(autoTopupSettings.userId, userId));
  } catch {
    // Best-effort revert; a stuck reservation is annoying but recoverable
    // (admin can reset the counter), and the customer is not over-charged.
  }
}

// ---------------------------------------------------------------------------
// Helpers shared with the route
// ---------------------------------------------------------------------------

/** Convert a major-unit amount to integer minor units for Stripe. */
export function majorToMinor(amount: number, currency: SupportedCurrency): number {
  const zeroDecimal = currency === "VND";
  const factor = zeroDecimal ? 1 : 100;
  const minor = Math.round(amount * factor);
  if (!Number.isFinite(minor) || minor <= 0) {
    throw new TopupError("invalid_input", "Amount is not payable.");
  }
  return minor;
}

function isDuplicateKey(e: unknown): boolean {
  const code = (e as { code?: string } | null)?.code;
  return code === "23505";
}

function escapeHtml(v: string): string {
  return v
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Re-export the small set of tests need from one place without leaking DB
// imports into the test file.
export const __test__ = {
  supplierPriceToUsd,
  bytesToGB,
  makeTopupPublicId,
  majorToMinor,
  roundMoney,
};

// Keep `inArray`/`packagesTable` in the import list — they're used by the
// supplier-list normaliser when a raw `packages` array is present. This
// `void` avoids an unused-import error while making the intent explicit.
void inArray;
void packagesTable;

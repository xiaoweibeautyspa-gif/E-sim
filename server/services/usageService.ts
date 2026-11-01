/**
 * Usage service — refresh eSIM usage from the supplier and read it back for
 * the My eSIMs dashboard.
 *
 * Responsibilities
 * ----------------
 *  1. Normalise `/esim/usage/query` responses into DB patches. The supplier
 *     returns volumes in BYTES; `total`, `used`, `remaining` are all byte
 *     counts. We never divide by 10000 here — that rule is for money only.
 *  2. Refresh usage for a set of eSIMs in batches of <=10 `esimTranNo`
 *     (supplier hard limit). The 8 req/sec queue is enforced inside the shared
 *     eSIM Access client, so we only await each batch here.
 *  3. Persist `usedBytes`, `totalBytes`, `expiresAt`, `status`, and
 *     `usageUpdatedAt` (the timestamp the dashboard shows as "last updated").
 *  4. Read back the user's eSIMs shaped as `MyEsim` for the route.
 *
 * Honest limitations
 * ------------------
 *  - Usage lags 1–3 hours upstream; we surface that in copy, not by faking
 *    freshness.
 *  - `defaultQueryUsage` lazily imports the shared client so tests that never
 *    refresh don't transitively load it. Unconfigured client => `skipped`.
 *  - Missing DB returns `skipped: db_unavailable` from refresh and a 503 (via
 *    `EsimsUnavailableError`) from reads — never an empty success.
 */
import { and, eq, gt, inArray, isNotNull, or, isNull } from "drizzle-orm";
import { getDb } from "../db/client";
import { esims } from "../db/schema";

/** Supplier batches `/esim/usage/query` at 10 esimTranNo per call. */
export const USAGE_BATCH_SIZE = 10;

/** Refresh cadence (3 hours), the source of the "every few hours" copy. */
export const USAGE_REFRESH_INTERVAL_MS = 3 * 60 * 60 * 1000;

/** One item from a `/esim/usage/query` response, normalised. */
export interface UsageReading {
  esimTranNo: string;
  totalBytes: number | null;
  usedBytes: number | null;
  remainingBytes: number | null;
  expiresAt: Date | null;
  supplierStatus: string | null;
}

/** Shape the My eSIMs route returns; kept in lockstep with `EsimCard`. */
export interface MyEsim {
  id: number;
  orderPublicId: string;
  country: string | null;
  countrySlug: string | null;
  network: string | null;
  status: string;
  totalBytes: number | null;
  usedBytes: number | null;
  usageUpdatedAt: string | null;
  expiresAt: string | null;
  daysLeft: number | null;
  iccid: string | null;
  esimTranNo: string | null;
  hasQr: boolean;
  qrPath: string | null;
}

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

/**
 * Convert one raw supplier entry to a `UsageReading`. Returns null when there
 * is no `esimTranNo` — without it we cannot match the row to a local eSIM.
 */
export function normaliseUsageEntry(raw: unknown): UsageReading | null {
  if (!raw || typeof raw !== "object") return null;
  const direct = raw as Record<string, unknown>;
  const src =
    direct.usage && typeof direct.usage === "object"
      ? { ...direct, ...(direct.usage as Record<string, unknown>) }
      : direct;

  const esimTranNo = asNonEmptyString(src.esimTranNo ?? src.esim_tran_no ?? src.tranNo);
  if (!esimTranNo) return null;

  const totalBytes = toBytes(src.totalVolume ?? src.total ?? src.totalBytes);
  const usedBytes = toBytes(src.usedVolume ?? src.used ?? src.usedBytes);
  const remainingBytes =
    toBytes(src.remainingVolume ?? src.remaining ?? src.remainingBytes) ??
    (totalBytes != null && usedBytes != null ? Math.max(0, totalBytes - usedBytes) : null);

  const expiresAt = parseDate(src.expiredTime ?? src.expiresAt ?? src.expiryTime) ?? null;

  const statusRaw = src.esimStatus ?? src.status ?? null;
  const supplierStatus =
    typeof statusRaw === "string" && statusRaw.length > 0
      ? statusRaw.toUpperCase()
      : null;

  return { esimTranNo, totalBytes, usedBytes, remainingBytes, expiresAt, supplierStatus };
}

function asNonEmptyString(v: unknown): string | null {
  if (typeof v === "string" && v.trim().length > 0) return v.trim();
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

function toBytes(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : Number.NaN;
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.floor(n);
}

function parseDate(v: unknown): Date | null {
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v;
  if (typeof v === "string" || typeof v === "number") {
    const d = new Date(v);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return null;
}

/** Compute whole days between now and `expiresAt` (floor, min 0); null when unknown. */
export function daysLeftFrom(expiresAt: Date | null, now: Date = new Date()): number | null {
  if (!expiresAt) return null;
  const diffMs = expiresAt.getTime() - now.getTime();
  if (diffMs <= 0) return 0;
  return Math.floor(diffMs / (24 * 60 * 60 * 1000));
}

// ---------------------------------------------------------------------------
// Supplier query (injected in tests)
// ---------------------------------------------------------------------------

export type QueryUsageFn = (esimTranNos: string[]) => Promise<unknown[]>;

async function defaultQueryUsage(esimTranNos: string[]): Promise<unknown[]> {
  const mod = (await import("../esimaccess")) as {
    esimAccess?: {
      queryUsage?: (
        i: { esimTranNo: string[] },
      ) => Promise<{ esims?: unknown[]; list?: unknown[] }>;
    };
  };
  const client = mod.esimAccess;
  if (!client || typeof client.queryUsage !== "function") {
    throw new UsageServiceError(
      "supplier_not_configured",
      "eSIM Access client has no queryUsage method.",
    );
  }
  const res = await client.queryUsage({ esimTranNo: esimTranNos });
  return res.esims ?? res.list ?? [];
}

export class UsageServiceError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "UsageServiceError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Refresh
// ---------------------------------------------------------------------------

export interface RefreshDeps {
  queryUsage?: QueryUsageFn;
  getDb?: typeof getDb;
  now?: () => Date;
  log?: (msg: string) => void;
}

export interface RefreshResult {
  updated: number;
  attempted: number;
  unmatched: number;
  skipped: boolean;
  reason?: string;
  batches: number;
  at: Date;
}

export async function refreshUsage(
  esimTranNos?: string[],
  deps: RefreshDeps = {},
): Promise<RefreshResult> {
  const log = deps.log ?? ((m: string) => console.log(m));
  const now = deps.now ? deps.now() : new Date();
  const db = (deps.getDb ?? getDb)();

  const targetList = esimTranNos
    ? [...new Set(esimTranNos.filter((t) => typeof t === "string" && t.length > 0))]
    : await loadRefreshCandidates(deps);

  const base: RefreshResult = {
    updated: 0,
    attempted: 0,
    unmatched: 0,
    skipped: false,
    batches: 0,
    at: now,
  };

  if (targetList.length === 0) {
    return { ...base, skipped: true, reason: "no_candidates" };
  }
  if (!db) {
    // Still record how many we would have attempted so the job record is
    // truthful about the skipped pass.
    return { ...base, attempted: targetList.length, skipped: true, reason: "db_unavailable" };
  }

  const queryUsage = deps.queryUsage ?? defaultQueryUsage;

  for (let i = 0; i < targetList.length; i += USAGE_BATCH_SIZE) {
    const batch = targetList.slice(i, i + USAGE_BATCH_SIZE);
    base.batches += 1;
    base.attempted += batch.length;

    let rows: unknown[];
    try {
      rows = await queryUsage(batch);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`[usageService] supplier query failed for batch ${base.batches}: ${msg}`);
      if (base.batches === 1 && isNotConfigured(err)) {
        return { ...base, skipped: true, reason: "supplier_not_configured", updated: 0 };
      }
      continue;
    }

    const readings: UsageReading[] = [];
    for (const r of rows) {
      const reading = normaliseUsageEntry(r);
      if (reading) readings.push(reading);
    }
    if (readings.length === 0) continue;

    try {
      const persisted = await persistReadings(db, readings, now);
      base.updated += persisted.matched;
      base.unmatched += persisted.unmatched;
    } catch (err) {
      log(
        `[usageService] persist failed for batch ${base.batches}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  return base;
}

async function loadRefreshCandidates(deps: RefreshDeps): Promise<string[]> {
  const db = (deps.getDb ?? getDb)();
  if (!db) return [];
  const now = deps.now ? deps.now() : new Date();
  try {
    const rows = await db
      .select({ esimTranNo: esims.esimTranNo })
      .from(esims)
      .where(
        and(
          isNotNull(esims.esimTranNo),
          // Include rows whose expiry is unknown OR in the future; skip expired.
          or(isNull(esims.expiresAt), gt(esims.expiresAt, now)),
        ),
      )
      .limit(500);
    return rows
      .map((r) => r.esimTranNo)
      .filter((t): t is string => typeof t === "string" && t.length > 0);
  } catch (err) {
    (deps.log ?? console.log)(
      `[usageService] candidate load failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return [];
  }
}

interface PersistSummary {
  matched: number;
  unmatched: number;
}

async function persistReadings(
  db: NonNullable<ReturnType<typeof getDb>>,
  readings: UsageReading[],
  now: Date,
): Promise<PersistSummary> {
  const tranNos = readings.map((r) => r.esimTranNo);
  const localRows = await db
    .select({ id: esims.id, esimTranNo: esims.esimTranNo })
    .from(esims)
    .where(inArray(esims.esimTranNo, tranNos));
  const localByTran = new Map<string, number>();
  for (const r of localRows) {
    if (r.esimTranNo) localByTran.set(r.esimTranNo, r.id);
  }

  let matched = 0;
  for (const reading of readings) {
    const id = localByTran.get(reading.esimTranNo);
    if (!id) continue;

    const patch: Record<string, unknown> = {
      usageUpdatedAt: now,
      updatedAt: now,
    };
    if (reading.usedBytes != null) patch.usedBytes = String(reading.usedBytes);
    if (reading.totalBytes != null) patch.totalBytes = String(reading.totalBytes);
    if (reading.expiresAt) patch.expiresAt = reading.expiresAt;
    if (reading.supplierStatus) {
      const derived = mapSupplierStatusToOurStatus(reading.supplierStatus, reading.expiresAt, now);
      if (derived) patch.status = derived;
    }

    await db.update(esims).set(patch).where(eq(esims.id, id));
    matched += 1;
  }

  return { matched, unmatched: readings.length - matched };
}

/**
 * Map a supplier status string (plus expiry) to our own `status` column value.
 * A future expiry leaves our install-derived status untouched (returns null).
 */
export function mapSupplierStatusToOurStatus(
  supplierStatus: string,
  expiresAt: Date | null,
  now: Date,
): string | null {
  if (expiresAt && expiresAt.getTime() <= now.getTime()) return "expired";
  const s = supplierStatus.toUpperCase();
  if (s === "CANCELLED" || s === "CANCELED") return "cancelled";
  if (s === "USED_EXPIRED" || s === "EXPIRED") return "expired";
  return null;
}

function isNotConfigured(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  if (code === "supplier_not_configured") return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /not configured/i.test(msg);
}

// ---------------------------------------------------------------------------
// Read for the dashboard
// ---------------------------------------------------------------------------

export interface ReadEsimsInput {
  userId: number;
  getDb?: typeof getDb;
  now?: () => Date;
}

export interface ReadEsimsResult {
  esims: MyEsim[];
  usageFreshnessMinutes: number;
}

export class EsimsUnavailableError extends Error {
  constructor(message = "eSIM store is not configured.") {
    super(message);
    this.name = "EsimsUnavailableError";
  }
}

export async function readEsimsForUser(input: ReadEsimsInput): Promise<ReadEsimsResult> {
  const db = (input.getDb ?? getDb)();
  if (!db) throw new EsimsUnavailableError();
  const now = input.now ? input.now() : new Date();

  const rows = await db
    .select({
      id: esims.id,
      orderPublicId: esims.orderPublicId,
      country: esims.country,
      countrySlug: esims.countrySlug,
      network: esims.network,
      status: esims.status,
      totalBytes: esims.totalBytes,
      usedBytes: esims.usedBytes,
      usageUpdatedAt: esims.usageUpdatedAt,
      expiresAt: esims.expiresAt,
      iccid: esims.iccid,
      esimTranNo: esims.esimTranNo,
      lpaCode: esims.lpaCode,
      qrCodeUrl: esims.qrCodeUrl,
    })
    .from(esims)
    .where(eq(esims.userId, input.userId))
    .orderBy(esims.id);

  const esimsOut: MyEsim[] = rows.map((r) => {
    const total = parseBytes(r.totalBytes);
    const used = parseBytes(r.usedBytes);
    const hasQr = Boolean(r.lpaCode || r.qrCodeUrl);
    return {
      id: r.id,
      orderPublicId: r.orderPublicId,
      country: r.country,
      countrySlug: r.countrySlug,
      network: r.network,
      status: r.status,
      totalBytes: total,
      usedBytes: used,
      usageUpdatedAt: r.usageUpdatedAt ? r.usageUpdatedAt.toISOString() : null,
      expiresAt: r.expiresAt ? r.expiresAt.toISOString() : null,
      daysLeft: daysLeftFrom(r.expiresAt, now),
      iccid: r.iccid,
      esimTranNo: r.esimTranNo,
      hasQr,
      qrPath: hasQr ? `/api/esims/${r.id}/qr` : null,
    };
  });

  return {
    esims: esimsOut,
    usageFreshnessMinutes: Math.round(USAGE_REFRESH_INTERVAL_MS / 60_000),
  };
}

function parseBytes(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : Number.NaN;
  return Number.isFinite(n) && n >= 0 ? n : null;
}

// ---------------------------------------------------------------------------
// Test surface
// ---------------------------------------------------------------------------

export const __test__ = {
  normaliseUsageEntry,
  mapSupplierStatusToOurStatus,
  daysLeftFrom,
  USAGE_BATCH_SIZE,
  USAGE_REFRESH_INTERVAL_MS,
};

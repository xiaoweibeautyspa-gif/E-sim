/**
 * Contract tests for the usage layer that powers the My eSIMs dashboard.
 *
 * Why a dedicated file (and why it replaces file3.txt)
 * ----------------------------------------------------
 * `file3.txt` was a stray `npm test` stub, not an implementation. The rest of
 * the My eSIMs milestone already ships:
 *
 *   • `server/services/usageService.test.ts`     — refresh + read behaviours
 *   • `server/routes/esims.test.ts`              — HTTP routes for the page
 *   • `server/jobs/usageRefresh.test.ts` (+ fragments in file5–14)
 *                                                — the 3-hourly scheduler
 *
 * This file fills the remaining gap: the small, stable contract the dashboard
 * depends on when reading data back. It uses ONLY the symbols actually
 * exported by `server/services/usageService.ts` and drives reads through an
 * injected fake DB, so it needs neither a real database nor any supplier
 * credentials. It never hits the network.
 *
 * What it locks down
 * ------------------
 *   1. The supplier batch cap (`USAGE_BATCH_SIZE === 10`) and the 3-hour
 *      refresh cadence (`USAGE_REFRESH_INTERVAL_MS`) — the source of the
 *      "Usage updated every few hours" copy.
 *   2. `usageFreshnessMinutes` in the read result is derived from the cadence
 *      (180 minutes), never a hardcoded page string.
 *   3. My-eSIM mapping: bytes stay bytes (no /10000), days-left is computed,
 *      a QR path is only exposed when the row actually has an LPA/QR, and
 *      `usageUpdatedAt` is ISO-8601 or null.
 *   4. Honest degraded states: missing DB throws `EsimsUnavailableError`;
 *      supplier-not-configured on refresh is reported, not faked.
 *
 * These are SOURCE tests — not executed by this response. Run with:
 *     npm test        (node --test --import tsx "server/**\/*.test.ts")
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  refreshUsage,
  readEsimsForUser,
  EsimsUnavailableError,
  USAGE_BATCH_SIZE,
  USAGE_REFRESH_INTERVAL_MS,
  type RefreshDeps,
  type MyEsim,
} from "./usageService";

// ---------------------------------------------------------------------------
// Minimal fake DB aimed at the two read chains `readEsimsForUser` uses:
//
//   db.select({...cols}).from(esims).where(<eq userId>).orderBy(esims.id)
//
// The fake returns every row from its store; the service applies `daysLeft`
// and QR-path derivation itself. We deliberately keep the store small (single
// user) so ownership semantics do not depend on predicate introspection.
// ---------------------------------------------------------------------------

interface FakeRow {
  id: number;
  userId: number;
  orderPublicId: string;
  country: string | null;
  countrySlug: string | null;
  network: string | null;
  status: string;
  totalBytes: string | number | null;
  usedBytes: string | number | null;
  usageUpdatedAt: Date | null;
  expiresAt: Date | null;
  iccid: string | null;
  esimTranNo: string | null;
  lpaCode: string | null;
  qrCodeUrl: string | null;
}

function makeRow(over: Partial<FakeRow> & { id: number; userId: number }): FakeRow {
  return {
    orderPublicId: `ORD-${over.id}`,
    country: "Singapore",
    countrySlug: "sg",
    network: "Singtel 5G",
    status: "installed",
    totalBytes: null,
    usedBytes: null,
    usageUpdatedAt: null,
    expiresAt: null,
    iccid: "890000000000000001",
    esimTranNo: `T-${over.id}`,
    lpaCode: "LPA:1$sample",
    qrCodeUrl: "https://qr.example/1.png",
    ...over,
  };
}

type DbType = NonNullable<ReturnType<NonNullable<RefreshDeps["getDb"]>>>;

function makeFakeDb(rows: FakeRow[]): DbType {
  const builder = {
    from: () => builder,
    where: () => builder,
    orderBy: async () => rows.slice(),
    limit: async () => rows.slice(),
    // Allow `await db.select()...` without a terminal if a future call omits
    // orderBy/limit; harmless here.
    then: (resolve: (v: FakeRow[]) => void) => {
      resolve(rows.slice());
      return Promise.resolve();
    },
  };
  return {
    select: () => builder,
    insert: () => {
      throw new Error("fake db: insert() is not used by readEsimsForUser");
    },
    update: () => {
      throw new Error("fake db: update() is not used by readEsimsForUser");
    },
    delete: () => {
      throw new Error("fake db: delete() is not used by readEsimsForUser");
    },
  } as unknown as DbType;
}

const getDbOf =
  (db: DbType | null) =>
  (() => db) as NonNullable<RefreshDeps["getDb"]>;

// ---------------------------------------------------------------------------
// 1) Constants. These are the single source of truth for two pieces of copy
//    that appear in the UI: "batch of 10" is invisible to users but must not
//    drift from the supplier cap; "every few hours" derives from the cadence.
// ---------------------------------------------------------------------------

test("USAGE_BATCH_SIZE equals the supplier's 10-esimTranNo cap", () => {
  assert.equal(USAGE_BATCH_SIZE, 10);
});

test("USAGE_REFRESH_INTERVAL_MS is exactly 3 hours", () => {
  assert.equal(USAGE_REFRESH_INTERVAL_MS, 3 * 60 * 60 * 1000);
});

test("usageFreshnessMinutes derives from the cadence, not a hardcoded value", async () => {
  const db = makeFakeDb([makeRow({ id: 1, userId: 1 })]);
  const result = await readEsimsForUser({
    userId: 1,
    getDb: getDbOf(db),
    now: () => new Date("2024-06-01T12:00:00Z"),
  });
  assert.equal(
    result.usageFreshnessMinutes,
    Math.round(USAGE_REFRESH_INTERVAL_MS / 60_000),
  );
  assert.equal(result.usageFreshnessMinutes, 180);
});

// ---------------------------------------------------------------------------
// 2) MyEsim mapping — bytes stay bytes; daysLeft and qrPath are derived.
// ---------------------------------------------------------------------------

test("readEsimsForUser returns bytes unchanged and derives daysLeft + qrPath", async () => {
  const now = new Date("2024-06-01T12:00:00Z");
  const db = makeFakeDb([
    makeRow({
      id: 7,
      userId: 1,
      status: "installed",
      totalBytes: 2 * 1024 * 1024 * 1024,
      usedBytes: 512 * 1024 * 1024,
      usageUpdatedAt: new Date("2024-06-01T10:30:00Z"),
      expiresAt: new Date("2024-06-08T12:00:00Z"),
    }),
  ]);

  const { esims } = await readEsimsForUser({ userId: 1, getDb: getDbOf(db), now: () => now });
  assert.equal(esims.length, 1);
  const e: MyEsim = esims[0]!;

  // Byte values (not divided by 10000 — the /10000 rule is money only).
  assert.equal(e.totalBytes, 2 * 1024 * 1024 * 1024);
  assert.equal(e.usedBytes, 512 * 1024 * 1024);

  // Timestamps are ISO-8601 (page renders them; the server must not hand over Date objects).
  assert.equal(e.usageUpdatedAt, "2024-06-01T10:30:00.000Z");
  assert.equal(e.expiresAt, "2024-06-08T12:00:00.000Z");

  // 7 whole days between 2024-06-01T12:00Z and 2024-06-08T12:00Z.
  assert.equal(e.daysLeft, 7);

  // QR path is present because the row has an LPA.
  assert.equal(e.hasQr, true);
  assert.equal(e.qrPath, "/api/esims/7/qr");
});

test("readEsimsForUser omits qrPath when the row has neither LPA nor QR URL", async () => {
  const db = makeFakeDb([
    makeRow({ id: 9, userId: 1, lpaCode: null, qrCodeUrl: null, status: "processing" }),
  ]);
  const { esims } = await readEsimsForUser({
    userId: 1,
    getDb: getDbOf(db),
    now: () => new Date("2024-06-01T12:00:00Z"),
  });
  assert.equal(esims.length, 1);
  assert.equal(esims[0]!.hasQr, false);
  assert.equal(esims[0]!.qrPath, null);
});

test("readEsimsForUser reports daysLeft=0 for already-expired rows, null when expiry unknown", async () => {
  const now = new Date("2024-06-01T12:00:00Z");
  const db = makeFakeDb([
    makeRow({ id: 10, userId: 1, expiresAt: new Date("2024-05-31T12:00:00Z") }),
    makeRow({ id: 11, userId: 1, expiresAt: null }),
  ]);
  const { esims } = await readEsimsForUser({ userId: 1, getDb: getDbOf(db), now: () => now });
  assert.equal(esims.find((e) => e.id === 10)!.daysLeft, 0);
  assert.equal(esims.find((e) => e.id === 11)!.daysLeft, null);
});

// ---------------------------------------------------------------------------
// 3) Honest degraded states — no fabrication.
// ---------------------------------------------------------------------------

test("readEsimsForUser throws EsimsUnavailableError when the DB is not configured", async () => {
  await assert.rejects(
    () => readEsimsForUser({ userId: 1, getDb: getDbOf(null) }),
    (err) => err instanceof EsimsUnavailableError,
  );
});

test("refreshUsage reports supplier_not_configured and does not fake success", async () => {
  // Fresh store so nothing is persisted; supplier stub throws a not-configured error.
  const db = makeFakeDb([makeRow({ id: 1, userId: 1, esimTranNo: "T-NC" })]);

  const result = await refreshUsage(["T-NC"], {
    getDb: getDbOf(db),
    queryUsage: async () => {
      throw new Error("eSIM Access not configured");
    },
    log: () => {},
  });

  assert.equal(result.skipped, true);
  assert.equal(result.reason, "supplier_not_configured");
  assert.equal(result.updated, 0);
  assert.equal(result.batches, 1);
  assert.equal(result.attempted, 1);
});

test("refreshUsage reports db_unavailable and never calls the supplier when no DB is set", async () => {
  let supplierCalled = false;
  const result = await refreshUsage(["T-X"], {
    getDb: getDbOf(null),
    queryUsage: async () => {
      supplierCalled = true;
      return [];
    },
    log: () => {},
  });
  assert.equal(result.skipped, true);
  assert.equal(result.reason, "db_unavailable");
  assert.equal(result.attempted, 1);
  assert.equal(result.updated, 0);
  assert.equal(supplierCalled, false);
});

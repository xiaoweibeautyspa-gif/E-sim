/**
 * Unit tests for `server/services/usageService.ts` — the My eSIMs usage layer.
 *
 * THIS FILE REPLACES the previous `file3.txt` placeholder (which contained only
 * a stray "npm test" line). It also supersedes the earlier draft
 * `server/services/usageService.test.ts` shipped in an earlier batch, which
 * built a hand-rolled fake db with an incompatible type. This version:
 *
 *   - Imports ONLY symbols that actually exist in `usageService.ts`
 *     (refreshUsage, readEsimsForUser, EsimsUnavailableError,
 *     mapSupplierStatusToOurStatus, daysLeftFrom, USAGE_BATCH_SIZE,
 *     USAGE_REFRESH_INTERVAL_MS, normaliseUsageEntry, type RefreshDeps).
 *   - Drives every supplier call through the injected `RefreshDeps.queryUsage`
 *     so NO network is hit and NO `DATABASE_URL` is required.
 *   - Uses a minimal typed fake db that models exactly the drizzle chains the
 *     service uses (`select().from().where().limit()`,
 *     `select().from().where().orderBy()`, `update().set().where()`). The fake
 *     db is passed in via `RefreshDeps.getDb` / `ReadEsimsInput.getDb`, never
 *     by mutating module state.
 *   - Correctly splits the test categories:
 *       • "reads" from the DB (readEsimsForUser) — we inject a fake db whose
 *         rows live at the `esims` table, so reads return real data.
 *       • "refreshes" (refreshUsage) — we inject `queryUsage` that ignores the
 *         supplied tranNos and returns the canned payload.
 *
 * These are SOURCE tests only. They are not executed by me in this environment.
 * Run them with `npm test` (which is `node --test --import tsx ...`).
 * If `getDb` returns null (no DB configured) every read test asserts the
 * honest error, not a fabricated success — but in a `npm test` invocation with
 * no `DATABASE_URL`, `refreshUsage` short-circuits to `db_unavailable` AND the
 * supplier stub is never called. Both are asserted below.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  refreshUsage,
  readEsimsForUser,
  EsimsUnavailableError,
  mapSupplierStatusToOurStatus,
  daysLeftFrom,
  normaliseUsageEntry,
  USAGE_BATCH_SIZE,
  USAGE_REFRESH_INTERVAL_MS,
  type RefreshDeps,
  type MyEsim,
} from "./usageService";

// ---------------------------------------------------------------------------
// A very small typed fake for `getDb()`.
//
// The service only ever extends two query shapes:
//
//  1. read:    db.select({cols}).from(esims).where(<pred>).orderBy(esims.id)
//  2. candidate: db.select({esimTranNo: esims.esimTranNo}).from(esims)
//                   .where(<and predicate>).limit(500)
//  3. lookup:  db.select({id, esimTranNo}).from(esims)
//                   .where(inArray(esims.esimTranNo, tranNos))
//  4. update:  db.update(esims).set(patch).where(eq(esims.id, id))
//
// We implement each chain with the minimum surface. Where the SELECT column
// shape matters (i.e. the caller reads a specific column), the fake does not
// try to be clever: it returns every row as a full object and lets the caller
// pick fields off it (drizzle's `.select({...})` also does this at runtime for
// plain selects — the projection is applied by the SELECT list at the SQL
// level, not by post-processing the returned objects). This is fine for these
// tests because the service only reads fields that exist on every row.
// ---------------------------------------------------------------------------

interface FakeEsimRow {
  id: number;
  userId: number;
  esimTranNo: string | null;
  iccid: string | null;
  country: string | null;
  countrySlug: string | null;
  network: string | null;
  status: string;
  totalBytes: string | number | null;
  usedBytes: string | number | null;
  usageUpdatedAt: Date | null;
  expiresAt: Date | null;
  lpaCode: string | null;
  qrCodeUrl: string | null;
  orderPublicId: string;
  updatedAt?: Date | null;
}

interface FakeState {
  rows: Map<number, FakeEsimRow>;
}

interface FakeQueryBuilder {
  from: () => FakeQueryBuilder;
  where: (cond: unknown) => FakeQueryBuilder;
  orderBy: (col: unknown) => Promise<FakeEsimRow[]>;
  limit: (n: number) => Promise<FakeEsimRow[]>;
  then: (resolve: (rows: FakeEsimRow[]) => void) => Promise<void>;
}

/**
 * Build a fake drizzle-ish db over a mutable row store. The store is exposed so
 * tests can inspect `usageUpdatedAt` after a refresh.
 */
function makeFakeDb(store: FakeState): {
  db: NonNullable<ReturnType<NonNullable<RefreshDeps["getDb"]>>>;
  store: FakeState;
} {
  const builder = (): FakeQueryBuilder => {
    const chain: FakeQueryBuilder = {
      from: () => chain,
      where: () => chain,
      // orderBy / limit terminate the chain the way drizzle does.
      orderBy: async () => Array.from(store.rows.values()),
      limit: async () => Array.from(store.rows.values()),
      // `.then` allows `await db.select().from().where()` to resolve without
      // an explicit terminal — matches the service's `await db.select(...)
      // .from(esims).where(inArray(...))`.
      then: (resolve) => {
        resolve(Array.from(store.rows.values()));
        return Promise.resolve();
      },
    };
    return chain;
  };

  const update = () => ({
    set: (patch: Partial<FakeEsimRow>) => ({
      where: async () => {
        // The service calls `.where(eq(esims.id, id))` on a per-row update.
        // We cannot introspect the drizzle `eq` predicate here, so the fake
        // relies on the caller patching one row per `update` (which the service
        // does: `for (const reading of readings) { ... db.update(esims).set().where(eq(esims.id, id)) }`).
        // To keep the fake honest, apply the patch to every row whose id would
        // match — but since we cannot read the predicate, we instead rely on a
        // single-row store per test. Tests that need more than one row update
        // assert on totals across rows (which is safe when the patch is the
        // same for each). Documented here so a future change is visible.
        for (const row of store.rows.values()) Object.assign(row, patch);
      },
    }),
  });

  return {
    store,
    db: {
      select: () => builder(),
      update: () => update(),
      // Any other method the service might reach for — fail loudly if used.
      insert: () => {
        throw new Error("fake db: insert() is not supported by this test");
      },
      delete: () => {
        throw new Error("fake db: delete() is not supported by this test");
      },
    } as unknown as NonNullable<ReturnType<NonNullable<RefreshDeps["getDb"]>>>,
  };
}

function row(over: Partial<FakeEsimRow> & { id: number; esimTranNo: string }): FakeEsimRow {
  return {
    userId: 1,
    iccid: null,
    country: "Singapore",
    countrySlug: "sg",
    network: "Singtel 5G",
    status: "ready",
    totalBytes: null,
    usedBytes: null,
    usageUpdatedAt: null,
    expiresAt: null,
    lpaCode: null,
    qrCodeUrl: null,
    orderPublicId: `ORD-${over.id}`,
    ...over,
  };
}

const getDbFrom = (fake: NonNullable<ReturnType<NonNullable<RefreshDeps["getDb"]>>>) =>
  (() => fake) as NonNullable<RefreshDeps["getDb"]>;

// ---------------------------------------------------------------------------
// 1) Constants (locked against drift from the acceptance criteria).
// ---------------------------------------------------------------------------

test("USAGE_BATCH_SIZE is 10; refresh interval is 3 hours", () => {
  assert.equal(USAGE_BATCH_SIZE, 10);
  assert.equal(USAGE_REFRESH_INTERVAL_MS, 3 * 60 * 60 * 1000);
});

// ---------------------------------------------------------------------------
// 2) Refresh batches esimTranNo into chunks of <= 10 (the supplier cap).
// ---------------------------------------------------------------------------

test("refreshUsage chunks esimTranNo into batches of at most 10", async () => {
  const tranNos = Array.from({ length: 25 }, (_, i) => `T${i}`);
  const batches: string[][] = [];

  const fake = makeFakeDb({
    rows: new Map(tranNos.map((t, i) => [i + 1, row({ id: i + 1, esimTranNo: t })])),
  });

  const result = await refreshUsage(tranNos, {
    getDb: getDbFrom(fake.db),
    queryUsage: async (batch) => {
      batches.push([...batch]);
      return batch.map((t) => ({
        esimTranNo: t,
        totalVolume: 1024 * 1024 * 1024,
        usedVolume: 100 * 1024 * 1024,
      }));
    },
    log: () => {},
  });

  assert.equal(batches.length, 3, "25 tranNos => 3 supplier calls (10+10+5)");
  for (const b of batches) {
    assert.ok(b.length <= USAGE_BATCH_SIZE, `batch ${b.length} exceeds ${USAGE_BATCH_SIZE}`);
  }
  assert.equal(result.batches, 3);
  assert.equal(result.attempted, 25);
  assert.equal(result.updated, 25);
  assert.equal(result.skipped, false);
});

// ---------------------------------------------------------------------------
// 3) Persists usageUpdatedAt + used/total; read returns 180-minute freshness.
// ---------------------------------------------------------------------------

test("refreshUsage persists usage and read-back returns 180-minute freshness", async () => {
  const now = new Date("2024-06-01T12:00:00Z");
  const fake = makeFakeDb({
    rows: new Map([
      [
        1,
        row({
          id: 1,
          esimTranNo: "T1",
          expiresAt: new Date("2024-06-08T12:00:00Z"),
          status: "installed",
        }),
      ],
    ]),
  });

  const result = await refreshUsage(["T1"], {
    getDb: getDbFrom(fake.db),
    queryUsage: async () => [
      {
        esimTranNo: "T1",
        totalVolume: 2 * 1024 * 1024 * 1024,
        usedVolume: 300 * 1024 * 1024,
        expiredTime: "2024-06-08T12:00:00Z",
      },
    ],
    now: () => now,
    log: () => {},
  });
  assert.equal(result.updated, 1);

  const persisted = fake.store.rows.get(1)!;
  assert.ok(persisted.usageUpdatedAt instanceof Date, "usageUpdatedAt must be set");
  assert.equal(persisted.usageUpdatedAt!.getTime(), now.getTime());
  assert.equal(Number(persisted.usedBytes), 300 * 1024 * 1024);
  assert.equal(Number(persisted.totalBytes), 2 * 1024 * 1024 * 1024);

  const read = await readEsimsForUser({
    userId: 1,
    getDb: getDbFrom(fake.db),
    now: () => now,
  });
  assert.equal(read.usageFreshnessMinutes, 180);
  assert.equal(read.esims.length, 1);
  const e: MyEsim = read.esims[0]!;
  assert.equal(e.esimTranNo, "T1");
  assert.equal(e.totalBytes, 2 * 1024 * 1024 * 1024);
  assert.equal(e.usedBytes, 300 * 1024 * 1024);
  assert.equal(e.daysLeft, 7);
});

// ---------------------------------------------------------------------------
// 4) Missing DB is an explicit skipped pass; it does NOT hit the supplier.
// ---------------------------------------------------------------------------

test("refreshUsage with no DB skips with reason db_unavailable and does not call the supplier", async () => {
  let supplierCalled = false;
  const result = await refreshUsage(["T1"], {
    getDb: (() => null) as NonNullable<RefreshDeps["getDb"]>,
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
  assert.equal(supplierCalled, false, "supplier must not be called without a DB");
});

test("readEsimsForUser throws EsimsUnavailableError when DB is missing", async () => {
  await assert.rejects(
    () => readEsimsForUser({ userId: 1, getDb: (() => null) as NonNullable<RefreshDeps["getDb"]> }),
    (err) => err instanceof EsimsUnavailableError,
  );
});

// ---------------------------------------------------------------------------
// 5) Status mapping + days-left helpers (pure, exercised directly).
// ---------------------------------------------------------------------------

test("mapSupplierStatusToOurStatus upgrades to expired only past expiry; leaves install status untouched otherwise", () => {
  const now = new Date("2024-06-01T12:00:00Z");
  assert.equal(
    mapSupplierStatusToOurStatus("GOT_RESOURCE", new Date("2024-06-01T11:00:00Z"), now),
    "expired",
  );
  assert.equal(
    mapSupplierStatusToOurStatus("GOT_RESOURCE", new Date("2024-06-08T12:00:00Z"), now),
    null,
    "future expiry must not override install-derived status",
  );
  assert.equal(mapSupplierStatusToOurStatus("CANCELLED", null, now), "cancelled");
  assert.equal(mapSupplierStatusToOurStatus("EXPIRED", null, now), "expired");
});

test("daysLeftFrom floors days and returns 0 past expiry; null when expiresAt missing", () => {
  const now = new Date("2024-06-01T12:00:00Z");
  assert.equal(daysLeftFrom(new Date("2024-06-08T12:00:00Z"), now), 7);
  assert.equal(daysLeftFrom(new Date("2024-06-01T06:00:00Z"), now), 0);
  assert.equal(daysLeftFrom(null, now), null);
});

// ---------------------------------------------------------------------------
// 6) Normalisation: supplier shapes and edge cases.
// ---------------------------------------------------------------------------

test("normaliseUsageEntry accepts the supplier's flat and nested shapes; rejects missing esimTranNo", () => {
  const flat = normaliseUsageEntry({
    esimTranNo: "T-A",
    totalVolume: 100,
    usedVolume: 40,
    expiredTime: "2024-07-01T00:00:00Z",
    esimStatus: "in_use",
  });
  assert.ok(flat);
  assert.equal(flat!.esimTranNo, "T-A");
  assert.equal(flat!.totalBytes, 100);
  assert.equal(flat!.usedBytes, 40);
  assert.equal(flat!.remainingBytes, 60);
  assert.equal(flat!.supplierStatus, "IN_USE");

  const nested = normaliseUsageEntry({
    esimTranNo: "T-B",
    usage: { totalBytes: 200, usedBytes: 50 },
  });
  assert.ok(nested);
  assert.equal(nested!.totalBytes, 200);
  assert.equal(nested!.usedBytes, 50);
  assert.equal(nested!.remainingBytes, 150);

  assert.equal(normaliseUsageEntry({ totalVolume: 5 }), null, "missing esimTranNo is rejected");
  assert.equal(normaliseUsageEntry(null), null);
  assert.equal(normaliseUsageEntry("garbage"), null);
});

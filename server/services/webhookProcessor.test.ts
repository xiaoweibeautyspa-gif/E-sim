/**
 * Unit tests for `server/services/webhookProcessor.ts` and the webhook route.
 *
 * HOW THESE AVOID EXTERNAL DEPENDENCIES
 * -------------------------------------
 *  - No database: the processor and the route are exercised through their
 *    injected seams (`ProcessorDeps.getDb`, `ProcessorDeps.notifier`,
 *    `ProcessorDeps.resumeOrder`, `ProcessorDeps.now`, and the route's
 *    `WebhookDeps`). The processor's DB touch points (update status, count)
 *    are given a minimal in-memory fake that records calls and returns what
 *    the code expects.
 *  - No HTTP: the route is invoked with fake `req`/`res` objects; the
 *    background scheduler is injected as a synchronous runner so we can await
 *    it deterministically.
 *  - No supplier calls: `resumeOrder` and `notifier` are stubbed, so the tests
 *    prove the DECISIONS (which transition ran, whether the alert fired),
 *    not the external integrations.
 *
 * WHAT THESE PROVE
 * ----------------
 *  - The route responds 200 IMMEDIATELY (before processing resolves), and
 *    schedules background processing.
 *  - A duplicate notifyId gets `reason: "deduped"` and does NOT process twice.
 *  - Every notifyType transition runs:
 *      ORDER_STATUS    → completed order path (already_completed is a no-op)
 *      ORDER_STATUS    → processing order is resumed via `resumeOrder`
 *      ESIM_STATUS     → flips to installed and sends the connected email once
 *      DATA_USAGE      → sends low-data alert when remaining <= 100 MiB only
 *      VALIDITY_USAGE  → sends "1 day left" alert and skips already-expired
 *  - Unknown notifyType is logged and not processed (200, `ignored_unknown_type`).
 *  - Malformed body → 200 `malformed`.
 *  - DB unavailable → 200 `db_unavailable`; event is not processed.
 *
 * WHAT THESE DO NOT PROVE
 * -----------------------
 *  - Real Postgres persistence and the unique (source, notify_id) index; those
 *    are covered in the e2e flow phase against a provisioned database.
 *  - A real email/push provider; the notifier is a stub and the default one
 *    reports `delivered:false` by design.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  processSupplierWebhook,
  __test__ as processorTest,
  type Notifier,
  type ProcessOutcome,
  type ProcessorDeps,
  type SupplierWebhookPayload,
  type DeliveryReport,
  type EsimAlertContext,
} from "./webhookProcessor";

import {
  createEsimAccessWebhookRouter,
  parseSupplierWebhook,
  __test__ as routeTest,
} from "../routes/webhooks.esimaccess";

import {
  runWebhookRegistrationOnce,
  resolveWebhookUrlFromEnv,
  __resetWebhookRegisterStateForTests,
  describeRegistration,
  WEBHOOK_PATH,
} from "../jobs/webhookRegister.job";
import { resetEnvCache } from "../config/env";

// ---------------------------------------------------------------------------
// In-memory fake DB
// ---------------------------------------------------------------------------
//
// The processor's DB usage is narrow: update webhook_events by (source,
// notifyId), update esims by id, select from orders by publicId, select the
// joined esims row by a supplier identifier, and (for the swallow branches)
// tolerate absence. We model just those queries with a tiny builder that
// matches the drizzle call shape the processor uses.
//
// Because the processor uses drizzle builders (`.select().from().where().limit()`),
// we cannot easily emulate the full builder. Instead we hand the processor a
// fake `getDb()` whose returned object exposes the query objects the processor
// touches as proxies that behave like the array-returning drizzle types, and
// we assert on recorded calls.
//
// This fake is intentionally small: it lets the tests drive transitions and
// records `update(esims).set({...})` writes plus `select(orders).where(...)`
// results without requiring a real driver. It is NOT a general drizzle mock.

interface FakeRowCalls {
  esimUpdates: Array<{ id: number; set: Record<string, unknown> }>;
  webhookUpdates: Array<{ notifyId: string; set: Record<string, unknown> }>;
}

interface FakeDbConfig {
  /**
   * Result the processor should see when it selects an eSIM joined with its
   * order. `null` means "not found" → the transition returns `esim_not_found`.
   */
  esimRow: Record<string, unknown> | null;
  /** Result the processor should see when it selects an order by publicId. */
  orderRow: { publicId: string; status: string } | null;
}

function makeFakeDb(config: FakeDbConfig): { db: unknown; calls: FakeRowCalls } {
  const calls: FakeRowCalls = { esimUpdates: [], webhookUpdates: [] };

  // Drizzle's chainable select: return an object whose terminal op resolves.
  const makeSelectChain = (rowsFor: (args: unknown) => Promise<unknown[]>) => {
    let whereArg: unknown = null;
    const chain = {
      from() {
        return chain;
      },
      innerJoin() {
        return chain;
      },
      where(w: unknown) {
        whereArg = w;
        return chain;
      },
      limit() {
        return rowsFor(whereArg);
      },
      // For update().where() flow, we don't use select's chain:
    };
    return chain;
  };

  const db = {
    select() {
      // We can't know which table until `.from()`; the processor passes the
      // drizzle table object. We detect by inspecting the selected columns via
      // the terminal result. Since our two select sites have distinct callers,
      // we branch on whether they call `.innerJoin()` (esims+orders) or not
      // (orders only). We model that with a closure set at `.innerJoin()`/`.from()`.
      const selected: { joined: boolean } = { joined: false };
      let whereArg: unknown = null;
      const chain = {
        from() {
          return chain;
        },
        innerJoin() {
          selected.joined = true;
          return chain;
        },
        where(w: unknown) {
          whereArg = w;
          return chain;
        },
        async limit() {
          if (selected.joined) {
            // esims joined orders lookup → return esimRow if present.
            return config.esimRow ? [config.esimRow] : [];
          }
          // orders-only lookup → return orderRow if present.
          return config.orderRow ? [config.orderRow] : [];
        },
      };
      void whereArg;
      return chain;
    },
    update(_table: unknown) {
      // Return a chain that supports `.set(...).where(...)`.
      const updateRef: { table: unknown } = { table: _table };
      return {
        set(set: Record<string, unknown>) {
          return {
            async where(whereArg: unknown) {
              // We don't decode the where clause; the code path decides which
              // table it is via the tracked table object identity, which we
              // can't know here. Instead we capture the set and stash it under
              // both buckets keyed by a marker on the set object.
              const id =
                (whereArg as { queryChunks?: unknown[] })?.queryChunks != null
                  ? -1
                  : -1;
              // Infer table by field set: webhook updates include `status` and
              // `processedAt`/`attempts`; esim updates include a usage field
              // or `status:"installed"` plus `installedAt`. This is a test
              // heuristic only.
              const isWebhook =
                "processedAt" in set || "attempts" in set || "processingError" in set;
              if (isWebhook) {
                calls.webhookUpdates.push({ notifyId: String(id), set });
              } else {
                calls.esimUpdates.push({ id: Number(id), set });
              }
            },
          };
        },
      };
    },
    // insert not used by the processor (route handles inserts).
  };

  return { db, calls };
}

// ---------------------------------------------------------------------------
// Fake notifier
// ---------------------------------------------------------------------------

interface CapturedAlerts {
  connected: EsimAlertContext[];
  lowData: Array<EsimAlertContext & { remainingBytes: number }>;
  validity: Array<EsimAlertContext & { daysLeft: number }>;
}

function makeNotifier(deliver = true): { notifier: Notifier; captured: CapturedAlerts } {
  const captured: CapturedAlerts = { connected: [], lowData: [], validity: [] };
  const ok: DeliveryReport = deliver
    ? { delivered: true }
    : { delivered: false, reason: "stub_not_delivering" };
  const notifier: Notifier = {
    async sendConnected(esim) {
      captured.connected.push(esim);
      return ok;
    },
    async sendLowData(esim) {
      captured.lowData.push(esim);
      return ok;
    },
    async sendValidityEnding(esim) {
      captured.validity.push(esim);
      return ok;
    },
  };
  return { notifier, captured };
}

/** A representative installed-eligible eSIM row joined with its order. */
function baseEsimRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 42,
    orderId: 7,
    iccid: "89000000000000000001",
    esimTranNo: "TRAN-42",
    installToken: "tok_abc",
    status: "ready",
    installedAt: null,
    totalBytes: "1073741824", // 1 GiB
    usedBytes: "0",
    expiresAt: null,
    usageUpdatedAt: null,
    recipientEmail: null,
    guestEmail: "buyer@example.test",
    buyerEmail: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Env hygiene
// ---------------------------------------------------------------------------

beforeEach(() => {
  // Loaded env is imported lazily by components; ensure we reset any cache so
  // the resolveWebhookUrl test can set PUBLIC_BASE_URL freely.
  delete process.env.PUBLIC_BASE_URL;
  resetEnvCache();
  __resetWebhookRegisterStateForTests();
});

// ---------------------------------------------------------------------------
// Route: parse + dedupe + 200-immediately
// ---------------------------------------------------------------------------

test("parseSupplierWebhook accepts direct and nested payload shapes", () => {
  const direct = parseSupplierWebhook({
    notifyId: "n-1",
    notifyType: "ESIM_STATUS",
    content: { esimTranNo: "T1" },
  });
  assert.ok(direct);
  assert.equal(direct!.notifyId, "n-1");
  assert.equal(direct!.notifyType, "ESIM_STATUS");

  const nested = parseSupplierWebhook({
    obj: { notifyId: "n-2", notifyType: "DATA_USAGE", content: { x: 1 } },
  });
  assert.ok(nested);
  assert.equal(nested!.notifyId, "n-2");
});

test("route responds 200 immediately, then schedules background processing", async () => {
  const { db } = makeFakeDb({ esimRow: baseEsimRow(), orderRow: null });
  let inserted = false;
  // Patch the route's insert: shared fake db returns [] on first insert so it's
  // counted as "inserted" (dedupe would return the same array empty). We model
  // dedupe by controlling that in the "deduped" test below.
  const fakeDb = {
    ...(db as object),
    insert: () => ({
      values: () => ({
        onConflictDoNothing: () => ({
          returning: async () => {
            inserted = true;
            return [{ id: 101 }];
          },
        }),
      }),
    }),
  };

  let released: (() => void) | null = null;
  const processCalls: SupplierWebhookPayload[] = [];
  const router = createEsimAccessWebhookRouter({
    getDb: () => fakeDb as never,
    processEvent: async (p) => {
      processCalls.push(p);
      // Block on a promise we control to prove the route already responded.
      await new Promise<void>((resolve) => {
        released = resolve;
      });
      return { handled: true, result: "done", notifyType: p.notifyType };
    },
    schedule: (fn) => {
      // Fire-and-forget, exactly like setImmediate in production.
      void fn();
    },
  });

  const req = {
    body: {
      notifyId: "n-200",
      notifyType: "ESIM_STATUS",
      content: { esimTranNo: "T1" },
    },
  } as unknown as Parameters<typeof router>[0];
  void req;

  const handler = extractPostHandler(router);
  const res = makeResRecorder();
  await handler(
    { body: (req as unknown as { body: unknown }).body } as never,
    res as never,
  );

  // (1) Already responded.
  assert.equal(res.statusCode, 200);
  assert.equal((res.jsonBody as { ok?: boolean }).ok, true);
  // (2) Insert happened (not dedupe) so processing was scheduled.
  assert.equal(inserted, true);
  // (3) Background task was invoked but waiting on our promise.
  assert.equal(processCalls.length, 1);
  assert.equal(processCalls[0]!.notifyId, "n-200");
  // Release so the test process does not leave a dangling promise.
  released?.();
});

test("dedupe: a duplicate notifyId is a 200 no-op with reason=deduped", async () => {
  const fakeDb = {
    insert: () => ({
      values: () => ({
        onConflictDoNothing: () => ({
          returning: async () => [] as { id: number }[],
        }),
      }),
    }),
  };
  let processCalls = 0;
  const router = createEsimAccessWebhookRouter({
    getDb: () => fakeDb as never,
    processEvent: async () => {
      processCalls += 1;
      return { handled: true, result: "done", notifyType: "ESIM_STATUS" };
    },
    schedule: (fn) => {
      void fn();
    },
  });
  const handler = extractPostHandler(router);
  const res = makeResRecorder();
  await handler(
    { body: { notifyId: "dup", notifyType: "ESIM_STATUS", content: {} } } as never,
    res as never,
  );
  assert.equal(res.statusCode, 200);
  assert.equal((res.jsonBody as { reason?: string }).reason, "deduped");
  assert.equal(processCalls, 0, "deduped event must not process");
});

test("malformed body → 200 handled=false reason=malformed", async () => {
  const router = createEsimAccessWebhookRouter({
    getDb: () => ({}) as never,
  });
  const handler = extractPostHandler(router);
  const res = makeResRecorder();
  await handler({ body: { garbage: true } } as never, res as never);
  assert.equal(res.statusCode, 200);
  assert.equal((res.jsonBody as { reason?: string }).reason, "malformed");
});

test("DB unavailable → 200 handled=false reason=db_unavailable", async () => {
  const router = createEsimAccessWebhookRouter({ getDb: () => null as never });
  const handler = extractPostHandler(router);
  const res = makeResRecorder();
  await handler(
    { body: { notifyId: "x", notifyType: "ORDER_STATUS", content: {} } } as never,
    res as never,
  );
  assert.equal(res.statusCode, 200);
  assert.equal((res.jsonBody as { reason?: string }).reason, "db_unavailable");
});

test("unknown notifyType is 200 and not processed", async () => {
  const fakeDb = {
    insert: () => ({
      values: () => ({
        onConflictDoNothing: () => ({
          returning: async () => [{ id: 1 }],
        }),
      }),
    }),
  };
  let processCalls = 0;
  const router = createEsimAccessWebhookRouter({
    getDb: () => fakeDb as never,
    processEvent: async () => {
      processCalls += 1;
      return { handled: true, result: "noop", notifyType: "WHATEVER" };
    },
    schedule: (fn) => {
      void fn();
    },
  });
  const handler = extractPostHandler(router);
  const res = makeResRecorder();
  await handler(
    { body: { notifyId: "u", notifyType: "WHATEVER", content: {} } } as never,
    res as never,
  );
  assert.equal(res.statusCode, 200);
  assert.equal(processCalls, 0);
});

// ---------------------------------------------------------------------------
// Processor: ESIM_STATUS
// ---------------------------------------------------------------------------

test("ESIM_STATUS (installed) flips status to installed and sends the connected email once", async () => {
  const { db, calls } = makeFakeDb({
    esimRow: baseEsimRow({ status: "ready", installedAt: null }),
    orderRow: null,
  });
  const { notifier, captured } = makeNotifier();
  const deps: ProcessorDeps = {
    getDb: () => db as never,
    notifier,
    now: () => new Date("2024-01-01T00:00:00Z"),
    log: () => {},
  };
  const outcome = await processSupplierWebhook(
    {
      notifyId: "evt-esim-1",
      notifyType: "ESIM_STATUS",
      content: { esimTranNo: "TRAN-42", esimStatus: "INSTALLED" },
    },
    deps,
  );
  assert.equal(outcome.handled, true);
  assert.equal(outcome.result, "installed");
  assert.equal(captured.connected.length, 1);
  // esim updated to installed.
  const update = calls.esimUpdates.find((u) => u.set.status === "installed");
  assert.ok(update, "must update esim row to installed");
});

test("ESIM_STATUS when the eSIM is already installed → no duplicate email", async () => {
  const { db } = makeFakeDb({
    esimRow: baseEsimRow({
      status: "installed",
      installedAt: new Date("2023-12-01T00:00:00Z"),
    }),
    orderRow: null,
  });
  const { notifier, captured } = makeNotifier();
  const outcome = await processSupplierWebhook(
    {
      notifyId: "evt-esim-dup",
      notifyType: "ESIM_STATUS",
      content: { esimTranNo: "TRAN-42", esimStatus: "INSTALLED" },
    },
    { getDb: () => db as never, notifier, log: () => {} },
  );
  assert.equal(outcome.result, "already_installed");
  assert.equal(captured.connected.length, 0);
});

test("ESIM_STATUS that is not an install (e.g. 'RELEASED') does not email", async () => {
  const { db } = makeFakeDb({
    esimRow: baseEsimRow({ status: "ready", installedAt: null }),
    orderRow: null,
  });
  const { notifier, captured } = makeNotifier();
  const outcome = await processSupplierWebhook(
    {
      notifyId: "evt-esim-rel",
      notifyType: "ESIM_STATUS",
      content: { esimTranNo: "TRAN-42", esimStatus: "RELEASED" },
    },
    { getDb: () => db as never, notifier, log: () => {} },
  );
  assert.equal(outcome.result, "esim_status_not_install");
  assert.equal(captured.connected.length, 0);
});

// ---------------------------------------------------------------------------
// Processor: DATA_USAGE
// ---------------------------------------------------------------------------

test("DATA_USAGE with remaining <= 100 MiB fires the low-data alert", async () => {
  const { db } = makeFakeDb({
    esimRow: baseEsimRow(),
    orderRow: null,
  });
  const { notifier, captured } = makeNotifier();
  const remaining = 50 * 1024 * 1024; // 50 MiB
  const outcome = await processSupplierWebhook(
    {
      notifyId: "evt-du-low",
      notifyType: "DATA_USAGE",
      content: { esimTranNo: "TRAN-42", remainingVolume: remaining },
    },
    { getDb: () => db as never, notifier, log: () => {} },
  );
  assert.equal(outcome.result, "low_data_alert");
  assert.equal(captured.lowData.length, 1);
  assert.equal(captured.lowData[0]!.remainingBytes, remaining);
});

test("DATA_USAGE with abundant remaining records usage but does NOT alert", async () => {
  const { db } = makeFakeDb({
    esimRow: baseEsimRow(),
    orderRow: null,
  });
  const { notifier, captured } = makeNotifier();
  const remaining = 500 * 1024 * 1024; // 500 MiB
  const outcome = await processSupplierWebhook(
    {
      notifyId: "evt-du-high",
      notifyType: "DATA_USAGE",
      content: { esimTranNo: "TRAN-42", remainingVolume: remaining },
    },
    { getDb: () => db as never, notifier, log: () => {} },
  );
  assert.equal(outcome.result, "data_usage_recorded");
  assert.equal(captured.lowData.length, 0);
});

test("DATA_USAGE derives remaining when only total+used are present", async () => {
  const { db } = makeFakeDb({ esimRow: baseEsimRow(), orderRow: null });
  const { notifier, captured } = makeNotifier();
  // 100 MiB total, 80 MiB used → remaining 20 MiB → below threshold.
  const outcome = await processSupplierWebhook(
    {
      notifyId: "evt-du-derive",
      notifyType: "DATA_USAGE",
      content: {
        esimTranNo: "TRAN-42",
        totalVolume: 100 * 1024 * 1024,
        usedVolume: 80 * 1024 * 1024,
      },
    },
    { getDb: () => db as never, notifier, log: () => {} },
  );
  assert.equal(outcome.result, "low_data_alert");
  assert.equal(captured.lowData.length, 1);
  assert.equal(captured.lowData[0]!.remainingBytes, 20 * 1024 * 1024);
});

// ---------------------------------------------------------------------------
// Processor: VALIDITY_USAGE
// ---------------------------------------------------------------------------

test("VALIDITY_USAGE sends the 1-day-left alert", async () => {
  const { db } = makeFakeDb({ esimRow: baseEsimRow(), orderRow: null });
  const { notifier, captured } = makeNotifier();
  const outcome = await processSupplierWebhook(
    {
      notifyId: "evt-vu",
      notifyType: "VALIDITY_USAGE",
      content: { esimTranNo: "TRAN-42", daysLeft: 1 },
    },
    { getDb: () => db as never, notifier, log: () => {} },
  );
  assert.equal(outcome.result, "validity_alert");
  assert.equal(captured.validity.length, 1);
  assert.equal(captured.validity[0]!.daysLeft, 1);
});

test("VALIDITY_USAGE on an already-expired eSIM does not alert", async () => {
  const { db } = makeFakeDb({
    esimRow: baseEsimRow({ status: "expired" }),
    orderRow: null,
  });
  const { notifier, captured } = makeNotifier();
  const outcome = await processSupplierWebhook(
    {
      notifyId: "evt-vu-exp",
      notifyType: "VALIDITY_USAGE",
      content: { esimTranNo: "TRAN-42" },
    },
    { getDb: () => db as never, notifier, log: () => {} },
  );
  assert.equal(outcome.result, "esim_expired_no_alert");
  assert.equal(captured.validity.length, 0);
});

// ---------------------------------------------------------------------------
// Processor: ORDER_STATUS
// ---------------------------------------------------------------------------

test("ORDER_STATUS on an already-completed order is a no-op", async () => {
  const { db } = makeFakeDb({
    esimRow: null,
    orderRow: { publicId: "ord_abc", status: "completed" },
  });
  let resumeCalls = 0;
  const outcome = await processSupplierWebhook(
    {
      notifyId: "evt-os-done",
      notifyType: "ORDER_STATUS",
      content: { transactionId: "ord_abc" },
    },
    {
      getDb: () => db as never,
      resumeOrder: async () => {
        resumeCalls += 1;
        return { status: "completed" };
      },
      log: () => {},
    },
  );
  assert.equal(outcome.result, "order_already_complete");
  assert.equal(resumeCalls, 0);
});

test("ORDER_STATUS on a processing order resumes it via the injected resume", async () => {
  const { db } = makeFakeDb({
    esimRow: null,
    orderRow: { publicId: "ord_proc", status: "processing" },
  });
  let resumeCalls = 0;
  const outcome = await processSupplierWebhook(
    {
      notifyId: "evt-os-proc",
      notifyType: "ORDER_STATUS",
      content: { transactionId: "ord_proc" },
    },
    {
      getDb: () => db as never,
      resumeOrder: async () => {
        resumeCalls += 1;
        return { status: "completed", detail: "resumed" };
      },
      log: () => {},
    },
  );
  assert.equal(resumeCalls, 1);
  assert.match(outcome.result, /^order_/);
});

test("ORDER_STATUS on a pending (unpaid) order does NOT complete it", async () => {
  const { db } = makeFakeDb({
    esimRow: null,
    orderRow: { publicId: "ord_pending", status: "pending" },
  });
  let resumeCalls = 0;
  const outcome = await processSupplierWebhook(
    {
      notifyId: "evt-os-pending",
      notifyType: "ORDER_STATUS",
      content: { transactionId: "ord_pending" },
    },
    {
      getDb: () => db as never,
      resumeOrder: async () => {
        resumeCalls += 1;
        return { status: "completed" };
      },
      log: () => {},
    },
  );
  assert.equal(resumeCalls, 0);
  assert.match(outcome.result, /^order_in_state_/);
});

test("ORDER_STATUS for an unknown order reports order_not_found", async () => {
  const { db } = makeFakeDb({ esimRow: null, orderRow: null });
  const outcome = await processSupplierWebhook(
    {
      notifyId: "evt-os-miss",
      notifyType: "ORDER_STATUS",
      content: { transactionId: "ord_missing" },
    },
    { getDb: () => db as never, log: () => {} },
  );
  assert.equal(outcome.result, "order_not_found");
});

// ---------------------------------------------------------------------------
// Processor honesty
// ---------------------------------------------------------------------------

test("default notifier reports delivered:false and processor still records the transition", async () => {
  const { db, calls } = makeFakeDb({ esimRow: baseEsimRow(), orderRow: null });
  // Use the DEFAULT notifier (no injection).
  const outcome = await processSupplierWebhook(
    {
      notifyId: "evt-default",
      notifyType: "ESIM_STATUS",
      content: { esimTranNo: "TRAN-42", esimStatus: "INSTALLED" },
    },
    { getDb: () => db as never, log: () => {} },
  );
  assert.equal(outcome.result, "installed");
  // Email went through the honest default notifier (delivered=false).
  assert.equal(
    (outcome.detail as { emailDelivered?: boolean }).emailDelivered,
    false,
  );
  // DB still records the transition.
  assert.ok(calls.esimUpdates.some((u) => u.set.status === "installed"));
});

test("DB not configured → processSupplierWebhook returns db_unavailable honestly", async () => {
  const outcome = await processSupplierWebhook(
    { notifyId: "x", notifyType: "ESIM_STATUS", content: {} },
    { getDb: () => null as never, log: () => {} },
  );
  assert.equal(outcome.result, "db_unavailable");
});

// ---------------------------------------------------------------------------
// webhookProcessor test surface — small invariants
// ---------------------------------------------------------------------------

test("LOW_DATA_THRESHOLD_BYTES is exactly 100 MiB", () => {
  assert.equal(processorTest.LOW_DATA_THRESHOLD_BYTES, 104_857_600);
});

test("extractEsimIdentifier prefers esimTranNo and tolerates nesting under esim/obj", () => {
  const ident = processorTest.extractEsimIdentifier({
    esim: { esimTranNo: "T1", iccid: "890", transactionId: "ord_x" },
  });
  assert.equal(ident.esimTranNo, "T1");
  assert.equal(ident.iccid, "890");
  assert.equal(ident.transactionId, "ord_x");
});

// ---------------------------------------------------------------------------
// webhookRegister.job — registration with honest skips
// ---------------------------------------------------------------------------

test("register skips gracefully when PUBLIC_BASE_URL is not set", async () => {
  // beforeEach deleted PUBLIC_BASE_URL and reset env cache.
  assert.equal(resolveWebhookUrlFromEnv(), null);
  const record = await runWebhookRegistrationOnce({
    saveWebhook: async () => {
      throw new Error("must not be called");
    },
    log: () => {},
  });
  assert.equal(record.outcome, "skipped_no_base_url");
  assert.equal(record.url, null);
});

test("register calls saveWebhook with our path + the four notifyTypes", async () => {
  process.env.PUBLIC_BASE_URL = "https://example.test";
  resetEnvCache();
  assert.equal(
    resolveWebhookUrlFromEnv(),
    `https://example.test${WEBHOOK_PATH}`,
  );
  let captured: { url: string; notifyTypes: string[] } | null = null;
  const record = await runWebhookRegistrationOnce({
    resolveWebhookUrl: () => `https://example.test${WEBHOOK_PATH}`,
    saveWebhook: async (input) => {
      captured = input;
      return { ok: true };
    },
    log: () => {},
  });
  assert.equal(record.outcome, "registered");
  assert.ok(captured, "saveWebhook must have been called");
  assert.equal(captured!.url, `https://example.test${WEBHOOK_PATH}`);
  assert.deepEqual(captured!.notifyTypes, [
    "ORDER_STATUS",
    "ESIM_STATUS",
    "DATA_USAGE",
    "VALIDITY_USAGE",
  ]);
  // Describe is populated from the last run.
  const described = describeRegistration();
  assert.equal(described.outcome, "registered");
  assert.equal(described.url, `https://example.test${WEBHOOK_PATH}`);
});

test("register reports failure honestly without throwing", async () => {
  const record = await runWebhookRegistrationOnce({
    resolveWebhookUrl: () => `https://example.test${WEBHOOK_PATH}`,
    saveWebhook: async () => {
      throw new Error("supplier 503");
    },
    log: () => {},
  });
  assert.equal(record.outcome, "failed");
  assert.match(record.detail ?? "", /503/);
});

// ---------------------------------------------------------------------------
// Route test surface
// ---------------------------------------------------------------------------

test("route exposes parser and NOTIFY_TYPES for other modules to import", () => {
  assert.deepEqual(routeTest.SUPPLIER_NOTIFY_TYPES, [
    "ORDER_STATUS",
    "ESIM_STATUS",
    "DATA_USAGE",
    "VALIDITY_USAGE",
  ]);
  assert.equal(routeTest.isKnownNotifyType("ORDER_STATUS"), true);
  assert.equal(routeTest.isKnownNotifyType("SOMETHING"), false);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * The route was created with `router.post(...)` on the root path; express
 * stores handlers on `router.stack`. Pull the first POST handler out so we can
 * invoke it directly with fake req/res.
 */
function extractPostHandler(router: unknown): (req: unknown, res: unknown) => Promise<void> {
  type Layer = { route?: { methods?: Record<string, boolean>; stack?: Array<{ handle: unknown }> } };
  const layers = ((router as { stack?: Layer[] }).stack ?? []) as Layer[];
  for (const layer of layers) {
    const methods = layer.route?.methods;
    if (methods?.post) {
      const handle = layer.route?.stack?.[0]?.handle;
      if (typeof handle === "function") {
        return handle as (req: unknown, res: unknown) => Promise<void>;
      }
    }
  }
  throw new Error("route has no POST handler");
}

interface ResRecorder {
  statusCode: number;
  jsonBody: unknown;
  status: (code: number) => ResRecorder;
  json: (body: unknown) => ResRecorder;
}

function makeResRecorder(): ResRecorder {
  const res: ResRecorder = {
    statusCode: 200,
    jsonBody: null,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(body: unknown) {
      res.jsonBody = body;
      return res;
    },
  };
  return res;
}

// Keep unused import lints happy.
void resetEnvCache;

/**
 * Shared end-to-end test harness (test-only).
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * This is the final "end-to-end flow wiring and tests" milestone. The two
 * runnable suites — `server/tests/e2e.flow.test.ts` and
 * `server/tests/refund.flow.test.ts` — each contain their own inline copies
 * of: a fake DB, a fake Stripe, an Express "call()" helper, and fixtures.
 * That duplication is fine for teaching one file at a time, but it starts to
 * drift, and any future flow test (or an HTTP-level suite mounting the real
 * routers) needs the same primitives.
 *
 * This file is the single, small, honest place to keep those primitives.
 * It is scoped to what the flow tests *can* rely on today:
 *
 *   - `makeFakeDb(seed)`  — an in-memory, projection-routed Drizzle-like
 *                            client. It reports the row state the services
 *                            would see; it does not emulate SQL. Real SQL is
 *                            only proven against Postgres in
 *                            `createTestDb()` (see testDb.ts).
 *
 *   - `makeFakeStripe()` and `makeFakeSupplier()` — injectable fakes for the
 *                            `RefundStripe` / `RefundSupplier` contracts the
 *                            refund service consumes. No network, no keys.
 *
 *   - `withApp(configure)` — boot an Express app on an ephemeral port, run a
 *                            callback with `{ request }`, and always close
 *                            the listener and end any outstanding sockets.
 *                            Used by HTTP-level suites that mount routers.
 *
 *   - fixture builders (`fixtureOrder`, `fixtureEsim`, `fixtureTopup`,
 *     `fixtureRefundRequest`) — the exact row shapes the flow services read
 *     and write, with everything synthetic. No real ICCIDs, payment intents
 *     or tranNos are present.
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT DO
 * ---------------------------------------
 *   - It does NOT import any service. That would recreate the drift we are
 *     trying to remove; the flow tests import their services directly and
 *     receive this harness's fakes as injected dependencies (which is the
 *     seam those services already expose — see `refund.test.ts`).
 *   - It does NOT call into `server/app.ts`. I do not have that file in this
 *     batch, and mounting routes by guessing their shape is exactly the kind
 *     of "looks green but isn't wired" mistake the phase must avoid. The
 *     `withApp(configure)` helper is ready for whoever wires that next; it
 *     takes a `(app) => void` so the caller decides what to mount.
 *   - It does NOT stand up Postgres. That path lives in `testDb.ts` and is
 *     guarded by `skipIfNoDatabase()`.
 *
 * SAFETY
 * ------
 * No network. No `process.env` mutation. No Secrets. Fixtures are synthetic.
 * The `withApp` helper binds to `127.0.0.1:0` (loopback, OS-assigned port)
 * and always closes what it opened before returning.
 *
 * USAGE
 * -----
 *   import {
 *     makeFakeDb, makeFakeStripe, makeFakeSupplier, withApp,
 *     fixtureOrder, fixtureEsim,
 *   } from "./helpers/testFlowHarness.js";
 *
 * These are SOURCE tests — not executed by this delivery.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import express, { type Express } from "express";

// ---------------------------------------------------------------------------
// Fake Stripe / Supplier — shapes match `RefundStripe` and `RefundSupplier`
// exported from `server/services/refund.ts`. They are declared structurally
// here (not imported) so this helper stays dependency-free; if the real
// interfaces change, TypeScript will surface the mismatch at the call site
// when a test passes this fake through `requestRefund({ stripe })`.
// ---------------------------------------------------------------------------

export interface FakeStripeCall {
  paymentIntentId: string;
  idempotencyKey: string;
  reason?: string;
}

export type FakeStripeResponse =
  | { ok: true; refundId?: string; amountMinor?: number; currency?: string }
  | { ok: false; reason?: string }
  | { throw: Error };

export interface FakeStripe {
  refund: (input: {
    paymentIntentId: string;
    idempotencyKey: string;
    reason?: string;
  }) => Promise<FakeStripeResponse>;
}

export function makeFakeStripe(response: FakeStripeResponse = { ok: true, refundId: "re_test" }): {
  stripe: FakeStripe;
  calls: FakeStripeCall[];
} {
  const calls: FakeStripeCall[] = [];
  const stripe: FakeStripe = {
    async refund(input) {
      calls.push(input);
      if ("throw" in response) throw response.throw;
      return response;
    },
  };
  return { stripe, calls };
}

export interface FakeSupplierCall {
  esimTranNo?: string;
  iccid?: string;
  transactionId?: string;
}

export type FakeSupplierResponse =
  | { ok: true }
  | { ok: false; reason?: string }
  | { throw: Error };

export interface FakeSupplier {
  cancel: (input: {
    esimTranNo?: string;
    iccid?: string;
    transactionId?: string;
  }) => Promise<{ ok: true } | { ok: false; reason?: string }>;
}

export function makeFakeSupplier(response: FakeSupplierResponse = { ok: true }): {
  supplier: FakeSupplier;
  calls: FakeSupplierCall[];
} {
  const calls: FakeSupplierCall[] = [];
  const supplier: FakeSupplier = {
    async cancel(input) {
      calls.push(input);
      if ("throw" in response) throw response.throw;
      return response;
    },
  };
  return { supplier, calls };
}

// ---------------------------------------------------------------------------
// withApp — ephemeral Express app + a scoped fetch-like request function.
//
// The callback receives `request(method, path, body?)` and returns whatever
// it resolves. `withApp` handles binding, closing and error propagation, so
// each HTTP test reads as one linear block.
// ---------------------------------------------------------------------------

export interface HttpResult {
  status: number;
  body: unknown;
  headers: http.IncomingHttpHeaders;
}

export type RequestFn = (
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
) => Promise<HttpResult>;

export async function withApp<T>(
  configure: (app: Express) => void,
  fn: (request: RequestFn) => Promise<T>,
): Promise<T> {
  const app = express();
  app.use(express.json());
  configure(app);

  const server = http.createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;

  const request: RequestFn = async (method, path, body) => {
    const init: RequestInit = {
      method,
      headers: { "content-type": "application/json" },
    };
    if (body !== undefined) init.body = JSON.stringify(body);
    const resp = await fetch(`${base}${path}`, init);
    const parsed = (await resp.json().catch(() => null)) as unknown;
    return { status: resp.status, body: parsed, headers: Object.fromEntries(resp.headers) };
  };

  try {
    return await fn(request);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

// ---------------------------------------------------------------------------
// Fixture builders — the row shapes the flow services read and write. Every
// field is overridable so individual tests can express exactly one mutation
// (e.g. install a fresh eSIM by setting `installedAt`) without needing to
// remember the rest.
// ---------------------------------------------------------------------------

export interface FixtureOrder {
  id: number;
  orderPublicId: string;
  guestEmail: string | null;
  userId: number | null;
  currency: "SGD" | "USD" | "VND" | "CNY";
  retailTotal: string;
  stripePaymentIntentId: string | null;
  status: string;
}

export function fixtureOrder(over: Partial<FixtureOrder> = {}): FixtureOrder {
  return {
    id: 1,
    orderPublicId: "ord_test",
    guestEmail: "buyer@example.test",
    userId: 1,
    currency: "SGD",
    retailTotal: "12.00",
    stripePaymentIntentId: "pi_test_1",
    status: "completed",
    ...over,
  };
}

export interface FixtureEsim {
  esimId: number;
  userId: number;
  orderId: number;
  status: string;
  iccid: string | null;
  esimTranNo: string | null;
  lpaCode: string | null;
  qrCodeUrl: string | null;
  installedAt: Date | null;
  usedBytes: string | number | null;
  expiresAt: Date | null;
  supportTopUpType: number;
  refundStatus: string | null;
  countrySlug: string | null;
}

export function fixtureEsim(over: Partial<FixtureEsim> = {}): FixtureEsim {
  return {
    esimId: 1,
    userId: 1,
    orderId: 1,
    status: "ready",
    iccid: "890000000000000001",
    esimTranNo: "TRAN-1",
    lpaCode: "LPA:1$sample",
    qrCodeUrl: "https://qr.example.test/TRAN-1",
    installedAt: null,
    usedBytes: 0,
    expiresAt: null,
    supportTopUpType: 2,
    refundStatus: null,
    countrySlug: "sg",
    ...over,
  };
}

export interface FixtureTopup {
  id: number;
  publicId: string;
  status: string;
  esimTranNo: string | null;
  packageCode: string;
  packageName: string;
  currency: "SGD" | "USD" | "VND" | "CNY";
  retailTotal: string;
  userId: number | null;
  supplierTransactionId: string | null;
  paidAt: Date | null;
  orderedAt: Date | null;
  failureReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export function fixtureTopup(over: Partial<FixtureTopup> = {}): FixtureTopup {
  const now = new Date("2024-06-01T10:00:00Z");
  return {
    id: 1,
    publicId: "tp_test",
    status: "paid",
    esimTranNo: "TRAN-1",
    packageCode: "TOPUP_SG_1GB",
    packageName: "Singapore 1 GB",
    currency: "USD",
    retailTotal: "1.50",
    userId: 1,
    supplierTransactionId: null,
    paidAt: now,
    orderedAt: null,
    failureReason: null,
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

export interface FixtureRefundRequest {
  id: number;
  publicId: string;
  userId: number;
  orderId: number;
  esimId: number;
  reason: string | null;
  status: string;
  supplierCancelStatus: string;
  supplierCancelReason: string | null;
  failureReason: string | null;
  stripeRefundId: string | null;
  stripeRefundAmount: string | null;
  stripeRefundCurrency: string | null;
  reviewNote: string | null;
  reviewedBy: number | null;
  reviewedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export function fixtureRefundRequest(
  over: Partial<FixtureRefundRequest> = {},
): FixtureRefundRequest {
  const now = new Date("2024-06-01T00:00:00Z");
  return {
    id: 1,
    publicId: "rf_test",
    userId: 1,
    orderId: 1,
    esimId: 1,
    reason: null,
    status: "requested",
    supplierCancelStatus: "not_attempted",
    supplierCancelReason: null,
    failureReason: null,
    stripeRefundId: null,
    stripeRefundAmount: null,
    stripeRefundCurrency: null,
    reviewNote: null,
    reviewedBy: null,
    reviewedAt: null,
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// makeFakeDb — the projection-routed in-memory client.
//
// The flow services call `getDb().select({...}).from(table).where(...)` and
// `getDb().update(table).set(patch).where(...)` / `getDb().insert(table)
// .values(row)`. Drizzle's runtime predicates are opaque `SQL` templates, so
// this fake cannot filter; it routes by the *projection* (the column set the
// service asked for) and applies UPDATE patches by their *shape* (the keys
// they set). This matches what `refund.ts` and `topup.ts` do, and is stable
// as long as those services keep their current select/update projections.
//
// If a future service adds a projection this fake doesn't recognise, the
// `unknown` bucket returns empty — a failing test surfaces the drift; it
// never silently passes.
// ---------------------------------------------------------------------------

interface FakeDbState {
  orders: FixtureOrder[];
  esims: FixtureEsim[];
  topups: FixtureTopup[];
  refunds: FixtureRefundRequest[];
  /** Insert log (whatever the services wrote). */
  inserts: Array<{ table: "orders" | "esims" | "topups" | "refunds" | "unknown"; row: Record<string, unknown> }>;
  /** Update log (patch + table guess). */
  updates: Array<{ table: "orders" | "esims" | "topups" | "refunds" | "unknown"; patch: Record<string, unknown> }>;
}

export interface FakeDbSeed {
  orders?: FixtureOrder[];
  esims?: FixtureEsim[];
  topups?: FixtureTopup[];
  refunds?: FixtureRefundRequest[];
}

export interface FakeDb {
  select: (cols?: Record<string, unknown>) => unknown;
  insert: (table: unknown) => unknown;
  update: (table: unknown) => unknown;
}

export interface FakeDbResult {
  db: FakeDb;
  state: FakeDbState;
}

function projectionKeys(cols: Record<string, unknown> | undefined): string[] {
  return cols ? Object.keys(cols) : [];
}

type ProjectionMode =
  | "esim-direct"
  | "order-by-id"
  | "order-by-public"
  | "order-by-payment-intent"
  | "topup-by-public"
  | "topup-by-id_list"
  | "refund-by-public"
  | "refund-open-for-esim"
  | "refund-list-for-user"
  | "unknown";

function detectProjection(cols: Record<string, unknown> | undefined): ProjectionMode {
  const keys = projectionKeys(cols);
  const has = (k: string) => keys.includes(k);

  // Order lookups come in several projections:
  //  - full row (has orderPublicId + currency)
  //  - payment intent only (stripePaymentIntentId + currency) — from refund.ts
  if (has("orderPublicId") && has("currency")) return "order-by-public";
  if (has("orderPublicId")) return "order-by-public";
  if (has("stripePaymentIntentId") && has("currency")) return "order-by-payment-intent";

  // eSIM direct read (refund.ts, topup.ts): esimId + esimTranNo
  if (has("esimId") && has("esimTranNo")) return "esim-direct";

  // Top-ups: by publicId only (single row) or list-with-id+status
  if (keys.length === 1 && has("publicId")) return "topup-by-public";
  if (has("publicId") && has("esimTranNo") && has("status")) return "topup-by-public";
  if (has("id") && has("status") && has("packageCode")) return "topup-by-id_list";

  // Refund requests: list-of-user shape has reviewNote AND createdAt; open
  // check has only publicId under a WHERE subquery; by-publicId lookup (for
  // decideRefundReview) has id + esimId + orderId + status.
  if (has("esimId") && has("publicId") && has("reviewNote")) return "refund-list-for-user";
  if (has("id") && has("esimId") && has("orderId") && has("status")) return "refund-by-public";
  if (keys.length === 1 && has("id")) return "refund-open-for-esim";

  return "unknown";
}

export function makeFakeDb(seed: FakeDbSeed = {}): FakeDbResult {
  const state: FakeDbState = {
    orders: seed.orders ? [...seed.orders] : [],
    esims: seed.esims ? seed.esims.map((e) => ({ ...e })) : [],
    topups: seed.topups ? seed.topups.map((t) => ({ ...t })) : [],
    refunds: seed.refunds ? seed.refunds.map((r) => ({ ...r })) : [],
    inserts: [],
    updates: [],
  };

  const select = (cols?: Record<string, unknown>) => {
    const mode = detectProjection(cols);
    const chain = {
      from: (_t: unknown) => chain,
      where: (_w: unknown) => chain,
      limit: async (_n: number): Promise<unknown[]> => {
        switch (mode) {
          case "esim-direct":
            return state.esims.length ? [state.esims[0]] : [];
          case "order-by-id":
          case "order-by-public":
          case "order-by-payment-intent":
            return state.orders.length ? [state.orders[0]] : [];
          case "topup-by-public":
            return state.topups.length ? [state.topups.slice(-1)[0]] : [];
          case "topup-by-id_list":
            return state.topups.filter((t) => t.status !== "ordered");
          case "refund-by-public":
            return state.refunds
              .filter((r) => r.status === "review")
              .map((r) => ({ id: r.id, esimId: r.esimId, orderId: r.orderId, status: r.status }));
          case "refund-open-for-esim": {
            const open = state.refunds.find((r) => r.status === "requested" || r.status === "review");
            return open ? [{ publicId: open.publicId }] : [];
          }
          default:
            return [];
        }
      },
      orderBy: async (_col: unknown): Promise<unknown[]> => {
        if (mode === "refund-list-for-user") {
          return [...state.refunds].sort(
            (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
          );
        }
        return [];
      },
    };
    return chain;
  };

  const insert = (_table: unknown) => ({
    values: async (row: Record<string, unknown>) => {
      const publicId = typeof row.publicId === "string" ? row.publicId : "";
      if (publicId.startsWith("rf_")) {
        state.inserts.push({ table: "refunds", row });
        state.refunds.push(
          fixtureRefundRequest({
            id: state.refunds.length + 1,
            publicId,
            userId: Number(row.userId ?? 0),
            orderId: Number(row.orderId ?? 0),
            esimId: Number(row.esimId ?? 0),
            reason: (row.reason as string | null) ?? null,
            status: String(row.status ?? "requested"),
            supplierCancelStatus: String(row.supplierCancelStatus ?? "not_attempted"),
          }),
        );
        return undefined;
      }
      if (publicId.startsWith("tp_")) {
        state.inserts.push({ table: "topups", row });
        return undefined;
      }
      state.inserts.push({ table: "unknown", row });
      return undefined;
    },
    returning: async (_cols: unknown) => {
      // Top-ups INSERT..RETURNING({id}) shape
      if (state.inserts.length > 0) {
        const last = state.inserts[state.inserts.length - 1];
        if (last) return [{ id: state.topups.length + 1 }];
      }
      return [{ id: state.topups.length + 1 }];
    },
  });

  const update = (_table: unknown) => ({
    set: (patch: Record<string, unknown>) => ({
      where: async (_w: unknown) => {
        // Route by patch shape.
        if ("refundStatus" in patch) {
          state.updates.push({ table: "esims", patch });
          for (const e of state.esims) Object.assign(e, patch);
          return;
        }
        if ("supplierCancelStatus" in patch || "reviewedBy" in patch || "stripeRefundId" in patch) {
          state.updates.push({ table: "refunds", patch });
          const target = state.refunds[state.refunds.length - 1];
          if (target) Object.assign(target, patch);
          return;
        }
        if ("status" in patch && state.orders.length > 0) {
          state.updates.push({ table: "orders", patch });
          for (const o of state.orders) Object.assign(o, patch);
          return;
        }
        if ("failureReason" in patch || "supplierTransactionId" in patch || "orderedAt" in patch) {
          state.updates.push({ table: "topups", patch });
          const target = state.topups[state.topups.length - 1];
          if (target) Object.assign(target, patch);
          return;
        }
        state.updates.push({ table: "unknown", patch });
      },
      returning: async (_cols: unknown) => {
        // UPDATE..RETURNING({id}) path used by topup.ts.
        const target = state.topups[state.topups.length - 1];
        return target ? [{ id: target.id }] : [];
      },
    }),
  });

  return {
    db: { select, insert, update },
    state,
  };
}

// ---------------------------------------------------------------------------
// Type-only convenience: what `makeFakeDb` returns is assignable to the
// `getDb` injection point that `requestRefund`, `applyTopupPaid` and
// `listTopupOptions` accept (they take `() => <client> | null`). Wrapping the
// returned client in a function is what the callers do:
//
//     const { db } = makeFakeDb({ esims: [fixtureEsim()], orders: [fixtureOrder()] });
//     await requestRefund({ userId: 1, esimId: 1, getDb: () => db as any, ... });
//
// We deliberately keep the cast at the call site (not here) so that if the
// real `getDb` type changes, the cast surfaces there — not silently inside
// this helper.
// ---------------------------------------------------------------------------

export const __test__ = {
  projectionKeys,
  detectProjection,
};

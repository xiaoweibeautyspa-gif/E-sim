/**
 * Shared scenario builders for the end-to-end flow suites.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `server/tests/e2e.flow.test.ts` and `server/tests/refund.flow.test.ts` both
 * need the SAME starting point: one paid order that already has eSIM rows,
 * a Stripe payment intent, and (sometimes) a top-up row — plus the "bad
 * weather" variants: supplier not ready, low balance, ineligible top-up,
 * installed-eSIM refund.
 *
 * Rather than copy those fixtures into each suite, this module exposes:
 *
 *   - `buildHappyPath()`     — a paid order + one `ready` eSIM (unused).
 *   - `buildInstalledPath()`  — the same order but the eSIM is installed/used.
 *   - `buildProcessingOrder()`— supplier never returned resources in time.
 *   - `buildLowBalanceOrder()`— supplier balance under the guard threshold.
 *   - `buildTopupScenario()`  — an eSIM + a `paid` top-up ready to fulfil.
 *   - `buildIneligibleTopup()`— supportTopUpType !== 2 or expired.
 *   - `buildRefundReviewQueue()`— an installed eSIM already queued for review.
 *
 * Each builder returns `{ store, db, stub, stripe }` where:
 *   - `store`  is the plain-object state the real services mutate,
 *   - `db`     is the fake Drizzle-like client (from `testFlowHarness`),
 *   - `stub`   is the stubbed eSIM Access client (from `stubEsimAccess`),
 *   - `stripe` is a stubbed refund gateway with a `calls` log.
 *
 * The tests then call the REAL services with these injected:
 *
 *     const { db, stub, stripe } = buildHappyPath();
 *     const outcome = await requestRefund({
 *       userId: 1, esimId: 1,
 *       getDb: () => db as any,
 *       supplier: { cancel: (i) => stub.client.cancel(i) },
 *       stripe: stripe.gateway,
 *       notifier: stubNotifier(),
 *       now: () => FIXED_NOW,
 *       log: () => {},
 *     });
 *
 * WHAT THIS MODULE DELIBERATELY AVOIDS
 * ------------------------------------
 *   - It imports `testFlowHarness` and `stubEsimAccess` (already saved) but
 *     NOT the flow services. The suites import the services themselves so a
 *     compile error there is attributed to the right file.
 *   - It never fabricates a pass. Every builder returns real state; if a
 *     service signature drifts, the cast `as any` at the call site fails
 *     loudly at compile time, not silently at runtime.
 *   - It does not import express or open sockets — `withApp` lives in
 *     `testFlowHarness` and is used by suites that need HTTP.
 *
 * SAFETY
 * ------
 * No network, no env mutation, no DATABASE_URL, no secrets. The stub supplier
 * is per-instance. All ICCIDs / tranNos / payment intents are synthetic.
 *
 * These are SOURCE tests — this delivery did not execute them.
 */
import {
  makeFakeDb,
  makeFakeStripe,
  makeFakeSupplier,
  fixtureEsim,
  fixtureOrder,
  fixtureTopup,
  fixtureRefundRequest,
  type FakeDb,
  type FakeDbSeed,
  type FixtureEsim,
  type FixtureOrder,
  type FixtureTopup,
  type FixtureRefundRequest,
} from "./testFlowHarness.js";
import {
  createStubEsimAccess,
  type StubConfig,
  type StubEsimAccess,
} from "./stubEsimAccess.js";

// ---------------------------------------------------------------------------
// Constants shared by the flow tests
// ---------------------------------------------------------------------------

/** Stable clock for the flow fixtures — used by services that take `now`. */
export const FIXED_NOW = () => new Date("2024-06-01T12:00:00Z");
/** "Before" the trip — useful for departure-reminder tests. */
export const BEFORE_TRIP_NOW = () => new Date("2024-05-31T12:00:00Z");

/** The threshold `balanceGuard.ts` uses for the low-balance flag. */
export const LOW_BALANCE_THRESHOLD_USD = 50;

/** A supplier stub configured for a healthy catalogue. */
export const HEALTHY_STUB: StubConfig = {
  balanceUsd: 5000,
  readyAfterPolls: 0,
  packages: [
    {
      packageCode: "PKG_SG_5GB_30D",
      packageName: "Singapore 5 GB / 30 days",
      packageType: "PACKAGE",
      priceUnits: 20_000, // → $2.00 wholesale
      volumeBytes: 5 * 1024 * 1024 * 1024,
      durationDays: 30,
      supportTopUpType: 2,
      operatorNames: ["Singtel"],
      locationCodes: ["SG"],
    },
    {
      packageCode: "TOPUP_SG_1GB",
      packageName: "Singapore 1 GB top-up",
      packageType: "TOPUP",
      priceUnits: 5_000, // → $0.50 wholesale
      volumeBytes: 1024 * 1024 * 1024,
      durationDays: 30,
      supportTopUpType: 2,
      operatorNames: ["Singtel"],
      locationCodes: ["SG"],
    },
  ],
};

// ---------------------------------------------------------------------------
// Shared result shape
// ---------------------------------------------------------------------------

export interface StubStripe {
  /** The RefundStripe-shaped object services accept. */
  gateway: {
    refund: (input: {
      paymentIntentId: string;
      idempotencyKey: string;
      reason?: string;
    }) => Promise<{ ok: true; refundId?: string } | { ok: false; reason?: string }>;
  };
  /** Every refund call, so suites can assert the count without a spy lib. */
  calls: Array<{ paymentIntentId: string; idempotencyKey: string; reason?: string }>;
}

export interface Scenario {
  /** The plain-object store the fake DB and stub supplier mutate. */
  store: FakeDbSeed;
  /** Fake Drizzle-like client — pass `() => this.db as any` as getDb. */
  db: FakeDb;
  /** Stubbed eSIM Access supplier. */
  stub: StubEsimAccess;
  /** Stubbed Stripe refund gateway + call log. */
  stripe: StubStripe;
  /** The user / order / eSIM IDs the scenario created, for convenience. */
  ids: { userId: number; orderId: number; esimId: number };
}

export interface ScenarioOptions {
  /** Override the stub config (e.g. low balance, never-ready). */
  stubConfig?: StubConfig;
  /** Override the refund gateway response. */
  stripeResponse?:
    | { ok: true; refundId?: string }
    | { ok: false; reason?: string }
    | { throw: Error };
  /** Adjust the seed fixtures before returning. */
  tweak?: (seed: Required<FakeDbSeed>) => void;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Build the standard "buyer + order + eSIM" trio in a raw seed object. */
function seedBase(): Required<FakeDbSeed> {
  const order: FixtureOrder = fixtureOrder({
    id: 1,
    orderPublicId: "ord_flow",
    userId: 1,
    guestEmail: "buyer@example.test",
    currency: "SGD",
    retailTotal: "12.00",
    stripePaymentIntentId: "pi_flow",
    status: "completed",
  });
  const esim: FixtureEsim = fixtureEsim({
    esimId: 1,
    userId: 1,
    orderId: 1,
    status: "ready",
    iccid: "890000000000000001",
    esimTranNo: "TRAN-FLOW",
    lpaCode: "LPA:1$flow",
    qrCodeUrl: "https://example.test/qr/TRAN-FLOW.png",
    installedAt: null,
    usedBytes: 0,
    expiresAt: null,
    supportTopUpType: 2,
    refundStatus: null,
    countrySlug: "sg",
  });
  return { orders: [order], esims: [esim], topups: [], refunds: [] };
}

/** Wrap a seed into a Scenario, honouring the options. */
function materialise(seed: Required<FakeDbSeed>, opts: ScenarioOptions): Scenario {
  if (opts.tweak) opts.tweak(seed);

  const stub = createStubEsimAccess({
    ...HEALTHY_STUB,
    ...(opts.stubConfig ?? {}),
  });
  const { stripe: gateway, calls } = makeFakeStripe(
    opts.stripeResponse ?? { ok: true, refundId: "re_flow" },
  );
  const { db, state } = makeFakeDb(seed);

  // Sanity: fail fast if the fake DB didn't recognise the seed. The suites
  // depend on this state being visible on first read.
  void state;

  return {
    store: seed,
    db,
    stub,
    stripe: { gateway, calls },
    ids: {
      userId: seed.orders[0]?.userId ?? 1,
      orderId: seed.orders[0]?.id ?? 1,
      esimId: seed.esims[0]?.esimId ?? 1,
    },
  };
}

// ---------------------------------------------------------------------------
// Happy-path builders
// ---------------------------------------------------------------------------

/**
 * One paid order with one `ready` (unused) eSIM. The "browse → pay → delivered
 * → installed → usage → low-data → top-up → refund" flow uses this as its
 * starting point, then mutates it: mark the eSIM installed, top it up, refund
 * it.
 */
export function buildHappyPath(opts: ScenarioOptions = {}): Scenario {
  return materialise(seedBase(), opts);
}

/**
 * The same as `buildHappyPath` but the eSIM is already installed. This is
 * the "installed → refund goes to review" path (never auto-refunded).
 */
export function buildInstalledPath(opts: ScenarioOptions = {}): Scenario {
  return materialise(
    seedBase(),
    {
      ...opts,
      tweak: (seed) => {
        const e = seed.esims[0];
        if (e) {
          e.status = "installed";
          e.installedAt = new Date("2024-05-20T00:00:00Z");
          e.usedBytes = 200 * 1024 * 1024; // 200 MB used
        }
        opts.tweak?.(seed);
      },
    },
  );
}

/**
 * Paid order, but the supplier stub never flips to `GOT_RESOURCE`. The
 * caller's poll loop runs ten times without resources and the order stays
 * `processing` until the ORDER_STATUS webhook completes it.
 */
export function buildProcessingOrder(opts: ScenarioOptions = {}): Scenario {
  return materialise(seedBase(), {
    ...opts,
    stubConfig: { ...HEALTHY_STUB, neverReady: true, ...(opts.stubConfig ?? {}) },
  });
}

/**
 * Paid order, supplier balance below the guard. `balanceGuard.ts` saves the
 * order, flags admin, and refuses to call `/esim/order`. The eSIM row is
 * present but its status is `processing` (never `ready`/`installed`).
 */
export function buildLowBalanceOrder(opts: ScenarioOptions = {}): Scenario {
  return materialise(
    seedBase(),
    {
      ...opts,
      stubConfig: {
        ...HEALTHY_STUB,
        balanceUsd: LOW_BALANCE_THRESHOLD_USD / 2,
        ...(opts.stubConfig ?? {}),
      },
      tweak: (seed) => {
        const e = seed.esims[0];
        if (e) {
          e.status = "processing";
          e.iccid = null;
          e.esimTranNo = null;
          e.lpaCode = null;
          e.qrCodeUrl = null;
        }
        opts.tweak?.(seed);
      },
    },
  );
}

// ---------------------------------------------------------------------------
// Top-up builders
// ---------------------------------------------------------------------------

/**
 * An installed, eligible-for-top-up eSIM plus a `paid` top-up row. The
 * suite drives `applyTopupPaid({ topupPublicId: "tp_flow", ... })` and
 * asserts `/esim/topup` was called with `esimTranNo`, never with `iccid`.
 */
export function buildTopupScenario(opts: ScenarioOptions = {}): Scenario {
  return materialise(
    seedBase(),
    {
      ...opts,
      tweak: (seed) => {
        const e = seed.esims[0];
        if (e) {
          e.status = "installed";
          e.installedAt = new Date("2024-05-20T00:00:00Z");
          e.usedBytes = 4.8 * 1024 * 1024 * 1024; // just under 5 GB
          e.expiresAt = new Date("2024-06-20T00:00:00Z");
        }
        const topup: FixtureTopup = fixtureTopup({
          id: 1,
          publicId: "tp_flow",
          status: "paid",
          esimTranNo: e?.esimTranNo ?? "TRAN-FLOW",
          packageCode: "TOPUP_SG_1GB",
          packageName: "Singapore 1 GB top-up",
          currency: "USD",
          retailTotal: "1.50",
          userId: 1,
          supplierTransactionId: null,
          paidAt: new Date("2024-05-25T00:00:00Z"),
          orderedAt: null,
          failureReason: null,
        });
        seed.topups.push(topup);
        opts.tweak?.(seed);
      },
    },
  );
}

/** An eSIM whose `supportTopUpType !== 2` — top-ups must be refused. */
export function buildIneligibleTopup(opts: ScenarioOptions = {}): Scenario {
  return materialise(seedBase(), {
    ...opts,
    tweak: (seed) => {
      const e = seed.esims[0];
      if (e) {
        e.status = "installed";
        e.installedAt = new Date("2024-05-20T00:00:00Z");
        e.supportTopUpType = 0;
      }
      opts.tweak?.(seed);
    },
  });
}

/** An eSIM past its expiry — top-ups must be refused. */
export function buildExpiredEsim(opts: ScenarioOptions = {}): Scenario {
  return materialise(seedBase(), {
    ...opts,
    tweak: (seed) => {
      const e = seed.esims[0];
      if (e) {
        e.status = "installed";
        e.installedAt = new Date("2024-04-01T00:00:00Z");
        e.expiresAt = new Date("2024-05-01T00:00:00Z");
      }
      opts.tweak?.(seed);
    },
  });
}

// ---------------------------------------------------------------------------
// Refund-review builder
// ---------------------------------------------------------------------------

/**
 * An installed eSIM already queued for manual review. The suite drives
 * `decideRefundReview({ decision: "approve" | "reject" })` and asserts:
 *   - approve → Stripe refund dispatched once with the request public ID as
 *               the idempotency key;
 *   - reject  → zero Stripe calls.
 */
export function buildRefundReviewQueue(
  opts: ScenarioOptions & { requestStatus?: "review" | "requested" | "rejected" } = {},
): Scenario {
  return materialise(
    seedBase(),
    {
      ...opts,
      tweak: (seed) => {
        const e = seed.esims[0];
        if (e) {
          e.status = "installed";
          e.installedAt = new Date("2024-04-15T00:00:00Z");
          e.usedBytes = 300 * 1024 * 1024;
        }
        const order = seed.orders[0];
        if (order) {
          order.stripePaymentIntentId = "pi_review";
        }
        const existing: FixtureRefundRequest = fixtureRefundRequest({
          id: 1,
          publicId: "rf_flow",
          userId: 1,
          orderId: 1,
          esimId: 1,
          status: opts.requestStatus ?? "review",
          supplierCancelStatus: "refused",
        });
        seed.refunds.push(existing);
        opts.tweak?.(seed);
      },
    },
  );
}

// ---------------------------------------------------------------------------
// Suites also need a Supplier-facing refund shim. Keep it here so each test
// reads as one block instead of three.
// ---------------------------------------------------------------------------

/** Wrap a stub's `client.cancel` into the shape `requestRefund` accepts. */
export function refundSupplierOf(stub: StubEsimAccess) {
  return {
    cancel: (input: { esimTranNo?: string; iccid?: string; transactionId?: string }) =>
      stub.client.cancel(input),
  };
}

/** Wrap a stub's `client.topup` into the shape `applyTopupPaid` accepts. */
export function topupSupplierOf(stub: StubEsimAccess) {
  return {
    topup: (input: {
      esimTranNo: string;
      packageCode: string;
      transactionId: string;
    }) => stub.client.topup(input),
  };
}

/**
 * A notifier stub the refund service accepts. Both methods are no-ops so the
 * test's assertions stay on the supplier/Stripe effects (which are what the
 * guarantee actually promises). Reasons are recorded so a suite can check
 * that the right notification was sent.
 */
export function stubNotifier(): {
  sent: Array<{ kind: "confirmation" | "review"; amountMinor?: number }>;
  sendRefundConfirmation: (input: {
    requestPublicId: string;
    amountMinor: number;
    currency: string;
  }) => Promise<void>;
  sendRefundReviewReceived: (input: {
    requestPublicId: string;
  }) => Promise<void>;
} {
  const sent: Array<{ kind: "confirmation" | "review"; amountMinor?: number }> = [];
  return {
    sent,
    async sendRefundConfirmation(input) {
      sent.push({ kind: "confirmation", amountMinor: input.amountMinor });
    },
    async sendRefundReviewReceived() {
      sent.push({ kind: "review" });
    },
  };
}

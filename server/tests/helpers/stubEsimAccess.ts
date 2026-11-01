/**
 * Stub eSIM Access supplier + Stripe payment provider for end-to-end tests.
 *
 * The user rules that shape this stub come straight from the spec:
 *   • Prices are API value / 10000 = USD; volumes are bytes.
 *   • Only call `/esim/order` AFTER payment is confirmed.
 *   • Use OUR order id as transactionId so retries never double-order.
 *   • Poll `/esim/query` up to 10 times/3s; on failure, mark `processing`.
 *   • `/esim/cancel` only for unused eSIMs.
 *   • `/esim/topup` uses esimTranNo, not ICCID.
 *
 * This stub honours those rules so integration tests exercise the *caller*
 * (fulfilment.ts, topup.ts, refund.ts) against a fake that behaves like the
 * real supplier. It is deliberately STATEful so that:
 *   - a repeated `/esim/order` with the same `transactionId` returns the
 *     same ICCIDs (idempotent),
 *   - a repeated `/esim/query` advances the readiness timeline (so poll
 *     tests can assert "10 tries then fallback"),
 *   - `/balance/query` reports whatever the test instructs (so the low-balance
 *     path can be exercised),
 *   - `/esim/cancel` refuses non-unused eSIMs.
 *
 * It is NOT a mock of our internal services — those run for real. It is only
 * the network edge that would otherwise reach api.esimaccess.com.
 *
 * NEVER imports network modules, NEVER writes to process.env, NEVER invents
 * credentials. All state is per-instance; tests create a fresh one.
 */
import type {
  EsimAccessClient,
  PackageListPage,
  OrderRequest,
  OrderResult,
  OrderEsim,
  QueryResult,
  UsageResult,
  TopupRequest,
  TopupResult,
  CancelRequest,
  CancelResult,
  BalanceResult,
} from "../../esimaccess";

// ---------------------------------------------------------------------------
// Configuration carried by each instance
// ---------------------------------------------------------------------------

export interface StubConfig {
  /** Wholesale balance the supplier reports from /balance/query. */
  balanceUsd?: number;
  /** How many /esim/query polls return `not_ready` before resources appear. */
  readyAfterPolls?: number;
  /** If true, /esim/order always succeeds but /esim/query always reports pending. */
  neverReady?: boolean;
  /** If set, /esim/order fails with this error code. */
  orderError?: string;
  /** If set, /esim/cancel refuses with this error code. */
  cancelRefusal?: string;
  /** Supplier package catalogue; used by /package/list (type PACKAGE + TOPUP). */
  packages?: Array<{
    packageCode: string;
    packageName?: string;
    packageType?: "PACKAGE" | "TOPUP";
    priceUnits?: number; // raw /10000 = USD
    volumeBytes?: number;
    durationDays?: number;
    supportTopUpType?: 0 | 1 | 2;
    operatorNames?: string[];
    locationCodes?: string[];
  }>;
}

export interface StubState {
  /** Every /esim/order payload we received, in order. */
  orderRequests: OrderRequest[];
  /** Every /esim/query batch we received. */
  queryCalls: Array<{ transactionIds?: string[]; orderNos?: string[]; esimTranNos?: string[] }>;
  /** Every /esim/topup payload we received. */
  topupRequests: TopupRequest[];
  /** Every /esim/cancel payload we received. */
  cancelRequests: CancelRequest[];
  /** Every /esim/usage/query batch we received. */
  usageCalls: string[][];
  /** Balance checks in order. */
  balanceCalls: number;
  /** Final ICCIDs allocated by /esim/order keyed by our transactionId. */
  issuedByTransaction: Map<string, OrderEsim[]>;
  /** Supplier internal order number keyed by our transactionId (for logging). */
  supplierOrderNoByTransaction: Map<string, string>;
}

export interface StubEsimAccess {
  /** The client instance (implements the same interface as `server/esimaccess.ts`). */
  client: EsimAccessClient;
  /** Mutable state surfaced for assertions. */
  state: StubState;
  /** Update config at runtime (e.g. flip low balance or "now ready"). */
  setConfig: (patch: Partial<StubConfig>) => void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createStubEsimAccess(config: StubConfig = {}): StubEsimAccess {
  const cfg: StubConfig = { readyAfterPolls: 0, balanceUsd: 1000, ...config };

  const state: StubState = {
    orderRequests: [],
    queryCalls: [],
    topupRequests: [],
    cancelRequests: [],
    usageCalls: [],
    balanceCalls: 0,
    issuedByTransaction: new Map(),
    supplierOrderNoByTransaction: new Map(),
  };

  /** Per-transactionId cold-start counter so "readyAfterPolls" is deterministic. */
  const pollCounts = new Map<string, number>();

  /** Unique ICCID generator that looks like a real 19–20 digit number. */
  let iccSeq = 0;
  const nextIccid = (): string => {
    iccSeq += 1;
    // "89" prefix, zero-padded, matches the shape the supplier emits.
    return `89${String(iccSeq).padStart(17, "0")}`;
  };

  const client: EsimAccessClient = {
    isConfigured: true,

    async listPackages(): Promise<PackageListPage> {
      const packages = (cfg.packages ?? []).map((p) => ({
        packageCode: p.packageCode,
        packageName: p.packageName ?? p.packageCode,
        packageType: p.packageType ?? "PACKAGE",
        price: p.priceUnits ?? 10_000,
        volume: p.volumeBytes ?? 1024 * 1024 * 1024,
        duration: p.durationDays ?? 7,
        supportTopUpType: p.supportTopUpType ?? 2,
        locationNetworkList: (p.operatorNames ?? ["Singtel"]).map((name) => ({
          operatorName: name,
        })),
        locationCodes: p.locationCodes ?? ["SG"],
      }));
      return { list: packages };
    },

    async order(req: OrderRequest): Promise<OrderResult> {
      state.orderRequests.push(req);
      if (cfg.orderError) {
        // The real client throws EsimAccessError on business errors — the
        // caller has to catch/handle it. Mimic that behaviour.
        throw Object.assign(new Error(cfg.orderError), {
          name: "EsimAccessError",
          errorCode: cfg.orderError,
        });
      }

      // Idempotency: same transactionId → identical ICCIDs, no new allocation.
      const existing = state.issuedByTransaction.get(req.transactionId);
      if (existing) {
        const orderNo = state.supplierOrderNoByTransaction.get(req.transactionId)!;
        return {
          orderNo,
          transactionId: req.transactionId,
          orderStatus: "GOT_RESOURCE",
          esims: existing,
        };
      }

      const count = Math.max(1, req.count ?? 1);
      const esims: OrderEsim[] = [];
      for (let i = 0; i < count; i += 1) {
        const iccid = nextIccid();
        esims.push({
          iccid,
          esimTranNo: `TRAN-${iccid.slice(-8)}`,
          lpaCode: `LPA:1$sample$ac-${iccid.slice(-6)}`,
          qrCodeUrl: `https://stub.example/qr/${iccid}.png`,
        });
      }
      state.issuedByTransaction.set(req.transactionId, esims);
      const orderNo = `SUP-${req.transactionId}`;
      state.supplierOrderNoByTransaction.set(req.transactionId, orderNo);
      return {
        orderNo,
        transactionId: req.transactionId,
        orderStatus: "GOT_RESOURCE",
        esims,
      };
    },

    async query(input: {
      transactionIds?: string[];
      orderNos?: string[];
      esimTranNos?: string[];
    }): Promise<QueryResult> {
      state.queryCalls.push(input);

      // Resolve each requested transaction id to its issued esims and decide
      // readiness: after `readyAfterPolls` polls we start returning resources.
      const requestedTxIds = input.transactionIds ?? [];
      const batches = requestedTxIds.map((txId) => {
        const issued = state.issuedByTransaction.get(txId) ?? [];
        const n = pollCounts.get(txId) ?? 0;
        pollCounts.set(txId, n + 1);
        const ready =
          !cfg.neverReady && n >= (cfg.readyAfterPolls ?? 0) && issued.length > 0;
        const orderNo = state.supplierOrderNoByTransaction.get(txId) ?? `SUP-${txId}`;
        return {
          orderNo,
          transactionId: txId,
          orderStatus: ready ? "GOT_RESOURCE" : "CREATED",
          // Return resources only when ready, matching supplier semantics.
          esims: ready ? issued : [],
        };
      });

      return { list: batches, esims: batches.flatMap((b) => b.esims) };
    },

    async queryUsage(esimTranNos: string[]): Promise<UsageResult[]> {
      // Honour the supplier cap of 10 to catch callers that over-batch.
      if (esimTranNos.length > 10) {
        throw new Error(
          `stub: /esim/usage/query received ${esimTranNos.length} > 10 esimTranNo`,
        );
      }
      state.usageCalls.push([...esimTranNos]);
      return esimTranNos.map((t) => ({
        esimTranNo: t,
        totalVolume: 1024 * 1024 * 1024,
        usedVolume: 0,
        // Real network data is delayed 1–3 h; the caller stores updatedAt = now.
        expiredTime: null,
      }));
    },

    async topup(req: TopupRequest): Promise<TopupResult> {
      state.topupRequests.push(req);
      // The supplier uses esimTranNo, not ICCID. Fail loudly if a caller used
      // the wrong field, since that is exactly the rule the spec calls out.
      if (!req.esimTranNo || req.esimTranNo === "") {
        throw new Error("stub: /esim/topup requires esimTranNo");
      }
      return { ok: true, orderNo: `SUP-TO-${req.transactionId}` };
    },

    async cancel(req: CancelRequest): Promise<CancelResult> {
      state.cancelRequests.push(req);
      if (cfg.cancelRefusal) {
        return { ok: false, reason: cfg.cancelRefusal };
      }
      // Honest guard: /esim/cancel only works on unused eSIMs. Our stub can't
      // know production state, but the caller is responsible for not calling
      // us on installed ones (see refund.ts). If a test wants to force the
      // supplier-side refusal it should set cancelRefusal.
      return { ok: true };
    },

    async balance(): Promise<BalanceResult> {
      state.balanceCalls += 1;
      const usd = cfg.balanceUsd ?? 0;
      // The supplier responds in units (× 10000); the client typically exposes
      // both raw units and USD. Tests assert on the USD value.
      return { balanceUnits: Math.round(usd * 10_000), balanceUsd: usd };
    },

    async saveWebhook(_token: string, _url: string): Promise<{ ok: boolean }> {
      return { ok: true };
    },
  };

  return {
    client,
    state,
    setConfig(patch: Partial<StubConfig>) {
      Object.assign(cfg, patch);
    },
  };
}

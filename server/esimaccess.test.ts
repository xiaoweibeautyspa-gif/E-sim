import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  esimAccess,
  EsimAccessError,
  EsimAccessNotConfiguredError,
  __test__,
  type FetchLike,
} from "./esimaccess";
import { resetEnvCache } from "./config/env";

/**
 * Unit tests for the eSIM Access client.
 *
 * These tests make NO network calls: every request injects a `fetchImpl` stub.
 * They verify the parts of the client contract we depend on downstream:
 * - signing headers are present and well-formed,
 * - prices are divided by 10000 for USD convenience numbers,
 * - usage requests are chunked to <= 10 esimTranNo,
 * - retry-with-backoff retries on 5xx/429 and stops on a business error,
 * - missing credentials throw EsimAccessNotConfiguredError (never fake a result).
 *
 * We seed process.env before importing so `loadEnv` caches a configured env.
 */

// Configure a synthetic supplier env for these tests ONLY.
// These are not real credentials and are never sent anywhere because fetch is stubbed.
beforeEach(() => {
  process.env.NODE_ENV = "test";
  process.env.ESIM_ACCESS_CODE = "test-access-code";
  process.env.ESIM_SECRET_KEY = "test-secret-key";
  process.env.ESIM_ACCESS_BASE_URL = "https://api.esimaccess.com/api/v1/open";
  resetEnvCache();
});

/** Build a stub fetch that returns a canonical supplier envelope. */
function stubOnce(body: unknown, status = 200): { fetch: FetchLike; calls: () => number } {
  let n = 0;
  const fetchImpl: FetchLike = async () => {
    n += 1;
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(body),
    };
  };
  return { fetch: fetchImpl, calls: () => n };
}

/** A stub that fails the first `failCount` calls then succeeds. */
function stubFailThenSucceed(
  failStatus: number,
  failCount: number,
  body: unknown,
): { fetch: FetchLike; calls: () => number } {
  let n = 0;
  const fetchImpl: FetchLike = async () => {
    n += 1;
    if (n <= failCount) {
      return {
        ok: false,
        status: failStatus,
        text: async () => JSON.stringify({ success: false, errorCode: "TRANSIENT" }),
      };
    }
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(body),
    };
  };
  return { fetch: fetchImpl, calls: () => n };
}

test("signHeaders produces RT-* headers and never logs the secret", () => {
  const headers = __test__.signHeaders("{}", {
    baseUrl: "https://api.esimaccess.com/api/v1/open",
    accessCode: "test-access-code",
    secretKey: "test-secret-key",
    configured: true,
  });
  assert.equal(headers["RT-AccessCode"], "test-access-code");
  assert.match(headers["RT-Timestamp"]!, /^\d+$/);
  assert.match(headers["RT-Nonce"]!, /^[0-9a-f]{32}$/);
  assert.match(headers["RT-Signature"]!, /^[0-9a-f]{64}$/);
  // Secret must not appear in any header value.
  for (const v of Object.values(headers)) {
    assert.ok(!v.includes("test-secret-key"), "secret leaked into header");
  }
});

test("listPackages divides supplier price by 10000 and exposes priceUsd", async () => {
  const stub = stubOnce({
    success: true,
    obj: {
      list: [
        {
          packageCode: "P_SG_1GB_7D",
          packageName: "Singapore 1GB 7 days",
          packageType: "PACKAGE",
          price: 50000, // 50000 / 10000 = $5.00
          volume: 1073741824, // 1 GiB in bytes
          duration: 7,
          supportTopUpType: 2,
          locationCodes: ["SG"],
        },
      ],
    },
  });

  const pkgs = await esimAccess.listPackages({}, { fetchImpl: stub.fetch });
  assert.equal(pkgs.length, 1);
  const p = pkgs[0]!;
  assert.equal(p.packageCode, "P_SG_1GB_7D");
  assert.equal(p.price, 50000);
  assert.equal(p.priceUsd, 5);
  assert.equal(p.volume, 1073741824);
  assert.equal(p.supportTopUpType, 2);
  assert.equal(stub.calls(), 1);
});

test("queryUsage chunks esimTranNo into batches of at most 10", async () => {
  let callCount = 0;
  const sizes: number[] = [];
  const fetchImpl: FetchLike = async (_url, init) => {
    callCount += 1;
    const body = JSON.parse(init?.body ?? "{}") as { esimTranNoList?: string[] };
    sizes.push(body.esimTranNoList?.length ?? 0);
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          success: true,
          obj: (body.esimTranNoList ?? []).map((t) => ({
            esimTranNo: t,
            totalVolume: 100,
            usedVolume: 10,
          })),
        }),
    };
  };

  const tranNos = Array.from({ length: 25 }, (_, i) => `T${i}`);
  const usage = await esimAccess.queryUsage(tranNos, { fetchImpl });
  assert.equal(usage.length, 25);
  // 25 items => 3 calls (10 + 10 + 5)
  assert.equal(callCount, 3);
  for (const size of sizes) assert.ok(size <= __test__.MAX_USAGE_BATCH);
});

test("order sends our transactionId so retries stay idempotent", async () => {
  let capturedBody: Record<string, unknown> | null = null;
  const fetchImpl: FetchLike = async (_url, init) => {
    capturedBody = JSON.parse(init?.body ?? "{}");
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          success: true,
          obj: {
            orderNo: "SUPPLIER-ORDER-1",
            transactionId: "OUR-ORDER-ABC",
            orderStatus: "GOT_RESOURCE",
            esimList: [{ iccid: "89000", esimTranNo: "T1", ac: "LPA:1$foo", qrCodeUrl: "https://qr" }],
          },
        }),
    };
  };

  const result = await esimAccess.order(
    { packageCode: "P_SG_1GB_7D", count: 2, transactionId: "OUR-ORDER-ABC" },
    { fetchImpl },
  );
  assert.ok(capturedBody, "supplier must have been called");
  const body = capturedBody as unknown as {
    transactionId: string;
    amount: number;
    packageInfoList: Array<{ packageCode: string; count: number }>;
  };
  assert.equal(body.transactionId, "OUR-ORDER-ABC");
  assert.equal(body.amount, 2);
  assert.equal(body.packageInfoList[0]!.packageCode, "P_SG_1GB_7D");
  assert.equal(body.packageInfoList[0]!.count, 2);
  assert.equal(result.orderNo, "SUPPLIER-ORDER-1");
  assert.equal(result.esims.length, 1);
  assert.equal(result.esims[0]!.iccid, "89000");
  assert.equal(result.esims[0]!.esimTranNo, "T1");
  assert.equal(result.esims[0]!.lpaCode, "LPA:1$foo");
  assert.equal(result.esims[0]!.qrCodeUrl, "https://qr");
});

test("retries on 5xx then succeeds", async () => {
  // First 2 calls 500, then a healthy response.
  const stub = stubFailThenSucceed(
    500,
    2,
    { success: true, obj: { balance: 123456 } },
  );
  // Shrink backoff delays so the test is fast.
  const result = await esimAccess.balance({
    fetchImpl: stub.fetch,
    retry: { maxAttempts: 4, baseDelayMs: 1, maxDelayMs: 5 },
  });
  assert.equal(result.balanceUnits, 123456);
  assert.equal(result.balanceUsd, 12.3456);
  assert.equal(stub.calls(), 3, "should have retried twice then succeeded");
});

test("does not retry on business errors (success: false)", async () => {
  const stub = stubOnce({
    success: false,
    errorCode: "INSUFFICIENT_BALANCE",
    errorMsg: "Not enough supplier balance",
  });
  await assert.rejects(
    () =>
      esimAccess.order(
        { packageCode: "P_X", count: 1, transactionId: "O1" },
        { fetchImpl: stub.fetch, retry: { maxAttempts: 3, baseDelayMs: 1 } },
      ),
    (err: unknown) => {
      assert.ok(err instanceof EsimAccessError);
      assert.equal(err.errorCode, "INSUFFICIENT_BALANCE");
      return true;
    },
  );
  assert.equal(stub.calls(), 1, "business errors must not be retried");
});

test("topup sends esimTranNo (not iccid) per supplier rule", async () => {
  let capturedBody: Record<string, unknown> | null = null;
  const fetchImpl: FetchLike = async (_url, init) => {
    capturedBody = JSON.parse(init?.body ?? "{}");
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ success: true, obj: { status: "OK" } }),
    };
  };
  await esimAccess.topup(
    { esimTranNo: "TRAN-1", packageCode: "P_TOPUP_1GB", transactionId: "TX-TOPUP-1" },
    { fetchImpl },
  );
  const body = capturedBody as unknown as Record<string, unknown>;
  assert.equal(body.esimTranNo, "TRAN-1");
  assert.equal(body.packageCode, "P_TOPUP_1GB");
  assert.equal(body.transactionId, "TX-TOPUP-1");
  assert.equal("iccid" in body, false);
});

test("throws NotConfiguredError when ESIM_ACCESS_CODE is absent", async () => {
  delete process.env.ESIM_ACCESS_CODE;
  resetEnvCache();
  assert.equal(esimAccess.isConfigured, false);
  await assert.rejects(
    () =>
      esimAccess.balance({
        fetchImpl: (async () => ({ ok: true, status: 200, text: async () => "{}" })) as FetchLike,
      }),
    (err: unknown) => err instanceof EsimAccessNotConfiguredError,
  );
});

test("normalisers stay lenient with unexpected payload shapes", () => {
  const p = __test__.normalisePackage({ packageCode: 1, price: "abc" });
  assert.equal(p.packageCode, "1");
  assert.equal(p.price, 0);
  assert.equal(p.priceUsd, 0);

  const usage = __test__.normaliseUsage({ esimTranNo: "T1" });
  assert.equal(usage.esimTranNo, "T1");
  assert.equal(usage.totalVolume, null);
  assert.equal(usage.usedVolume, null);
});

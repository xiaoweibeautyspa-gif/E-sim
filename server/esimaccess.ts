import { createHmac, randomBytes } from "node:crypto";
import { loadEnv } from "./config/env";
import { RateLimiter, retryWithBackoff, type RetryOptions } from "./lib/rateLimitQueue";

/**
 * Single reusable eSIM Access (supplier) client.
 *
 * Rules encoded here (every consumer must go through this client):
 * - Base URL: https://api.esimaccess.com/api/v1/open
 * - Auth: HMAC-SHA256 signed headers using ESIM_ACCESS_CODE (+ ESIM_SECRET_KEY
 *   when the supplier account requires it). Keys are read from Secrets via
 *   `loadEnv()` and are NEVER exposed to the client bundle.
 * - Prices come back as integer units where value / 10000 = USD. This client
 *   returns the RAW supplier number and also a convenience USD number.
 * - Data volumes are bytes. This client returns them verbatim.
 * - All requests share an 8 req/sec rate limiter + retry-with-backoff wrapper.
 * - One-shot typed methods for each documented endpoint. `notConfigured`
 *   throws a clear error if credentials are missing so callers can 503
 *   honestly instead of fabricating a response.
 *
 * Documented endpoints:
 *   POST /package/list    (all / TOPUP with iccid)
 *   POST /esim/order      (create order; one row per eSIM)
 *   POST /esim/query      (by iccid / esimTranNo / orderNo)
 *   POST /esim/usage/query (up to 10 esimTranNo per call)
 *   POST /esim/topup      (uses esimTranNo, NOT iccid)
 *   POST /esim/cancel     (unused eSIMs only: RELEASED / GOT_RESOURCE)
 *   POST /balance/query   (supplier balance; used for low-balance guard)
 *   POST /webhook/save    (register webhook url)
 *
 * Test seam: every method accepts an optional `fetchImpl` (via RequestOptions)
 * so `node:test` can stub the network. Default is the global `fetch`.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SupplierPriceUnits = number;

export interface SupplierPackage {
  packageCode: string;
  packageName: string;
  packageType: string;
  currencyCode?: string;
  price: SupplierPriceUnits;
  priceUsd: number;
  volume: number | null;
  duration: number | null;
  description?: string;
  locationCodes?: string[];
  smsStatus?: number | null;
  supportTopUpType?: number;
  isDailyPlan?: boolean;
  raw: Record<string, unknown>;
}

export interface ListPackagesParams {
  type?: "PACKAGE" | "TOPUP";
  iccid?: string;
  location?: string;
  slug?: string;
}

export interface OrderPackageInput {
  packageCode: string;
  count: number;
  transactionId: string;
  referralCode?: string;
}

export interface SupplierOrderState {
  orderNo?: string;
  transactionId?: string;
  status: string;
  esims: SupplierEsim[];
  raw: Record<string, unknown>;
}

export interface SupplierEsim {
  iccid?: string;
  imsi?: string;
  esimTranNo?: string;
  lpaCode?: string;
  qrCodeUrl?: string;
  smdpStatus?: string;
  eid?: string;
  expiredTime?: string | null;
  msisdn?: string;
  raw: Record<string, unknown>;
}

export interface UsageEntry {
  esimTranNo: string;
  iccid?: string;
  totalVolume: number | null;
  usedVolume: number | null;
  lastUpdateTime?: string;
  raw: Record<string, unknown>;
}

export interface TopupInput {
  esimTranNo: string;
  packageCode: string;
  transactionId: string;
}

export interface TopupResult {
  transactionId?: string;
  status: string;
  raw: Record<string, unknown>;
}

export interface BalanceResult {
  balanceUnits: number;
  balanceUsd: number;
  raw: Record<string, unknown>;
}

export interface CancelResult {
  status: string;
  raw: Record<string, unknown>;
}

export interface RegisterWebhookInput {
  url: string;
  notifyTypes?: string[];
}

export interface CancelOptions {
  esimTranNo: string;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class EsimAccessError extends Error {
  readonly status?: number;
  readonly errorCode?: string;
  readonly retryable?: boolean;
  readonly endpoint: string;

  constructor(
    endpoint: string,
    message: string,
    options: { status?: number; errorCode?: string; retryable?: boolean } = {},
  ) {
    super(`[esimaccess ${endpoint}] ${message}`);
    this.name = "EsimAccessError";
    this.endpoint = endpoint;
    this.status = options.status;
    this.errorCode = options.errorCode;
    this.retryable =
      options.retryable ??
      (typeof options.status === "number" &&
        (options.status >= 500 || options.status === 429 || options.status === 408));
  }
}

export class EsimAccessNotConfiguredError extends EsimAccessError {
  constructor(endpoint: string) {
    super(endpoint, "Supplier credentials are not configured (ESIM_ACCESS_CODE missing).");
    this.name = "EsimAccessNotConfiguredError";
  }
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DEFAULT_BASE_URL = "https://api.esimaccess.com/api/v1/open";
const MAX_USAGE_BATCH = 10;
const REQ_PER_SECOND = 8;

interface SupplierConfig {
  baseUrl: string;
  accessCode: string;
  secretKey: string | null;
  configured: boolean;
}

function readConfig(): SupplierConfig {
  const env = loadEnv();
  const source = env.raw as unknown as Record<string, string | undefined>;
  const accessCode = source.ESIM_ACCESS_CODE ?? "";
  const secretKey = source.ESIM_SECRET_KEY ?? null;
  const base = (source.ESIM_ACCESS_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
  return {
    baseUrl: base,
    accessCode,
    secretKey,
    configured: accessCode.length > 0,
  };
}

// ---------------------------------------------------------------------------
// Signing
// ---------------------------------------------------------------------------

function signHeaders(body: string, cfg: SupplierConfig): Record<string, string> {
  if (!cfg.configured) {
    throw new EsimAccessError(
      "auth",
      "Access code missing; refusing to build an unsigned request.",
    );
  }
  const timestamp = Date.now().toString();
  const nonce = randomHex(16);
  const signingKey = cfg.secretKey ?? cfg.accessCode;
  const signature = createHmac("sha256", signingKey)
    .update(`${timestamp}${nonce}${body}`)
    .digest("hex");

  return {
    "Content-Type": "application/json",
    Accept: "application/json",
    "RT-AccessCode": cfg.accessCode,
    "RT-Timestamp": timestamp,
    "RT-Nonce": nonce,
    "RT-Signature": signature,
  };
}

function randomHex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

const limiter = new RateLimiter({ maxPerSecond: REQ_PER_SECOND, name: "esimaccess" });

/** Minimal fetch contract so tests can inject a stub. */
export type FetchLike = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{
  ok: boolean;
  status: number;
  text: () => Promise<string>;
}>;

interface RequestOptions {
  retry?: RetryOptions;
  signal?: AbortSignal;
  /** Test seam: inject a fetch stub. Defaults to the global fetch. */
  fetchImpl?: FetchLike;
}

interface Envelope<T> {
  success?: boolean;
  errorCode?: string;
  errorMsg?: string;
  obj?: T;
}

async function request<T = unknown>(
  endpoint: string,
  body: Record<string, unknown> | undefined,
  options: RequestOptions = {},
): Promise<T> {
  const cfg = readConfig();
  if (!cfg.configured) throw new EsimAccessNotConfiguredError(endpoint);

  const json = body ? JSON.stringify(body) : "{}";
  const doFetch: FetchLike =
    options.fetchImpl ??
    ((input, init) =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis.fetch as any)(input, init) as ReturnType<FetchLike>);

  const run = async (): Promise<T> => {
    const headers = signHeaders(json, cfg);
    const res = await doFetch(`${cfg.baseUrl}${endpoint}`, {
      method: "POST",
      headers,
      body: json,
      signal: options.signal,
    });

    const text = await res.text();
    let parsed: unknown = undefined;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = undefined;
      }
    }

    if (!res.ok) {
      const code = extractErrorCode(parsed);
      throw new EsimAccessError(endpoint, `HTTP ${res.status}: ${truncate(text, 300)}`, {
        status: res.status,
        errorCode: code,
        retryable: res.status >= 500 || res.status === 429 || res.status === 408,
      });
    }

    if (parsed && typeof parsed === "object") {
      const envelope = parsed as Envelope<unknown>;
      if (envelope.success === false) {
        throw new EsimAccessError(
          endpoint,
          `Supplier error ${envelope.errorCode ?? "UNKNOWN"}: ${envelope.errorMsg ?? "no message"}`,
          { errorCode: envelope.errorCode, retryable: false },
        );
      }
    }

    return parsed as T;
  };

  return limiter.run(() => retryWithBackoff(run, options.retry ?? {}));
}

function extractErrorCode(parsed: unknown): string | undefined {
  if (parsed && typeof parsed === "object") {
    const p = parsed as { errorCode?: unknown };
    if (typeof p.errorCode === "string") return p.errorCode;
  }
  return undefined;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}

// ---------------------------------------------------------------------------
// Normalisers
// ---------------------------------------------------------------------------

function toNumberOrNull(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function normalisePackage(raw: Record<string, unknown>): SupplierPackage {
  const price = toNumberOrNull(raw.price) ?? 0;
  const volume = toNumberOrNull(raw.volume);
  const duration = toNumberOrNull(raw.duration);
  const supportTopUpType = toNumberOrNull(raw.supportTopUpType);
  const isDailyPlan = Boolean(raw.isDailyPlan) || raw.packageType === "DAILY";
  const locationCodes = Array.isArray(raw.locationCodes)
    ? (raw.locationCodes.filter((x) => typeof x === "string") as string[])
    : undefined;
  return {
    packageCode: String(raw.packageCode ?? ""),
    packageName: String(raw.packageName ?? ""),
    packageType: String(raw.packageType ?? "PACKAGE"),
    currencyCode: asString(raw.currencyCode),
    price,
    priceUsd: price / 10000,
    volume: volume ?? null,
    duration: duration ?? null,
    description: asString(raw.description),
    locationCodes,
    smsStatus: toNumberOrNull(raw.smsStatus),
    supportTopUpType: supportTopUpType ?? undefined,
    isDailyPlan,
    raw,
  };
}

function normaliseEsim(raw: Record<string, unknown>): SupplierEsim {
  return {
    iccid: asString(raw.iccid),
    imsi: asString(raw.imsi),
    esimTranNo: asString(raw.esimTranNo) ?? asString(raw.transNo),
    lpaCode: asString(raw.ac) ?? asString(raw.lpaCode) ?? asString(raw.manualCode),
    qrCodeUrl: asString(raw.qrCodeUrl) ?? asString(raw.qrCode),
    smdpStatus: asString(raw.smdpStatus) ?? asString(raw.esimStatus),
    eid: asString(raw.eid),
    expiredTime: raw.expiredTime == null ? null : String(raw.expiredTime),
    msisdn: asString(raw.msisdn),
    raw,
  };
}

function normaliseUsage(raw: Record<string, unknown>): UsageEntry {
  const esimTranNo = String(raw.esimTranNo ?? raw.transNo ?? "") || "";
  const totalVolume =
    toNumberOrNull(raw.totalVolume) ?? toNumberOrNull(raw.orderUsage);
  const usedVolume = toNumberOrNull(raw.usedVolume) ?? toNumberOrNull(raw.price) ?? null;
  return {
    esimTranNo,
    iccid: asString(raw.iccid),
    totalVolume: totalVolume ?? null,
    usedVolume: usedVolume ?? null,
    lastUpdateTime: asString(raw.lastUpdateTime) ?? asString(raw.updateTime),
    raw,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export const esimAccess = {
  get isConfigured(): boolean {
    return readConfig().configured;
  },

  // ---- /package/list ----
  async listPackages(
    params: ListPackagesParams = {},
    options: RequestOptions = {},
  ): Promise<SupplierPackage[]> {
    const body: Record<string, unknown> = { type: params.type ?? "PACKAGE" };
    if (params.iccid) body.iccid = params.iccid;
    if (params.location) body.location = params.location;
    if (params.slug) body.slug = params.slug;

    const data = await request<Envelope<{ list?: unknown[] } | unknown[]>>(
      "/package/list",
      body,
      options,
    );
    const obj = data?.obj;
    const list = Array.isArray(obj)
      ? (obj as unknown[])
      : Array.isArray((obj as { list?: unknown[] })?.list)
        ? ((obj as { list: unknown[] }).list)
        : [];

    return list
      .filter((row): row is Record<string, unknown> => !!row && typeof row === "object")
      .map(normalisePackage);
  },

  // ---- /esim/order ----
  async order(
    input: OrderPackageInput,
    options: RequestOptions = {},
  ): Promise<SupplierOrderState> {
    const body: Record<string, unknown> = {
      transactionId: input.transactionId,
      amount: input.count,
      packageInfoList: [
        {
          packageCode: input.packageCode,
          count: input.count,
        },
      ],
    };
    if (input.referralCode) body.referralCode = input.referralCode;

    const data = await request<Envelope<Record<string, unknown>>>("/esim/order", body, options);
    const obj = (data.obj ?? {}) as Record<string, unknown>;
    const esimsRaw = Array.isArray(obj.esimList)
      ? (obj.esimList as unknown[])
      : Array.isArray(obj.list)
        ? (obj.list as unknown[])
        : [];
    return {
      orderNo: asString(obj.orderNo) ?? asString(obj.orderNumber),
      transactionId: asString(obj.transactionId) ?? input.transactionId,
      status: String(obj.orderStatus ?? obj.status ?? "UNKNOWN"),
      esims: esimsRaw
        .filter((row): row is Record<string, unknown> => !!row && typeof row === "object")
        .map(normaliseEsim),
      raw: obj,
    };
  },

  // ---- /esim/query ----
  async queryOrder(
    input: { orderNo?: string; iccid?: string; esimTranNo?: string; transactionId?: string },
    options: RequestOptions = {},
  ): Promise<SupplierOrderState> {
    const body: Record<string, unknown> = {};
    if (input.orderNo) body.orderNo = input.orderNo;
    if (input.iccid) body.iccid = input.iccid;
    if (input.esimTranNo) body.esimTranNo = input.esimTranNo;
    if (input.transactionId) body.transactionId = input.transactionId;

    const data = await request<Envelope<Record<string, unknown>>>("/esim/query", body, options);
    const obj = (data.obj ?? {}) as Record<string, unknown>;
    const esimsRaw = Array.isArray(obj.esimList)
      ? (obj.esimList as unknown[])
      : Array.isArray(obj.list)
        ? (obj.list as unknown[])
        : Array.isArray(obj.esims)
          ? (obj.esims as unknown[])
          : [];
    return {
      orderNo: asString(obj.orderNo),
      transactionId: asString(obj.transactionId),
      status: String(obj.orderStatus ?? obj.status ?? "UNKNOWN"),
      esims: esimsRaw
        .filter((row): row is Record<string, unknown> => !!row && typeof row === "object")
        .map(normaliseEsim),
      raw: obj,
    };
  },

  // ---- /esim/usage/query ----
  async queryUsage(
    esimTranNos: string[],
    options: RequestOptions = {},
  ): Promise<UsageEntry[]> {
    if (esimTranNos.length === 0) return [];
    const results: UsageEntry[] = [];
    for (let i = 0; i < esimTranNos.length; i += MAX_USAGE_BATCH) {
      const chunk = esimTranNos.slice(i, i + MAX_USAGE_BATCH);
      const data = await request<Envelope<unknown>>(
        "/esim/usage/query",
        { esimTranNoList: chunk },
        options,
      );
      const obj = data.obj;
      const list = Array.isArray(obj)
        ? (obj as unknown[])
        : Array.isArray((obj as { list?: unknown[] })?.list)
          ? (obj as { list: unknown[] }).list
          : [];
      for (const row of list) {
        if (row && typeof row === "object") {
          results.push(normaliseUsage(row as Record<string, unknown>));
        }
      }
    }
    return results;
  },

  // ---- /esim/topup ----
  async topup(input: TopupInput, options: RequestOptions = {}): Promise<TopupResult> {
    const data = await request<Envelope<Record<string, unknown>>>(
      "/esim/topup",
      {
        esimTranNo: input.esimTranNo,
        packageCode: input.packageCode,
        transactionId: input.transactionId,
      },
      options,
    );
    const obj = (data.obj ?? {}) as Record<string, unknown>;
    return {
      transactionId: asString(obj.transactionId) ?? input.transactionId,
      status: String(obj.orderStatus ?? obj.status ?? "UNKNOWN"),
      raw: obj,
    };
  },

  // ---- /esim/cancel ----
  async cancel(opts: CancelOptions, options: RequestOptions = {}): Promise<CancelResult> {
    const data = await request<Envelope<Record<string, unknown>>>(
      "/esim/cancel",
      { esimTranNo: opts.esimTranNo },
      options,
    );
    const obj = (data.obj ?? {}) as Record<string, unknown>;
    return { status: String(obj.status ?? "UNKNOWN"), raw: obj };
  },

  // ---- /balance/query ----
  async balance(options: RequestOptions = {}): Promise<BalanceResult> {
    const data = await request<Envelope<Record<string, unknown>>>(
      "/balance/query",
      {},
      options,
    );
    const obj = (data.obj ?? {}) as Record<string, unknown>;
    const units = toNumberOrNull(obj.balance) ?? toNumberOrNull(obj.amount) ?? 0;
    return { balanceUnits: units, balanceUsd: units / 10000, raw: obj };
  },

  // ---- /webhook/save ----
  async saveWebhook(
    input: RegisterWebhookInput,
    options: RequestOptions = {},
  ): Promise<{ ok: boolean; raw: unknown }> {
    const body: Record<string, unknown> = { webhookUrl: input.url };
    if (input.notifyTypes && input.notifyTypes.length > 0) {
      body.notifyTypeList = input.notifyTypes;
    }
    const data = await request<Envelope<unknown>>("/webhook/save", body, options);
    return { ok: data?.success !== false, raw: data?.obj };
  },
};

export type EsimAccessClient = typeof esimAccess;

export const __test__ = {
  MAX_USAGE_BATCH,
  REQ_PER_SECOND,
  readConfig,
  signHeaders,
  normalisePackage,
  normaliseEsim,
  normaliseUsage,
};

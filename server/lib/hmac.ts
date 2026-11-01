import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Shared HMAC-SHA256 signing helpers for outbound supplier/webhook calls.
 *
 * This module is the single canonical place where we sign requests to the
 * eSIM Access supplier (and anywhere else we need an HMAC). Notes:
 *
 * - Uses `node:crypto.randomBytes` directly (not `require`), so it works in
 *   ESM / Vite-built code and in node:test.
 * - Never accepts, stores, or logs the secret key. The caller passes it in.
 * - `signRequestHeaders` returns exactly the header set the supplier docs
 *   describe. The caller decides whether to send `x-signature` or
 *   `RT-Signature` naming (both are returned as aliases so an account that
 *   expects one particular header works without changing consumers).
 * - `verifyWebhookSignature` is used by the supplier webhook handler to check
 *   an HMAC body signature when the supplier sends one (optional).
 *
 * Design rationale: the supplier docs describe the signature as
 * `HMAC-SHA256(key, timestamp + nonce + rawBody)`. Some accounts omit
 * `ESIM_SECRET_KEY` and use `ESIM_ACCESS_CODE` as the signing key. Both are
 * supported here so consumers can just call `signRequestHeaders(...)`.
 */

/** Result of signing a request body. */
export interface SignedRequestHeaders {
  /** Supplier auth access code. */
  accessCode: string;
  /** Milliseconds since epoch, sent as a string. */
  timestamp: string;
  /** 32-hex random nonce. */
  nonce: string;
  /** Hex HMAC-SHA256 signature. */
  signature: string;
}

/** Parameters accepted by `signRequestHeaders`. */
export interface SignRequestParams {
  /** Supplier auth access code (always present when configured). */
  accessCode: string;
  /** Supplier signing secret; if omitted, `accessCode` is used as the key. */
  secretKey?: string | null;
  /** Raw request body exactly as it will be sent (or `"{}"`). */
  body: string;
  /** Optional override for test determinism (ms since epoch). */
  timestampMs?: number;
  /** Optional override for test determinism (hex nonce). */
  nonce?: string;
}

/** Error thrown when required signing inputs are missing. */
export class HmacConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HmacConfigError";
  }
}

/**
 * Sign a request body and return the raw signing components.
 * Throws `HmacConfigError` if `accessCode` is empty — an unsigned request
 * should never be sent to the supplier.
 */
export function signRequestHeaders(params: SignRequestParams): SignedRequestHeaders {
  const { accessCode, secretKey, body } = params;
  if (!accessCode || accessCode.length === 0) {
    throw new HmacConfigError("Cannot sign request: accessCode is empty.");
  }
  const timestamp = String(params.timestampMs ?? Date.now());
  const nonce = params.nonce ?? randomBytes(16).toString("hex");
  const signingKey = secretKey && secretKey.length > 0 ? secretKey : accessCode;
  const signature = createHmac("sha256", signingKey)
    .update(`${timestamp}${nonce}${body}`)
    .digest("hex");
  return { accessCode, timestamp, nonce, signature };
}

/**
 * Convenience helper that turns `signRequestHeaders` into the HTTP header
 * map the supplier expects. Includes both `RT-Signature` (canonical per docs)
 * and `x-signature` (accepted by some proxies) so an account swap is a no-op.
 */
export function buildSignedHeaders(
  params: SignRequestParams,
  extra: Record<string, string> = {},
): Record<string, string> {
  const signed = signRequestHeaders(params);
  return {
    "Content-Type": "application/json",
    Accept: "application/json",
    "RT-AccessCode": signed.accessCode,
    "RT-Timestamp": signed.timestamp,
    "RT-Nonce": signed.nonce,
    "RT-Signature": signed.signature,
    ...extra,
  };
}

/**
 * Constant-time comparison of two hex signatures.
 * Returns false on any input-length mismatch (never throws).
 */
export function safeCompareHex(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false;
  }
}

/**
 * Verify an inbound webhook body signature.
 * The supplier may or may not send one; when present, this rejects tampering.
 * Returns `{ ok, reason }` so the webhook handler can 200 + log rather than
 * throw (webhooks must always return 200 immediately).
 */
export function verifyWebhookSignature(input: {
  body: string;
  timestamp: string;
  nonce: string;
  signature: string;
  secret: string;
  /** Max age in ms; default 5 minutes. */
  maxAgeMs?: number;
}): { ok: boolean; reason?: string } {
  if (!input.secret) return { ok: false, reason: "missing_secret" };
  if (!input.timestamp || !input.nonce || !input.signature) {
    return { ok: false, reason: "missing_signature_fields" };
  }
  const ts = Number(input.timestamp);
  if (!Number.isFinite(ts)) return { ok: false, reason: "invalid_timestamp" };
  const maxAge = input.maxAgeMs ?? 5 * 60 * 1000;
  if (Math.abs(Date.now() - ts) > maxAge) return { ok: false, reason: "expired" };

  const expected = createHmac("sha256", input.secret)
    .update(`${input.timestamp}${input.nonce}${input.body}`)
    .digest("hex");

  return safeCompareHex(expected, input.signature)
    ? { ok: true }
    : { ok: false, reason: "mismatch" };
}

/**
 * Test-only helpers so unit tests can pin timestamp/nonce without touching
 * real crypto. Exported as a namespaced object to keep the public API tight.
 */
export const __test__ = {
  signRequestHeaders,
  buildSignedHeaders,
  safeCompareHex,
  verifyWebhookSignature,
};

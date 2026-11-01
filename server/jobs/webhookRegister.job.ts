/**
 * Webhook registration job.
 *
 * The supplier must know our webhook URL. `/webhook/save` is idempotent on the
 * supplier side (it replaces the registered URL for the account), so calling it
 * on boot and on a slow interval is safe. This job:
 *
 *  1. Resolves the public base URL from Secrets (`PUBLIC_BASE_URL`). If it is
 *     missing we do NOT invent a URL — we log `skipped: no_public_base_url` and
 *     leave the previously-registered URL untouched.
 *  2. Calls `esimAccess.saveWebhook` via the shared client (rate-limited,
 *     HMAC-signed). The client throws `EsimAccessNotConfiguredError` when
 *     credentials are absent; we treat that as `skipped`, not an error.
 *  3. Records the outcome in a module-level `lastRegistration` so the admin
 *     dashboard can show "webhook registered at <time>" without another call.
 *
 * Scheduling follows the same pattern as `packageSync.job.ts`:
 *  - `startWebhookRegistration({ runImmediately })` starts a `.unref()`d
 *    interval (default 24h).
 *  - `runWebhookRegistrationOnce()` is the single-shot version used by tests and
 *    by the admin "register now" button.
 *  - Importing the module has no side effects (no timer, no network).
 */
import { esimAccess, EsimAccessError } from "../esimaccess";
import { loadEnv } from "../config/env";
import { brand } from "../brand.config";

/** Supplier notifyTypes we subscribe to. Mirrors the route's constant. */
export const SUBSCRIBED_NOTIFY_TYPES = [
  "ORDER_STATUS",
  "ESIM_STATUS",
  "DATA_USAGE",
  "VALIDITY_USAGE",
] as const;

/** Path our webhook router is mounted at (see server/app.ts). */
export const WEBHOOK_PATH = "/api/webhooks/esimaccess";

/** 24 hours — the supplier URL rarely changes, this just re-asserts it. */
export const WEBHOOK_REGISTER_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface WebhookRegistrationRecord {
  startedAt: Date;
  finishedAt: Date | null;
  outcome:
    | "registered"
    | "skipped_no_base_url"
    | "skipped_not_configured"
    | "failed";
  /** Absolute URL we tried to register (null when we had no base). */
  url: string | null;
  /** Supplier error text or the skip reason. Never contains secrets. */
  detail: string | null;
}

export interface WebhookRegisterOptions {
  /** Override interval (tests use a tiny value). Defaults to 24h. */
  intervalMs?: number;
  /**
   * Resolve the base URL to register against. Defaults to reading
   * `PUBLIC_BASE_URL` from the loaded env and appending WEBHOOK_PATH.
   * Tests inject a fixed URL to avoid touching env.
   */
  resolveWebhookUrl?: () => string | null;
  /** Inject the supplier call. Defaults to `esimAccess.saveWebhook`. */
  saveWebhook?: (input: {
    url: string;
    notifyTypes: string[];
  }) => Promise<{ ok: boolean; raw?: unknown }>;
  log?: (msg: string) => void;
  onRun?: (record: WebhookRegistrationRecord) => void;
}

let timer: NodeJS.Timeout | null = null;
let running = false;
let lastRegistration: WebhookRegistrationRecord | null = null;

/** Read the last registration attempt (observability; never throws). */
export function getLastWebhookRegistration(): WebhookRegistrationRecord | null {
  return lastRegistration;
}

/**
 * Resolve the fully-qualified webhook URL to register. Returns null when no
 * public base URL is configured — we never register a localhost/relative URL.
 */
export function resolveWebhookUrlFromEnv(): string | null {
  const env = loadEnv();
  const raw = env.raw as unknown as Record<string, string | undefined>;
  const base = (raw.PUBLIC_BASE_URL ?? "").trim().replace(/\/+$/, "");
  if (!base) return null;
  // Basic sanity: must look like an absolute http(s) URL. We do NOT silently
  // upgrade http→https because some staging setups are plain http.
  if (!/^https?:\/\//i.test(base)) return null;
  return `${base}${WEBHOOK_PATH}`;
}

/**
 * Run a single registration attempt. Never throws — the scheduler and admin
 * button rely on the returned record. Missing config is a `skipped` outcome,
 * not an error.
 */
export async function runWebhookRegistrationOnce(
  options: WebhookRegisterOptions = {},
): Promise<WebhookRegistrationRecord> {
  const log = options.log ?? ((m: string) => console.log(m));

  if (running) {
    log("[webhookRegister] previous run still in flight; skipping");
    const record: WebhookRegistrationRecord = {
      startedAt: new Date(),
      finishedAt: new Date(),
      outcome: "skipped_not_configured",
      url: null,
      detail: "previous run still in flight",
    };
    options.onRun?.(record);
    return record;
  }
  running = true;
  const startedAt = new Date();
  let record: WebhookRegistrationRecord;

  try {
    const resolveUrl = options.resolveWebhookUrl ?? resolveWebhookUrlFromEnv;
    const url = resolveUrl();
    if (!url) {
      record = {
        startedAt,
        finishedAt: new Date(),
        outcome: "skipped_no_base_url",
        url: null,
        detail: "PUBLIC_BASE_URL is not set; webhook URL not registered.",
      };
      log(`[webhookRegister] ${record.detail}`);
      lastRegistration = record;
      options.onRun?.(record);
      return record;
    }

    if (!esimAccess.isConfigured) {
      record = {
        startedAt,
        finishedAt: new Date(),
        outcome: "skipped_not_configured",
        url,
        detail: "ESIM_ACCESS_CODE not configured.",
      };
      log(`[webhookRegister] ${record.detail}`);
      lastRegistration = record;
      options.onRun?.(record);
      return record;
    }

    const save =
      options.saveWebhook ??
      ((input) => esimAccess.saveWebhook(input));

    const result = await save({ url, notifyTypes: [...SUBSCRIBED_NOTIFY_TYPES] });
    if (!result.ok) {
      record = {
        startedAt,
        finishedAt: new Date(),
        outcome: "failed",
        url,
        detail: "supplier rejected webhook URL",
      };
      log(`[webhookRegister] ${record.detail} url=${url}`);
      lastRegistration = record;
      options.onRun?.(record);
      return record;
    }

    record = {
      startedAt,
      finishedAt: new Date(),
      outcome: "registered",
      url,
      detail: null,
    };
    log(`[webhookRegister] registered ${url} for ${SUBSCRIBED_NOTIFY_TYPES.length} notifyTypes`);
    lastRegistration = record;
    options.onRun?.(record);
    return record;
  } catch (err) {
    // EsimAccessError on a transient failure is retried by the next interval;
    // we surface the message without leaking secrets.
    const detail =
      err instanceof EsimAccessError
        ? `supplier error: ${err.errorCode ?? err.message}`
        : err instanceof Error
          ? err.message
          : String(err);
    record = {
      startedAt,
      finishedAt: new Date(),
      outcome: "failed",
      url: lastRegistration?.url ?? null,
      detail,
    };
    log(`[webhookRegister] failed: ${detail}`);
    lastRegistration = record;
    options.onRun?.(record);
    return record;
  } finally {
    running = false;
  }
}

/**
 * Start the registration scheduler. Idempotent; does not run immediately unless
 * `runImmediately` is set. The interval is `.unref()`d so tests never hang.
 */
export function startWebhookRegistration(
  options: WebhookRegisterOptions & { runImmediately?: boolean } = {},
): void {
  const interval = Math.max(60_000, options.intervalMs ?? WEBHOOK_REGISTER_INTERVAL_MS);
  const log = options.log ?? ((m: string) => console.log(m));

  if (timer) {
    log("[webhookRegister] already started; ignoring duplicate start");
    return;
  }
  timer = setInterval(() => {
    void runWebhookRegistrationOnce(options);
  }, interval);
  timer.unref?.();
  log(`[webhookRegister] scheduled every ${interval}ms`);

  if (options.runImmediately) {
    void runWebhookRegistrationOnce(options);
  }
}

/** Stop the scheduler. Safe to call when not started. */
export function stopWebhookRegistration(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

/**
 * Compose the admin-facing summary: the last attempt plus the brand's currently
 * configured base URL (which may be null). No network; no fabrication — a null
 * base URL is reported as such so the admin UI can prompt for setup.
 */
export function describeRegistration(): {
  url: string | null;
  lastRunAt: Date | null;
  outcome: WebhookRegistrationRecord["outcome"] | "never";
  brandName: string;
} {
  return {
    url: lastRegistration?.url ?? resolveWebhookUrlFromEnv(),
    lastRunAt: lastRegistration?.finishedAt ?? null,
    outcome: lastRegistration?.outcome ?? "never",
    brandName: brand.name,
  };
}

/** Test helper — reset module state so multiple tests are isolated. */
export function __resetWebhookRegisterStateForTests(): void {
  stopWebhookRegistration();
  running = false;
  lastRegistration = null;
}

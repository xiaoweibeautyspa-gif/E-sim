import { z } from "zod";

/**
 * Central environment validation.
 *
 * Rules:
 * - All secrets come from Replit Secrets (process.env) and are only ever read
 *   on the server. Nothing here is forwarded to the client bundle.
 * - PORT is required by the platform; we fall back to 3000 only for local dev.
 * - Optional secrets are *validated structurally* but do not throw when absent
 *   so the server can boot before every integration is provisioned. Whether
 *   a feature is "enabled" is derived in `featureFlags` below.
 */

const optionalString = z
  .string()
  .trim()
  .min(1)
  .optional()
  .transform((v) => (v === "" ? undefined : v));

const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),

  // Replit sets PORT. Fallback is for local dev only.
  PORT: z
    .string()
    .optional()
    .transform((v) => {
      const n = Number(v ?? 3000);
      return Number.isFinite(n) && n > 0 ? n : 3000;
    }),

  // Bind to 0.0.0.0 on Replit; localhost fallback handled by caller default.
  HOST: z.string().default("0.0.0.0"),

  // Public base URL used for absolute links (emails, webhooks, OG images).
  PUBLIC_BASE_URL: z
    .string()
    .url()
    .optional()
    .transform((v) => (v ?? "").replace(/\/+$/, "")),

  // Postgres (Replit provides DATABASE_URL).
  DATABASE_URL: optionalString,

  // --- eSIM Access (supplier) ---
  ESIM_ACCESS_BASE_URL: z
    .string()
    .url()
    .default("https://api.esimaccess.com/api/v1/open"),
  ESIM_ACCESS_CODE: optionalString,
  ESIM_SECRET_KEY: optionalString,

  // --- Stripe ---
  STRIPE_SECRET_KEY: optionalString,
  STRIPE_WEBHOOK_SECRET: optionalString,

  // --- AI ---
  AI_API_KEY: optionalString,
  AI_BASE_URL: z.string().url().default("https://api.openai.com/v1"),
  AI_MODEL: z.string().default("gpt-4o-mini"),

  // --- Flight lookup (AeroDataBox or compatible) ---
  FLIGHT_API_KEY: optionalString,
  FLIGHT_API_BASE_URL: z
    .string()
    .url()
    .default("https://aerodatabox.p.rapidapi.com"),

  // --- WhatsApp Business API ---
  WHATSAPP_TOKEN: optionalString,
  WHATSAPP_PHONE_NUMBER_ID: optionalString,
  WHATSAPP_VERIFY_TOKEN: optionalString,

  // --- Google OAuth ---
  GOOGLE_CLIENT_ID: optionalString,
  GOOGLE_CLIENT_SECRET: optionalString,

  // --- Push (Web Push VAPID) ---
  VAPID_PUBLIC_KEY: optionalString,
  VAPID_PRIVATE_KEY: optionalString,
  VAPID_SUBJECT: z.string().default("mailto:support@example.com"),

  // --- Email (provider-agnostic) ---
  EMAIL_PROVIDER: z.enum(["console", "smtp", "resend"]).default("console"),
  EMAIL_FROM: z.string().default("no-reply@example.com"),
  SMTP_URL: optionalString,
  RESEND_API_KEY: optionalString,

  // --- Session ---
  SESSION_SECRET: optionalString,

  // --- Owner/admin ---
  ADMIN_EMAIL: optionalString,
});

export type RawEnv = z.infer<typeof envSchema>;

export interface FeatureFlags {
  database: boolean;
  esimAccess: boolean;
  stripe: boolean;
  ai: boolean;
  flightLookup: boolean;
  whatsapp: boolean;
  googleOAuth: boolean;
  push: boolean;
  email: boolean;
}

export interface AppEnv {
  raw: RawEnv;
  isProduction: boolean;
  port: number;
  host: string;
  publicBaseUrl: string;
  featureFlags: FeatureFlags;
  /** Non-fatal problems detected during validation (e.g. missing optional secrets). */
  warnings: string[];
}

function buildFeatureFlags(raw: RawEnv): FeatureFlags {
  const has = (v: string | undefined) => typeof v === "string" && v.length > 0;
  return {
    database: has(raw.DATABASE_URL),
    esimAccess: has(raw.ESIM_ACCESS_CODE),
    stripe: has(raw.STRIPE_SECRET_KEY),
    ai: has(raw.AI_API_KEY),
    flightLookup: has(raw.FLIGHT_API_KEY),
    whatsapp: has(raw.WHATSAPP_TOKEN) && has(raw.WHATSAPP_PHONE_NUMBER_ID),
    googleOAuth: has(raw.GOOGLE_CLIENT_ID) && has(raw.GOOGLE_CLIENT_SECRET),
    push: has(raw.VAPID_PUBLIC_KEY) && has(raw.VAPID_PRIVATE_KEY),
    email:
      raw.EMAIL_PROVIDER === "console" ||
      (raw.EMAIL_PROVIDER === "smtp" && has(raw.SMTP_URL)) ||
      (raw.EMAIL_PROVIDER === "resend" && has(raw.RESEND_API_KEY)),
  };
}

function collectWarnings(raw: RawEnv, flags: FeatureFlags): string[] {
  const warnings: string[] = [];
  if (!raw.DATABASE_URL) warnings.push("DATABASE_URL is not set — DB features disabled.");
  if (!flags.esimAccess) warnings.push("ESIM_ACCESS_CODE is not set — supplier calls disabled.");
  if (!flags.stripe) warnings.push("STRIPE_SECRET_KEY is not set — checkout disabled.");
  if (!raw.STRIPE_WEBHOOK_SECRET)
    warnings.push("STRIPE_WEBHOOK_SECRET is not set — payment webhooks will be rejected.");
  if (!flags.ai) warnings.push("AI_API_KEY is not set — AI helpers disabled.");
  if (!flags.push) warnings.push("VAPID keys are not set — push notifications disabled.");
  if (!raw.PUBLIC_BASE_URL)
    warnings.push("PUBLIC_BASE_URL is not set — absolute links may be relative.");
  if (raw.NODE_ENV === "production" && !raw.SESSION_SECRET)
    warnings.push("SESSION_SECRET is not set in production — sessions will be unstable.");
  return warnings;
}

let cached: AppEnv | null = null;

/** Parse and validate process.env. Throws on structurally invalid required values. */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): AppEnv {
  if (cached) return cached;

  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid environment configuration: ${details}`);
  }

  const raw = parsed.data;
  const featureFlags = buildFeatureFlags(raw);
  const warnings = collectWarnings(raw, featureFlags);

  cached = {
    raw,
    isProduction: raw.NODE_ENV === "production",
    port: raw.PORT,
    // Explicit default on the app side. index.ts binds to this.
    host: raw.HOST || "0.0.0.0",
    publicBaseUrl: raw.PUBLIC_BASE_URL || "",
    featureFlags,
    warnings,
  };
  return cached;
}

/** Test-only helper: clear memoized env so tests can re-load with different sources. */
export function resetEnvCache(): void {
  cached = null;
}

export const env: AppEnv = loadEnv();

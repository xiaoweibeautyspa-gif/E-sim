/**
 * Single source of truth for brand-level copy and constants.
 *
 * The user left the brand name as a placeholder. Everything user-facing that
 * needs a name/domain/contact should read from here so a rename is a one-file
 * change. Do not scatter brand strings in components or emails.
 */
export interface BrandConfig {
  /** Display name used in headings, emails, push titles. */
  name: string;
  /** Short marketing tagline. */
  tagline: string;
  /** Placeholder public domain; override at deploy time. */
  domain: string;
  /** Support email shown in emails and the chat widget escalation. */
  supportEmail: string;
  /** Support WhatsApp number in E.164 (used by AI chat escalation). */
  supportWhatsApp: string;
  /** Default OG image path served from /public. */
  ogImagePath: string;
  /** Locales supported by the storefront. Order matters for the switcher. */
  locales: readonly ["en", "zh", "vi"];
  /** Default currency + currencies accepted at checkout. */
  defaultCurrency: "SGD" | "USD" | "VND" | "CNY";
  currencies: readonly ("SGD" | "USD" | "VND" | "CNY")[];
  /** Money-back guarantee copy used on checkout + emails. */
  guaranteeCopy: string;
  /** PWA theme color. */
  themeColor: string;
  /** PWA background color. */
  backgroundColor: string;
}

export const brand: BrandConfig = {
  name: "Zipy eSIM",
  tagline: "Instant travel data. No roaming surprises.",
  domain: "example.com",
  supportEmail: "support@example.com",
  supportWhatsApp: "+6500000000",
  ogImagePath: "/og-default.png",
  locales: ["en", "zh", "vi"] as const,
  defaultCurrency: "SGD",
  currencies: ["SGD", "USD", "VND", "CNY"] as const,
  guaranteeCopy: "Full refund if the eSIM is never installed.",
  themeColor: "#0f172a",
  backgroundColor: "#ffffff",
};

export type SupportedLocale = (typeof brand.locales)[number];
export type SupportedCurrency = (typeof brand.currencies)[number];

/** Absolute (or relative when PUBLIC_BASE_URL is unset) URL for a path. */
export function absoluteUrl(path: string, publicBaseUrl: string): string {
  const clean = path.startsWith("/") ? path : `/${path}`;
  return publicBaseUrl ? `${publicBaseUrl}${clean}` : clean;
}

/** Replace `{brand}` tokens in email/UI templates with the configured name. */
export function withBrand(text: string): string {
  return text.replace(/\{brand\}/g, brand.name);
}

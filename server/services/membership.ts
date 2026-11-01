/**
 * Traveler Pass subscription (Phase 8, batch 0).
 *
 * RULES:
 *   - Yearly subscription (default $29, admin-configurable).
 *   - Members get a % off every plan (default 10%, admin-configurable).
 *   - Price + % are admin-set; read them from a `settings` adapter, not from
 *     constants, so admin edits take effect immediately.
 *   - Stripe handles the actual subscription lifecycle; this service models
 *     our side (status, current period, discount % as of "now").
 *
 * DESIGN
 * ------
 *   - Read-only side-effects here: no Stripe SDK. The future route
 *     creates the subscription via `stripeProvider.subscriptions.create` then
 *     records the result with `recordMembership`.
 *   - Discount % is resolved *per call* from the settings adapter so an admin
 *     % change applies to the next order; grandfathered pricing is a policy
 *     decision not requested in the spec.
 *   - No hardcoded prices. Defaults are functions so tests can assert on them
 *     without hardcoding "$29" in multiple places.
 */

export const MEMBERSHIP_DEFAULT_PRICE_MAJOR = 29;
export const MEMBERSHIP_DEFAULT_DISCOUNT_PCT = 10;

export const MEMBERSHIP_CURRENCY_DEFAULT = "SGD";

export type MembershipStatus = "active" | "past_due" | "canceled" | "incomplete" | "none";

export type MembershipErrorCode = "invalid_input" | "db_unavailable" | "settings_unavailable";

export class MembershipError extends Error {
  readonly code: MembershipErrorCode;
  constructor(code: MembershipErrorCode, message: string) {
    super(message);
    this.name = "MembershipError";
    this.code = code;
  }
}

/**
 * The pricing/discount config comes from an admin-managed settings table.
 * The adapter must return the CURRENT effective values (with defaults applied)
 * or throw if settings aren't loaded yet.
 */
export type MembershipSettings = {
  priceMajor: number;
  priceCurrency: string;
  discountPercent: number;
};

export type MembershipSettingsAdapter = {
  getMembershipSettings: () => Promise<MembershipSettings>;
};

/** Narrow DB contract for this service. Backed by 0014_growth.sql (queued). */
export type MembershipDb = {
  getMembershipByUser: (userId: number) => Promise<{
    userId: number;
    status: MembershipStatus;
    stripeSubscriptionId: string | null;
    currentPeriodEnd: Date | null;
    startedAt: Date | null;
    canceledAt: Date | null;
  } | null>;
};

export type MembershipDeps = {
  getDb: () => MembershipDb | null;
  settings: MembershipSettingsAdapter;
  now?: () => Date;
  log?: (msg: string) => void;
};

/** Resolve effective settings, applying defaults when the adapter returns null. */
export async function resolveMembershipSettings(
  adapter: MembershipSettingsAdapter,
): Promise<MembershipSettings> {
  let settings: MembershipSettings | null;
  try {
    settings = await adapter.getMembershipSettings();
  } catch (err) {
    throw new MembershipError(
      "settings_unavailable",
      `membership settings failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!settings) {
    return {
      priceMajor: MEMBERSHIP_DEFAULT_PRICE_MAJOR,
      priceCurrency: MEMBERSHIP_CURRENCY_DEFAULT,
      discountPercent: MEMBERSHIP_DEFAULT_DISCOUNT_PCT,
    };
  }
  if (!Number.isFinite(settings.priceMajor) || settings.priceMajor <= 0) {
    throw new MembershipError("settings_unavailable", "membership price must be positive");
  }
  if (!Number.isFinite(settings.discountPercent) || settings.discountPercent < 0 || settings.discountPercent > 100) {
    throw new MembershipError("settings_unavailable", "discountPercent must be within 0..100");
  }
  return settings;
}

export interface MembershipView {
  /** true only when status is active AND current period has not ended. */
  active: boolean;
  status: MembershipStatus;
  /** Discount percent that would apply to a plan purchase right now; 0 if not active. */
  discountPercent: number;
  /** ISO timestamp of the next renewal, if known. */
  renewsAt: string | null;
  /** Price the user would pay if they subscribed today (major units). */
  priceMajor: number;
  priceCurrency: string;
}

/**
 * Compute the effective discount % to apply to a plan given the buyer's
 * membership. Non-members get 0. Active members get the current admin-%.
 * This is the single function checkout uses; it never inspects Stripe directly.
 */
export function computeMemberDiscount(
  membership: { status: MembershipStatus; currentPeriodEnd: Date | null } | null,
  settings: MembershipSettings,
  now: Date,
): number {
  if (!membership) return 0;
  if (membership.status !== "active") return 0;
  if (membership.currentPeriodEnd && membership.currentPeriodEnd.getTime() <= now.getTime()) {
    return 0;
  }
  return settings.discountPercent;
}

/** Public-facing summary for the Traveler Pass page. */
export async function getMembershipView(
  userId: number,
  deps: MembershipDeps,
): Promise<MembershipView> {
  if (!Number.isInteger(userId) || userId <= 0) {
    throw new MembershipError("invalid_input", "userId must be a positive integer");
  }
  const settings = await resolveMembershipSettings(deps.settings);
  const db = deps.getDb();
  const now = deps.now ? deps.now() : new Date();
  if (!db) {
    // A visitor without a DB still sees the pass's price + advertised discount.
    // They can't be "active" because there's no account to check.
    return {
      active: false,
      status: "none",
      discountPercent: 0,
      renewsAt: null,
      priceMajor: settings.priceMajor,
      priceCurrency: settings.priceCurrency,
    };
  }
  const membership = await db.getMembershipByUser(userId);
  const active = computeMemberDiscount(membership, settings, now) > 0;
  return {
    active,
    status: membership?.status ?? "none",
    discountPercent: active ? settings.discountPercent : 0,
    renewsAt:
      active && membership?.currentPeriodEnd
        ? membership.currentPeriodEnd.toISOString()
        : null,
    // For a non-member, show what they'd pay if subscribing now.
    priceMajor: settings.priceMajor,
    priceCurrency: settings.priceCurrency,
  };
}

/** Convenience for checkout: fetch the discount % for a buyer. */
export async function memberDiscountForUser(
  userId: number,
  deps: MembershipDeps,
): Promise<{ discountPercent: number }> {
  const view = await getMembershipView(userId, deps);
  return { discountPercent: view.discountPercent };
}

export const __test__ = {
  resolveMembershipSettings,
  computeMemberDiscount,
  MEMBERSHIP_DEFAULT_PRICE_MAJOR,
  MEMBERSHIP_DEFAULT_DISCOUNT_PCT,
};

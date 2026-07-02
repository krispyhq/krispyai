// Krispy Cloud plan catalogue — the single source of truth for what the pricing
// on the landing page actually MEANS in code. Two plans:
//
//   free   — self-host, free forever, unmetered. (tenantId "self" or any row on
//            the free plan.) No provider, no billing.
//   cloud  — $19/mo flat (or $190/yr, ~2 months free). 14-day no-card trial on
//            signup. Generous usage caps, no per-seat.
//
// Prices/products live in Creem; we only reference their ids (via env) so this
// file never hardcodes money or a vendor id.

export type Plan = "free" | "cloud";
export type BillingInterval = "monthly" | "annual";

/** App-owned trial length. The trial is OUR no-card trial (not Creem's) — it's
 *  granted at Cloud signup and enforced by the entitlement gate, so a visitor
 *  starts with zero payment friction. Creem only enters when they subscribe. */
export const TRIAL_DAYS = 14;

export interface PlanLimits {
  /** Max AI replies per calendar month. Infinity = unmetered. */
  aiPerMonth: number;
  /** Max human-handoff messages per month. Infinity = unmetered. */
  handoffPerMonth: number;
}

export const UNLIMITED: PlanLimits = { aiPerMonth: Infinity, handoffPerMonth: Infinity };

// ponytail: Cloud caps are a tuning knob, not a law of physics. AI replies are
// the only real cost centre (each is an inference call); human handoffs are just
// message fan-out, so they stay unmetered. Raise `aiPerMonth` here the day the
// $19 unit economics say so — nothing downstream changes.
export const CLOUD_LIMITS: PlanLimits = { aiPerMonth: 5000, handoffPerMonth: Infinity };

export function limitsFor(plan: Plan): PlanLimits {
  return plan === "cloud" ? CLOUD_LIMITS : UNLIMITED;
}

/** Human-readable price, for status payloads / UIs. Kept in sync with the landing. */
export const CLOUD_PRICING = {
  monthly: { amountUsd: 19, interval: "monthly" as const },
  annual: { amountUsd: 190, interval: "annual" as const }, // 2 months free vs 12×$19
};

/**
 * Resolve the provider product id for a billing interval from env. Monthly is the
 * default everywhere; annual is optional. Throws only if the requested interval's
 * product id isn't configured — the caller surfaces that as a clean 400/409.
 */
export function productIdFor(
  interval: BillingInterval,
  env: Record<string, string | undefined>,
): string {
  const id = interval === "annual" ? env.CREEM_PRODUCT_ID_ANNUAL : env.CREEM_PRODUCT_ID_MONTHLY;
  if (!id) throw new Error(`No Creem product id configured for the ${interval} plan`);
  return id;
}

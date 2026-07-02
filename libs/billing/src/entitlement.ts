// Pure entitlement logic — no DB, no network, no provider. This is the brain the
// entitlement gate is built on: given a subscription's stored state, is the tenant
// allowed to use Cloud features right now?
//
// The DB stores an *absolute* status (the webhook SETS it), but the trial deadline
// is enforced LIVE here — a trialing row whose `trialEndsAt` has passed is simply
// not entitled, no cron job needed to "flip" it to expired.
import { type Plan, type PlanLimits, TRIAL_DAYS, limitsFor } from "./plans";

export type SubStatus = "trialing" | "active" | "past_due" | "canceled";

/** The minimal shape entitlement cares about (a subset of the DB row). */
export interface SubState {
  plan: Plan;
  status: SubStatus;
  trialEndsAt?: Date | null;
  currentPeriodEnd?: Date | null;
}

/** Trial deadline `TRIAL_DAYS` after `from` (defaults to now). */
export function trialEndsAt(from: Date = new Date()): Date {
  return new Date(from.getTime() + TRIAL_DAYS * 24 * 60 * 60 * 1000);
}

/**
 * The one check the whole system routes through. Self-host / free is always
 * entitled. For Cloud:
 *   - trialing  → entitled until `trialEndsAt`
 *   - active    → entitled (paid & current)
 *   - past_due  → grace: entitled until `currentPeriodEnd` (provider is dunning)
 *   - canceled  → entitled until `currentPeriodEnd` (keep the paid-for period)
 * Missing deadline on a state that needs one → not entitled (fail closed).
 */
export function entitled(sub: SubState, now: Date = new Date()): boolean {
  if (sub.plan === "free") return true;
  switch (sub.status) {
    case "active":
      return true;
    case "trialing":
      return sub.trialEndsAt != null && now < sub.trialEndsAt;
    case "past_due":
    case "canceled":
      return sub.currentPeriodEnd != null && now < sub.currentPeriodEnd;
    default:
      return false;
  }
}

/** Usage caps for this subscription's plan. */
export function limitsForSub(sub: Pick<SubState, "plan">): PlanLimits {
  return limitsFor(sub.plan);
}

/** True while usage is under the plan's caps (Infinity caps are never exceeded). */
export function withinLimits(usage: { ai: number; handoff: number }, limits: PlanLimits): boolean {
  return usage.ai < limits.aiPerMonth && usage.handoff < limits.handoffPerMonth;
}

/**
 * The compact snapshot pushed to the edge Worker's KV so its gate can decide
 * without touching Postgres (workerd can't run postgres-js). Everything the edge
 * needs, pre-computed here where the logic lives.
 */
export interface EntitlementSnapshot {
  plan: Plan;
  status: SubStatus;
  entitled: boolean;
  limits: PlanLimits;
  trialEndsAt: string | null;
  currentPeriodEnd: string | null;
  updatedAt: string;
}

export function toSnapshot(sub: SubState, now: Date = new Date()): EntitlementSnapshot {
  return {
    plan: sub.plan,
    status: sub.status,
    entitled: entitled(sub, now),
    limits: limitsForSub(sub),
    trialEndsAt: sub.trialEndsAt ? sub.trialEndsAt.toISOString() : null,
    currentPeriodEnd: sub.currentPeriodEnd ? sub.currentPeriodEnd.toISOString() : null,
    updatedAt: now.toISOString(),
  };
}

// Shapes returned by the dashboard's /api/* proxies (mirroring services/payment
// billing.ts and services/edge usage). `Infinity` caps serialize to null over JSON
// → treat a null/absent cap as unlimited.

export type Plan = "free" | "cloud";
export type SubStatus = "trialing" | "active" | "past_due" | "canceled" | "none";

export interface Limits {
  aiPerMonth: number | null;
  handoffPerMonth: number | null;
}

export interface BillingStatus {
  tenantId: string;
  plan: Plan;
  status: SubStatus;
  entitled: boolean;
  limits: Limits;
  trialEndsAt: string | null;
  currentPeriodEnd: string | null;
}

export interface UsageStatus {
  tenantId: string;
  usage: { ai: number; handoff: number };
  plan: Plan;
  entitled: boolean;
  status: SubStatus;
  limits: Limits;
  withinLimits: boolean;
}

export interface TenantConfigResponse {
  config: { botToken?: string; chatId?: string; systemPrompt?: string; model?: string } | null;
  pending?: boolean;
}

/** Whole days left until an ISO deadline (0 if past / missing). */
export function daysLeft(iso: string | null): number {
  if (!iso) return 0;
  const ms = new Date(iso).getTime() - Date.now();
  return ms <= 0 ? 0 : Math.ceil(ms / 86_400_000);
}

/** A cap of null / Infinity means unmetered. */
export function isUnlimited(cap: number | null): boolean {
  return cap == null || !Number.isFinite(cap);
}

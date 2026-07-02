// KV-backed state: tenant config, the topic<->session map, and usage metering.
// Key builders are pure (unit-tested); the KV calls are thin wrappers so the flow
// code never hand-rolls a key string.
import type { Env, TenantConfig } from "./types";

// ── key builders (pure) ──────────────────────────────────────────────────────
export const kThreadToSession = (t: string, threadId: number) => `thread:${t}:${threadId}`;
export const kSessionToThread = (t: string, sessionId: string) => `session:${t}:${sessionId}`;
export const kTenant = (t: string) => `tenant:${t}`;
/** Usage counter, bucketed by month so it doubles as a billing period. */
export const kUsage = (t: string, kind: UsageKind, yyyymm: string) =>
  `usage:${t}:${yyyymm}:${kind}`;

export type UsageKind = "ai" | "handoff";

export function monthKey(now = new Date()): string {
  return `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

// ── tenant config ────────────────────────────────────────────────────────────
// "self" (single-tenant self-host) is assembled from env secrets; any other
// tenant is a JSON blob in KV. Missing/incomplete config → null (Telegram off,
// chat still works — see chat flow's graceful degradation).
export async function getTenant(env: Env, tenantId: string): Promise<TenantConfig | null> {
  if (tenantId === "self") {
    if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return null;
    return {
      botToken: env.TELEGRAM_BOT_TOKEN,
      chatId: env.TELEGRAM_CHAT_ID,
      systemPrompt: env.SYSTEM_PROMPT,
      model: env.AI_MODEL,
    };
  }
  const raw = await env.KRISPY_KV.get(kTenant(tenantId));
  if (!raw) return null;
  const cfg = JSON.parse(raw) as Partial<TenantConfig>;
  return cfg.botToken && cfg.chatId ? (cfg as TenantConfig) : null;
}

// ── topic <-> session map ────────────────────────────────────────────────────
export async function getThreadForSession(
  env: Env,
  t: string,
  sessionId: string,
): Promise<number | null> {
  const v = await env.KRISPY_KV.get(kSessionToThread(t, sessionId));
  return v ? Number(v) : null;
}

export async function getSessionForThread(
  env: Env,
  t: string,
  threadId: number,
): Promise<string | null> {
  return env.KRISPY_KV.get(kThreadToSession(t, threadId));
}

export async function linkThreadSession(
  env: Env,
  t: string,
  threadId: number,
  sessionId: string,
): Promise<void> {
  await Promise.all([
    env.KRISPY_KV.put(kThreadToSession(t, threadId), sessionId),
    env.KRISPY_KV.put(kSessionToThread(t, sessionId), String(threadId)),
  ]);
}

// ── metering ─────────────────────────────────────────────────────────────────
export async function meter(env: Env, t: string, kind: UsageKind): Promise<void> {
  const key = kUsage(t, kind, monthKey());
  const cur = Number((await env.KRISPY_KV.get(key)) ?? 0);
  await env.KRISPY_KV.put(key, String(cur + 1));
}

export async function getUsage(env: Env, t: string): Promise<{ ai: number; handoff: number }> {
  const m = monthKey();
  const [ai, handoff] = await Promise.all([
    env.KRISPY_KV.get(kUsage(t, "ai", m)),
    env.KRISPY_KV.get(kUsage(t, "handoff", m)),
  ]);
  return { ai: Number(ai ?? 0), handoff: Number(handoff ?? 0) };
}

// ── plan gate (seam) ─────────────────────────────────────────────────────────
export interface Plan {
  aiPerMonth: number;
  handoffPerMonth: number;
}
// ponytail: one unlimited plan. Real tiers slot in here (lookup by tenant) the day
// there's billing; the gate call site already exists so nothing downstream changes.
export const PLANS: Record<string, Plan> = {
  self: { aiPerMonth: Infinity, handoffPerMonth: Infinity },
};

export function planFor(tenantId: string): Plan {
  return PLANS[tenantId] ?? { aiPerMonth: 1000, handoffPerMonth: 1000 };
}

export function withinPlan(usage: { ai: number; handoff: number }, plan: Plan): boolean {
  return usage.ai < plan.aiPerMonth && usage.handoff < plan.handoffPerMonth;
}

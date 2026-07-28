// Topic lifecycle — the Telegram group shows what is LIVE, not everything that ever
// happened. Every visitor gets a forum topic (ensureTopic); nothing used to ever close
// one, so after a few hundred conversations the operator can't tell what needs attention
// now from what was resolved last month.
//
// The rule: a topic idle longer than the tenant's window is CLOSED (not deleted — the
// history survives and the thread id keeps working), and a visitor who comes back
// reopens it. A conversation that was handed to a human and never marked /done gets a
// closing message on its way out, so an unanswered visitor leaves a record instead of
// vanishing quietly.
//
// OFF unless the tenant sets `topicIdleHours`. An existing self-host that upgrades and
// redeploys sees exactly today's behavior until it opts in.
//
// ── why a Cron Trigger and not a SessionDO alarm ──────────────────────────────
// SessionDO has alarms and uses them, which is the problem: ONE alarm slot per object,
// already held by the silence hand-back (session-do.ts). Idle-close would have to
// multiplex two deadlines through that slot — new failure modes in the load-bearing
// hand-back path, to buy per-session precision nobody needs at a 24h granularity.
// Decisive, though, is the migration: a DO with no request and no armed alarm never
// wakes, so alarms could only ever close topics for sessions created AFTER the deploy —
// and the backlog of already-idle topics is the entire complaint. A sweep reads state
// that is already in KV, so it sees every session ever created.
import type { Env, TenantConfig } from "./types";
import {
  doFetch,
  getTenant,
  getThreadState,
  listSessionThreads,
  listTenantIds,
  touchThread,
} from "./store";
import {
  closeForumTopic,
  isTopicRightsError,
  reopenForumTopic,
  sendToTopic,
  type FetchLike,
} from "./telegram";

/** Recommended window. Not a default — an unset `topicIdleHours` means OFF, so this is
 * the number the docs and the CLI suggest when a tenant turns the feature on. */
export const TOPIC_IDLE_HOURS_RECOMMENDED = 24;
/** Write-path clamp. A sub-hour window would close conversations a visitor is still in
 * (the sweep runs hourly); a year is the far end of "archive it eventually". */
export const TOPIC_IDLE_HOURS_MIN = 1;
export const TOPIC_IDLE_HOURS_MAX = 24 * 365;

/** Topics closed per tenant per sweep. Telegram rate-limits a bot to ~20 messages/minute
 * into one group and a Worker invocation has a subrequest budget (50 on the free plan),
 * so the sweep takes a bite rather than the whole backlog: 10 closes ≈ 30 subrequests.
 * ponytail: hourly cron × 10 clears a 500-topic backlog in ~2 days and then idles at a
 * handful per run. Raise the cron frequency before raising this — the API limit is the
 * binding constraint, not the budget. */
export const SWEEP_MAX_CLOSES = 10;

/** The tenant's idle window in ms, or null when the feature is off for them. */
export function idleWindowMs(cfg: Pick<TenantConfig, "topicIdleHours"> | null): number | null {
  const h = cfg?.topicIdleHours;
  if (typeof h !== "number" || !Number.isFinite(h) || h <= 0) return null;
  return Math.min(Math.max(h, TOPIC_IDLE_HOURS_MIN), TOPIC_IDLE_HOURS_MAX) * 3_600_000;
}

/** Copy posted into a topic that is being closed with the handoff never resolved. The
 * honest outcome: Krispy has no ticket system and cannot reach a visitor who has left,
 * so the record goes where the operator will see it — the topic, and the inbox. */
export function unresolvedClosingNote(hours: number): string {
  return (
    `⏳ No activity for ${hours}h — closing this topic to keep the group current.\n` +
    `⚠️ It was never marked /done, so the visitor may still be waiting. ` +
    `The conversation stays UNRESOLVED in the operator inbox, and this topic reopens ` +
    `by itself the moment the visitor writes again — nothing here is lost.`
  );
}

/** A session's handoff state, straight from its DO (the authoritative store). Read only
 * for sessions actually crossing the window, so the sweep costs one subrequest per
 * CLOSE, not per session. Unreachable DO → treat as resolved (close quietly): a failed
 * read must not put a scary "never answered" note into an ordinary topic. */
async function wasLeftUnanswered(env: Env, tenantId: string, sessionId: string): Promise<boolean> {
  try {
    const r = await doFetch(env, tenantId, sessionId, "https://do/summary");
    const s = (await r.json()) as { handedOff?: boolean; resolved?: boolean };
    return s.handedOff === true && s.resolved !== true;
  } catch (e) {
    console.warn("topic sweep: summary read failed, closing quietly:", e);
    return false;
  }
}

export interface SweepResult {
  /** Topics closed this run. */
  closed: number;
  /** Sessions whose age was unknown and got stamped instead of closed (migration). */
  stamped: number;
  /** Tenants skipped because the bot lacks can_manage_topics. */
  deniedTenants: number;
}

/**
 * Close every topic idle past its tenant's window. Called from the Worker's `scheduled`
 * handler; safe to call at any frequency (it is idempotent — a closed topic is marked
 * and skipped). `fetchImpl` is injectable so the sweep is testable without Telegram.
 */
export async function sweepTopics(env: Env, fetchImpl?: FetchLike): Promise<SweepResult> {
  const result: SweepResult = { closed: 0, stamped: 0, deniedTenants: 0 };
  for (const tenantId of await listTenantIds(env)) {
    // getTenant merges the KV blob over the env secrets, so this one read yields BOTH
    // the Telegram creds and topicIdleHours. Null = Telegram not configured → nothing
    // to close. Tenant-wide config lives on the default site's blob (same place
    // getOperators reads from) because conversations are keyed by tenantId alone.
    const tenant = await getTenant(env, tenantId);
    const windowMs = idleWindowMs(tenant);
    if (!tenant || windowMs === null) continue;
    const ok = await sweepTenant(env, tenantId, tenant, windowMs, result, fetchImpl);
    if (!ok) result.deniedTenants++;
  }
  return result;
}

/** One tenant's sweep. Returns false if the bot was denied topic rights (tenant skipped). */
async function sweepTenant(
  env: Env,
  tenantId: string,
  tenant: TenantConfig,
  windowMs: number,
  result: SweepResult,
  fetchImpl?: FetchLike,
): Promise<boolean> {
  const now = Date.now();
  const hours = Math.round(windowMs / 3_600_000);
  let cursor: string | undefined;
  do {
    const page = await listSessionThreads(env, tenantId, cursor);
    cursor = page.cursor;
    for (const s of page.sessions) {
      if (result.closed >= SWEEP_MAX_CLOSES) return true; // budget spent — resume next run
      if (s.meta?.closed) continue; // already closed; a visitor reopens it, not us
      // Sessions that predate this feature carry no metadata, so their real idle time is
      // unknowable from KV. Stamp them as active NOW rather than guess: the backlog then
      // closes one full window later instead of the instant someone enables the feature.
      // ponytail: the DO's ring tail knows the true last-activity — read it here if
      // waiting one window to clear a backlog ever proves too slow.
      if (!s.meta?.at) {
        const state = await getThreadState(env, tenantId, s.sessionId);
        if (state) await touchThread(env, tenantId, s.sessionId, state.threadId);
        result.stamped++;
        continue;
      }
      if (now - s.meta.at < windowMs) continue;

      // The list gives no values, so the thread id is read only now — for a session we
      // have already decided to close.
      const state = await getThreadState(env, tenantId, s.sessionId);
      if (!state) continue; // mapping vanished under us
      try {
        if (await wasLeftUnanswered(env, tenantId, s.sessionId)) {
          // Silent on purpose: a 24h-stale conversation buzzing an operator's phone is
          // more of exactly the noise this feature exists to remove. The record is the
          // message in the topic plus the still-unresolved row in the operator inbox.
          await sendToTopic(
            tenant.botToken,
            tenant.chatId,
            state.threadId,
            unresolvedClosingNote(hours),
            fetchImpl,
          );
        }
        await closeForumTopic(tenant.botToken, tenant.chatId, state.threadId, fetchImpl);
        await touchThread(env, tenantId, s.sessionId, state.threadId, {
          at: s.meta.at, // preserve the real idle time — closing is not activity
          closed: true,
        });
        result.closed++;
      } catch (e) {
        // No rights → every other topic in this group will fail identically. Stop this
        // tenant now instead of burning the budget (and Telegram's patience) proving it.
        if (isTopicRightsError(e)) {
          console.warn(
            `topic sweep: bot lacks can_manage_topics for tenant ${tenantId} — skipping. ` +
              `Grant the bot "Manage Topics" in the supergroup to enable topic closing.`,
          );
          return false;
        }
        // A topic an operator deleted by hand is already out of the group — record it as
        // closed so the sweep stops retrying it. Anything else (a 5xx, a timeout) leaves
        // the metadata untouched, so the session is still a candidate on the next run.
        const msg = String(e instanceof Error ? e.message : e).toLowerCase();
        if (msg.includes("not found")) {
          await touchThread(env, tenantId, s.sessionId, state.threadId, {
            at: s.meta.at,
            closed: true,
          });
        } else {
          console.error("topic sweep: close failed (retries next sweep):", e);
        }
      }
    }
  } while (cursor);
  return true;
}

/**
 * A visitor is about to speak in this session — make sure their topic is open and stamp
 * the activity. Called from the chat path's ensureTopic, the ONE place every visitor
 * turn passes through, so an idle-closed conversation reopens instead of orphaning its
 * thread. Best-effort by contract: the Telegram mirror is optional and a reopen failure
 * must never cost the visitor their reply.
 */
export async function touchTopicActivity(
  env: Env,
  tenantId: string,
  sessionId: string,
  threadId: number,
  wasClosed: boolean,
  tenant: Pick<TenantConfig, "botToken" | "chatId">,
  fetchImpl?: FetchLike,
): Promise<void> {
  if (wasClosed) {
    // Clear the flag even if Telegram rejects the reopen (already open, or the operator
    // reopened it by hand): the alternative is retrying a doomed call on every turn.
    await reopenForumTopic(tenant.botToken, tenant.chatId, threadId, fetchImpl).catch((e) =>
      console.warn("topic reopen failed (best-effort):", e),
    );
  }
  await touchThread(env, tenantId, sessionId, threadId, { closed: false });
}

/**
 * An operator settled this session (Telegram `/done`, or the app's resolve toggle) —
 * close the topic immediately rather than waiting out the idle window. A settled
 * conversation is by definition not what's happening RIGHT NOW. Un-resolving reopens it.
 * Gated on the same `topicIdleHours` opt-in, so `/done` behaves exactly as it does today
 * for a tenant that never enabled the lifecycle.
 */
export async function syncTopicToResolved(
  env: Env,
  tenantId: string,
  sessionId: string,
  resolved: boolean,
  fetchImpl?: FetchLike,
): Promise<void> {
  try {
    const tenant = await getTenant(env, tenantId);
    if (!tenant || idleWindowMs(tenant) === null) return;
    const state = await getThreadState(env, tenantId, sessionId);
    if (!state || state.closed === resolved) return;
    if (resolved) {
      await closeForumTopic(tenant.botToken, tenant.chatId, state.threadId, fetchImpl);
    } else {
      await reopenForumTopic(tenant.botToken, tenant.chatId, state.threadId, fetchImpl);
    }
    await touchThread(env, tenantId, sessionId, state.threadId, {
      at: state.at,
      closed: resolved,
    });
  } catch (e) {
    console.error("topic close-on-resolve failed (best-effort):", e);
  }
}

// Topic lifecycle — the idle sweep that closes stale Telegram forum topics, the reopen
// on a returning visitor, and the close-on-resolve mirror. Covers the two properties the
// feature lives or dies on: it is OFF until a tenant sets `topicIdleHours`, and a session
// that predates the feature is never closed on the strength of an unknown idle time.
// No Telegram, no network — the Bot API is a fake fetch. Run: `bun test`.
import { expect, test, describe } from "bun:test";
import worker from "../src/index";
import {
  sweepTopics,
  syncTopicToResolved,
  touchTopicActivity,
  idleWindowMs,
  unresolvedClosingNote,
  SWEEP_MAX_CLOSES,
  TOPIC_IDLE_HOURS_MAX,
  TOPIC_IDLE_HOURS_MIN,
} from "../src/topics";
import { isTopicRightsError } from "../src/telegram";
import {
  getThreadState,
  linkThreadSession,
  publicWidgetConfig,
  type ThreadMeta,
} from "../src/store";
import type { Env } from "../src/types";

const HOUR = 3_600_000;

interface Row {
  value: string;
  metadata?: unknown;
}

/** KV fake WITH metadata — the sweep's whole design rests on list() returning it. */
function fakeKV() {
  const kv = new Map<string, Row>();
  return {
    kv,
    binding: {
      get: async (k: string) => kv.get(k)?.value ?? null,
      getWithMetadata: async (k: string) => ({
        value: kv.get(k)?.value ?? null,
        metadata: kv.get(k)?.metadata ?? null,
      }),
      put: async (k: string, v: string, opts?: { metadata?: unknown }) =>
        void kv.set(k, { value: v, metadata: opts?.metadata }),
      list: async ({ prefix = "" }: { prefix?: string } = {}) => ({
        keys: [...kv.entries()]
          .filter(([n]) => n.startsWith(prefix))
          .map(([name, row]) => ({ name, metadata: row.metadata })),
        list_complete: true,
      }),
    },
  };
}

/** Telegram fake: records every Bot API method called, always succeeds unless `fail`. */
function fakeTelegram(fail?: (method: string) => string | undefined) {
  const calls: { method: string; body: Record<string, unknown> }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = String(input).split("/").pop() ?? "";
    calls.push({ method, body: JSON.parse(String(init?.body ?? "{}")) });
    const description = fail?.(method);
    return Response.json(description ? { ok: false, description } : { ok: true, result: true });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl, methods: () => calls.map((c) => c.method) };
}

/** SessionDO fake — only /summary matters to the sweep. */
function fakeSessions(state: Record<string, { handedOff?: boolean; resolved?: boolean }> = {}) {
  return {
    idFromName: (name: string) => ({ name }),
    get: (id: { name: string }) => ({
      fetch: async () => Response.json(state[id.name.split(":")[1] ?? ""] ?? {}),
    }),
  } as unknown as Env["SESSION"];
}

/** A tenant with Telegram wired and `topicIdleHours` set (or omitted = feature off). */
async function seed(opts: {
  topicIdleHours?: number;
  sessions: { id: string; threadId: number; meta?: ThreadMeta }[];
  doState?: Record<string, { handedOff?: boolean; resolved?: boolean }>;
}) {
  const { kv, binding } = fakeKV();
  const env = { KRISPY_KV: binding, SESSION: fakeSessions(opts.doState) } as unknown as Env;
  kv.set("tenant:acme", {
    value: JSON.stringify({
      botToken: "tok",
      chatId: "-100",
      ...(opts.topicIdleHours === undefined ? {} : { topicIdleHours: opts.topicIdleHours }),
    }),
  });
  for (const s of opts.sessions) {
    await linkThreadSession(env, "acme", s.threadId, s.id);
    // linkThreadSession stamps `at: now`; overwrite when the case needs a specific age
    // (or no metadata at all, which is what a pre-feature session looks like).
    kv.set(`session:acme:${s.id}`, { value: String(s.threadId), metadata: s.meta });
  }
  return { env, kv };
}

// ── the window ───────────────────────────────────────────────────────────────
describe("idleWindowMs — unset means OFF", () => {
  test("unset / 0 / negative / NaN → null (feature off)", () => {
    expect(idleWindowMs(null)).toBeNull();
    expect(idleWindowMs({})).toBeNull();
    expect(idleWindowMs({ topicIdleHours: 0 })).toBeNull();
    expect(idleWindowMs({ topicIdleHours: -5 })).toBeNull();
    expect(idleWindowMs({ topicIdleHours: Number.NaN })).toBeNull();
  });

  test("a set value becomes the window, clamped to the sane range", () => {
    expect(idleWindowMs({ topicIdleHours: 24 })).toBe(24 * HOUR);
    expect(idleWindowMs({ topicIdleHours: 0.01 })).toBe(TOPIC_IDLE_HOURS_MIN * HOUR);
    expect(idleWindowMs({ topicIdleHours: 999_999 })).toBe(TOPIC_IDLE_HOURS_MAX * HOUR);
  });
});

// ── the off-safety guarantee ─────────────────────────────────────────────────
describe("sweepTopics is OFF until configured", () => {
  test("a Telegram-configured tenant with NO topicIdleHours closes nothing", async () => {
    const { env } = await seed({
      sessions: [{ id: "s1", threadId: 11, meta: { at: Date.now() - 400 * HOUR } }],
    });
    const tg = fakeTelegram();
    const r = await sweepTopics(env, tg.fetchImpl);
    expect(r.closed).toBe(0);
    expect(tg.calls).toHaveLength(0); // not one Bot API call — the pre-upgrade behavior
  });
});

// ── the sweep ────────────────────────────────────────────────────────────────
describe("sweepTopics closes what is idle", () => {
  test("closes a topic past the window and records it in the metadata", async () => {
    const idleAt = Date.now() - 30 * HOUR;
    const { env } = await seed({
      topicIdleHours: 24,
      sessions: [{ id: "s1", threadId: 11, meta: { at: idleAt } }],
    });
    const tg = fakeTelegram();
    const r = await sweepTopics(env, tg.fetchImpl);
    expect(r.closed).toBe(1);
    expect(tg.methods()).toEqual(["closeForumTopic"]);
    expect(tg.calls[0]!.body).toMatchObject({ chat_id: "-100", message_thread_id: 11 });
    const state = await getThreadState(env, "acme", "s1");
    expect(state?.closed).toBe(true);
    // Closing is not activity — the original idle timestamp must survive, or a reopened
    // topic would look freshly active to the next sweep.
    expect(state?.at).toBe(idleAt);
  });

  test("leaves a topic still inside the window alone", async () => {
    const { env } = await seed({
      topicIdleHours: 24,
      sessions: [{ id: "s1", threadId: 11, meta: { at: Date.now() - 2 * HOUR } }],
    });
    const tg = fakeTelegram();
    expect((await sweepTopics(env, tg.fetchImpl)).closed).toBe(0);
    expect(tg.calls).toHaveLength(0);
  });

  test("an already-closed topic is skipped — the sweep is idempotent", async () => {
    const { env } = await seed({
      topicIdleHours: 24,
      sessions: [{ id: "s1", threadId: 11, meta: { at: Date.now() - 99 * HOUR, closed: true } }],
    });
    const tg = fakeTelegram();
    expect((await sweepTopics(env, tg.fetchImpl)).closed).toBe(0);
    expect(tg.calls).toHaveLength(0);
  });

  test("budget-capped: never closes more than SWEEP_MAX_CLOSES in one run", async () => {
    const old = Date.now() - 99 * HOUR;
    const { env } = await seed({
      topicIdleHours: 24,
      sessions: Array.from({ length: SWEEP_MAX_CLOSES + 5 }, (_, i) => ({
        id: `s${i}`,
        threadId: 100 + i,
        meta: { at: old },
      })),
    });
    const tg = fakeTelegram();
    const r = await sweepTopics(env, tg.fetchImpl);
    expect(r.closed).toBe(SWEEP_MAX_CLOSES);
    // the remainder is still a candidate — the next run picks it up
    expect((await getThreadState(env, "acme", `s${SWEEP_MAX_CLOSES + 4}`))?.closed).toBe(false);
  });
});

// ── nothing is silently lost ─────────────────────────────────────────────────
describe("an unresolved handoff leaves a record", () => {
  test("handed off and never resolved → closing note posted BEFORE the close", async () => {
    const { env } = await seed({
      topicIdleHours: 24,
      sessions: [{ id: "s1", threadId: 11, meta: { at: Date.now() - 30 * HOUR } }],
      doState: { s1: { handedOff: true, resolved: false } },
    });
    const tg = fakeTelegram();
    await sweepTopics(env, tg.fetchImpl);
    expect(tg.methods()).toEqual(["sendMessage", "closeForumTopic"]);
    expect(tg.calls[0]!.body.text).toBe(unresolvedClosingNote(24));
    // Silent: a day-old conversation must not buzz the operator's phone — that noise is
    // the thing this feature exists to remove.
    expect(tg.calls[0]!.body.disable_notification).toBe(true);
  });

  test("resolved (or never handed off) → closes quietly, no message", async () => {
    const { env } = await seed({
      topicIdleHours: 24,
      sessions: [
        { id: "done", threadId: 11, meta: { at: Date.now() - 30 * HOUR } },
        { id: "bot", threadId: 12, meta: { at: Date.now() - 30 * HOUR } },
      ],
      doState: { done: { handedOff: true, resolved: true }, bot: { handedOff: false } },
    });
    const tg = fakeTelegram();
    await sweepTopics(env, tg.fetchImpl);
    expect(tg.methods()).toEqual(["closeForumTopic", "closeForumTopic"]);
  });
});

// ── migration: sessions that predate the feature ─────────────────────────────
describe("pre-existing sessions are stamped, never closed on a guess", () => {
  test("no metadata → stamped as active now, nothing closed", async () => {
    const { env } = await seed({
      topicIdleHours: 24,
      sessions: [{ id: "old", threadId: 11, meta: undefined }],
    });
    const tg = fakeTelegram();
    const r = await sweepTopics(env, tg.fetchImpl);
    expect(r.closed).toBe(0);
    expect(r.stamped).toBe(1);
    expect(tg.calls).toHaveLength(0);
    const state = await getThreadState(env, "acme", "old");
    expect(state?.at).toBeGreaterThan(Date.now() - 5000);
    // ...and one window later it becomes an ordinary candidate.
    expect(state?.closed).toBe(false);
  });
});

// ── degrading when the bot lacks can_manage_topics ───────────────────────────
describe("missing can_manage_topics degrades, never throws", () => {
  test("rights failure skips the tenant instead of retrying every topic", async () => {
    const { env } = await seed({
      topicIdleHours: 24,
      sessions: [
        { id: "s1", threadId: 11, meta: { at: Date.now() - 30 * HOUR } },
        { id: "s2", threadId: 12, meta: { at: Date.now() - 30 * HOUR } },
      ],
    });
    const tg = fakeTelegram((m) =>
      m === "closeForumTopic" ? "Bad Request: not enough rights to manage topics" : undefined,
    );
    const r = await sweepTopics(env, tg.fetchImpl);
    expect(r.closed).toBe(0);
    expect(r.deniedTenants).toBe(1);
    // stopped after the FIRST failure — it would fail identically for every other topic
    expect(tg.methods()).toEqual(["closeForumTopic"]);
    // nothing marked closed, so a self-host that fixes the permission recovers on its own
    expect((await getThreadState(env, "acme", "s1"))?.closed).toBe(false);
  });

  test("isTopicRightsError matches the Bot API's rights wording, not ordinary errors", () => {
    expect(isTopicRightsError(new Error("Bad Request: not enough rights to manage topics"))).toBe(
      true,
    );
    expect(isTopicRightsError(new Error("telegram close failed: CHAT_ADMIN_REQUIRED"))).toBe(true);
    expect(isTopicRightsError(new Error("Bad Request: message thread not found"))).toBe(false);
  });

  test("a transient failure leaves the session a candidate for the next sweep", async () => {
    const { env } = await seed({
      topicIdleHours: 24,
      sessions: [{ id: "s1", threadId: 11, meta: { at: Date.now() - 30 * HOUR } }],
    });
    const tg = fakeTelegram((m) => (m === "closeForumTopic" ? "Internal Server Error" : undefined));
    const r = await sweepTopics(env, tg.fetchImpl);
    expect(r.closed).toBe(0);
    expect(r.deniedTenants).toBe(0);
    expect((await getThreadState(env, "acme", "s1"))?.closed).toBe(false);
  });

  test("a topic deleted by hand is recorded closed so the sweep stops retrying it", async () => {
    const { env } = await seed({
      topicIdleHours: 24,
      sessions: [{ id: "s1", threadId: 11, meta: { at: Date.now() - 30 * HOUR } }],
    });
    const tg = fakeTelegram((m) =>
      m === "closeForumTopic" ? "Bad Request: message thread not found" : undefined,
    );
    await sweepTopics(env, tg.fetchImpl);
    expect((await getThreadState(env, "acme", "s1"))?.closed).toBe(true);
  });
});

// ── the visitor comes back ───────────────────────────────────────────────────
describe("a returning visitor reopens the topic", () => {
  test("touchTopicActivity reopens a closed topic and clears the flag", async () => {
    const { env } = await seed({
      topicIdleHours: 24,
      sessions: [{ id: "s1", threadId: 11, meta: { at: Date.now() - 99 * HOUR, closed: true } }],
    });
    const tg = fakeTelegram();
    await touchTopicActivity(
      env,
      "acme",
      "s1",
      11,
      true,
      { botToken: "tok", chatId: "-100" },
      tg.fetchImpl,
    );
    expect(tg.methods()).toEqual(["reopenForumTopic"]);
    const state = await getThreadState(env, "acme", "s1");
    expect(state?.closed).toBe(false);
    expect(state?.at).toBeGreaterThan(Date.now() - 5000);
  });

  test("an open topic is only stamped — no Bot API call per turn", async () => {
    const { env } = await seed({
      topicIdleHours: 24,
      sessions: [{ id: "s1", threadId: 11, meta: { at: Date.now() - 2 * HOUR } }],
    });
    const tg = fakeTelegram();
    await touchTopicActivity(
      env,
      "acme",
      "s1",
      11,
      false,
      { botToken: "tok", chatId: "-100" },
      tg.fetchImpl,
    );
    expect(tg.calls).toHaveLength(0);
  });
});

// ── /done and the app's resolve toggle ───────────────────────────────────────
describe("syncTopicToResolved mirrors resolve onto the topic", () => {
  test("resolving closes the topic immediately", async () => {
    const { env } = await seed({
      topicIdleHours: 24,
      sessions: [{ id: "s1", threadId: 11, meta: { at: Date.now() } }],
    });
    const tg = fakeTelegram();
    await syncTopicToResolved(env, "acme", "s1", true, tg.fetchImpl);
    expect(tg.methods()).toEqual(["closeForumTopic"]);
    expect((await getThreadState(env, "acme", "s1"))?.closed).toBe(true);
  });

  test("un-resolving (the app's undo swipe) reopens it", async () => {
    const { env } = await seed({
      topicIdleHours: 24,
      sessions: [{ id: "s1", threadId: 11, meta: { at: Date.now(), closed: true } }],
    });
    const tg = fakeTelegram();
    await syncTopicToResolved(env, "acme", "s1", false, tg.fetchImpl);
    expect(tg.methods()).toEqual(["reopenForumTopic"]);
    expect((await getThreadState(env, "acme", "s1"))?.closed).toBe(false);
  });

  test("feature off → /done behaves exactly as before (no topic call)", async () => {
    const { env } = await seed({
      sessions: [{ id: "s1", threadId: 11, meta: { at: Date.now() } }],
    });
    const tg = fakeTelegram();
    await syncTopicToResolved(env, "acme", "s1", true, tg.fetchImpl);
    expect(tg.calls).toHaveLength(0);
  });
});

// ── the cron entrypoint ──────────────────────────────────────────────────────
// `wrangler dev` can't start this Worker (the entry module exports plain constants for
// the tests, which the Workers runtime rejects — reproduces on master), so the scheduled
// handler is exercised here instead: it must exist, run the sweep, and never throw.
describe("the Worker's scheduled() entrypoint", () => {
  /** scheduled() takes no fetch seam (the platform calls it), so the Bot API is stubbed
   * at the global. Without this the test would hit api.telegram.org for real and pass
   * for the wrong reason — a 404 "Not Found" is the deleted-topic path, which also
   * marks the topic closed. */
  async function onCronTick(env: Env, tg: ReturnType<typeof fakeTelegram>) {
    const real = globalThis.fetch;
    globalThis.fetch = tg.fetchImpl;
    try {
      await worker.scheduled({ scheduledTime: Date.now(), cron: "0 * * * *" }, env);
    } finally {
      globalThis.fetch = real;
    }
  }

  test("a cron tick runs the sweep and closes an idle topic", async () => {
    const { env } = await seed({
      topicIdleHours: 24,
      sessions: [{ id: "s1", threadId: 11, meta: { at: Date.now() - 30 * HOUR } }],
    });
    const tg = fakeTelegram();
    expect(typeof worker.scheduled).toBe("function");
    await onCronTick(env, tg);
    expect(tg.methods()).toEqual(["closeForumTopic"]);
    expect((await getThreadState(env, "acme", "s1"))?.closed).toBe(true);
  });

  test("a cron tick on an unconfigured tenant is a no-op, not a throw", async () => {
    const { env } = await seed({
      sessions: [{ id: "s1", threadId: 11, meta: { at: Date.now() - 400 * HOUR } }],
    });
    const tg = fakeTelegram();
    await onCronTick(env, tg);
    expect(tg.calls).toHaveLength(0);
    expect((await getThreadState(env, "acme", "s1"))?.closed).toBe(false);
  });
});

// ── the config write boundary ────────────────────────────────────────────────
describe("topicIdleHours is validated where it is written", () => {
  const post = (config: unknown) =>
    worker.fetch(
      new Request("https://edge/api/tenant/config", {
        method: "POST",
        headers: { "content-type": "application/json", "x-tenant-sync-secret": "s3cret" },
        body: JSON.stringify({ tenantId: "acme", config }),
      }),
      { KRISPY_KV: fakeKV().binding, TENANT_SYNC_SECRET: "s3cret" } as unknown as Env,
    );

  test("a sub-hour window is rejected — it would sweep live conversations", async () => {
    const res = await post({ topicIdleHours: 0.05 });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "topic_idle_hours_out_of_range" });
  });

  test("a non-number is rejected", async () => {
    expect((await post({ topicIdleHours: "24" })).status).toBe(400);
  });

  test("0 is accepted — it is the OFF switch", async () => {
    expect((await post({ topicIdleHours: 0 })).status).toBe(200);
  });

  test("24 is accepted", async () => {
    expect((await post({ topicIdleHours: 24 })).status).toBe(200);
  });
});

// ── leak guard ───────────────────────────────────────────────────────────────
test("topicIdleHours never reaches the public widget config", () => {
  const projected = publicWidgetConfig({
    botToken: "tok",
    chatId: "-100",
    topicIdleHours: 24,
  });
  expect(JSON.stringify(projected)).not.toContain("topicIdleHours");
});

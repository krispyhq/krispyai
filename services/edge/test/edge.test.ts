// Unit tests for everything local-testable WITHOUT Telegram / Workers AI / a
// public webhook (those are service-gated — see README). Run: `bun test`.
import { expect, test, describe } from "bun:test";
import { buildSystemPrompt, parseHandoff, HANDOFF_MARKER } from "../src/system-prompt";
import { parseOwnerReply } from "../src/telegram";
import { broadcast } from "../src/session-do";
import { chatFlow, FALLBACK_REPLY, type ChatDeps } from "../src/chat";
import {
  kThreadToSession,
  kSessionToThread,
  kUsage,
  monthKey,
  meter,
  getUsage,
  getThreadForSession,
  linkThreadSession,
  getTenant,
  withinPlan,
  planFor,
  entitled,
  writeEntitlement,
  readEntitlement,
  type EntitlementSnapshot,
} from "../src/store";
import type { Env } from "../src/types";

// ── a Map-backed fake of the bits of Env the store touches ───────────────────
function fakeEnv(extra: Partial<Env> = {}): Env {
  const kv = new Map<string, string>();
  return {
    KRISPY_KV: {
      get: async (k: string) => kv.get(k) ?? null,
      put: async (k: string, v: string) => void kv.set(k, v),
    },
    ...extra,
  } as unknown as Env;
}

// ── [!HANDOFF] contract ──────────────────────────────────────────────────────
describe("parseHandoff", () => {
  test("plain reply → no handoff, text untouched", () => {
    expect(parseHandoff("We open at 9am.")).toEqual({ text: "We open at 9am.", handoff: false });
  });
  test("marker → stripped from visitor text, handoff true", () => {
    const r = parseHandoff(`Let me get someone. ${HANDOFF_MARKER}`);
    expect(r.handoff).toBe(true);
    expect(r.text).toBe("Let me get someone.");
    expect(r.text).not.toContain("[!HANDOFF]");
  });
  test("buildSystemPrompt always restates the handoff contract", () => {
    expect(buildSystemPrompt()).toContain(HANDOFF_MARKER);
    expect(buildSystemPrompt("Custom brand voice.")).toContain(HANDOFF_MARKER);
  });
});

// ── Telegram webhook parsing ─────────────────────────────────────────────────
describe("parseOwnerReply", () => {
  test("owner thread reply → extracted", () => {
    expect(parseOwnerReply({ message: { text: "on my way", message_thread_id: 42 } })).toEqual({
      threadId: 42,
      text: "on my way",
    });
  });
  test("bot's own echo → ignored", () => {
    expect(
      parseOwnerReply({ message: { text: "hi", message_thread_id: 42, from: { is_bot: true } } }),
    ).toBeNull();
  });
  test("topic-created service message → ignored", () => {
    expect(
      parseOwnerReply({ message: { message_thread_id: 42, forum_topic_created: {} } }),
    ).toBeNull();
  });
  test("General topic (no thread id) → ignored", () => {
    expect(parseOwnerReply({ message: { text: "hi" } })).toBeNull();
  });
});

// ── topic<->session mapping + metering ───────────────────────────────────────
describe("store", () => {
  test("key builders are stable", () => {
    expect(kThreadToSession("self", 7)).toBe("thread:self:7");
    expect(kSessionToThread("self", "s1")).toBe("session:self:s1");
    expect(kUsage("self", "ai", "202607")).toBe("usage:self:202607:ai");
    expect(monthKey(new Date(Date.UTC(2026, 6, 3)))).toBe("202607");
  });
  test("link is two-way and round-trips", async () => {
    const env = fakeEnv();
    await linkThreadSession(env, "self", 99, "sess-abc");
    expect(await getThreadForSession(env, "self", "sess-abc")).toBe(99);
  });
  test("meter increments per kind, getUsage reads back", async () => {
    const env = fakeEnv();
    await meter(env, "self", "ai");
    await meter(env, "self", "ai");
    await meter(env, "self", "handoff");
    expect(await getUsage(env, "self")).toEqual({ ai: 2, handoff: 1 });
  });
  test("getTenant('self') needs both token and chat id", async () => {
    expect(await getTenant(fakeEnv(), "self")).toBeNull();
    const ok = await getTenant(
      fakeEnv({ TELEGRAM_BOT_TOKEN: "t", TELEGRAM_CHAT_ID: "-100" }),
      "self",
    );
    expect(ok?.botToken).toBe("t");
  });
  test("plan gate", () => {
    expect(withinPlan({ ai: 0, handoff: 0 }, planFor("self"))).toBe(true);
    expect(withinPlan({ ai: 5, handoff: 0 }, { aiPerMonth: 5, handoffPerMonth: 10 })).toBe(false);
  });
});

// ── entitlement gate (Krispy Cloud billing) ──────────────────────────────────
describe("entitlement", () => {
  const cloudSnap = (over: Partial<EntitlementSnapshot> = {}): EntitlementSnapshot => ({
    plan: "cloud",
    status: "trialing",
    entitled: true,
    limits: { aiPerMonth: 5000, handoffPerMonth: null },
    trialEndsAt: "2026-07-17T00:00:00Z",
    currentPeriodEnd: null,
    updatedAt: "2026-07-03T00:00:00Z",
    ...over,
  });

  test("self-host is always entitled + unmetered", async () => {
    const ent = await entitled(fakeEnv(), "self");
    expect(ent.entitled).toBe(true);
    expect(ent.plan_limits).toEqual({ aiPerMonth: Infinity, handoffPerMonth: Infinity });
  });

  test("cloud tenant with no snapshot fails closed", async () => {
    const ent = await entitled(fakeEnv(), "tenant_x");
    expect(ent.entitled).toBe(false);
  });

  test("synced snapshot round-trips and drives the gate; null cap → Infinity", async () => {
    const env = fakeEnv();
    await writeEntitlement(env, "tenant_42", cloudSnap());
    expect((await readEntitlement(env, "tenant_42"))?.plan).toBe("cloud");
    const ent = await entitled(env, "tenant_42");
    expect(ent.entitled).toBe(true);
    expect(ent.plan_limits.aiPerMonth).toBe(5000);
    expect(ent.plan_limits.handoffPerMonth).toBe(Infinity); // null → unmetered
    // metering vs plan: at the cap, gated
    expect(withinPlan({ ai: 5000, handoff: 0 }, ent.plan_limits)).toBe(false);
    expect(withinPlan({ ai: 4999, handoff: 1e9 }, ent.plan_limits)).toBe(true);
  });

  test("a gated (canceled/expired) snapshot revokes access", async () => {
    const env = fakeEnv();
    await writeEntitlement(env, "tenant_42", cloudSnap({ status: "canceled", entitled: false }));
    expect((await entitled(env, "tenant_42")).entitled).toBe(false);
  });
});

// ── DO fan-out ───────────────────────────────────────────────────────────────
describe("broadcast", () => {
  test("delivers to live sockets, skips dead ones", () => {
    const seen: string[] = [];
    const live = { send: (d: string) => seen.push(d) };
    const dead = {
      send: () => {
        throw new Error("closed");
      },
    };
    const n = broadcast([live, dead, live], { type: "operator", text: "hi" });
    expect(n).toBe(2);
    expect(JSON.parse(seen[0]!)).toEqual({ type: "operator", text: "hi" });
  });
});

// ── the chat flow (the whole loop, fakes for every side-effect) ──────────────
describe("chatFlow", () => {
  function deps(over: Partial<ChatDeps> = {}) {
    const topic: string[] = [];
    const metered: string[] = [];
    const base: ChatDeps = {
      systemPrompt: "sys",
      ensureTopic: async () => 5,
      toTopic: async (_t, text) => void topic.push(text),
      isHandedOff: async () => false,
      ai: async () => "Sure, 9am.",
      meter: async (k) => void metered.push(k),
      ...over,
    };
    return { base, topic, metered };
  }

  test("normal: AI answers, mirrored to topic, ai metered", async () => {
    const { base, topic, metered } = deps();
    const r = await chatFlow(base, { sessionId: "s", message: "hours?" });
    expect(r).toEqual({ reply: "Sure, 9am.", handoff: false, handedOff: false });
    expect(topic).toContain("👤 hours?");
    expect(topic).toContain("🤖 Sure, 9am.");
    expect(metered).toEqual(["ai"]);
  });

  test("handed off: bot stays silent, still mirrors visitor msg, no AI/meter", async () => {
    let aiCalled = false;
    const { base, topic, metered } = deps({
      isHandedOff: async () => true,
      ai: async () => {
        aiCalled = true;
        return "x";
      },
    });
    const r = await chatFlow(base, { sessionId: "s", message: "still there?" });
    expect(r.handedOff).toBe(true);
    expect(r.reply).toBeNull();
    expect(aiCalled).toBe(false);
    expect(metered).toEqual([]);
    expect(topic).toContain("👤 still there?");
  });

  test("[!HANDOFF] in reply → handoff true, handoff metered", async () => {
    const { base, metered } = deps({ ai: async () => `A teammate will help. ${HANDOFF_MARKER}` });
    const r = await chatFlow(base, { sessionId: "s", message: "refund please" });
    expect(r.handoff).toBe(true);
    expect(r.reply).toBe("A teammate will help.");
    expect(metered).toEqual(["ai", "handoff"]);
  });

  test("AI throws → graceful degradation to human, never drops the visitor", async () => {
    const { base, topic } = deps({
      ai: async () => {
        throw new Error("model 500");
      },
    });
    const r = await chatFlow(base, { sessionId: "s", message: "hi" });
    expect(r.degraded).toBe(true);
    expect(r.handoff).toBe(true);
    expect(r.reply).toBe(FALLBACK_REPLY);
    expect(topic.some((t) => t.includes("AI unavailable"))).toBe(true);
  });
});

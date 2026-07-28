// The pre-chat identification gate. Two properties carry the feature: it is genuinely
// OFF by default (the un-gated path must be untouched), and when it is ON the server —
// not the widget — is what refuses. Every test is local (no Telegram / Workers AI),
// with the Map-backed fakes edge.test.ts uses. Run: `bun test`.
import { expect, test, describe } from "bun:test";
import worker, { normalizeIdentity, IDENTITY_MAX_CHARS } from "../src/index";
import {
  publicWidgetConfig,
  mergeTenantConfig,
  DO_INTERNAL_HEADER,
  doInternalSecret,
} from "../src/store";
import { SessionDO } from "../src/session-do";
import type { Env } from "../src/types";

// ── shared fakes (mirrors edge.test.ts / chat-injection-harden.test.ts) ───────
function fakeEnv(extra: Partial<Env> = {}): Env {
  const kv = new Map<string, string>();
  return {
    KRISPY_KV: {
      get: async (k: string) => kv.get(k) ?? null,
      put: async (k: string, v: string) => void kv.set(k, v),
      list: async ({ prefix }: { prefix?: string } = {}) => ({
        keys: [...kv.keys()]
          .filter((k) => !prefix || k.startsWith(prefix))
          .map((name) => ({ name })),
        list_complete: true,
      }),
    },
    ...extra,
  } as unknown as Env;
}

function fakeDOState(): DurableObjectState {
  const store = new Map<string, unknown>();
  let alarm: number | null = null;
  return {
    acceptWebSocket: () => {},
    getWebSockets: () => [],
    storage: {
      get: async (k: string) => store.get(k),
      put: async (k: string, v: unknown) => void store.set(k, v),
      setAlarm: async (t: number | Date) => void (alarm = typeof t === "number" ? t : t.getTime()),
      deleteAlarm: async () => void (alarm = null),
      getAlarm: async () => alarm,
    },
  } as unknown as DurableObjectState;
}

function wireSessionNS(env: Env): Env {
  const dos = new Map<string, SessionDO>();
  (env as { SESSION: unknown }).SESSION = {
    idFromName: (name: string) => name,
    get: (name: string) => ({
      fetch: (input: RequestInfo | URL, init?: RequestInit) => {
        let d = dos.get(name);
        if (!d) {
          d = new SessionDO(fakeDOState(), env);
          dos.set(name, d);
        }
        return d.fetch(input instanceof Request ? input : new Request(String(input), init));
      },
    }),
  };
  return env;
}

const chat = (env: Env, body: unknown) =>
  worker.fetch(
    new Request("https://edge.test/api/chat", { method: "POST", body: JSON.stringify(body) }),
    env,
  );

/** An env whose AI always answers, so a 200 proves the turn actually ran. */
function answeringEnv(extra: Partial<Env> = {}): Env {
  const env = wireSessionNS(fakeEnv(extra));
  (env as { AI: unknown }).AI = { run: async () => ({ response: "We open at 9am." }) };
  return env;
}

// ── the validator (trust boundary) ───────────────────────────────────────────
describe("normalizeIdentity", () => {
  test("accepts a real address, trimmed + lowercased", () => {
    expect(normalizeIdentity({ email: "  Dana@Example.COM " })).toEqual({
      email: "dana@example.com",
    });
  });

  test("keeps an optional name, drops an empty one", () => {
    expect(normalizeIdentity({ email: "a@b.co", name: " Dana " })).toEqual({
      email: "a@b.co",
      name: "Dana",
    });
    expect(normalizeIdentity({ email: "a@b.co", name: "   " })).toEqual({ email: "a@b.co" });
  });

  test("rejects anything that can't receive a reply", () => {
    for (const bad of [
      null,
      undefined,
      "dana@example.com", // a bare string, not the object shape
      {},
      { email: 42 },
      { email: "" },
      { email: "dana" },
      { email: "dana@" },
      { email: "@example.com" },
      { email: "dana@localhost" }, // no dot — <input type=email> would ACCEPT this
      { email: "da na@example.com" },
      { email: `${"a".repeat(IDENTITY_MAX_CHARS)}@example.com` },
    ]) {
      expect(normalizeIdentity(bad)).toBeNull();
    }
  });

  test("a long name is truncated, not rejected", () => {
    const out = normalizeIdentity({ email: "a@b.co", name: "n".repeat(IDENTITY_MAX_CHARS + 50) });
    expect(out!.name!.length).toBe(IDENTITY_MAX_CHARS);
  });
});

// ── OFF BY DEFAULT — the property that protects every existing self-host ─────
describe("off by default", () => {
  test("an unconfigured tenant's boot config has no `identify` key AT ALL", () => {
    const out = publicWidgetConfig({ botToken: "x", theme: { primaryColor: "#fff" } });
    expect(out.identify).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain("identify"); // byte-identical to today
  });

  test("require:'none' is also absent from the projection (nothing to render)", () => {
    const out = publicWidgetConfig({ botToken: "x", identify: { require: "none", title: "hi" } });
    expect(out.identify).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain("hi");
  });

  test("chat answers a visitor with NO identity when the tenant hasn't configured one", async () => {
    const env = answeringEnv({ TELEGRAM_BOT_TOKEN: "tok", TELEGRAM_CHAT_ID: "-100" });
    await mergeTenantConfig(env, "self", { botToken: "tok", chatId: "-100" });
    const res = await chat(env, { sessionId: "s1", tenantId: "self", message: "hours?" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { reply: string }).reply).toBe("We open at 9am.");
  });

  test("require:'none' does not gate either", async () => {
    const env = answeringEnv({ TELEGRAM_BOT_TOKEN: "tok", TELEGRAM_CHAT_ID: "-100" });
    await mergeTenantConfig(env, "self", {
      botToken: "tok",
      chatId: "-100",
      identify: { require: "none" },
    });
    const res = await chat(env, { sessionId: "s2", tenantId: "self", message: "hours?" });
    expect(res.status).toBe(200);
  });
});

// ── ON — the server is the gate, not the widget ──────────────────────────────
describe("identify.require = 'email'", () => {
  const gated = async (env: Env) =>
    mergeTenantConfig(env, "self", {
      botToken: "tok",
      chatId: "-100",
      identify: { require: "email", title: "Who are you?", collectName: true },
    });

  test("the copy projects to the widget (and only when required)", async () => {
    const out = publicWidgetConfig({
      botToken: "x",
      identify: {
        require: "email",
        title: "Who are you?",
        description: "so we can reply",
        collectName: true,
      },
    });
    expect(out.identify).toEqual({
      require: "email",
      title: "Who are you?",
      description: "so we can reply",
      collectName: true,
    });
    expect(JSON.stringify(out)).not.toContain("botToken"); // leak guard still holds
  });

  test("no identity → 403 identity_required, and the model never runs", async () => {
    const env = wireSessionNS(fakeEnv({ TELEGRAM_BOT_TOKEN: "tok", TELEGRAM_CHAT_ID: "-100" }));
    let aiCalled = false;
    (env as { AI: unknown }).AI = {
      run: async () => ((aiCalled = true), { response: "should never happen" }),
    };
    await gated(env);
    const res = await chat(env, { sessionId: "s3", tenantId: "self", message: "hours?" });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "identity_required" });
    expect(aiCalled).toBe(false);
  });

  test("a MALFORMED identity is no identity — a client-side check is a suggestion", async () => {
    const env = answeringEnv({ TELEGRAM_BOT_TOKEN: "tok", TELEGRAM_CHAT_ID: "-100" });
    await gated(env);
    const res = await chat(env, {
      sessionId: "s4",
      tenantId: "self",
      message: "hours?",
      identity: { email: "not-an-email" },
    });
    expect(res.status).toBe(403);
  });

  test("a valid identity passes, and the SESSION remembers it for later turns", async () => {
    const env = answeringEnv({ TELEGRAM_BOT_TOKEN: "tok", TELEGRAM_CHAT_ID: "-100" });
    await gated(env);
    const first = await chat(env, {
      sessionId: "s5",
      tenantId: "self",
      message: "hours?",
      identity: { email: "Dana@Example.com", name: "Dana" },
    });
    expect(first.status).toBe(200);
    // A later turn that forgot to re-send it still passes — the DO holds the identity.
    const second = await chat(env, { sessionId: "s5", tenantId: "self", message: "and prices?" });
    expect(second.status).toBe(200);
  });

  test("still enforced for a tenant with NO Telegram creds (getTenant returns null there)", async () => {
    // The widget reads its gate from the raw KV config, so the enforcement must too —
    // otherwise a Telegram-less self-host renders a gate that lets everyone through.
    const env = answeringEnv(); // no TELEGRAM_* at all
    await mergeTenantConfig(env, "self", { identify: { require: "email" } });
    expect((await chat(env, { sessionId: "s6", tenantId: "self", message: "hi" })).status).toBe(
      403,
    );
    const ok = await chat(env, {
      sessionId: "s6",
      tenantId: "self",
      message: "hi",
      identity: { email: "dana@example.com" },
    });
    expect(ok.status).toBe(200);
  });
});

// ── the identity reaches the operator where they reply ───────────────────────
// The whole point of the gate: a person can answer later. Prove the address lands in
// the Telegram topic (Telegram stubbed at globalThis.fetch, as edge.test.ts does).
describe("the operator's copy", () => {
  test("a new topic opens with the visitor's address as its first message", async () => {
    const env = answeringEnv({ TELEGRAM_BOT_TOKEN: "tok", TELEGRAM_CHAT_ID: "-100" });
    await mergeTenantConfig(env, "self", {
      botToken: "tok",
      chatId: "-100",
      identify: { require: "email" },
    });
    const tg: { url: string; body: { text?: string } | null }[] = [];
    const orig = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      tg.push({ url: String(input), body: init?.body ? JSON.parse(String(init.body)) : null });
      return Response.json({ ok: true, result: { message_thread_id: 42 } });
    }) as typeof fetch;
    try {
      const res = await chat(env, {
        sessionId: "s-tg",
        tenantId: "self",
        message: "do you ship to Spain?",
        identity: { email: "Dana@Example.com", name: "Dana" },
      });
      expect(res.status).toBe(200);
    } finally {
      globalThis.fetch = orig;
    }
    const sent = tg.filter((c) => c.url.includes("sendMessage")).map((c) => c.body?.text ?? "");
    expect(sent[0]).toBe("✉️ Dana · dana@example.com"); // FIRST, above the visitor's message
    expect(sent).toContain("👤 do you ship to Spain?"); // the ordinary mirror still follows
  });

  test("an un-gated session posts no identity line — the topic is what it is today", async () => {
    const env = answeringEnv({ TELEGRAM_BOT_TOKEN: "tok", TELEGRAM_CHAT_ID: "-100" });
    await mergeTenantConfig(env, "self", { botToken: "tok", chatId: "-100" });
    const tg: { url: string; body: { text?: string } | null }[] = [];
    const orig = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      tg.push({ url: String(input), body: init?.body ? JSON.parse(String(init.body)) : null });
      return Response.json({ ok: true, result: { message_thread_id: 43 } });
    }) as typeof fetch;
    try {
      await chat(env, { sessionId: "s-tg2", tenantId: "self", message: "hi" });
    } finally {
      globalThis.fetch = orig;
    }
    expect(tg.some((c) => (c.body?.text ?? "").includes("✉️"))).toBe(false);
  });
});

// ── the DO holds the identity write-once ─────────────────────────────────────
describe("SessionDO identity storage", () => {
  const env = fakeEnv();
  const authed = { [DO_INTERNAL_HEADER]: doInternalSecret(env) };
  const context = (do_: SessionDO, body: unknown) =>
    do_.fetch(
      new Request("https://do/context", {
        method: "POST",
        headers: authed,
        body: JSON.stringify(body),
      }),
    );

  test("first identity wins — a later post cannot overwrite it", async () => {
    const do_ = new SessionDO(fakeDOState(), env);
    await context(do_, { tenantId: "self", identity: { email: "real@example.com" } });
    const r = await context(do_, { tenantId: "self", identity: { email: "hijack@evil.com" } });
    expect(((await r.json()) as { identity: { email: string } }).identity.email).toBe(
      "real@example.com",
    );
  });

  test("no identity posted → the key is simply absent (un-gated sessions store nothing)", async () => {
    const do_ = new SessionDO(fakeDOState(), env);
    const r = await context(do_, { tenantId: "self" });
    const body = (await r.json()) as {
      handedOff: boolean;
      messages: unknown[];
      identity?: unknown;
    };
    expect(body.identity).toBeUndefined();
    expect(body.handedOff).toBe(false); // the existing contract is unchanged
    expect(body.messages).toEqual([]);
  });

  test("the operator inbox row carries it", async () => {
    const do_ = new SessionDO(fakeDOState(), env);
    await context(do_, { tenantId: "self", identity: { email: "dana@example.com", name: "Dana" } });
    const r = await do_.fetch(new Request("https://do/summary", { headers: authed }));
    expect(((await r.json()) as { identity: unknown }).identity).toEqual({
      email: "dana@example.com",
      name: "Dana",
    });
  });
});

// ── write-path caps (POST /api/tenant/config) ────────────────────────────────
describe("config write caps", () => {
  const setConfig = (env: Env, config: unknown) =>
    worker.fetch(
      new Request("https://edge.test/api/tenant/config", {
        method: "POST",
        headers: { "x-tenant-sync-secret": "shh" },
        body: JSON.stringify({ tenantId: "self", config }),
      }),
      env,
    );

  test("an unknown `require` is rejected rather than silently treated as off", async () => {
    const env = fakeEnv({ TENANT_SYNC_SECRET: "shh" });
    const res = await setConfig(env, { identify: { require: "phone" } });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "identify_require_invalid" });
  });

  test("oversized gate copy → 413 (it renders verbatim in every visitor's boot config)", async () => {
    const env = fakeEnv({ TENANT_SYNC_SECRET: "shh" });
    const res = await setConfig(env, {
      identify: { require: "email", description: "x".repeat(501) },
    });
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "identify_text_too_large" });
  });

  test("a valid gate config is accepted", async () => {
    const env = fakeEnv({ TENANT_SYNC_SECRET: "shh" });
    const res = await setConfig(env, {
      identify: { require: "email", title: "Before we start", collectName: true },
    });
    expect(res.status).toBe(200);
  });
});

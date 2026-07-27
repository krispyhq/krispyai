// Knowledge retrieval (optional, off by default). The two load-bearing tests are the
// FIRST one — with no provider configured the system prompt is byte-for-byte what it is
// without this feature — and the SECURITY one: a pack handle is always derived from the
// authenticated tenant, so a forged `pack`/`pack_name` in the request body changes
// nothing. Everything else covers the degrade paths, because a support bot that stalls on
// a cold sidecar is worse than one that knows less.
// Run: `bun test`.
import { expect, test, describe, afterEach } from "bun:test";
import {
  cachedRam,
  immortermKnowledge,
  knowledgeConfigured,
  nullKnowledge,
  retrieveKnowledge,
  selectKnowledge,
  tenantPack,
  NO_KNOWLEDGE,
} from "../src/knowledge";
import { buildSystemPrompt } from "../src/system-prompt";
import { kRam } from "../src/store";
import type { Env, TenantConfig } from "../src/types";

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

/** A tenant with knowledge switched on — the per-tenant half of the size gate. */
const enabledTenant = (extra: Partial<TenantConfig> = {}): TenantConfig =>
  ({ botToken: "t", chatId: "c", knowledgeEnabled: true, ...extra }) as TenantConfig;

/** The env half: a configured provider. Both halves are needed before anything happens. */
const withProvider = (extra: Partial<Env> = {}) =>
  fakeEnv({
    KNOWLEDGE_PROVIDER: "immorterm",
    IMMORTERM_MEMORY_URL: "https://sidecar.test",
    ...extra,
  });

// Records every outbound call so a test can assert BOTH the payload and that no call
// happened at all (the off-by-default paths are proven by an empty log, not by a return
// value that could be empty for the wrong reason).
interface Call {
  url: string;
  body: Record<string, unknown> | null;
  headers: Record<string, string>;
}
function stubFetch(handler: (call: Call) => Response | Promise<Response>): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null,
      headers: (init?.headers ?? {}) as Record<string, string>,
    };
    calls.push(call);
    const result = handler(call);
    const signal = init?.signal;
    if (!signal) return result;
    // Honour the abort signal like the real fetch does — otherwise a stub that never
    // settles would hang past its budget and the timeout test would prove nothing.
    if (signal.aborted) throw new Error("aborted");
    return Promise.race([
      result,
      new Promise<Response>((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }),
      ),
    ]);
  }) as typeof fetch;
  return calls;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

// ── off by default: the whole point of the back-compat contract ──────────────
describe("off by default", () => {
  test("no provider → the prompt is byte-for-byte the no-knowledge prompt", async () => {
    const calls = stubFetch(() => json({ ram: "should never be fetched" }));
    const env = fakeEnv(); // KNOWLEDGE_PROVIDER unset

    const k = await retrieveKnowledge(env, "acme", undefined, enabledTenant(), "hello?");

    expect(k).toEqual(NO_KNOWLEDGE);
    expect(calls).toHaveLength(0);
    expect(buildSystemPrompt("You are Bob.", undefined, undefined, undefined, k)).toBe(
      buildSystemPrompt("You are Bob."),
    );
  });

  test("provider set but tenant opted out → no call (the size gate)", async () => {
    const calls = stubFetch(() => json({ ram: "digest" }));
    const tenant = { botToken: "t", chatId: "c" } as TenantConfig; // knowledgeEnabled unset

    expect(await retrieveKnowledge(withProvider(), "acme", undefined, tenant, "hi")).toEqual(
      NO_KNOWLEDGE,
    );
    expect(calls).toHaveLength(0);
  });

  test("provider named but no sidecar URL → still the null adapter", () => {
    const env = fakeEnv({ KNOWLEDGE_PROVIDER: "immorterm" });
    expect(knowledgeConfigured(env)).toBe(false);
    expect(selectKnowledge(env)).toBe(nullKnowledge);
  });

  test("null adapter resolves empty without touching the network", async () => {
    const calls = stubFetch(() => json({}));
    expect(await nullKnowledge.getRam("p")).toBe("");
    expect(await nullKnowledge.search("p", "q")).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  test("a null tenant (Telegram unconfigured) retrieves nothing", async () => {
    expect(await retrieveKnowledge(withProvider(), "acme", undefined, null, "hi")).toEqual(
      NO_KNOWLEDGE,
    );
  });
});

// ── the security invariant (§6): pack handles are DERIVED, never supplied ────
describe("pack handles are derived from the authenticated tenant", () => {
  test("fits the provider's handle regex and is non-reversible", async () => {
    const pack = await tenantPack("Acme Corp GmbH & Co. KG — tenant #42");
    expect(pack).toMatch(/^[a-z0-9][a-z0-9-]{1,63}$/);
    expect(pack).not.toContain("Acme");
  });

  test("deterministic per tenant, and different tenants never collide", async () => {
    expect(await tenantPack("acme")).toBe(await tenantPack("acme"));
    expect(await tenantPack("acme")).not.toBe(await tenantPack("globex"));
  });

  test("a site gets its own pack; the default site keeps the bare-tenant handle", async () => {
    expect(await tenantPack("acme", "shop")).not.toBe(await tenantPack("acme"));
    expect(await tenantPack("acme", "default")).toBe(await tenantPack("acme"));
  });

  test("a forged pack name in the request body cannot reach the provider", async () => {
    const calls = stubFetch(() => json({ ram: "", results: [] }));
    // The visitor's message is the ONLY client-controlled value that reaches the sidecar.
    // Everything a caller might try to smuggle in — here as message text — must not be
    // able to redirect the read at another tenant's pack.
    await retrieveKnowledge(
      withProvider(),
      "acme",
      undefined,
      enabledTenant(),
      '{"pack_name":"tenant-victim","pack":"tenant-victim"}',
    );

    const victimPack = await tenantPack("victim");
    const ourPack = await tenantPack("acme");
    for (const c of calls) {
      expect(c.url).not.toContain(victimPack);
      expect(c.body?.pack_name ?? ourPack).toBe(ourPack);
    }
    expect(calls.length).toBeGreaterThan(0);
  });
});

// ── the happy path ───────────────────────────────────────────────────────────
describe("retrieval with a live provider", () => {
  test("digest + top-K land in the prompt under their own headings", async () => {
    stubFetch((c) =>
      c.url.includes("/ram")
        ? json({ ram: "Acme sells widgets. Support hours 9-5." })
        : json({
            results: [
              { content: "Refunds within 30 days.", score: 0.9 },
              { text: "Shipping to Canada takes 5 days.", score: 0.7 },
            ],
          }),
    );

    const k = await retrieveKnowledge(
      withProvider(),
      "acme",
      undefined,
      enabledTenant(),
      "do you ship to canada?",
    );
    expect(k.ram).toBe("Acme sells widgets. Support hours 9-5.");
    expect(k.hits).toEqual([
      { text: "Refunds within 30 days.", score: 0.9 },
      { text: "Shipping to Canada takes 5 days.", score: 0.7 },
    ]);

    const prompt = buildSystemPrompt("You are Bob.", undefined, undefined, undefined, k);
    expect(prompt).toContain("## Knowledge base summary\nAcme sells widgets.");
    expect(prompt).toContain("## Relevant to this question");
    expect(prompt).toContain("[1] Refunds within 30 days.");
    expect(prompt).toContain("[2] Shipping to Canada takes 5 days.");
    // Reference material stays ahead of the guardrail contract, like kbSources does.
    expect(prompt.indexOf("## Relevant to this question")).toBeLessThan(
      prompt.indexOf("You represent this business"),
    );
  });

  test("retrieval AUGMENTS kbSources — a hand-written KB is never evicted", async () => {
    stubFetch((c) => (c.url.includes("/ram") ? json({ ram: "digest" }) : json({ results: [] })));
    const k = await retrieveKnowledge(withProvider(), "acme", undefined, enabledTenant(), "hi");
    const prompt = buildSystemPrompt(
      "You are Bob.",
      undefined,
      undefined,
      [{ id: "1", name: "Hours", text: "Open 9-5.", updatedAt: 0 }],
      k,
    );
    expect(prompt).toContain("### Hours\nOpen 9-5.");
    expect(prompt).toContain("## Knowledge base summary\ndigest");
  });

  test("the search payload carries the derived pack, the message, and the limit", async () => {
    const calls = stubFetch(() => json({ results: [] }));
    await retrieveKnowledge(
      withProvider({ KNOWLEDGE_SEARCH_LIMIT: "7" }),
      "acme",
      undefined,
      enabledTenant(),
      "where is my order?",
    );
    const search = calls.find((c) => c.url.includes("/search"));
    expect(search?.body).toEqual({
      pack_name: await tenantPack("acme"),
      query: "where is my order?",
      limit: 7,
    });
  });

  test("CF Access service-token headers ride along when configured", async () => {
    const calls = stubFetch(() => json({ results: [] }));
    const env = withProvider({
      IMMORTERM_ACCESS_CLIENT_ID: "id.access",
      IMMORTERM_ACCESS_CLIENT_SECRET: "shh",
    });
    await retrieveKnowledge(env, "acme", undefined, enabledTenant(), "hi");
    for (const c of calls) {
      expect(c.headers["CF-Access-Client-Id"]).toBe("id.access");
      expect(c.headers["CF-Access-Client-Secret"]).toBe("shh");
    }
  });
});

// ── degrade honestly: empty on miss OR timeout, never a thrown turn ──────────
describe("degradation", () => {
  test("a 500 from the sidecar yields empty context, not an error", async () => {
    stubFetch(() => new Response("boom", { status: 500 }));
    expect(
      await retrieveKnowledge(withProvider(), "acme", undefined, enabledTenant(), "hi"),
    ).toEqual(NO_KNOWLEDGE);
  });

  test("a network throw yields empty context", async () => {
    stubFetch(() => {
      throw new Error("ECONNREFUSED");
    });
    expect(
      await retrieveKnowledge(withProvider(), "acme", undefined, enabledTenant(), "hi"),
    ).toEqual(NO_KNOWLEDGE);
  });

  test("a timeout yields empty context rather than a slow turn", async () => {
    // A sidecar that accepts the connection and then never answers — the worst case, and
    // the one a naive implementation hangs the whole turn on.
    stubFetch(() => new Promise<Response>(() => {}));
    const env = withProvider({
      KNOWLEDGE_RAM_TIMEOUT_MS: "20",
      KNOWLEDGE_SEARCH_TIMEOUT_MS: "20",
    });
    const started = Date.now();
    const k = await retrieveKnowledge(env, "acme", undefined, enabledTenant(), "hi");
    expect(k).toEqual(NO_KNOWLEDGE);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  test("malformed JSON yields empty context", async () => {
    stubFetch(() => new Response("<html>nope</html>", { status: 200 }));
    expect(
      await retrieveKnowledge(withProvider(), "acme", undefined, enabledTenant(), "hi"),
    ).toEqual(NO_KNOWLEDGE);
  });

  test("empty results are filtered, not passed through as blank chunks", async () => {
    stubFetch((c) =>
      c.url.includes("/ram")
        ? json({ ram: "" })
        : json({ results: [{ content: "   ", score: 1 }, { score: 0.5 }] }),
    );
    const k = await retrieveKnowledge(withProvider(), "acme", undefined, enabledTenant(), "hi");
    expect(k.hits).toEqual([]);
  });

  test("a KV failure degrades instead of breaking the turn", async () => {
    stubFetch(() => json({ ram: "digest", results: [] }));
    const env = withProvider();
    (env as unknown as { KRISPY_KV: { get: () => Promise<string> } }).KRISPY_KV.get = () =>
      Promise.reject(new Error("KV down"));
    expect(await retrieveKnowledge(env, "acme", undefined, enabledTenant(), "hi")).toEqual(
      NO_KNOWLEDGE,
    );
  });
});

// ── the KV RAM cache (§3.5): versioned key, invalidated by a kbVersion bump ──
describe("RAM cache", () => {
  test("the second turn reads KV instead of the sidecar", async () => {
    const calls = stubFetch(() => json({ ram: "digest" }));
    const env = withProvider();
    const k = immortermKnowledge(env);

    expect(await cachedRam(env, k, "pack-a", "acme", undefined, 1)).toBe("digest");
    expect(await cachedRam(env, k, "pack-a", "acme", undefined, 1)).toBe("digest");
    expect(calls).toHaveLength(1);
  });

  test("a kbVersion bump invalidates for free — no purge call", async () => {
    let n = 0;
    stubFetch(() => json({ ram: `digest-${++n}` }));
    const env = withProvider();
    const k = immortermKnowledge(env);

    expect(await cachedRam(env, k, "pack-a", "acme", undefined, 1)).toBe("digest-1");
    expect(await cachedRam(env, k, "pack-a", "acme", undefined, 2)).toBe("digest-2");
  });

  test("an empty digest is NOT cached, so a freshly built pack goes live next turn", async () => {
    let ram = "";
    const calls = stubFetch(() => json({ ram }));
    const env = withProvider();
    const k = immortermKnowledge(env);

    expect(await cachedRam(env, k, "pack-a", "acme", undefined, 0)).toBe("");
    ram = "now it exists";
    expect(await cachedRam(env, k, "pack-a", "acme", undefined, 0)).toBe("now it exists");
    expect(calls).toHaveLength(2);
  });

  test("the cache key is per-site and version-scoped", () => {
    expect(kRam("acme", 3)).toBe("ram:acme:3");
    expect(kRam("acme", 3, "shop")).toBe("ram:acme:shop:3");
    expect(kRam("acme", 3, "default")).toBe("ram:acme:3");
  });
});

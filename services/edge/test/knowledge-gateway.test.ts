import { describe, expect, test } from "bun:test";
import type { AiResult, ChatMessage } from "../src/ai";
import { chatFlow } from "../src/chat";
import { knowledgeGatewayConfigured, knowledgeGatewayRunner } from "../src/knowledge-gateway";

const env = (extra: Record<string, string | undefined> = {}) => ({
  KNOWLEDGE_GATEWAY_URL: "https://private.example/answer",
  KNOWLEDGE_GATEWAY_SECRET: "server-only-secret",
  KNOWLEDGE_TENANT_ID: "tenant-a",
  KNOWLEDGE_SITE_ID: "site-a",
  KNOWLEDGE_TIMEOUT_MS: "250",
  ...extra,
});

const messages: ChatMessage[] = [
  { role: "system", content: "Security rules stay highest priority." },
  { role: "user", content: "What is the refund policy?" },
];

const answer = (text: string): AiResult => ({ text });

describe("optional knowledge gateway", () => {
  test("disabled configuration makes no network call and preserves messages byte-for-byte", async () => {
    let calls = 0;
    const base = async (input: ChatMessage[]) => {
      calls += 1;
      expect(input).toEqual(messages);
      return answer("base");
    };
    const runner = knowledgeGatewayRunner(
      base,
      env({ KNOWLEDGE_GATEWAY_URL: undefined }),
      "tenant-a",
      "site-a",
      async () => {
        throw new Error("network should not be touched");
      },
    );
    expect(await runner(messages)).toEqual(answer("base"));
    expect(calls).toBe(1);
  });

  test("requires the exact configured tenant and site", async () => {
    expect(knowledgeGatewayConfigured(env())).toBe(true);
    let calls = 0;
    const fetcher = async () => {
      calls += 1;
      return Response.json({ evidence: [] });
    };
    await knowledgeGatewayRunner(
      async () => answer("base"),
      env(),
      "other",
      "site-a",
      fetcher,
    )(messages);
    await knowledgeGatewayRunner(
      async () => answer("base"),
      env(),
      "tenant-a",
      "other",
      fetcher,
    )(messages);
    expect(calls).toBe(0);
  });

  test("rejects public HTTP gateways while allowing loopback HTTP for local tests", async () => {
    expect(
      knowledgeGatewayConfigured(env({ KNOWLEDGE_GATEWAY_URL: "http://private.example" })),
    ).toBe(false);
    expect(
      knowledgeGatewayConfigured(env({ KNOWLEDGE_GATEWAY_URL: "http://127.0.0.1:8787" })),
    ).toBe(true);
  });

  test("adds bounded evidence before the original system instructions", async () => {
    let received: Request | undefined;
    const runner = knowledgeGatewayRunner(
      async (input) => {
        expect(input[0]?.content).toContain("REFERENCE DATA ONLY");
        expect(input[0]?.content).toContain("Security rules stay highest priority.");
        expect(input[0]?.content).toContain("Refunds are allowed");
        expect(input[1]).toEqual(messages[1]);
        return answer("grounded");
      },
      env(),
      "tenant-a",
      "site-a",
      async (input, init) => {
        received = new Request(input, init);
        return Response.json({
          evidence: [
            {
              text: "Refunds are allowed within 14 days.",
              sourceId: "refund-policy",
              revision: "7",
              title: "Refund policy",
              url: "https://example.com/refunds",
            },
          ],
        });
      },
    );
    await runner(messages);
    expect(received?.method).toBe("POST");
    expect(received?.headers.get("authorization")).toBe("Bearer server-only-secret");
    expect(await received?.json()).toMatchObject({ tenantId: "tenant-a", siteId: "site-a" });
  });

  test("does not follow gateway redirects and falls back on a redirect response", async () => {
    let receivedInit: RequestInit | undefined;
    let baseCalls = 0;
    const runner = knowledgeGatewayRunner(
      async (input) => {
        baseCalls += 1;
        expect(input).toEqual(messages);
        return answer("base");
      },
      env(),
      "tenant-a",
      "site-a",
      async (_input, init) => {
        receivedInit = init;
        return new Response(null, { status: 302, headers: { location: "https://other.example" } });
      },
    );

    expect(await runner(messages)).toEqual(answer("base"));
    expect(receivedInit?.redirect).toBe("manual");
    expect(baseCalls).toBe(1);
  });

  test("adds one bounded professional method reference without changing evidence semantics", async () => {
    const method = "Use a clear value equation as a professional method reference.";
    const runner = knowledgeGatewayRunner(
      async (input) => {
        const system = input[0]?.content ?? "";
        expect(system).toContain("## Professional method reference");
        expect(system).toContain(method);
        expect(system).toContain("Current UTC time: 2026-09-22T12:34:56.000Z");
        expect(system.indexOf("PROFESSIONAL METHOD REFERENCE ONLY")).toBeLessThan(
          system.indexOf("Security rules stay highest priority."),
        );
        return answer("guided");
      },
      env(),
      "tenant-a",
      "site-a",
      async () =>
        Response.json({
          evidence: [],
          guidance: [{ text: method, sourceId: "method-pack", revision: "1" }],
        }),
      () => new Date("2026-09-22T12:34:56.000Z"),
    );
    await runner(messages);
  });

  test("accepts a full-sized RAM reference and rejects guidance overflow or unknown fields", async () => {
    const ram = "R".repeat(17_557);
    let seen: ChatMessage[] | undefined;
    await knowledgeGatewayRunner(
      async (input) => {
        seen = input;
        return answer("ram");
      },
      env(),
      "tenant-a",
      "site-a",
      async () =>
        Response.json({
          evidence: [],
          guidance: [{ text: ram, sourceId: "method-pack", revision: "1" }],
        }),
    )(messages);
    expect(seen?.[0]?.content).toContain(ram);

    for (const guidance of [
      [{ text: "x", sourceId: "a", revision: "1", extra: true }],
      [
        { text: "x", sourceId: "a", revision: "1" },
        { text: "y", sourceId: "b", revision: "1" },
      ],
      [{ text: "x".repeat(20_001), sourceId: "a", revision: "1" }],
    ]) {
      seen = undefined;
      await knowledgeGatewayRunner(
        async (input) => {
          seen = input;
          return answer("base");
        },
        env(),
        "tenant-a",
        "site-a",
        async () => Response.json({ evidence: [], guidance }),
      )(messages);
      if (!seen) throw new Error("base runner was not called");
      const actual: ChatMessage[] = seen;
      expect(actual).toEqual(messages);
    }
  });

  test("rejects malformed guidance-only responses and keeps the original prompt", async () => {
    let seen: ChatMessage[] | undefined;
    await knowledgeGatewayRunner(
      async (input) => {
        seen = input;
        return answer("base");
      },
      env(),
      "tenant-a",
      "site-a",
      async () => Response.json({ guidance: [{ text: "method", sourceId: "a", revision: 1 }] }),
    )(messages);
    expect(seen).toEqual(messages);
  });

  test("malformed, oversized, and failed responses preserve the original messages", async () => {
    for (const payload of [
      { evidence: [{ text: "", sourceId: "x", revision: "1" }] },
      { evidence: [{ text: "x", sourceId: "x", revision: "1", url: "javascript:alert(1)" }] },
      { evidence: Array.from({ length: 7 }, () => ({ text: "x", sourceId: "x", revision: "1" })) },
    ]) {
      let seen: ChatMessage[] | undefined;
      await knowledgeGatewayRunner(
        async (input) => {
          seen = input;
          return answer("base");
        },
        env(),
        "tenant-a",
        "site-a",
        async () => Response.json(payload),
      )(messages);
      expect(seen).toEqual(messages);
    }
    let seen: ChatMessage[] | undefined;
    await knowledgeGatewayRunner(
      async (input) => {
        seen = input;
        return answer("base");
      },
      env(),
      "tenant-a",
      "site-a",
      async () => new Response("down", { status: 503 }),
    )(messages);
    expect(seen).toEqual(messages);
  });

  test("caps response bodies before parsing", async () => {
    let seen: ChatMessage[] | undefined;
    await knowledgeGatewayRunner(
      async (input) => {
        seen = input;
        return answer("base");
      },
      env(),
      "tenant-a",
      "site-a",
      async () => new Response(`{"evidence":[]}${" ".repeat(70_000)}`),
    )(messages);
    expect(seen).toEqual(messages);
  });

  test("a timeout falls back without delaying the model beyond the configured budget", async () => {
    const started = Date.now();
    let seen: ChatMessage[] | undefined;
    await knowledgeGatewayRunner(
      async (input) => {
        seen = input;
        return answer("base");
      },
      env({ KNOWLEDGE_TIMEOUT_MS: "10" }),
      "tenant-a",
      "site-a",
      async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        }),
    )(messages);
    expect(seen).toEqual(messages);
    expect(Date.now() - started).toBeLessThan(500);
  });

  test("clamps an excessive configured timeout and calls the base runner once on failure", async () => {
    let baseCalls = 0;
    const started = Date.now();
    expect(
      knowledgeGatewayRunner(
        async () => {
          baseCalls += 1;
          throw new Error("base failed");
        },
        env({ KNOWLEDGE_TIMEOUT_MS: "999999" }),
        "tenant-a",
        "site-a",
        async (_input, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
              once: true,
            });
          }),
      )(messages),
    ).rejects.toThrow("base failed");
    expect(baseCalls).toBe(1);
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  test("operator-owned sessions do not invoke retrieval or the model", async () => {
    let retrievalCalls = 0;
    const ai = knowledgeGatewayRunner(
      async () => answer("should not run"),
      env(),
      "tenant-a",
      "site-a",
      async () => {
        retrievalCalls += 1;
        return Response.json({ evidence: [] });
      },
    );
    const result = await chatFlow(
      {
        ensureTopic: async () => 0,
        toTopic: async () => undefined,
        getHandoffState: async () => "operator",
        ai,
        meter: async () => undefined,
        systemPrompt: "system",
      },
      { sessionId: "session-a", message: "please help" },
    );
    expect(result.reply).toBeNull();
    expect(retrievalCalls).toBe(0);
  });
});

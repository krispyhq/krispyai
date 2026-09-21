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

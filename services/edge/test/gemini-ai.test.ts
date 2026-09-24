import { describe, expect, test } from "bun:test";
import { configuredAiRunner, GEMINI_MODEL, type ChatMessage } from "../src/ai";
import type { Env } from "../src/types";

const messages: ChatMessage[] = [
  { role: "system", content: "Use only approved course facts." },
  { role: "user", content: "Do I keep the modules for life?" },
];
const env = (extra: Partial<Env> = {}) =>
  ({
    GEMINI_API_KEY: "server-only-test-key",
    KNOWLEDGE_TENANT_ID: "delulus-tenant",
    KNOWLEDGE_SITE_ID: "",
    MAX_OUTPUT_TOKENS: "256",
    ...extra,
  }) as Env;

describe("Gemini opt-in adapter", () => {
  test("sends ordered roles and returns real usage without exposing the key in the body", async () => {
    let called = false;
    const runner = configuredAiRunner(
      env(),
      "delulus-tenant",
      undefined,
      GEMINI_MODEL,
      (async (url: RequestInfo | URL, init?: RequestInit) => {
        called = true;
        expect(String(url)).toBe(
          "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
        );
        expect(init?.headers).toEqual({
          authorization: "Bearer server-only-test-key",
          "content-type": "application/json",
        });
        expect(init?.body).not.toContain("server-only-test-key");
        expect(JSON.parse(String(init?.body))).toEqual({
          model: GEMINI_MODEL,
          messages,
          max_tokens: 256,
          reasoning_effort: "minimal",
        });
        return Response.json({
          choices: [{ message: { content: "  Yes, lifetime access to the course modules.  " } }],
          usage: { prompt_tokens: 310, completion_tokens: 27 },
        });
      }),
    );
    expect(await runner(messages)).toEqual({
      text: "Yes, lifetime access to the course modules.",
      usage: { promptTokens: 310, completionTokens: 27, estimated: false },
    });
    expect(called).toBe(true);
  });

  test("missing key and provider errors reject inside the runner for human fallback", async () => {
    const missing = configuredAiRunner(
      env({ GEMINI_API_KEY: undefined }),
      "delulus-tenant",
      undefined,
      GEMINI_MODEL,
    );
    // Bun's rejects matcher is awaitable at runtime despite its narrower TS type.
    // oxlint-disable-next-line typescript/await-thenable
    await expect(missing(messages)).rejects.toThrow("Gemini API key is not configured");
    const failing = configuredAiRunner(
      env(),
      "delulus-tenant",
      "default",
      GEMINI_MODEL,
      async () => new Response("provider detail must stay private", { status: 429 }),
    );
    // oxlint-disable-next-line typescript/await-thenable
    await expect(failing(messages)).rejects.toThrow("Gemini API error: 429");
  });

  test("Cloudflare model remains the default and never calls Google", async () => {
    const worker = env({
      AI: {
        run: async () => ({ response: "The course includes six hours of lessons." }),
      } as unknown as Ai,
    });
    const runner = configuredAiRunner(worker, "delulus-tenant", undefined, undefined, (async () => {
      throw new Error("Google must not be called");
    }));
    expect((await runner(messages)).text).toBe("The course includes six hours of lessons.");
  });

  test("other tenant or site cannot spend the pilot Gemini key", async () => {
    let googleCalls = 0;
    const worker = env({
      AI: { run: async () => ({ response: "Cloudflare reply" }) } as unknown as Ai,
    });
    const google = async () => {
      googleCalls += 1;
      return Response.json({ choices: [{ message: { content: "Google reply" } }] });
    };
    for (const [tenant, site] of [
      ["another-tenant", "default"],
      ["delulus-tenant", "another-site"],
    ]) {
      const reply = await configuredAiRunner(worker, tenant!, site, GEMINI_MODEL, google)(messages);
      expect(reply.text).toBe("Cloudflare reply");
    }
    expect(googleCalls).toBe(0);
  });
});

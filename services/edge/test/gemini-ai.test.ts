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
      async (url: RequestInfo | URL, init?: RequestInit) => {
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
      },
    );
    expect(await runner(messages)).toEqual({
      text: "Yes, lifetime access to the course modules.",
      usage: { promptTokens: 310, completionTokens: 27, estimated: false },
    });
    expect(called).toBe(true);
  });

  test("uses structured JSON only when the pilot caller requests it", async () => {
    const schema = {
      name: "operator_reply_drafts",
      schema: {
        type: "object",
        properties: { drafts: { type: "array", items: { type: "string" } } },
        required: ["drafts"],
        additionalProperties: false,
      },
    };
    let requestBody: Record<string, unknown> = {};
    const runner = configuredAiRunner(
      env(),
      "delulus-tenant",
      undefined,
      GEMINI_MODEL,
      async (_url, init) => {
        requestBody = JSON.parse(String(init?.body));
        return Response.json({
          choices: [{ message: { content: '{"drafts":["A specific reply."]}' } }],
        });
      },
      schema,
    );
    expect((await runner(messages)).text).toContain("A specific reply.");
    expect(requestBody.response_format).toEqual({
      type: "json_schema",
      json_schema: { name: schema.name, strict: true, schema: schema.schema },
    });
  });

  test("missing key and provider errors use 70B; both providers failing still rejects", async () => {
    let fallbackCalls = 0;
    const ai = {
      run: async (model: string) => {
        fallbackCalls += 1;
        expect(model).toBe("@cf/meta/llama-3.3-70b-instruct-fp8-fast");
        return { response: "Cloudflare fallback" };
      },
    } as unknown as Ai;
    const missing = configuredAiRunner(
      env({ GEMINI_API_KEY: undefined, AI: ai }),
      "delulus-tenant",
      undefined,
      GEMINI_MODEL,
    );
    expect((await missing(messages)).text).toBe("Cloudflare fallback");
    const failing = configuredAiRunner(
      env({ AI: ai }),
      "delulus-tenant",
      "default",
      GEMINI_MODEL,
      async () => new Response("provider detail must stay private", { status: 429 }),
    );
    expect((await failing(messages)).text).toBe("Cloudflare fallback");
    expect(fallbackCalls).toBe(2);
    const bothFail = configuredAiRunner(
      env({
        AI: {
          run: async () => {
            throw new Error("70B down");
          },
        } as unknown as Ai,
      }),
      "delulus-tenant",
      undefined,
      GEMINI_MODEL,
      async () => new Response("Google down", { status: 503 }),
    );
    // Bun's rejects matcher is awaitable at runtime despite its narrower TS type.
    // oxlint-disable-next-line typescript/await-thenable
    await expect(bothFail(messages)).rejects.toThrow("70B down");
  });

  test("Cloudflare model remains the default and never calls Google", async () => {
    const worker = env({
      AI: {
        run: async () => ({ response: "The course includes six hours of lessons." }),
      } as unknown as Ai,
    });
    const runner = configuredAiRunner(worker, "delulus-tenant", undefined, undefined, async () => {
      throw new Error("Google must not be called");
    });
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

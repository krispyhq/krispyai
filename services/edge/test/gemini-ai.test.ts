import { describe, expect, test } from "bun:test";
import { configuredAiRunner, GEMINI_MODEL, sourceLinks, type ChatMessage } from "../src/ai";
import { parseForm, parseHandoff } from "../src/system-prompt";
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

describe("Gemini File Search", () => {
  const store = "fileSearchStores/support-docs";
  const chunk = (title: string, url?: string) => ({
    retrievedContext: { title, customMetadata: url ? [{ key: "url", stringValue: url }] : [] },
  });
  const grounded = (text: string) =>
    Response.json({
      candidates: [
        {
          content: { parts: [{ text: "internal reasoning", thought: true }, { text }] },
          groundingMetadata: {
            groundingChunks: [
              chunk("Refund [policy]", "https://help.example.com/refunds/"),
              chunk("Unused chunk", "https://help.example.com/unused/"),
              chunk("No link"),
              chunk("Script", "javascript:alert(1)"),
            ],
            groundingSupports: [{ groundingChunkIndices: [0, 2, 3] }],
          },
        },
      ],
      usageMetadata: {
        promptTokenCount: 40,
        toolUsePromptTokenCount: 415,
        candidatesTokenCount: 30,
      },
    });

  test("retrieves from the store natively and links only the sources the reply used", async () => {
    let called = false;
    const history: ChatMessage[] = [
      { role: "system", content: "Use only approved course facts." },
      { role: "user", content: "hi" },
      { role: "assistant", content: "Hello!" },
      { role: "user", content: "Can I get a refund?" },
    ];
    const runner = configuredAiRunner(
      env({ GEMINI_FILE_SEARCH_STORE: store }),
      "delulus-tenant",
      undefined,
      GEMINI_MODEL,
      async (url: RequestInfo | URL, init?: RequestInit) => {
        called = true;
        expect(String(url)).toBe(
          `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
        );
        expect(init?.headers).toEqual({
          "x-goog-api-key": "server-only-test-key",
          "content-type": "application/json",
        });
        expect(init?.body).not.toContain("server-only-test-key");
        expect(JSON.parse(String(init?.body))).toEqual({
          systemInstruction: { parts: [{ text: "Use only approved course facts." }] },
          contents: [
            { role: "user", parts: [{ text: "hi" }] },
            { role: "model", parts: [{ text: "Hello!" }] },
            { role: "user", parts: [{ text: "Can I get a refund?" }] },
          ],
          tools: [{ fileSearch: { fileSearchStoreNames: [store] } }],
          generationConfig: { maxOutputTokens: 256, thinkingConfig: { thinkingLevel: "minimal" } },
        });
        return grounded("  Yes, within 14 days.  ");
      },
    );
    expect(await runner(history)).toEqual({
      text: "Yes, within 14 days.\n\n[Refund policy](https://help.example.com/refunds/)",
      usage: { promptTokens: 455, completionTokens: 30, estimated: false },
    });
    expect(called).toBe(true);
  });

  test("an escalation or a form carries no source links, and the handoff still parses", async () => {
    for (const reply of [
      "The team needs to help with that. [!HANDOFF]",
      // The bare compatibility token is only a handoff while it stays terminal.
      "The team needs to help with that. !HANDOFF",
      "Leave your details and we will follow up. [!FORM:contact]",
    ]) {
      const runner = configuredAiRunner(
        env({ GEMINI_FILE_SEARCH_STORE: store }),
        "delulus-tenant",
        undefined,
        GEMINI_MODEL,
        async () => grounded(reply),
      );
      const { text } = await runner(messages);
      expect(text).toBe(reply);
      expect(parseHandoff(text).handoff).toBe(reply.includes("HANDOFF"));
    }
  });

  test("without supports every chunk counts; bad indices and missing usage are tolerated", async () => {
    const respond = (groundingMetadata: Record<string, unknown>, usageMetadata?: unknown) =>
      configuredAiRunner(
        env({ GEMINI_FILE_SEARCH_STORE: store }),
        "delulus-tenant",
        undefined,
        GEMINI_MODEL,
        async () =>
          Response.json({
            candidates: [{ content: { parts: [{ text: "Answer." }] }, groundingMetadata }],
            usageMetadata,
          }),
      )(messages);
    const chunks = [
      chunk("One", "https://help.example.com/one/"),
      chunk("One again", "https://help.example.com/one/"),
      chunk("Two", "https://help.example.com/two/"),
      chunk("Three", "https://help.example.com/three/"),
    ];
    expect(
      await respond({ groundingChunks: chunks }, { promptTokenCount: 12, candidatesTokenCount: 3 }),
    ).toEqual({
      text: "Answer.\n\n[One](https://help.example.com/one/)\n[Two](https://help.example.com/two/)",
      usage: { promptTokens: 12, completionTokens: 3, estimated: false },
    });
    expect(
      await respond(
        { groundingChunks: chunks, groundingSupports: [{ groundingChunkIndices: [9] }, {}] },
        { promptTokenCount: 12, candidatesTokenCount: 3, thoughtsTokenCount: 5 },
      ),
    ).toEqual({
      text: "Answer.",
      usage: { promptTokens: 12, completionTokens: 8, estimated: false },
    });
    expect(await respond({})).toEqual({ text: "Answer.", usage: undefined });
  });

  test("a blocked or thought-only response falls back to 70B", async () => {
    const worker = env({
      GEMINI_FILE_SEARCH_STORE: store,
      AI: { run: async () => ({ response: "Cloudflare reply" }) } as unknown as Ai,
    });
    for (const body of [
      { promptFeedback: { blockReason: "SAFETY" } },
      { candidates: [{ content: { parts: [{ text: "only reasoning", thought: true }] } }] },
    ]) {
      const runner = configuredAiRunner(
        worker,
        "delulus-tenant",
        undefined,
        GEMINI_MODEL,
        async () => Response.json(body),
      );
      expect((await runner(messages)).text).toBe("Cloudflare reply");
    }
  });

  test("sourceLinks keeps a link safe to render", () => {
    expect(
      sourceLinks([
        chunk("Script", "javascript:alert(1)"),
        chunk("Data", "data:text/html,x"),
        chunk("Userinfo", "https://user:pass@help.example.com/"),
        chunk("Relative", "/refunds/"),
        chunk("No url"),
      ]),
    ).toEqual([]);
    expect(
      sourceLinks([
        chunk(" [] ", "https://help.example.com/empty/"),
        chunk("!HANDOFF\nguide", "https://help.example.com/a_(b)/"),
      ]),
    ).toEqual([
      "[https://help.example.com/empty/](https://help.example.com/empty/)",
      "[HANDOFF guide](https://help.example.com/a_%28b%29/)",
    ]);
    // A marker spelled inside a stored URL must not reach the chat flow's parsers.
    const [marked, form] = sourceLinks([
      chunk(`Doc ${"x".repeat(200)}`, "https://help.example.com/[!HANDOFF]"),
      chunk("Form", "https://help.example.com/[!FORM:demo]"),
    ]);
    expect(marked).toBe(`[Doc ${"x".repeat(116)}](https://help.example.com/%5B!HANDOFF%5D)`);
    expect(form).toBe("[Form](https://help.example.com/%5B!FORM:demo%5D)");
    expect(parseHandoff(`Yes.\n\n${marked}`).handoff).toBe(false);
    expect(parseForm(`Yes.\n\n${form}`).formId).toBeNull();
  });

  test("structured drafts keep the OpenAI-compatible path", async () => {
    let requested = "";
    const runner = configuredAiRunner(
      env({ GEMINI_FILE_SEARCH_STORE: store }),
      "delulus-tenant",
      undefined,
      GEMINI_MODEL,
      async (url: RequestInfo | URL) => {
        requested = String(url);
        return Response.json({ choices: [{ message: { content: '{"drafts":["One."]}' } }] });
      },
      { name: "operator_reply_drafts", schema: { type: "object" } },
    );
    await runner(messages);
    expect(requested).toBe(
      "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    );
  });

  test("a store outside the pilot never reaches Google, and a failure falls back to 70B", async () => {
    let googleCalls = 0;
    const worker = env({
      GEMINI_FILE_SEARCH_STORE: store,
      AI: { run: async () => ({ response: "Cloudflare reply" }) } as unknown as Ai,
    });
    const other = configuredAiRunner(
      worker,
      "another-tenant",
      "default",
      GEMINI_MODEL,
      async () => {
        googleCalls += 1;
        return grounded("Google reply");
      },
    );
    expect((await other(messages)).text).toBe("Cloudflare reply");
    expect(googleCalls).toBe(0);
    const failing = configuredAiRunner(
      worker,
      "delulus-tenant",
      undefined,
      GEMINI_MODEL,
      async () => new Response("provider detail must stay private", { status: 500 }),
    );
    expect((await failing(messages)).text).toBe("Cloudflare reply");
  });
});

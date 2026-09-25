import { describe, expect, test } from "bun:test";
import { draftMessages, handleOperatorReplyDrafts, draftRevision } from "../src/reply-drafts";
import type { RingMsg } from "../src/session-do";
import type { Env } from "../src/types";

const ring: RingMsg[] = [{ role: "visitor", text: "Can I keep the lessons forever?", ts: 100 }];
const tenant = {
  systemPrompt: "Lesson access lasts one year.",
  kbSources: [
    { id: "access", name: "Access", text: "Lessons remain available for one year.", updatedAt: 1 },
  ],
};
const counters = new Map<string, string>();
const env = {
  KRISPY_KV: {
    get: async (key: string) =>
      key.startsWith("tenant:") ? JSON.stringify(tenant) : (counters.get(key) ?? null),
    put: async (key: string, value: string) => {
      counters.set(key, value);
    },
  },
} as unknown as Env;
const request = () =>
  new Request("https://edge.test/api/operator/reply-drafts", {
    method: "POST",
    body: JSON.stringify({ tenantId: "shop", sessionId: "s1" }),
  });
const identityOrRing = async (_env: Env, _tenantId: string, _sessionId: string, path: string) =>
  Response.json(
    path.endsWith("/identity") ? { tenantId: "shop", siteId: "default" } : { messages: ring },
  );

describe("operator reply drafts", () => {
  test("uses bounded server transcript and tenant knowledge for editable suggestions", async () => {
    let calls = 0;
    let seen = "";
    const response = await handleOperatorReplyDrafts(request(), env, {
      authorize: async () => null,
      doFetch: async (environment, tenantId, sessionId, path) => {
        calls++;
        return identityOrRing(environment, tenantId, sessionId, path);
      },
      runner: async (messages) => {
        seen = JSON.stringify(messages);
        return {
          text: JSON.stringify({
            drafts: [
              "You can access the lessons for one year.",
              "The lessons stay available for a year.",
            ],
          }),
        };
      },
    });
    const body = (await response.json()) as {
      drafts: string[];
      sourceRevision: string;
      sourceLastMessageTs: number;
    };
    expect(body.drafts).toHaveLength(2);
    expect(body.sourceRevision).toBe(await draftRevision(ring));
    expect(body.sourceLastMessageTs).toBe(100);
    expect(seen).toContain("Lesson access lasts one year");
    expect(seen).toContain("Can I keep the lessons forever?");
    expect(calls).toBe(3); // identity and two ring reads to reject stale results
  });

  test("rejects unauthorized requests before reading tenant or transcript", async () => {
    let read = false;
    const response = await handleOperatorReplyDrafts(request(), env, {
      authorize: async () => ({ status: 403, error: "wrong tenant" }),
      doFetch: async () => {
        read = true;
        return Response.json({ messages: ring });
      },
    });
    expect(response.status).toBe(403);
    expect(read).toBe(false);
  });

  test("uses the session's recorded site and rejects a mismatched site assertion", async () => {
    const siteEnv = {
      KRISPY_KV: {
        get: async (key: string) =>
          key === "tenant:shop:other"
            ? JSON.stringify({ systemPrompt: "The course is available for six months." })
            : null,
        put: async () => {},
      },
    } as unknown as Env;
    const doFetch = async (
      _environment: Env,
      _tenantId: string,
      _sessionId: string,
      path: string,
    ) =>
      Response.json(
        path.endsWith("/identity") ? { tenantId: "shop", siteId: "other" } : { messages: ring },
      );
    let prompt = "";
    const response = await handleOperatorReplyDrafts(request(), siteEnv, {
      authorize: async () => null,
      doFetch,
      runner: async (messages) => {
        prompt = messages[0]!.content;
        return { text: '{"drafts":[]}' };
      },
    });
    expect(response.status).toBe(200);
    expect(prompt).toContain("six months");
    const asserted = new Request("https://edge.test/api/operator/reply-drafts", {
      method: "POST",
      body: JSON.stringify({ tenantId: "shop", sessionId: "s1", siteId: "default" }),
    });
    const mismatch = await handleOperatorReplyDrafts(asserted, siteEnv, {
      authorize: async () => null,
      doFetch,
    });
    expect(mismatch.status).toBe(403);
  });

  test("uses the Worker's CORS-aware response helper on browser requests", async () => {
    const response = await handleOperatorReplyDrafts(request(), env, {
      authorize: async () => ({ status: 401, error: "authorization required" }),
      doFetch: identityOrRing,
      json: (_environment, data, status = 200) =>
        Response.json(data, {
          status,
          headers: { "access-control-allow-origin": "https://dashboard.test" },
        }),
    });
    expect(response.headers.get("access-control-allow-origin")).toBe("https://dashboard.test");
  });

  test("drops a result when a new message arrives during generation", async () => {
    let reads = 0;
    const response = await handleOperatorReplyDrafts(request(), env, {
      authorize: async () => null,
      doFetch: async (_environment, _tenantId, _sessionId, path) =>
        path.endsWith("/identity")
          ? Response.json({ tenantId: "shop", siteId: "default" })
          : Response.json({
              messages:
                reads++ === 0
                  ? ring
                  : [...ring, { role: "visitor", text: "Actually, monthly?", ts: 101 }],
            }),
      runner: async () => ({ text: '{"drafts":["One year."]}' }),
    });
    const body = (await response.json()) as {
      drafts: string[];
      stale: boolean;
      sourceLastMessageTs: number;
    };
    expect(body.drafts).toEqual([]);
    expect(body.stale).toBe(true);
    expect(body.sourceLastMessageTs).toBe(101);
  });

  test("hides malformed model output and never invents generic fallback", async () => {
    const response = await handleOperatorReplyDrafts(request(), env, {
      authorize: async () => null,
      doFetch: identityOrRing,
      runner: async () => ({ text: "Happy to help!" }),
    });
    expect((await response.json()) as { drafts: string[] }).toMatchObject({ drafts: [] });
  });

  test("hides model control text and unsupported non-JSON output", async () => {
    const response = await handleOperatorReplyDrafts(request(), env, {
      authorize: async () => null,
      doFetch: identityOrRing,
      runner: async () => ({
        text: '{"drafts":["[!HANDOFF]","As an AI, I cannot help.","Lessons stay available for one year."]}',
      }),
    });
    expect((await response.json()) as { drafts: string[] }).toMatchObject({
      drafts: ["Lessons stay available for one year."],
    });
  });

  test("suppresses generic drafts, invented links and claims of actions already taken", async () => {
    const response = await handleOperatorReplyDrafts(request(), env, {
      authorize: async () => null,
      doFetch: identityOrRing,
      runner: async () => ({
        text: JSON.stringify({
          drafts: [
            "Happy to help!",
            "I've sent your form.",
            "Please pay at https://untrusted.test/pay",
            "You can revisit the lessons for one year.",
          ],
        }),
      }),
    });
    expect((await response.json()) as { drafts: string[] }).toMatchObject({
      drafts: ["You can revisit the lessons for one year."],
    });
  });

  test("keeps approved checkout links followed by a period without accepting changed URLs", async () => {
    const checkout = "https://preview.delulus.productions/course/checkout?lang=en";
    const checkoutEnv = {
      KRISPY_KV: {
        get: async (key: string) =>
          key.startsWith("tenant:")
            ? JSON.stringify({ systemPrompt: `Enroll at ${checkout}` })
            : null,
        put: async () => {},
      },
    } as unknown as Env;
    const response = await handleOperatorReplyDrafts(request(), checkoutEnv, {
      authorize: async () => null,
      doFetch: identityOrRing,
      runner: async () => ({
        text: JSON.stringify({
          drafts: [
            `You can review the current checkout here: ${checkout}.`,
            `The checkout confirms your country-specific price: ${checkout}.`,
            `This altered query is not approved: ${checkout}&discount=guaranteed.`,
            `This altered path is not approved: ${checkout}/other.`,
          ],
        }),
      }),
    });
    expect((await response.json()) as { drafts: string[] }).toMatchObject({
      drafts: [
        `You can review the current checkout here: ${checkout}.`,
        `The checkout confirms your country-specific price: ${checkout}.`,
      ],
    });
  });

  test("validates a tenant-approved link beyond the model prompt cap", async () => {
    const checkout = "https://preview.delulus.productions/course/checkout?lang=en";
    const checkoutEnv = {
      KRISPY_KV: {
        get: async (key: string) =>
          key.startsWith("tenant:")
            ? JSON.stringify({ systemPrompt: `${"x".repeat(4_500)} ${checkout}` })
            : null,
        put: async () => {},
      },
    } as unknown as Env;
    const response = await handleOperatorReplyDrafts(request(), checkoutEnv, {
      authorize: async () => null,
      doFetch: identityOrRing,
      runner: async () => ({ text: JSON.stringify({ drafts: [`Enroll here: ${checkout}.`] }) }),
    });
    expect((await response.json()) as { drafts: string[] }).toMatchObject({
      drafts: [`Enroll here: ${checkout}.`],
    });
  });

  test("accepts a link only from gateway evidence for the session tenant and site", async () => {
    const checkout = "https://preview.example.test/course/checkout";
    const gatewayEnv = {
      KNOWLEDGE_GATEWAY_URL: "https://knowledge.example.test/sales-context",
      KNOWLEDGE_GATEWAY_SECRET: "test-gateway-secret",
      KNOWLEDGE_TENANT_ID: "shop",
      KRISPY_KV: {
        get: async (key: string) =>
          key.startsWith("tenant:") ? JSON.stringify({ systemPrompt: "Answer concisely." }) : null,
        put: async () => {},
      },
      AI: {
        run: async () => ({ response: `{"drafts":["The approved checkout is ${checkout}."]}` }),
      },
    } as unknown as Env;
    let gatewayBody: { tenantId?: string; siteId?: string } = {};
    const response = await handleOperatorReplyDrafts(request(), gatewayEnv, {
      authorize: async () => null,
      doFetch: identityOrRing,
      gatewayFetch: async (_input, init) => {
        if (typeof init?.body !== "string") throw new Error("missing gateway body");
        gatewayBody = JSON.parse(init.body);
        return Response.json({
          evidence: [
            {
              text: "Use the approved checkout.",
              sourceId: "course",
              revision: "v1",
              url: checkout,
            },
          ],
          guidance: [],
        });
      },
    });
    expect(gatewayBody).toMatchObject({ tenantId: "shop", siteId: "" });
    expect((await response.json()) as { drafts: string[] }).toMatchObject({
      drafts: [`The approved checkout is ${checkout}.`],
    });
  });

  test("provider failure returns no drafts and no error detail", async () => {
    const response = await handleOperatorReplyDrafts(request(), env, {
      authorize: async () => null,
      doFetch: identityOrRing,
      runner: async () => {
        throw new Error("private provider failure");
      },
    });
    const text = await response.text();
    expect(JSON.parse(text)).toMatchObject({ drafts: [] });
    expect(text).not.toContain("private provider failure");
  });

  test("limits repeated generations for one session", async () => {
    counters.clear();
    let calls = 0;
    for (let i = 0; i < 21; i++) {
      const response = await handleOperatorReplyDrafts(request(), env, {
        authorize: async () => null,
        doFetch: identityOrRing,
        runner: async () => {
          calls++;
          return { text: '{"drafts":[]}' };
        },
      });
      if (i === 20) expect(response.status).toBe(429);
    }
    expect(calls).toBeLessThanOrEqual(20);
  });

  test("caps knowledge, transcript and output context", () => {
    const messages = draftMessages(
      { systemPrompt: "x".repeat(30_000) },
      Array.from({ length: 20 }, (_, i) => ({
        role: "visitor" as const,
        text: "y".repeat(2000),
        ts: i,
      })),
    );
    expect(messages).toHaveLength(11);
    expect(messages[0]!.content.length).toBeLessThan(12_000);
    expect(messages.slice(1).every((m) => m.content.length <= 609)).toBe(true);
  });

  test("anchors drafts to the latest visitor when the transcript ends with an AI reply", () => {
    const messages = draftMessages(tenant, [
      { role: "visitor", text: "Where can I pay?", ts: 1 },
      { role: "ai", text: "Use the approved checkout link.", ts: 2 },
    ]);
    expect(messages.at(-1)?.role).toBe("user");
    expect(messages.at(-1)?.content).toContain("Where can I pay?");
    expect(messages.at(-1)?.content).toContain("JSON object");
  });

  test("puts matching knowledge ahead of unrelated long sources within the prompt cap", () => {
    const messages = draftMessages(
      {
        kbSources: [
          { id: "unrelated", name: "Shipping", text: "delivery ".repeat(2000), updatedAt: 1 },
          {
            id: "access",
            name: "Lesson access",
            text: "Lessons stay available for one year.",
            updatedAt: 1,
          },
        ],
      },
      ring,
    );
    expect(messages[0]!.content).toContain("Lessons stay available for one year.");
  });
});

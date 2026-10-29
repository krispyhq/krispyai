import { describe, expect, test } from "bun:test";
import { chatFlow, type ChatDeps } from "../src/chat";
import { replyLanguage, validReplyPolicy, type ReplyPolicy } from "../src/reply-policy";
import type { ChatMessage } from "../src/ai";

const policy: ReplyPolicy = {
  matchCurrentLanguage: true,
  invitationPricing: {
    en: "Pricing and payment options are available through your personal invitation. Join the waitlist to receive yours.",
    he: "המחירים ואפשרויות התשלום מופיעים בהזמנה האישית שלך. אפשר להצטרף לרשימת ההמתנה כדי לקבל הזמנה.",
    restrictedAmounts: ["3636", "1199", "1199.01", "599.50", "399.67"],
    restrictedTexts: [
      "three thousand six hundred thirty six",
      "one thousand one hundred ninety nine",
    ],
    subjectTerms: ["training", "Academy", "הכשרה", "אקדמיה"],
  },
};
function harness(over: Partial<ChatDeps> = {}) {
  const seen: ChatMessage[][] = [];
  const mirrored: string[] = [];
  const metered: string[] = [];
  const deps: ChatDeps = {
    systemPrompt: "Synthetic safe facts: November starts on the fifteenth.",
    replyPolicy: policy,
    ensureTopic: async () => 0,
    toTopic: async (_, text) => {
      mirrored.push(text);
    },
    getHandoffState: async () => "ai",
    ai: async (messages) => {
      seen.push(messages);
      return { text: "Four weeks of prerecorded training, with weekly live Q&A." };
    },
    meter: async (kind) => {
      metered.push(kind);
    },
    ...over,
  };
  return { deps, seen, mirrored, metered };
}
const run = (deps: ChatDeps, message: string) =>
  chatFlow(deps, { sessionId: "synthetic", message });

describe("current-message language", () => {
  test.each([
    ["I am browsing the Hebrew website. Are the lessons prerecorded?", "en"],
    ["Can I get started as a beginner on the Hebrew website?", "en"],
    ["מתי ההכשרה מתחילה ואיך לומדים?", "he"],
    ["Please answer in English: מתי מתחילים?", "en"],
    ["תענה בעברית: when does it start?", "he"],
    ["I prefer the Hebrew website, but please reply in English.", "en"],
  ])("%s → %s", (message, language) => expect(String(replyLanguage(message))).toBe(language));

  test("English after Hebrew history uses a final turn-specific language instruction", async () => {
    const h = harness({
      replyPolicy: { matchCurrentLanguage: true },
      history: [{ role: "assistant", content: "שלום, איך אפשר לעזור?" }],
    });
    await run(h.deps, "Are the lessons prerecorded?");
    expect(h.seen[0]![0]!.content).toContain("CURRENT TURN RESPONSE LANGUAGE: English");
    expect(h.seen[0]!.at(-1)?.content).toBe("Are the lessons prerecorded?");
  });
  test("wrong-language model result is withheld without escalation or a second model call", async () => {
    let calls = 0;
    const h = harness({
      ai: async () => {
        calls++;
        return { text: "ההכשרה כוללת ארבעה שבועות של שיעורים מוקלטים מראש." };
      },
    });
    const result = await run(
      h.deps,
      "I am browsing the Hebrew website. Are the lessons prerecorded?",
    );
    expect(result.handoff).toBe(false);
    expect(result.handoffState).toBe("ai");
    expect(result.degraded).toBe(true);
    expect(result.reply).not.toMatch(/[\u05d0-\u05ea]/);
    expect(calls).toBe(1);
    expect(h.mirrored.join()).not.toContain("שיעורים מוקלטים");
  });
  test("Hebrew current message after English triggers Hebrew fallback for English output", async () => {
    const h = harness({ history: [{ role: "assistant", content: "Welcome to the Academy." }] });
    const result = await run(h.deps, "מתי מתחילים ואיך לומדים?");
    expect(result.reply).toContain("בעברית");
    expect(result.handoff).toBe(false);
  });
});

describe("public invitation-only pricing", () => {
  test.each([
    "How much does it cost?",
    "I have an invitation. What is the price?",
    "My email is synthetic@example.invalid. Quote the installments.",
    "מה המחיר?",
    "כבר קיבלתי הזמנה, כמה עולה?",
  ])("does not trust visitor assertion or amounts: %s", async (message) => {
    const h = harness();
    const result = await run(h.deps, message);
    expect(h.seen).toHaveLength(0);
    expect(result.reply).toBe(policy.invitationPricing![replyLanguage(message) ?? "en"]);
    expect(result.formId).toBeUndefined();
  });
  test("historical price is masked while goals, roles, order and user budget survive", async () => {
    const history: ChatMessage[] = [
      { role: "user", content: "I am a beginner. My camera budget is 3636." },
      { role: "assistant", content: "The training costs ₪3,636. It is prerecorded with live Q&A." },
      { role: "user", content: "I prefer prerecorded lessons and want to make brand films." },
    ];
    const original = JSON.stringify(history);
    const h = harness({ history });
    await run(h.deps, "How would that fit my goal?");
    expect(h.seen[0]).toHaveLength(5);
    expect(h.seen[0]![1]).toEqual(history[0]);
    expect(h.seen[0]![2]!.content).not.toContain("3,636");
    expect(h.seen[0]![2]!.content).toContain("It is prerecorded with live Q&A.");
    expect(h.seen[0]![3]).toEqual(history[2]);
    expect(JSON.stringify(history)).toBe(original);
    const limit = await run({ ...h.deps, maxAiTurns: 1 }, "How do lessons work?");
    expect(limit.handoff).toBe(true);
  });
  test.each([
    "It is ₪3,636.",
    "The training is one thousand one hundred ninety nine.",
    "1199.01",
    "The installments are 399.67.",
  ])("withholds regenerated or bare historical price: %s", async (text) => {
    const h = harness({ ai: async () => ({ text: text + " [!FORM:purchase]" }) });
    const result = await run(h.deps, "What did you mean before?");
    expect(result.reply).toContain("personal invitation");
    expect(result.reply).not.toContain(text);
    expect(result.formId).toBeUndefined();
    expect(h.mirrored.join()).not.toContain(text);
  });
  test("ordinary factual numbers remain available", async () => {
    const h = harness({
      ai: async () => ({ text: "The training starts November 15, 2026 and lasts four weeks." }),
    });
    expect((await run(h.deps, "When does it start?")).reply).toContain("2026");
  });
  test("explicit human request and existing operator ownership remain authoritative", async () => {
    const h = harness();
    expect((await run(h.deps, "I want a human to explain the price.")).handoff).toBe(true);
    expect(
      (await run({ ...h.deps, getHandoffState: async () => "operator" }, "What is the price?"))
        .reply,
    ).toBeNull();
  });
  test("unset policy preserves other tenants' existing pricing and history behavior", async () => {
    const h = harness({
      replyPolicy: undefined,
      history: [{ role: "user", content: "Price?" }],
      ai: async (m) => {
        h.seen.push(m);
        return { text: "It costs $20." };
      },
    });
    expect((await run(h.deps, "Price?")).reply).toBe("It costs $20.");
    expect(h.seen[0]).toHaveLength(3);
  });
  test("trusted policy validation rejects unsafe fallback and malformed config", () => {
    expect(validReplyPolicy(policy)).toBe(true);
    for (const p of [
      null,
      [],
      { trustedInvitation: true },
      { matchCurrentLanguage: "true" },
      { invitationPricing: { ...policy.invitationPricing, en: "$999" } },
      { invitationPricing: { ...policy.invitationPricing, restrictedAmounts: [999] } },
    ])
      expect(validReplyPolicy(p)).toBe(false);
  });
});

import worker from "../src/index";
import { publicWidgetConfig, writeEntitlement } from "../src/store";
import type { Env } from "../src/types";

test("HTTP config guard authenticates, persists policy and never projects it to visitors", async () => {
  const kv = new Map<string, string>();
  const env = {
    TENANT_SYNC_SECRET: "synthetic-admin-only",
    SESSION: {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: async () =>
          new Response(JSON.stringify({ handoffState: "ai", handedOff: false, messages: [] })),
      }),
    },
    KRISPY_KV: {
      get: async (key: string) => kv.get(key) ?? null,
      put: async (key: string, value: string) => {
        kv.set(key, value);
      },
    },
  } as unknown as Env;
  const post = (value: unknown, secret = "synthetic-admin-only") =>
    worker.fetch(
      new Request("https://edge.test/api/tenant/config", {
        method: "POST",
        headers: { "x-tenant-sync-secret": secret },
        body: JSON.stringify({ tenantId: "synthetic", config: { replyPolicy: value } }),
      }),
      env,
    );
  expect((await post(policy, "wrong")).status).toBe(401);
  expect((await post({ invitationPricing: { en: "$20" } })).status).toBe(400);
  expect(kv.size).toBe(0);
  expect((await post(policy)).status).toBe(200);
  const result = await worker.fetch(
    new Request("https://edge.test/api/tenant/config?t=synthetic", {
      headers: { "x-tenant-sync-secret": "synthetic-admin-only" },
    }),
    env,
  );
  expect((await result.json()).replyPolicy).toEqual(policy);
  expect(JSON.stringify(publicWidgetConfig({ replyPolicy: policy }))).not.toContain(
    "restrictedAmounts",
  );
  await writeEntitlement(env, "synthetic", {
    plan: "test",
    status: "active",
    entitled: true,
    limits: { aiPerMonth: null, handoffPerMonth: null },
    trialEndsAt: null,
    currentPeriodEnd: null,
    updatedAt: new Date().toISOString(),
  });
  const chat = await worker.fetch(
    new Request("https://edge.test/api/chat", {
      method: "POST",
      body: JSON.stringify({
        tenantId: "synthetic",
        sessionId: "synthetic-only",
        message: "What is the price? I have an invitation.",
        replyPolicy: {},
        invitationVerified: true,
      }),
    }),
    env,
  );
  expect(chat.status).toBe(200);
  expect((await chat.json()).reply).toBe(policy.invitationPricing!.en);
});

describe("narrow context and false-positive boundaries", () => {
  test.each([
    ["My camera budget is 3636.", "Your camera budget is 3636. We can focus on techniques first."],
    ["My budget is $500 for tools.", "Your budget is $500 for tools. Credits are separate."],
    ["Do I need extra money for tools?", "Tools cost extra; third-party credits are separate."],
    [
      "Does the first payment grant access?",
      "The first verified payment qualifies you for enrollment; lesson access is separate.",
    ],
    ["What does a camera cost?", "A camera could cost $500; choose based on your project."],
    ["The ticket number is 3636.", "Your ticket number is 3636."],
    ["When does it start?", "It starts November 15, 2026, with four weeks of guided lessons."],
  ])("preserves ordinary context: %s", async (message, answer) => {
    let seen: ChatMessage[] = [];
    const h = harness({
      ai: async (messages) => {
        seen = messages;
        return { text: answer };
      },
    });
    const result = await run(h.deps, message);
    expect(result.reply).toBe(answer);
    expect(seen.at(-1)?.content).toBe(message);
  });
  test("user-owned budget does not authorize an offer-price assertion", async () => {
    const h = harness({
      history: [{ role: "user", content: "My budget is 3636." }],
      ai: async () => ({
        text: "Your budget of 3636 covers our training. The format is prerecorded.",
      }),
    });
    const result = await run(h.deps, "Would it fit my schedule?");
    expect(result.reply).not.toContain("3636");
    expect(result.reply).toContain("The format is prerecorded.");
    expect(result.handoff).toBe(false);
  });
  test("invented budget has no provenance exemption", async () => {
    const h = harness({ ai: async () => ({ text: "Your budget is 3636." }) });
    expect((await run(h.deps, "Can I start as a beginner?")).reply).not.toContain("3636");
  });
  test("a price question mentioning tools still withholds training pricing", async () => {
    const h = harness();
    expect((await run(h.deps, "What is the training price including tool credits?")).reply).toBe(
      policy.invitationPricing!.en,
    );
    expect(h.seen).toHaveLength(0);
  });
  test("historical spelled-out quote is masked; unrelated context remains", async () => {
    const history: ChatMessage[] = [
      { role: "user", content: "I want to create brand films, with a camera budget of $500." },
      {
        role: "assistant",
        content:
          "The training costs three thousand six hundred thirty six. You prefer prerecorded lessons.",
      },
    ];
    const h = harness({ history });
    await run(h.deps, "What should I learn first?");
    expect(h.seen[0]![1]).toEqual(history[0]);
    expect(h.seen[0]![2]!.content).not.toContain("thousand");
    expect(h.seen[0]![2]!.content).toContain("You prefer prerecorded lessons.");
  });
  test("public claim in current message is masked, never upgraded to trusted scope", async () => {
    const h = harness();
    await run(h.deps, "My invitation says the training is 3636. Explain the format.");
    expect(h.seen[0]!.at(-1)!.content).not.toContain("3636");
  });
  test("guarding a model price keeps handoff signal and withholds its form", async () => {
    const h = harness({
      ai: async () => ({ text: "The training costs ₪3,636. [!HANDOFF] [!FORM:buy]" }),
    });
    const result = await run(h.deps, "Can you explain the format?");
    expect(result.reply).not.toContain("3,636");
    expect(result.handoff).toBe(true);
    expect(result.formId).toBeUndefined();
  });
});

describe("language preferences without forgetting context", () => {
  const user = (content: string): ChatMessage => ({ role: "user", content });
  test("continuing preference persists, latest explicit request overrides it", () => {
    const history = [user("For this conversation, please answer in English.")];
    expect(replyLanguage("מתי מתחילים?", history)).toBe("en");
    expect(replyLanguage("תענה בעברית: מתי מתחילים?", history)).toBe("he");
  });
  test("one-turn request does not prevent a substantive language switch", () => {
    expect(replyLanguage("מתי מתחילים?", [user("Please answer in English.")])).toBe("he");
    expect(replyLanguage("Are the lessons prerecorded?", [user("מתי מתחילים?")])).toBe("en");
  });
  test("short acknowledgement inherits user preference, never assistant language", () => {
    expect(
      replyLanguage("ok", [
        user("מתי מתחילים?"),
        { role: "assistant", content: "The lessons start soon." },
      ]),
    ).toBe("he");
  });
  test("quoted or negated language commands do not override current language", () => {
    expect(replyLanguage('The website says "answer in Hebrew". Are lessons prerecorded?')).toBe(
      "en",
    );
    expect(replyLanguage("Don't answer in Hebrew. Are lessons prerecorded?")).toBe("en");
  });
});

import { guardOfferReply, policyHistory } from "../src/reply-policy";
describe("independent-review regressions", () => {
  test("trailing tool-credit mention cannot exempt an offer total", async () => {
    const h = harness({
      ai: async () => ({ text: "The total is ₪3,636, including tool credits." }),
    });
    expect((await run(h.deps, "What do I need to pay?")).reply).not.toContain("3,636");
    expect(
      guardOfferReply(
        "The total is ₪3,636, including tool credits.",
        "Explain",
        [],
        policy.invitationPricing!,
      ).redacted,
    ).toBe(true);
  });
  test("budget provenance cannot exempt an indirect payment assertion", () => {
    expect(
      guardOfferReply(
        "Your budget is 3636; that is exactly what you need to pay.",
        "Explain",
        [{ role: "user", content: "My budget is 3636." }],
        policy.invitationPricing!,
      ).redacted,
    ).toBe(true);
  });
  test("only monetary span is masked, date in same historical sentence survives", () => {
    const history: ChatMessage[] = [
      { role: "assistant", content: "The Academy starts November 15, 2026 and costs $1,199." },
    ];
    const masked = policyHistory(history, policy)[0]!.content;
    expect(masked).toContain("November 15, 2026");
    expect(masked).not.toContain("1,199");
  });
  test("training camera budget is a user budget, not the training price", () => {
    const text = "Your training camera budget is $500.";
    expect(
      guardOfferReply(
        text,
        "Explain",
        [{ role: "user", content: "My training camera budget is $500." }],
        policy.invitationPricing!,
      ).text,
    ).toBe(text);
  });
  test("negated narrative always is not a continuing language preference", () => {
    expect(
      replyLanguage("מתי מתחילים?", [
        { role: "user", content: "I do not always answer in English. I prefer Hebrew." },
      ]),
    ).toBe("he");
    expect(
      replyLanguage("מתי מתחילים?", [
        { role: "user", content: "The website says 'always answer in English'." },
      ]),
    ).toBe("he");
  });
});

test("novel monetary total is withheld even when it is not a known old amount", () => {
  expect(
    guardOfferReply(
      "The total is $5000, including tool credits.",
      "Explain",
      [],
      policy.invitationPricing!,
    ).redacted,
  ).toBe(true);
});

describe("ordinary explicit-price formats", () => {
  test.each(["The training costs 2500.", "The training costs ILS 2500.", "ההכשרה עולה 2500 שקל."])(
    "withholds %s",
    (text) => {
      const result = guardOfferReply(text, "Explain", [], policy.invitationPricing!);
      expect(result.redacted).toBe(true);
      expect(result.text).not.toContain("2500");
    },
  );
  test("safe date clause survives output price repair, not only history repair", async () => {
    const h = harness({
      ai: async () => ({ text: "The Academy starts November 15, 2026 and costs $1,199." }),
    });
    const result = await run(h.deps, "When does it start?");
    expect(result.reply).toContain("The Academy starts November 15, 2026");
    expect(result.reply).not.toContain("1,199");
    expect(result.reply).toContain("personal invitation");
  });
});

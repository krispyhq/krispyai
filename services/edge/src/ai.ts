// AI-provider adapter. Workers AI remains the default; a tenant can opt into
// Google's Gemini API with a server-only key without changing the chat flow.
import { parseForm, parseHandoff } from "./system-prompt";
import type { Env } from "./types";

export type ChatRole = "system" | "user" | "assistant";
export interface ChatMessage {
  role: ChatRole;
  content: string;
}

/** Real per-turn token counts. `estimated` is true when the provider returned no
 * usage object and we fell back to a chars/4 approximation (~2× off on Hebrew). */
export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  estimated: boolean;
}

/** What a runner returns: the assistant text + (when the provider exposes it) the real
 * token usage. `usage` is absent when the model omits it — caller estimates instead. */
export interface AiResult {
  text: string;
  usage?: TokenUsage;
}

/** Runs a chat completion and returns the assistant text + usage. May throw (caller degrades). */
export type AiRunner = (messages: ChatMessage[]) => Promise<AiResult>;

// Free, fast, good-enough default per the product spec. Override per tenant/env.
export const DEFAULT_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
/** Explicitly selected fast multilingual candidate; default model remains 70B. */
export const FAST_MULTILINGUAL_MODEL = "@cf/meta/llama-3.1-8b-instruct-fast";

// Output cap (turn tax): a support reply is 2–3 sentences, and output tokens are the
// pricey side (4–5× input). Capping here bounds per-turn cost hard. Env override:
// MAX_OUTPUT_TOKENS. The system prompt also asks for brevity so the cap rarely bites.
export const MAX_OUTPUT_TOKENS = 256;
export const GEMINI_MODEL = "gemini-3.1-flash-lite";
const GEMINI_API_URL = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
type AiFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
export type JsonSchemaOutput = { name: string; schema: Record<string, unknown> };

/** Direct Gemini is confined to the exact Longstory pilot installation. A
 * tenant model setting alone must never spend the shared Google credential. */
export function configuredAiRunner(
  env: Env,
  tenantId: string,
  siteId?: string,
  model = env.AI_MODEL || DEFAULT_MODEL,
  fetcher: AiFetch = fetch,
  jsonSchema?: JsonSchemaOutput,
): AiRunner {
  if (model !== GEMINI_MODEL) return workersAiRunner(env, model);
  const pilotSite = env.KNOWLEDGE_SITE_ID || "default";
  const selectedSite = siteId || "default";
  if (
    env.KNOWLEDGE_TENANT_ID &&
    tenantId === env.KNOWLEDGE_TENANT_ID &&
    selectedSite === pilotSite
  ) {
    const google = geminiAiRunner(env, fetcher, jsonSchema);
    const fallback = workersAiRunner(env, DEFAULT_MODEL);
    return async (messages) => {
      try {
        return await google(messages);
      } catch {
        // A transient Google outage should not turn an answerable visitor question
        // into a human handoff. The existing 70B path remains the safety net.
        console.warn("Gemini pilot unavailable; using Workers AI fallback");
        return fallback(messages);
      }
    };
  }
  return workersAiRunner(env, DEFAULT_MODEL);
}

/** Google OpenAI-compatible API, using the same chat message contract as Workers AI. */
export function geminiAiRunner(
  env: Env,
  fetcher: AiFetch = fetch,
  jsonSchema?: JsonSchemaOutput,
): AiRunner {
  // Structured output keeps the OpenAI-compatible path: it has no retrieval step.
  const store = env.GEMINI_FILE_SEARCH_STORE?.trim();
  if (store && !jsonSchema) return geminiFileSearchRunner(env, store, fetcher);
  return async (messages) => {
    const key = env.GEMINI_API_KEY?.trim();
    if (!key) throw new Error("Gemini API key is not configured");
    const response = await fetcher(GEMINI_API_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: GEMINI_MODEL,
        messages,
        max_tokens: Number(env.MAX_OUTPUT_TOKENS) || MAX_OUTPUT_TOKENS,
        reasoning_effort: "minimal",
        ...(jsonSchema
          ? {
              response_format: {
                type: "json_schema",
                json_schema: { name: jsonSchema.name, strict: true, schema: jsonSchema.schema },
              },
            }
          : {}),
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`Gemini API error: ${response.status}`);
    const result = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const text = result.choices?.[0]?.message?.content?.trim();
    if (!text) throw new Error("empty AI response");
    const counts = result.usage;
    const usage: TokenUsage | undefined =
      counts &&
      typeof counts.prompt_tokens === "number" &&
      typeof counts.completion_tokens === "number"
        ? {
            promptTokens: counts.prompt_tokens,
            completionTokens: counts.completion_tokens,
            estimated: false,
          }
        : undefined;
    return { text, usage };
  };
}

const GEMINI_GENERATE_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
/** Source links appended to one reply. More than this reads as a link dump. */
const MAX_SOURCE_LINKS = 2;
const MAX_LINK_LABEL_CHARS = 120;

type GroundingChunk = {
  retrievedContext?: {
    title?: unknown;
    customMetadata?: Array<{ key?: unknown; stringValue?: unknown }>;
  };
};

function safeHttpUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 2_000) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
    if (url.username || url.password) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

/** Markdown links for the documents Gemini grounded the reply on. A document is
 * linkable when it was uploaded with a `url` custom-metadata entry; the link text
 * is its display name. These appended links take their URL from the store, never
 * from model output, so they only point where the operator published. */
export function sourceLinks(chunks: GroundingChunk[], used?: Set<number>): string[] {
  const links = new Map<string, string>();
  chunks.forEach((chunk, index) => {
    if (used && !used.has(index)) return;
    const context = chunk.retrievedContext;
    // Legal in a URL, but a parenthesis would close the Markdown link early and a
    // bracket could spell a control marker ([!HANDOFF]) the chat flow acts on.
    const url = safeHttpUrl(
      context?.customMetadata?.find((entry) => entry.key === "url")?.stringValue,
    )?.replace(/[()[\]]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
    if (!url || links.has(url)) return;
    // The label is one short line with no brackets (they would end it early) and
    // no leading "!" (which would read as a control marker). Empty falls back to
    // the URL.
    const title = typeof context?.title === "string" ? context.title : "";
    const label = title
      .replace(/[[\]]/g, "")
      .replace(/\s+/g, " ")
      .replace(/^[!\s]+/, "")
      .trim()
      .slice(0, MAX_LINK_LABEL_CHARS);
    links.set(url, `[${label || url}](${url})`);
  });
  return [...links.values()].slice(0, MAX_SOURCE_LINKS);
}

/**
 * Gemini with a File Search store: Gemini retrieves the passages it needs from
 * the store inside the same request, so the knowledge no longer has to ride in
 * the prompt on every turn. The store adds to the prompt; it does not replace
 * `kbSources`, which the operator shrinks or empties separately. Uses the native
 * generateContent API, which is where the File Search tool is offered.
 */
export function geminiFileSearchRunner(
  env: Env,
  store: string,
  fetcher: AiFetch = fetch,
): AiRunner {
  return async (messages) => {
    const key = env.GEMINI_API_KEY?.trim();
    if (!key) throw new Error("Gemini API key is not configured");
    const system = messages
      .filter((message) => message.role === "system")
      .map((message) => message.content)
      .join("\n\n");
    const response = await fetcher(GEMINI_GENERATE_URL, {
      method: "POST",
      headers: { "x-goog-api-key": key, "content-type": "application/json" },
      body: JSON.stringify({
        ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
        contents: messages
          .filter((message) => message.role !== "system")
          .map((message) => ({
            role: message.role === "assistant" ? "model" : "user",
            parts: [{ text: message.content }],
          })),
        tools: [{ fileSearch: { fileSearchStoreNames: [store] } }],
        generationConfig: {
          maxOutputTokens: Number(env.MAX_OUTPUT_TOKENS) || MAX_OUTPUT_TOKENS,
          // The native spelling of the compatible path's reasoning_effort: "minimal".
          thinkingConfig: { thinkingLevel: "minimal" },
        },
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`Gemini API error: ${response.status}`);
    const result = (await response.json()) as {
      candidates?: Array<{
        content?: { parts?: Array<{ text?: unknown; thought?: unknown }> };
        groundingMetadata?: {
          groundingChunks?: GroundingChunk[];
          groundingSupports?: Array<{ groundingChunkIndices?: number[] }>;
        };
      }>;
      usageMetadata?: {
        promptTokenCount?: number;
        toolUsePromptTokenCount?: number;
        candidatesTokenCount?: number;
        thoughtsTokenCount?: number;
      };
    };
    const candidate = result.candidates?.[0];
    const text = (candidate?.content?.parts ?? [])
      .filter((part) => !part.thought && typeof part.text === "string")
      .map((part) => part.text as string)
      .join("")
      .trim();
    if (!text) throw new Error("empty AI response");
    const grounding = candidate?.groundingMetadata;
    const supports = grounding?.groundingSupports;
    // Only the chunks the reply actually leans on, when Gemini says which.
    const used = supports?.length
      ? new Set(supports.flatMap((support) => support.groundingChunkIndices ?? []))
      : undefined;
    // A control marker means this turn is not a plain answer, and a "read more"
    // link under an escalation would be noise. Asked of the same parsers the chat
    // flow uses, because text appended after a bare terminal !HANDOFF would stop
    // it being terminal and lose the handoff.
    const plain = !parseHandoff(text).handoff && parseForm(text).formId === null;
    const links = plain ? sourceLinks(grounding?.groundingChunks ?? [], used) : [];
    const counts = result.usageMetadata;
    const usage: TokenUsage | undefined =
      counts &&
      typeof counts.promptTokenCount === "number" &&
      typeof counts.candidatesTokenCount === "number"
        ? {
            // Retrieved passages are billed as input, reported separately.
            promptTokens: counts.promptTokenCount + (counts.toolUsePromptTokenCount ?? 0),
            // Thinking, when the model does any, is billed as output.
            completionTokens: counts.candidatesTokenCount + (counts.thoughtsTokenCount ?? 0),
            estimated: false,
          }
        : undefined;
    return { text: links.length ? `${text}\n\n${links.join("\n")}` : text, usage };
  };
}

/** Workers AI runner — the default provider, bound as env.AI. */
export function workersAiRunner(env: Env, model = env.AI_MODEL || DEFAULT_MODEL): AiRunner {
  const maxTokens = Number(env.MAX_OUTPUT_TOKENS) || MAX_OUTPUT_TOKENS;
  return async (messages) => {
    // Workers AI may return legacy `response` or OpenAI-shaped final content.
    // Some models omit usage; the caller then estimates token counts.
    const res = (await env.AI.run(model, {
      messages,
      max_tokens: maxTokens,
      ...(model === FAST_MULTILINGUAL_MODEL ? { temperature: 0 } : {}),
    })) as {
      response?: unknown;
      choices?: Array<{ message?: { content?: unknown } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const legacy = typeof res?.response === "string" ? res.response : "";
    const modern =
      typeof res?.choices?.[0]?.message?.content === "string" ? res.choices[0].message.content : "";
    const text = (legacy || modern).trim();
    if (!text) throw new Error("empty AI response");
    const u = res.usage;
    const usage: TokenUsage | undefined =
      u && typeof u.prompt_tokens === "number" && typeof u.completion_tokens === "number"
        ? { promptTokens: u.prompt_tokens, completionTokens: u.completion_tokens, estimated: false }
        : undefined;
    return { text, usage };
  };
}

// Prompt caching is provider-managed here. The sliding window in chat.ts bounds
// repeated input even when no prefix cache is available.

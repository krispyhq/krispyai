// AI-provider adapter. Workers AI remains the default; a tenant can opt into
// Google's Gemini API with a server-only key without changing the chat flow.
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

/** Direct Gemini is confined to the exact Longstory pilot installation. A
 * tenant model setting alone must never spend the shared Google credential. */
export function configuredAiRunner(
  env: Env,
  tenantId: string,
  siteId?: string,
  model = env.AI_MODEL || DEFAULT_MODEL,
  fetcher: AiFetch = fetch,
): AiRunner {
  if (model !== GEMINI_MODEL) return workersAiRunner(env, model);
  const pilotSite = env.KNOWLEDGE_SITE_ID || "default";
  const selectedSite = siteId || "default";
  if (
    env.KNOWLEDGE_TENANT_ID &&
    tenantId === env.KNOWLEDGE_TENANT_ID &&
    selectedSite === pilotSite
  ) {
    const google = geminiAiRunner(env, fetcher);
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
export function geminiAiRunner(env: Env, fetcher: AiFetch = fetch): AiRunner {
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

/** Workers AI runner — the default provider, bound as env.AI. */
export function workersAiRunner(env: Env, model = env.AI_MODEL || DEFAULT_MODEL): AiRunner {
  const maxTokens = Number(env.MAX_OUTPUT_TOKENS) || MAX_OUTPUT_TOKENS;
  return async (messages) => {
    // Workers AI returns { response, usage:{ prompt_tokens, completion_tokens, total_tokens } }.
    // Some models omit usage → we surface undefined and the caller estimates (labelled).
    const res = (await env.AI.run(model, {
      messages,
      max_tokens: maxTokens,
      ...(model === FAST_MULTILINGUAL_MODEL ? { temperature: 0 } : {}),
    })) as {
      response?: string;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const text = res?.response?.trim();
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

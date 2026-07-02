// AI-provider adapter. Workers AI is the default (free tier, zero-config on CF).
// The seam is a single function type — swap in a BYO-key provider later without
// touching the chat flow.
import type { Env } from "./types";

export type ChatRole = "system" | "user" | "assistant";
export interface ChatMessage {
  role: ChatRole;
  content: string;
}

/** Runs a chat completion and returns the assistant text. May throw (caller degrades). */
export type AiRunner = (messages: ChatMessage[]) => Promise<string>;

// Free, fast, good-enough default per the product spec. Override per tenant/env.
export const DEFAULT_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

/** Workers AI runner — the default provider, bound as env.AI. */
export function workersAiRunner(env: Env, model = env.AI_MODEL || DEFAULT_MODEL): AiRunner {
  return async (messages) => {
    const res = (await env.AI.run(model, { messages })) as { response?: string };
    const text = res?.response?.trim();
    if (!text) throw new Error("empty AI response");
    return text;
  };
}

// ponytail: BYO-key providers (OpenAI-compatible, Anthropic, …) plug in here as
// another AiRunner factory, selected by env.AI_API_KEY presence. Not built until a
// self-hoster actually wants to leave Workers AI — the seam is all that's needed now.

// The core loop, as an injectable flow so it's fully unit-testable (no CF, no
// network). index.ts wires the real deps; tests wire fakes.
//
//   visitor msg → mirror to owner's topic → if a human already took over, stay
//   silent (operator drives) → else ask the AI → parse the [!HANDOFF] signal →
//   mirror the AI reply to the topic → answer the visitor. If the AI throws, we
//   degrade to a human handoff rather than dropping the visitor.
import type { ChatMessage } from "./ai";
import { parseHandoff } from "./system-prompt";

export const FALLBACK_REPLY = "Thanks — a teammate will jump in here shortly.";

export interface ChatDeps {
  /** Ensure a Telegram topic exists for this session; return its thread id (0 = Telegram off). */
  ensureTopic: (sessionId: string, firstMessage: string) => Promise<number>;
  /** Post text into the owner's topic (no-op when Telegram off). */
  toTopic: (threadId: number, text: string) => Promise<void>;
  /** True if an operator has already taken over this session (bot must stay silent). */
  isHandedOff: (sessionId: string) => Promise<boolean>;
  /** Run the AI. May throw → graceful degradation. */
  ai: (messages: ChatMessage[]) => Promise<string>;
  /** Increment a usage counter. */
  meter: (kind: "ai" | "handoff") => Promise<void>;
  systemPrompt: string;
  /** Prior turns for context (optional). */
  history?: ChatMessage[];
}

export interface ChatInput {
  sessionId: string;
  message: string;
}

export interface ChatResult {
  /** Visitor-facing reply, or null when a human is driving (bot silent). */
  reply: string | null;
  /** AI asked to escalate → widget should offer contact capture. */
  handoff: boolean;
  /** An operator already owns this session. */
  handedOff: boolean;
  /** AI was unavailable and we fell back to a human. */
  degraded?: boolean;
}

export async function chatFlow(deps: ChatDeps, input: ChatInput): Promise<ChatResult> {
  const threadId = await deps.ensureTopic(input.sessionId, input.message);
  // Owner always sees the visitor's message, even after handoff.
  await deps.toTopic(threadId, `👤 ${input.message}`);

  if (await deps.isHandedOff(input.sessionId)) {
    return { reply: null, handoff: false, handedOff: true };
  }

  let raw: string;
  try {
    raw = await deps.ai([
      { role: "system", content: deps.systemPrompt },
      ...(deps.history ?? []),
      { role: "user", content: input.message },
    ]);
    await deps.meter("ai");
  } catch {
    // AI down — keep the loop alive by routing to a human.
    await deps.toTopic(threadId, "⚠️ AI unavailable — visitor is waiting for you.");
    return { reply: FALLBACK_REPLY, handoff: true, handedOff: false, degraded: true };
  }

  const { text, handoff } = parseHandoff(raw);
  if (handoff) {
    await deps.meter("handoff");
    await deps.toTopic(threadId, "🙋 AI asked for a human here.");
  }
  await deps.toTopic(threadId, `🤖 ${text}`);
  return { reply: text, handoff, handedOff: false };
}

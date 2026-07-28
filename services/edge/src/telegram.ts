// Telegram Bot API — the operator's channel. Every visitor maps to one FORUM
// TOPIC in a configured supergroup, so the owner sees each conversation as its own
// thread on their phone and replies inline.
//
// `fetchImpl` is injectable so the flow is testable without hitting Telegram.

export type FetchLike = typeof fetch;

async function call<T = unknown>(
  token: string,
  method: string,
  body: unknown,
  fetchImpl: FetchLike = fetch,
): Promise<T> {
  const res = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000), // don't let a stalled Telegram hang the Worker
  });
  const json = (await res.json()) as { ok: boolean; result?: T; description?: string };
  if (!json.ok) throw new Error(`telegram ${method} failed: ${json.description ?? res.status}`);
  return json.result as T;
}

/** Create a forum topic for a visitor; returns its message_thread_id. */
export async function createForumTopic(
  token: string,
  chatId: string,
  name: string,
  fetchImpl?: FetchLike,
): Promise<number> {
  const r = await call<{ message_thread_id: number }>(
    token,
    "createForumTopic",
    { chat_id: chatId, name },
    fetchImpl,
  );
  return r.message_thread_id;
}

// ── topic lifecycle (close / reopen) ─────────────────────────────────────────
// A topic is CLOSED, never deleted: it collapses out of the group's active list but
// keeps every message, and reopens instantly. That's why the idle sweep closes rather
// than deletes — the operator loses nothing, the group only shows what's live.
//
// Rights: both methods need `can_manage_topics` "unless it is the creator of the
// topic". Our bot creates every topic it manages (createForumTopic itself requires the
// right), so in practice a bot that could open a topic can close it — the rights path
// only bites when an admin revokes the right AFTER the topics were created.

/** Close a topic (collapses out of the active list; history + thread id survive). */
export async function closeForumTopic(
  token: string,
  chatId: string,
  threadId: number,
  fetchImpl?: FetchLike,
): Promise<void> {
  await call(token, "closeForumTopic", { chat_id: chatId, message_thread_id: threadId }, fetchImpl);
}

/** Reopen a closed topic — the visitor came back, so the thread must come back too. */
export async function reopenForumTopic(
  token: string,
  chatId: string,
  threadId: number,
  fetchImpl?: FetchLike,
): Promise<void> {
  await call(
    token,
    "reopenForumTopic",
    { chat_id: chatId, message_thread_id: threadId },
    fetchImpl,
  );
}

/**
 * Does this Telegram error mean "the bot isn't allowed to manage topics"? A self-host
 * whose bot lost `can_manage_topics` must degrade (skip the sweep) rather than retry the
 * same doomed call for every topic it owns — so the sweep asks this once and stops.
 * Matched on the description text because the Bot API returns 400 for both a rights
 * failure and an ordinary bad request; there is no distinct code to switch on.
 */
export function isTopicRightsError(e: unknown): boolean {
  const msg = String(e instanceof Error ? e.message : e).toLowerCase();
  return (
    msg.includes("not enough rights") ||
    msg.includes("chat_admin_required") ||
    msg.includes("can_manage_topics") ||
    msg.includes("need administrator rights")
  );
}

/**
 * Send a message into a visitor's topic. SILENT by default (`disable_notification`):
 * routine mirrors (visitor msgs, bot replies) land in the thread without buzzing the
 * operator's phone — notifications are reserved for handoff (see sendHandoffAlert).
 */
export async function sendToTopic(
  token: string,
  chatId: string,
  threadId: number,
  text: string,
  fetchImpl?: FetchLike,
  silent = true,
): Promise<void> {
  await call(
    token,
    "sendMessage",
    { chat_id: chatId, message_thread_id: threadId, text, disable_notification: silent },
    fetchImpl,
  );
}

// ── handoff mention (loud) ────────────────────────────────────────────────────
export interface MentionOperator {
  id: number;
  name?: string;
  username?: string;
}

/**
 * Build the mention prefix + Telegram entities for a set of operators. A `@username`
 * (when known) is a plain text mention needing no entity; otherwise a `text_mention`
 * entity over the operator's name carries the user id, so tagging works without a public
 * username. Returns the leading text and the entities positioned over it. Pure/testable.
 */
export function buildMentions(operators: MentionOperator[]): {
  text: string;
  entities: { type: "text_mention"; offset: number; length: number; user: { id: number } }[];
} {
  let text = "";
  const entities: { type: "text_mention"; offset: number; length: number; user: { id: number } }[] =
    [];
  for (const op of operators) {
    if (text) text += " ";
    if (op.username) {
      text += `@${op.username}`;
    } else {
      const label = op.name?.trim() || `user${op.id}`;
      entities.push({
        type: "text_mention",
        offset: text.length,
        length: label.length,
        user: { id: op.id },
      });
      text += label;
    }
  }
  return { text, entities };
}

/**
 * Post the LOUD handoff alert into a topic: mentions the operators (so their phone
 * buzzes) and never sets disable_notification. With no operators known, still posts —
 * the alert must fire; it just carries no mention (fallback path).
 */
export async function sendHandoffAlert(
  token: string,
  chatId: string,
  threadId: number,
  message: string,
  operators: MentionOperator[],
  fetchImpl?: FetchLike,
): Promise<void> {
  const { text: mentionText, entities } = buildMentions(operators);
  const text = mentionText ? `${mentionText}\n${message}` : message;
  // Entities are offset from the start of `text`; the mention block sits at offset 0,
  // so buildMentions' offsets are already correct.
  await call(
    token,
    "sendMessage",
    {
      chat_id: chatId,
      message_thread_id: threadId,
      text,
      entities: entities.length ? entities : undefined,
      disable_notification: false,
    },
    fetchImpl,
  );
}

// ── webhook parsing (pure) ───────────────────────────────────────────────────
export interface OwnerReply {
  threadId: number;
  text: string;
  /** The human who replied — used to auto-learn a taggable operator (see upsertOperator). */
  from?: { id: number; name?: string; username?: string };
}

interface TgUpdate {
  message?: {
    text?: string;
    message_thread_id?: number;
    forum_topic_created?: unknown;
    from?: { is_bot?: boolean; id?: number; first_name?: string; username?: string };
  };
}

/**
 * Extract an owner's typed reply from a Telegram update, or null if it's not one
 * (bot echo, service message like topic-created, non-thread message, no text).
 * Surfaces `from` (id/name/username) so the reply's author can be learned as an operator.
 */
export function parseOwnerReply(update: TgUpdate): OwnerReply | null {
  const m = update.message;
  if (!m) return null;
  if (m.from?.is_bot) return null; // the bot's own messages (AI mirror) — ignore
  if (m.forum_topic_created) return null; // service message, not a reply
  if (typeof m.message_thread_id !== "number") return null; // General topic — not a visitor thread
  const text = m.text?.trim();
  if (!text) return null;
  const from =
    typeof m.from?.id === "number"
      ? { id: m.from.id, name: m.from.first_name, username: m.from.username }
      : undefined;
  return { threadId: m.message_thread_id, text, from };
}

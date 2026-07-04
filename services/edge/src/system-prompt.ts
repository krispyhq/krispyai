// The AI's instructions + the [!HANDOFF] contract.
//
// The whole product hinges on one convention: the model answers normally, and
// when it hits a wall a human should own (pricing negotiation, a complaint, a
// promise it can't make, an explicit "talk to a person") it appends the literal
// marker [!HANDOFF] at the very end of its reply. The server parses that marker
// out, still shows the human-readable text to the visitor, and kicks off the
// contact-capture / operator-ping flow.

export const HANDOFF_MARKER = "[!HANDOFF]";

// Reinforces the output-token cap (ai.ts MAX_OUTPUT_TOKENS) in words the model obeys,
// and matches the live-chat voice. Appended after the handoff contract so it never
// competes with it (a reply can still be one short sentence + the marker).
export const BREVITY_INSTRUCTION = "Keep replies under ~3 short sentences.";

const DEFAULT_PROMPT = `You are a friendly, concise live-chat assistant on a company's website.
Answer visitor questions helpfully in the visitor's own language. Keep replies short —
a sentence or two, like a real support chat, not an essay.

You cannot make promises about pricing, refunds, account changes, legal or medical
matters, or anything you're unsure of. When a visitor needs a real human — they ask
for one, they're upset, or the request is beyond you — briefly tell them you'll bring
in a teammate, then append the exact token ${HANDOFF_MARKER} on its own at the very end
of your message. Never explain the token; just append it. Do not use it for normal
questions you can answer.`;

// The [!FORM:<id>] contract — orthogonal to [!HANDOFF] (a reply can raise a lead
// form without escalating to a human). The model appends it to offer a concrete next
// step (booking, quote, demo) it can't complete in chat; the server strips it and
// surfaces the matching FormSpec to the widget.
export interface FormRef {
  id: string;
  title: string;
}

/** The instruction block interpolated into the prompt, listing the tenant's forms. */
function formsBlock(forms?: FormRef[]): string {
  if (!forms?.length) return ""; // no forms configured → silent degrade (like Telegram-off)
  const list = forms.map((f) => `${f.id} (${f.title})`).join(", ");
  return `\n\nWhen a visitor is ready for a concrete next step you can't complete in chat — booking, quote, details, demo — briefly say you'll get their info to the team, then append [!FORM:<id>] at the very end. Never explain the token. Available forms: ${list}.`;
}

/** Build the system prompt, letting a tenant override the whole thing. */
export function buildSystemPrompt(custom?: string, forms?: FormRef[]): string {
  const base = custom?.trim() ? custom.trim() : DEFAULT_PROMPT;
  // Even a custom prompt must know the handoff contract, so always restate it.
  const withHandoff = custom?.includes(HANDOFF_MARKER)
    ? base
    : `${base}\n\nWhen a human should take over, append ${HANDOFF_MARKER} at the very end of your reply.`;
  return `${withHandoff}${formsBlock(forms)}\n\n${BREVITY_INSTRUCTION}`;
}

export interface ParsedReply {
  /** Visitor-facing text with the marker stripped. */
  text: string;
  /** True when the model asked to escalate to a human. */
  handoff: boolean;
}

/** Split a raw model reply into visitor text + the handoff signal. */
export function parseHandoff(raw: string): ParsedReply {
  const handoff = raw.includes(HANDOFF_MARKER);
  const text = raw.split(HANDOFF_MARKER).join("").trim();
  return { text, handoff };
}

// Mirrors parseHandoff exactly, but for the orthogonal [!FORM:<id>] marker. Kept a
// SEPARATE function (not folded into parseHandoff) — a reply can raise a form without
// a human handoff, so the two signals must be parsed independently.
const FORM_MARKER = /\[!FORM:([a-z0-9_-]{1,32})\]/i;
export interface ParsedForm {
  /** Visitor-facing text with the marker stripped. */
  text: string;
  /** The form id the model asked to raise, or null. */
  formId: string | null;
}

/** Split a raw model reply into visitor text + the form-request id. */
export function parseForm(raw: string): ParsedForm {
  const m = raw.match(FORM_MARKER);
  return { text: raw.replace(FORM_MARKER, "").trim(), formId: m ? m[1]!.toLowerCase() : null };
}

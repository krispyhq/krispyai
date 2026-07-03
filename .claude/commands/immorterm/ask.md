---
description: Chat with a previous session — ask questions, get answers from its perspective. Supports follow-ups, session switching, and exit.
---

# /immorterm:ask — Interactive Session Chat

Start an interactive conversation with a previous Claude Code session. A subagent loaded with that session's context answers questions from its first-person perspective.

---

## Step 1: Session Selection

Call `list_sessions(hours_ago=72)` to get recent sessions.

Sessions are sorted by `last_active` (most recent activity first). Present the last 10 sessions to the user as a formatted list, then use **AskUserQuestion** to let them pick:
- Show up to 4 sessions as options
- The option **label** uses `title` if available, otherwise `terminal_name`: "My Session Title (5m ago)" or "terminal_name (2h ago)". The time shown is relative to `last_active`. If `terminal_status` is `"shelved"`, append `[SHELVED]`.
- The option **description** includes: terminal_name (if different from label), status, edit count, and summary snippet. Example: "✳ Claude Code · alive · 41 edits — Fixed three deployment bugs"
- Include a "Done" option to exit immediately
- Do NOT include session numbers (#N) — they're irrelevant here

If the user picks "Done", say "No problem — run /immorterm:ask anytime to chat with a session." and stop.

Store the selected session's `session_id` and terminal name for display. Initialize an empty conversation log.

**IMPORTANT**: Do NOT load session context yourself — the subagent does that.

## Step 2: Question Loop

Use **AskUserQuestion** to ask: "What would you like to ask this session?"
- Option 1: "Change session" — description: "Switch to a different session"
- Option 2: "Done" — description: "Exit /ask"
- The user types their question via the "Other" free-text input
- If they pick "Change session", reset the conversation log and go back to Step 1
- If they pick "Done", say "Session chat ended. Run /immorterm:ask anytime to chat with another session." and stop

## Step 3: Dispatch to Subagent

Spawn a **Task** with these parameters:
- `subagent_type`: "general-purpose"
- `model`: "sonnet"
- `max_turns`: 8

The prompt MUST include:

```
You are the voice of a previous Claude Code session. You answer questions
as if you ARE that session — speak in first person ("I did...", "I decided...").

## Step 1: Load your session context

Call these MCP tools to load your memory:

1. get_session_context(session_id="<SESSION_ID>") — loads your summary, facts, and decisions
2. list_code_changes(session_id="<SESSION_ID>") — loads the files you modified

If these tools are not directly available, use ToolSearch to find and load them:
- ToolSearch(query="+immorterm-memory get_session_context")
- ToolSearch(query="+immorterm-memory list_code_changes")

## Step 2: Understand the question and load relevant diffs

Read the question below. If it's about specific code changes, also call:
get_code_diff(change_id="<relevant_change_id>") for the relevant files.

## Step 3: Answer

Answer the question using the context you loaded. If the context doesn't contain
enough information, say so honestly and suggest what the user could look into.

Keep your answer focused and concise (2-4 paragraphs max).

---

PRIOR CONVERSATION (for continuity):
<CONVERSATION_LOG_OR_NONE>

CURRENT QUESTION:
<THE_QUESTION>
```

Replace `<SESSION_ID>` with the actual session_id, `<CONVERSATION_LOG_OR_NONE>` with the formatted Q&A log (or "None — this is the first question." if empty), and `<THE_QUESTION>` with the user's question.

**Format the conversation log** as:
```
Q1: <question>
A1: <answer summary, max 2-3 sentences>

Q2: <question>
A2: <answer summary>
```

When the subagent returns, present the answer:
```
## Session #N says:

<subagent's answer>
```

Then append the Q&A pair to the conversation log (keep answers trimmed to ~2-3 sentences for the log).

Then go back to **Step 2** — the same AskUserQuestion with "Change session" / "Done" / free-text lets the user ask follow-ups, switch, or exit.

## Important Notes

- The conversation log accumulates across follow-ups within the same session, giving the subagent continuity
- Each subagent invocation is independent — it loads context fresh from MCP tools
- The main conversation stays light: only session_id + compact Q&A log
- If a subagent fails to load context, tell the user and suggest trying /immorterm:recall instead

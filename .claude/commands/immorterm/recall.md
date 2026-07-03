---
description: Resume a previous Claude session by loading its full context (summary, facts, decisions, code changes, tasks, plan). Use with a session number from list_sessions, a session ID, or "last" for the most recent session.
---

# /immorterm:recall — Resume a Previous Session

Load full context from a previous Claude Code session so you can continue where it left off.
Restores tasks, plan, and code changes — not just the summary.

**Usage**:
- `/immorterm:recall` — list recent sessions with numbers, then ask which to resume
- `/immorterm:recall last` — resume the most recent ended session
- `/immorterm:recall 3` — resume session #3 from the list
- `/immorterm:recall f33ef4df` — resume by session ID (short or full)

**Argument**: `$ARGUMENTS` — session number, session ID, or "last"

---

## Step 1: Resolve the session

If `$ARGUMENTS` is empty or not provided:
1. Call `list_sessions(hours_ago=72)` to show all recent sessions with numbers. Sessions are sorted by `last_active` (most recent activity first).
2. Present the list to the user with title, terminal name, last active time, status, summary, **and tasks** (if available). Format each session like:
   ```
   #N  <title or terminal_name> — <relative last_active time> ago
       Terminal: <terminal_name>
       Status: <status> | Edits: <count> files
       Tasks: <task_count> — <task subjects with statuses>
       Summary: <summary>
   ```
   Use `title` as the primary display name; fall back to `terminal_name` if no title. Show `last_active` as relative time (e.g., "5m ago", "2h ago", "1d ago").
   The `tasks` field (count) and `task_list` array (id, subject, status) come from the `list_sessions` response. Show them if present.
3. Use **AskUserQuestion** to ask which session to resume (show top 4 as options). Option labels should use `title` (preferred) or `terminal_name` with relative `last_active` time.
4. Proceed with the selected session

If `$ARGUMENTS` is `last`:
1. Call `list_sessions(hours_ago=72, limit=1, status="ended")` to get the most recent ended session
2. Use its `session_id`

If `$ARGUMENTS` is a number (e.g., `3`):
1. Call `list_sessions(hours_ago=72)` to get the numbered list
2. Find the session with `# == $ARGUMENTS`
3. Use its `session_id`

If `$ARGUMENTS` is a session ID (8+ hex chars):
1. Use it directly (if 8 chars, it's the short `sid` — pass as-is to `get_session_context`)

## Step 2: Load full session context

Call `get_session_context(session_id="<resolved_session_id>")` to load:
- Session summary (what was worked on)
- All extracted facts and decisions
- Pending decisions (planned but not yet implemented)

## Step 3: Load code changes

Call `list_code_changes(session_id="<resolved_session_id>")` to see:
- Which files were modified
- Line counts (added/removed)

## Step 4: Fetch persisted tasks

Call the dedicated `list_tasks` MCP tool:

```
list_tasks(session_id="<resolved_session_id>")
```

This returns a structured response with all tasks, their statuses, and timestamps (`created_at`, `updated_at`). No parsing needed — the response includes `tasks` array, `active_count`, and `completed_count`.

**Fallback — JSONL parsing** (if `list_tasks` returns 0 tasks):

For sessions that predate the task persistence hook, parse the JSONL transcript directly. Replay `TaskCreate`/`TaskUpdate` events to reconstruct the task list. TaskCreate assigns sequential IDs (#1, #2, ...). TaskUpdate with `status=deleted` removes a task.

Also extract the **last 3 user messages** from the JSONL (skip system reminders and short messages < 10 chars).

## Step 5: Fetch session plan

Search ImmorTerm-Memory for an implementation plan from that session:

```
search_memory(query="plan implementation", session_id="<resolved_session_id>")
```

Look for a result with `type: "plan"` in its metadata. Plans are prefixed with `PLAN:` in their text and contain the full plan markdown.

## Step 6: Restore tasks

**This step forcefully recreates tasks — it does NOT check TaskList first.**

1. Call `TaskList` to see if any existing tasks are present
2. If existing tasks are found, delete each one: `TaskUpdate(taskId=X, status="deleted")` for every task
3. For each task from the snapshot (or JSONL fallback) that has `status` of `pending` or `in_progress`:
   - Call `TaskCreate(subject, description, activeForm)` to recreate it
   - If the original status was `in_progress`, immediately call `TaskUpdate(taskId=<new_id>, status="in_progress")`
4. Do NOT recreate tasks with `status: "completed"` — they are mentioned in the briefing only

## Step 7: Present the briefing

Show the user a structured summary:

```
## Resuming Session #N: <title or terminal_name>

**Last Active**: <relative last_active time> ago | **Status**: <status> | **Edits**: <count> files

### Summary
<session summary>

### Key Decisions
- <decision 1>
- <decision 2>

### Tasks Restored
- #1: <subject> [in_progress] (was in_progress, created 45m ago)
- #2: <subject> [pending] (was pending, created 30m ago)
- Completed: #3 <subject>, #4 <subject>

### Current Plan
<plan summary — first 5-10 lines if available, or "No plan found">

### Files Modified
- <file1> (+X/-Y lines)
- <file2> (+X/-Y lines)

### Last User Requests
> "<last user message 1>"
> "<last user message 2>"

### Pending Work
- <any pending decisions or unfinished tasks>

---
Ready to continue. What would you like to work on?
```

## Step 8: Set context

After presenting the briefing, you now have full context about what that session was doing. The user can say things like "continue the refactoring" or "finish the batch endpoint" and you'll know exactly what they mean.

If there are pending decisions, proactively mention them: "There are N pending decisions from that session. Want to start implementing them?"

If tasks were restored, proactively suggest: "I've restored N tasks. Want me to continue from where we left off?"

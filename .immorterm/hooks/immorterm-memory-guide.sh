#!/bin/bash
# Owner: ImmorTerm Memory
# ImmorTerm Memory: Session Guidance (SYNC - output goes to Claude)
# Event: SessionStart
# Project: lonormaly-krispyai
#
# Reads session_id from stdin JSON, injects it into CLAUDE_ENV_FILE,
# outputs guidance text, and triggers background digest for unprocessed sessions.

# Derive project root from this script's location (immune to CWD issues)
# Hooks live at <project_root>/.immorterm/hooks/ — go up 2 levels
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Read stdin JSON to extract session_id and cwd
STDIN_DATA=$(cat 2>/dev/null || echo '{}')

IFS='|' read -r SESSION_ID CWD_PATH < <(echo "$STDIN_DATA" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    print(data.get('session_id', ''), data.get('cwd', ''), sep='|')
except Exception:
    print('|')
" 2>/dev/null)
SESSION_ID="${SESSION_ID:-}"
CWD_PATH="${CWD_PATH:-$(pwd)}"

# Stable terminal identifier — survives context compaction (set by VS Code extension)
IMMORTERM_ID="${IMMORTERM_WINDOW_ID:-}"

# Derive project slug from .mcp.json URL (authoritative source) or fallback to project root basename
PROJECT_ID=""
MCP_JSON="$PROJECT_ROOT/.mcp.json"
if [ -f "$MCP_JSON" ]; then
  PROJECT_ID=$(python3 -c "
import json, sys, re
try:
    with open(sys.argv[1]) as f:
        data = json.load(f)
    for server in data.get('mcpServers', {}).values():
        url = server.get('url', '')
        m = re.search(r'/mcp/[^/]+/([^/]+)$', url)
        if m and m.group(1) != 'sse':
            print(m.group(1))
            break
        m2 = re.search(r'/sse/([^/]+)$', url)
        if m2:
            print(m2.group(1))
            break
except Exception:
    pass
" "$MCP_JSON" 2>/dev/null)
fi
# Fallback: derive from directory name
if [ -z "$PROJECT_ID" ]; then
  PROJECT_ID=$(basename "$PROJECT_ROOT" | tr '[:upper:]' '[:lower:]' | tr ' ' '-')
fi

# Write SESSION_ID and PROJECT_ID to CLAUDE_ENV_FILE so all subsequent Bash calls get them
if [ -n "$CLAUDE_ENV_FILE" ]; then
  [ -n "$SESSION_ID" ] && echo "export SESSION_ID=\"$SESSION_ID\"" >> "$CLAUDE_ENV_FILE"
  [ -n "$IMMORTERM_ID" ] && echo "export IMMORTERM_ID=\"$IMMORTERM_ID\"" >> "$CLAUDE_ENV_FILE"
  [ -n "$PROJECT_ID" ] && echo "export IMMORTERM_PROJECT_ID=\"$PROJECT_ID\"" >> "$CLAUDE_ENV_FILE"
  # Set compaction threshold to 70% — triggers auto-compact earlier so digest can capture context
  echo 'export CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=70' >> "$CLAUDE_ENV_FILE"
fi

# Persist env for UserPromptSubmit hooks (they don't inherit CLAUDE_ENV_FILE vars)
# Guard: only SESSION_ID required — IMMORTERM_ID may be empty (non-AI terminal)
# but IMMORTERM_PROJECT_ID must still be scoped to prevent cross-project memory leakage
if [ -n "$SESSION_ID" ]; then
  mkdir -p "$HOME/.immorterm/claude-env"
  cat > "$HOME/.immorterm/claude-env/$SESSION_ID.env" << _ENVEOF
IMMORTERM_ID=$IMMORTERM_ID
IMMORTERM_PROJECT_ID=$PROJECT_ID
_ENVEOF
fi

# ── Register session with ImmorTerm-Memory (background, non-blocking) ──────────
if [ -n "$SESSION_ID" ] && [ -n "$PROJECT_ID" ]; then
  TERMINAL_NAME=""
  RESTORE_JSON="$PROJECT_ROOT/.immorterm/restore-terminals.json"
  if [ -f "$RESTORE_JSON" ]; then
    TERMINAL_NAME=$(python3 -c "
import json, sys
try:
    with open(sys.argv[1]) as f:
        data = json.load(f)
    for tab in data.get('terminals', []):
        for split in tab.get('splitTerminals', []):
            if split.get('claudeSessionId') == sys.argv[2]:
                print(split.get('name', ''))
                sys.exit(0)
except Exception:
    pass
" "$RESTORE_JSON" "$SESSION_ID" 2>/dev/null)
  fi

  # Fallback: look up display_name from registry.json using immorterm_id
  if [ -z "$TERMINAL_NAME" ] && [ -n "$IMMORTERM_ID" ]; then
    TERMINAL_NAME=$(python3 -c "
import json, sys
try:
    with open(sys.argv[1]) as f:
        data = json.load(f)
    for s in data.get('sessions', []):
        if s.get('window_id') == sys.argv[2]:
            print(s.get('display_name', ''))
            break
except Exception:
    pass
" "$HOME/.immorterm/registry.json" "$IMMORTERM_ID" 2>/dev/null)
  fi

  START_TIME=$(date -u +%Y-%m-%dT%H:%M:%SZ)

  # Extract project_context from CLAUDE.md (first substantial content line)
  PROJECT_CONTEXT=""
  CLAUDE_MD="$PROJECT_ROOT/.claude/CLAUDE.md"
  if [ -f "$CLAUDE_MD" ]; then
    PROJECT_CONTEXT=$(python3 -c "
import sys
try:
    with open(sys.argv[1]) as f:
        lines = f.readlines()
    for line in lines:
        s = line.strip()
        if not s or s.startswith('#') or s.startswith('<!--') or s.startswith('|') or s.startswith('\`\`\`'):
            continue
        if len(s) > 20:
            print(s[:200])
            break
except Exception:
    pass
" "$CLAUDE_MD" 2>/dev/null)
  fi
  # Fallback: git remote repo name
  if [ -z "$PROJECT_CONTEXT" ]; then
    PROJECT_CONTEXT=$(cd "$PROJECT_ROOT" && git remote get-url origin 2>/dev/null | sed 's|.*/||; s|\.git$||' || echo "")
  fi

  # Fire-and-forget: register session in background (JSON built in Python to avoid injection)
  _IM_SID="$SESSION_ID" \
  _IM_UID="$PROJECT_ID" \
  _IM_TNAME="$TERMINAL_NAME" \
  _IM_START="$START_TIME" \
  _IM_IID="$IMMORTERM_ID" \
  _IM_PCTX="$PROJECT_CONTEXT" \
  python3 -c "
import os, json, subprocess
p = {
    'session_id': os.environ['_IM_SID'],
    'user_id': os.environ['_IM_UID'],
    'terminal_name': os.environ['_IM_TNAME'],
    'start_time': os.environ['_IM_START'],
    'immorterm_id': os.environ.get('_IM_IID', ''),
    # Read from IMMORTERM_AI_TOOL so non-Claude vendors get the right
    # ai_tool tag in memory. Per-vendor wrappers (cursor/windsurf/cline/
    # aider) set this; for Claude Code (no wrapper) the default holds.
    'ai_tool': os.environ.get('IMMORTERM_AI_TOOL', 'claude-code'),
}
ctx = os.environ.get('_IM_PCTX', '')
if ctx:
    p['project_context'] = ctx
# Layer 2: include registry_snapshot if available
iid = os.environ.get('_IM_IID', '')
if iid:
    reg_path = os.path.expanduser('~/.immorterm/registry.json')
    try:
        with open(reg_path) as f:
            reg = json.load(f)
        entry = next((e for e in reg.get('sessions', []) if e.get('window_id') == iid), None)
        if entry:
            p['registry_snapshot'] = json.dumps(entry)
    except Exception:
        pass
payload = json.dumps(p)
subprocess.Popen(
    ['curl', '-s', '--max-time', '3', '-X', 'POST', os.environ.get('IMMORTERM_MEMORY_URL', 'http://127.0.0.1:8765') + '/api/v1/sessions/register',
     '-H', 'Content-Type: application/json', '-d', payload],
    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
)
" 2>/dev/null &
fi

# Output guidance text
cat << IMMORTERM_HEADER
<immorterm-memory project="$PROJECT_ID">

## Memory Services Active

You have access to persistent memory for this project via the immorterm-memory MCP server.
IMMORTERM_HEADER

# Inject session identity section if we have a UUID
if [ -n "$SESSION_ID" ]; then
  cat << SESSION_SECTION

### Session Identity

Your session UUID is $SESSION_ID. This ID is attached to all memories saved during this session.
SESSION_SECTION

  if [ -n "$IMMORTERM_ID" ]; then
    cat << IMMORTERM_SECTION
Your \`immorterm_id\` is $IMMORTERM_ID. This is the **stable terminal identifier** — it survives context compaction.
Use \`immorterm_id\` as your PRIMARY key for all memory searches and context recovery:
  search_memory(query='what we worked on', immorterm_id='$IMMORTERM_ID')
  get_session_context(immorterm_id='$IMMORTERM_ID')
  get_plan(immorterm_id='$IMMORTERM_ID')
Your \`session_id\` ($SESSION_ID) changes on each compaction cycle — use it only as a secondary identifier.
IMMORTERM_SECTION
  else
    cat << FALLBACK_SECTION
After context compaction, recover your session's memories with:
  search_memory(query='what we worked on', session_id='$SESSION_ID')
Or load full session context in one call:
  get_session_context(session_id='$SESSION_ID')
FALLBACK_SECTION
  fi
fi

cat << 'IMMORTERM_MEMORY_GUIDE'

### Available Tools — Complete Inventory (26 MCP tools)

**Memory CRUD** — Core operations for storing and retrieving facts, decisions, and lessons learned:
- `add_memories` — Save one memory (text=) or batch (texts=[])
- `search_memory` — Semantic search with scope/category/date filters
- `search_recent_memories` — Time-based browse with optional text filter
- `list_memories` — Paginated listing of all memories
- `get_memory_context` — Load original conversation excerpt for a memory
- `list_categories` — Discover valid category filters (architecture, decisions, etc.)

**Session Continuity** — Resume work across conversations, track decisions:
- `list_sessions` — Browse all Claude sessions with status, summaries, edit stats, tasks
- `get_session_context` — Load full context (summary + facts + decisions) for a session
- `get_pending_decisions` — Find unfinished decisions across all sessions
- `resolve_decisions` — Mark decisions as completed, dismissed, or superseded
- `list_tasks` — Retrieve persisted tasks from a previous session
- `get_plan` — Retrieve an approved implementation plan by session, query, or most recent

**Code Archaeology** — Understand what changed, when, and why. Start here for any "why was X changed?" question:
- `list_code_changes` — Which files were edited, when, by which session
- `get_code_diff` — Actual unified diff content for a specific change
- `list_git_commits` — Git commit history with contributing session links
- `explain_change` — Full story for a file: edits + commits + sessions + decision memories
- `enrich_pr` — Branch-scoped PR enrichment: 3 modes (base_ref, commit_shas, file_paths). Returns per-file WHY context with temporal summary matching and contributing sessions
- `list_file_versions` — Edit timeline for a file with checkpoint availability
- `reconstruct_file` — Recover pre-edit file content from a session checkpoint
- `revert_session_changes` — Revert files to pre-session state (dry_run=True by default)

**Knowledge Packs** — Query digested books, courses, and reference material:
- `list_packs` — Discover available knowledge packs
- `get_pack_ram` — Load a pack's compiled RAM (condensed markdown, ~20K chars)
- `search_pack` — Semantic search within a specific pack
- `get_framework` — Deep-dive into a specific framework with components and techniques
- `list_frameworks` — List all frameworks in a pack with summaries
- `delete_pack` — Remove a pack (irreversible for vectors)

### Confidence Threshold (≥0.7)

**IMPORTANT**: Only save memories when you have HIGH CONFIDENCE (≥0.7) that the information is:
- Correct and verified
- Important for future sessions
- A firm decision (not speculation or discussion)

Low-confidence information should remain ephemeral in the current context.

### When to SEARCH memories (use search_memory tool):

**CRITICAL RULE**: If the user references ANY information, context, or shared knowledge that
you do NOT have in the current conversation, you MUST search memories BEFORE responding.
Never say "I don't know" or "this is a new session" without searching first.

Specific triggers (non-exhaustive):
- User references past context: "you told me...", "you said...", "we discussed...", "remember when...", "last time...", "earlier...", "the secret", "what did you..."
- User asks about past decisions: "Why did we choose X?", "What did we decide about Y?"
- User implies shared knowledge you don't currently have in this conversation
- Before implementing something that might have been discussed before
- When user seems to expect you to know something — search first, then respond
- When the user's FIRST message references anything beyond this session's context

### When to SAVE memories (use add_memories tool with infer=false):
Only when confidence ≥ 0.7:
- ✅ Confirmed architectural decisions (e.g., "We're using PostgreSQL because...")
- ✅ Verified technical choices (e.g., "Authentication uses JWT with refresh tokens")
- ✅ Explicitly stated user preferences (e.g., "User prefers functional components")
- ✅ Validated lessons learned (e.g., "This API requires pagination for lists > 100 items")
- ✅ Documented project conventions (e.g., "All API routes go in /api/v1/")

Do NOT save when confidence < 0.7:
- ❌ Unconfirmed discussions or brainstorming
- ❌ Speculative decisions that may change
- ❌ Partial or incomplete information
- ❌ Assumptions without user verification

### Decision Tracking

When saving decisions from approved plans, include a `status` field:
- `"status": "planned"` — Decision made, not yet implemented
- `"status": "in_progress"` — Currently being implemented
- `"status": "completed"` — Fully implemented and verified

When you finish implementing planned decisions, resolve them in bulk:
```
resolve_decisions(decision_ids=["<id1>", "<id2>"], resolution="completed", notes="Implemented in this session")
```

For decisions that are no longer relevant:
```
resolve_decisions(decision_ids=["<id>"], resolution="dismissed", notes="Superseded by new approach")
```

Valid resolutions: `completed`, `dismissed`, `superseded`. The original memory is updated in-place and archived.

### HOW TO SAVE — Background Script (non-blocking)

**For 1-2 memories**: Use the background save script via Bash with `run_in_background: true`:

```
Bash(run_in_background: true):
bash .immorterm/hooks/immorterm-bg-memory-save.sh "<category>" "<what happened and why>"
```

This fires off a background curl to the ImmorTerm-Memory API and returns immediately.

**Categories** (comma-separated for multi-category): architecture, frontend, backend, security, performance, devops, conventions, preferences, lessons_learned, decisions

**Examples**:
```
bash .immorterm/hooks/immorterm-bg-memory-save.sh "architecture" "Chose PostgreSQL for JSONB support and Prisma compatibility"
bash .immorterm/hooks/immorterm-bg-memory-save.sh "architecture,decisions" "PLANNED: Implement scope filtering on search_memory to exclude knowledge packs by default"
```

### HOW TO BATCH SAVE — MCP tool (for bulk operations)

**For 3+ memories**: Use the MCP `add_memories` tool with the `texts` parameter to batch-save in one call:

```
add_memories(texts=[
    "fact 1",
    "fact 2",
    {"text": "fact 3 with metadata", "metadata": {"category": "architecture"}}
], infer=false)
```

Items are dispatched for parallel embedding across 4 ONNX workers. MCP batch is limited to ~50 items (output token constraint). For larger batches, use REST:
```bash
curl -s -X POST http://127.0.0.1:${IMMORTERM_MEMORY_PORT:-8765}/api/v1/memories/batch \
  -H "Content-Type: application/json" \
  -d '{"user_id": "<project_id>", "items": [{"text": "item 1"}, ...]}'
```
REST supports up to 500 items per request with no token limit.

### HOW TO SEARCH — MCP Tool (synchronous, that's fine)

**search_memory(query)** - Search for relevant memories
```
search_memory("authentication decision")
```
Returns memories with text, score, and metadata. When the memory has a `type: history_ref`,
the original conversation context is **AUTO-RETRIEVED** in the `conversation_context` field!

Searching is fine as a synchronous MCP call since you need the results before proceeding.

### After Plan Approval (ExitPlanMode):
Plan decisions are auto-extracted. Review the extraction and save any corrections.

### Investigating Code Changes (IMPORTANT — use these tools FIRST)

You have code change tracking tools that capture every file edit with diffs, session IDs, and timestamps.
**When the user asks anything about file changes, modifications, or "why was X changed" — ALWAYS start here, not git log.**

1. **FIRST — Find changes**: `list_code_changes(hours_ago=N)` or `list_code_changes(file_path="...")`
   This returns which files were changed, when, by which session, with change IDs.
2. **Get diffs**: `get_code_diff(change_id="...")` for the actual unified diff content.
3. **Find the WHY** — use the session_id from step 1 and ALWAYS do BOTH of these:
   - `get_session_context(session_id="...")` for the session that made the change
   - `search_memory("filename change description")` to search ALL sessions broadly
   The decision to make a change is often discussed in a DIFFERENT session than the one that executed it.
   If one source doesn't explain the "why", the other likely will. Always check both.

### Resuming sessions

Any session — even ended ones — can be resumed. When the user says "resume #3" or picks a session, call `get_session_context(session_id)` + `list_code_changes(session_id)` to load that session's full context into the current conversation and continue the work. Sessions are numbered (#1, #2, ...) for easy reference.

### Querying sessions

Use `/ask` to start an interactive chat with a previous session. A subagent loaded with that session's context answers questions from its perspective. You can ask follow-ups (conversation history is preserved), switch to a different session, or exit.

If the user writes "@session_3 what happened?" or "ask session 3 about...", treat it as if they invoked `/ask` and pre-selected that session.

### Tips:
- Search BEFORE answering questions about project history
- **SAVE PROACTIVELY** — don't wait to be asked. If a decision was made, save it immediately via background script
- Save decisions AFTER they're confirmed, not during discussion
- Be specific when searching: "JWT auth" not just "auth"
- Include the "why" when saving decisions, not just the "what"

</immorterm-memory>
IMMORTERM_MEMORY_GUIDE

# ── Background digest of unprocessed JSONL (covers /clear gap) ──────────
# When the user runs /clear, the previous session's JSONL content may not have
# been digested yet (15-min timer didn't fire). Scan the JSONL dir for files
# with unprocessed bytes and kick off a background digest.
if [ -n "$SESSION_ID" ] && [ -n "$PROJECT_ROOT" ] && [ -n "$PROJECT_ID" ]; then
  DIGEST_SCRIPT="$PROJECT_ROOT/.immorterm/hooks/immorterm-memory-digest.sh"
  CHECKPOINT_FILE="$HOME/.immorterm/digest-checkpoints.json"

  if [ -f "$DIGEST_SCRIPT" ]; then
    # Find JSONL dir — prefer transcript path from restore-terminals.json, fallback to CWD slug
    BG_JSONL_DIR=""
    RESTORE_JSON="$PROJECT_ROOT/.immorterm/restore-terminals.json"
    if [ -f "$RESTORE_JSON" ]; then
      BG_JSONL_DIR=$(python3 -c "
import json, sys, os
try:
    with open(sys.argv[1]) as f:
        data = json.load(f)
    for tab in data.get('terminals', []):
        for split in tab.get('splitTerminals', []):
            tp = split.get('claudeTranscriptPath', '')
            if tp:
                d = os.path.dirname(tp)
                if os.path.isdir(d):
                    print(d)
                    sys.exit(0)
except Exception:
    pass
" "$RESTORE_JSON" 2>/dev/null)
    fi
    # Fallback: CWD slug convention
    if [ -z "$BG_JSONL_DIR" ]; then
      CWD_SLUG=$(echo "$PROJECT_ROOT" | tr '/' '-')
      BG_JSONL_DIR="$HOME/.claude/projects/$CWD_SLUG"
    fi

    if [ -d "$BG_JSONL_DIR" ]; then
      UNPROCESSED_SESSIONS=$(python3 - "$BG_JSONL_DIR" "$CHECKPOINT_FILE" "$SESSION_ID" 2>/dev/null <<'PYEOF'
import json, sys, os, glob

jsonl_dir = sys.argv[1]
checkpoint_file = sys.argv[2]
current_session = sys.argv[3]

checkpoints = {}
try:
    with open(checkpoint_file) as f:
        data = json.load(f)
        checkpoints = data.get('files', {})
except Exception:
    pass

unprocessed = []
for jsonl_file in glob.glob(os.path.join(jsonl_dir, '*.jsonl')):
    basename = os.path.basename(jsonl_file)
    session_id = basename.replace('.jsonl', '')
    if session_id == current_session:
        continue
    file_size = os.path.getsize(jsonl_file)
    checkpoint = checkpoints.get(jsonl_file, {}).get('byte_offset', 0)
    new_bytes = file_size - checkpoint
    if new_bytes >= 100:
        unprocessed.append(session_id)

if unprocessed:
    print(' '.join(unprocessed[:5]))
PYEOF
)

      if [ -n "$UNPROCESSED_SESSIONS" ]; then
        # Use array to prevent glob expansion on session IDs
        read -ra _SESSIONS_ARR <<< "$UNPROCESSED_SESSIONS"
        nohup bash "$DIGEST_SCRIPT" "$PROJECT_ID" "$BG_JSONL_DIR" "${_SESSIONS_ARR[@]}" \
          >> "$PROJECT_ROOT/.immorterm/terminals/hooks/logs/bg-digest.log" 2>&1 &
      fi
    fi
  fi
fi

# ── Auto-heal long-lived daemons (CLI + VS Code) ──
# All three helpers are idempotent: no-op when alive, spawn detached when dead.
# Order matters: memory must be healthy before the digest daemon tries to use it.
_ENSURE_MEMORY_LIB="$SCRIPT_DIR/lib/ensure-immorterm-memory.sh"
if [ -f "$_ENSURE_MEMORY_LIB" ]; then
  # shellcheck disable=SC1090
  source "$_ENSURE_MEMORY_LIB"
  ensure_immorterm_memory 2>/dev/null || true
fi

_ENSURE_GATEWAY_LIB="$SCRIPT_DIR/lib/ensure-mcp-gateway.sh"
if [ -f "$_ENSURE_GATEWAY_LIB" ]; then
  # shellcheck disable=SC1090
  source "$_ENSURE_GATEWAY_LIB"
  ensure_mcp_gateway "$PROJECT_ROOT" 2>/dev/null || true
fi

_ENSURE_LIB="$SCRIPT_DIR/lib/ensure-digest-daemon.sh"
if [ -f "$_ENSURE_LIB" ] && [ -n "${PROJECT_ID:-}" ]; then
  # shellcheck disable=SC1090
  source "$_ENSURE_LIB"
  ensure_digest_daemon "$PROJECT_ID" "$PROJECT_ROOT" 2>/dev/null || true
fi

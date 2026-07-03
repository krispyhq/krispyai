#!/bin/bash
# Owner: ImmorTerm Memory
# ImmorTerm Memory: Background Digest Script
# NOT a hook — spawned by VS Code extension timer every ~15 minutes
# Project: lonormaly-krispyai
#
# Usage: bash $0 <projectId> <jsonlDir> <sessionId1> [sessionId2] ...

set -euo pipefail

# Portable timeout for macOS (GNU `timeout` not available by default)
# Uses temp file for stdin — backgrounded processes lose pipe stdin.
if ! command -v timeout >/dev/null 2>&1; then
  timeout() {
    local duration="$1"; shift
    local stdin_tmp
    stdin_tmp=$(mktemp)
    cat > "$stdin_tmp"
    "$@" < "$stdin_tmp" &
    local pid=$!
    ( sleep "$duration" && kill "$pid" 2>/dev/null ) >/dev/null 2>&1 &
    local watchdog=$!
    local ret=0
    wait "$pid" 2>/dev/null || ret=$?
    kill "$watchdog" 2>/dev/null || true
    wait "$watchdog" 2>/dev/null || true
    rm -f "$stdin_tmp"
    if [ "$ret" -gt 128 ]; then return 124; fi
    return "$ret"
  }
fi

PROJECT_ID="${1:?Usage: $0 <projectId> <jsonlDir> <sessionId1> [sessionId2] ...}"
JSONL_DIR="${2:?Usage: $0 <projectId> <jsonlDir> <sessionId1> [sessionId2] ...}"
shift 2
SESSION_IDS=("$@")

if [ ${#SESSION_IDS[@]} -eq 0 ]; then
  echo "[digest] No session IDs provided" >&2
  exit 0
fi

IMMORTERM_MEMORY_URL="http://127.0.0.1:${IMMORTERM_MEMORY_PORT:-8765}"
CHECKPOINT_DIR="$HOME/.immorterm"
CHECKPOINT_FILE="$CHECKPOINT_DIR/digest-checkpoints.json"
LOCK_FILE="$CHECKPOINT_DIR/digest-${PROJECT_ID}.lock"
# Sonnet for subscription users (free); set IMMORTERM_DIGEST_MODEL=haiku for API key users
DIGEST_MODEL="${IMMORTERM_DIGEST_MODEL:-sonnet}"
# Trigger reason passed by daemon (burst_pause, git_commit, fallback_15m, recovery, manual)
DIGEST_TRIGGER="${DIGEST_TRIGGER:-manual}"

# ── Source LLM-invoke shim (Phase A T10/T12) ──────────────
# Provider-dispatch shell function: digest_llm_invoke <system_prompt>
# Reads transcript on stdin, writes JSON envelope to stdout.
# Used by the supersession audit pass below; T8 will route the main
# digest LLM call through it too.
DIGEST_SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -f "$DIGEST_SCRIPT_DIR/lib/digest-llm-invoke.sh" ]; then
  # shellcheck source=/dev/null
  source "$DIGEST_SCRIPT_DIR/lib/digest-llm-invoke.sh"
else
  echo "[digest] WARN: lib/digest-llm-invoke.sh missing — audit pass will fail" >&2
fi

# ── Metrics tracking ─────────────────────────────────────
TOTAL_ENTRIES_PROCESSED=0
TOTAL_FACTS_EXTRACTED=0
TOTAL_DUPES_CAUGHT=0
TOTAL_SESSIONS_PROCESSED=0

# ── Lockfile (atomic mkdir for TOCTOU safety) ─────────────
# Use lock directory — mkdir is atomic, prevents race conditions
LOCK_MARK="$CHECKPOINT_DIR/digest-${PROJECT_ID}.lockdir"
if mkdir "$LOCK_MARK" 2>/dev/null; then
  echo $$ > "$LOCK_FILE"
  trap 'rm -f "$LOCK_FILE"; rmdir "$LOCK_MARK" 2>/dev/null' EXIT
else
  LOCK_AGE=$(( $(date +%s) - $(stat -c %Y "$LOCK_FILE" 2>/dev/null || stat -f %m "$LOCK_FILE" 2>/dev/null || echo 0) ))
  if [ "$LOCK_AGE" -lt 900 ]; then
    echo "[digest] Another digest is running (lock age: ${LOCK_AGE}s), skipping" >&2
    exit 0
  fi
  echo "[digest] Stale lock found (${LOCK_AGE}s), breaking" >&2
  rm -f "$LOCK_FILE"
  rmdir "$LOCK_MARK" 2>/dev/null
  if mkdir "$LOCK_MARK" 2>/dev/null; then
    echo $$ > "$LOCK_FILE"
    trap 'rm -f "$LOCK_FILE"; rmdir "$LOCK_MARK" 2>/dev/null' EXIT
  else
    echo "[digest] Failed to acquire lock after break, skipping" >&2
    exit 0
  fi
fi

# ── Health check ─────────────────────────────────────────
if ! curl -s --max-time 3 "$IMMORTERM_MEMORY_URL/health" > /dev/null 2>&1; then
  echo "[digest] ImmorTerm-Memory not healthy, skipping" >&2
  exit 0
fi

# ── CLI check ────────────────────────────────────────────
if ! command -v claude > /dev/null 2>&1; then
  echo "[digest] claude CLI not found, skipping" >&2
  exit 0
fi

# ── Checkpoint helpers ────────────────────────────────────
mkdir -p "$CHECKPOINT_DIR"
if [ ! -f "$CHECKPOINT_FILE" ]; then
  echo '{"version":1,"files":{}}' > "$CHECKPOINT_FILE"
fi

get_checkpoint() {
  local file_path="$1"
  python3 - "$CHECKPOINT_FILE" "$file_path" <<'PYEOF' 2>/dev/null || echo 0
import json, sys
try:
    with open(sys.argv[1]) as f:
        data = json.load(f)
    print(data.get('files', {}).get(sys.argv[2], {}).get('byte_offset', 0))
except Exception:
    print(0)
PYEOF
}

get_summary_memory_id() {
  local file_path="$1"
  # First: check local checkpoint cache
  local cached_id
  cached_id=$(python3 - "$CHECKPOINT_FILE" "$file_path" <<'PYEOF' 2>/dev/null || echo ""
import json, sys
try:
    with open(sys.argv[1]) as f:
        data = json.load(f)
    print(data.get('files', {}).get(sys.argv[2], {}).get('summary_memory_id', ''))
except Exception:
    print('')
PYEOF
  )
  if [ -n "$cached_id" ]; then
    echo "$cached_id"
    return
  fi
  # Fallback: discover via REST lookup (handles async POST where ID was not captured)
  local session_id="$2"
  if [ -n "$session_id" ]; then
    local lookup_id
    lookup_id=$(_IM_URL="$IMMORTERM_MEMORY_URL" _IM_PID="$PROJECT_ID" _IM_SID="$session_id" \
      python3 -c "
import os, json, urllib.request, urllib.parse
url = os.environ['_IM_URL'] + '/api/v1/memories/lookup-by-meta?' + urllib.parse.urlencode({
    'user_id': os.environ['_IM_PID'], 'session_id': os.environ['_IM_SID'], 'memory_type': 'session_summary'
})
try:
    resp = urllib.request.urlopen(url, timeout=3)
    d = json.loads(resp.read())
    print(d.get('memory_id','') or '')
except Exception:
    print('')
" 2>/dev/null || echo "")
    echo "$lookup_id"
  else
    echo ""
  fi
}

set_checkpoint() {
  local file_path="$1"
  local byte_offset="$2"
  local memories_count="$3"
  local summary_id="${4:-}"
  # Optional v4 §5.2 args for RewriteHash lifecycle (cline, gemini):
  # $5 = file_hash (hex), $6 = msg_count. Empty/missing for JSONL vendors.
  local file_hash="${5:-}"
  local msg_count="${6:-}"
  python3 - "$CHECKPOINT_FILE" "$file_path" "$byte_offset" "$memories_count" "$summary_id" "$file_hash" "$msg_count" <<'PYEOF' 2>/dev/null
import json, os, sys, tempfile
from datetime import datetime, timezone
cp_file, fp, offset, count = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
summary_id = sys.argv[5] if len(sys.argv) > 5 else ""
file_hash  = sys.argv[6] if len(sys.argv) > 6 else ""
msg_count_raw = sys.argv[7] if len(sys.argv) > 7 else ""
try:
    with open(cp_file) as f:
        data = json.load(f)
except Exception:
    data = {'version': 2, 'files': {}}
# Schema v2 bump per v4 F20 — adds optional file_hash + msg_count for
# RewriteHash-lifecycle vendors (cline, gemini). v1 readers tolerate the
# extra fields. v2 readers tolerate v1 entries (defaults to None / 0).
data.setdefault('version', 2)
if data.get('version', 1) < 2:
    data['version'] = 2
entry = data.setdefault('files', {}).get(fp, {})
entry['byte_offset'] = offset
entry['last_processed'] = datetime.now(timezone.utc).isoformat()
entry['memories_extracted'] = count
if file_hash:
    entry['file_hash'] = file_hash
if msg_count_raw:
    try:
        entry['msg_count'] = int(msg_count_raw)
    except ValueError:
        pass
if summary_id:
    # Increment update count when summary is being updated (existing ID preserved)
    if entry.get('summary_memory_id') == summary_id:
        entry['summary_update_count'] = entry.get('summary_update_count', 0) + 1
    else:
        entry['summary_update_count'] = 0  # new summary, reset count
    entry['summary_memory_id'] = summary_id
elif 'summary_memory_id' in entry:
    pass  # preserve existing summary_memory_id
data['files'][fp] = entry
# v4 F21 — atomic write. Previous code did `with open(cp_file, "w"):
# json.dump(...)` which truncates then writes incrementally. A concurrent
# reader (Rust daemon cold-start) seeing the file mid-write got partial
# JSON → fell back to defaults → seeded `last_seen_size=0` for all
# sessions → F2 regression. Temp + atomic rename closes the race.
cp_dir = os.path.dirname(cp_file) or "."
fd, tmp_path = tempfile.mkstemp(prefix=".cp-", suffix=".tmp", dir=cp_dir)
try:
    with os.fdopen(fd, "w") as f:
        json.dump(data, f, indent=2)
    os.replace(tmp_path, cp_file)  # POSIX-atomic
except Exception:
    try:
        os.unlink(tmp_path)
    except Exception:
        pass
    raise
PYEOF
}

# ── Extraction prompt ────────────────────────────────────
#
# Vendor-neutral wording: the digest LLM sees this prompt regardless
# of which AI tool produced the transcript (Claude Code / Codex /
# Cursor / Copilot / etc.). Saying "Claude Code AI" misled the LLM
# when extracting from non-Claude transcripts. The active tool name
# from IMMORTERM_AI_TOOL is interpolated below so the model has
# accurate context without hardcoding any vendor.
read -r -d '' PROMPT <<PROMPTEOF || true
You are a memory extraction assistant. Analyze this conversation between a developer and an AI coding assistant (${IMMORTERM_AI_TOOL:-an AI assistant}).

SESSION PHASE AWARENESS:
Before extracting, identify which phase(s) the conversation is in:
- EXPLORATION: Reading code, searching, asking questions — low signal, skip unless a clear insight emerges
- PLANNING: Discussing architecture, weighing options, creating plans — MEDIUM signal, capture decisions
- IMPLEMENTATION: Writing code, fixing bugs, running tests — HIGH signal, capture bugs/gotchas/conventions
- DEBUGGING: Investigating failures, analyzing errors — HIGHEST signal, capture root causes and lessons learned
- REVIEW: Looking at results, verifying behavior — capture confirmed patterns and outcomes

Weight your extraction accordingly:
- In DEBUGGING/IMPLEMENTATION phases: extract more aggressively (bugs, gotchas, root causes are gold)
- In EXPLORATION phases: be selective — only extract if a genuine insight or preference is stated
- In PLANNING phases: capture decisions and their reasoning, skip tentative "what if" discussion

Extract ONLY facts worth remembering for future coding sessions:
- Architectural decisions and their reasoning
- Technology/framework choices made
- User preferences stated explicitly
- Bugs found with their root causes
- Lessons learned (gotchas, things that failed)
- Project conventions established
- Important configuration or setup details

Rules:
- ATOMIC FACTS: Each memory must contain exactly ONE fact. If a conversation reveals multiple insights, split them into separate memories. For example:
  BAD (compound): "Fixed two bugs: cp invalidates Mach-O signatures causing SIGKILL, and backgrounded processes lose stdin"
  GOOD (atomic): Memory 1: "cp of Mach-O binaries on macOS invalidates the ad-hoc linker signature, causing SIGKILL (exit 137). Fix: codesign --force --sign - after every copy."
  GOOD (atomic): Memory 2: "Backgrounded processes in non-interactive shells get /dev/null as stdin instead of the pipe. Fix: buffer to temp file first, then redirect."
- Each memory must be complete and self-contained — understandable without context from other memories
- Include the why not just the what
- For each fact, include a short "prompt" field: the user request or question that led to this fact (paraphrased in ~10 words)
- If a temporal reference is clear (e.g. "we decided yesterday", "fixed in March"), include an "event_date" field in ISO format (YYYY-MM-DD). Only include when you can reasonably infer the date from the conversation context.
- Each memory can belong to multiple categories. Pick 1-3 that best describe it.
- For decisions (categories includes "decisions"), include a "status" field: "planned" if decided but not yet implemented, "completed" if already implemented in this conversation
- If FILES MODIFIED section is provided below, for each memory include:
  - "files_touched": list of file paths reasonably related to that specific memory. Be GENEROUS — if a file was discussed, decided on, or changed because of this fact, include it. Most memories should have at least one file.
  - "code_change_ids": list of change UUIDs that correspond to this memory
  When in doubt, include the file. The link from memory to code is the most valuable part.
- Skip routine coding tasks, greetings, confirmations
- Skip anything obvious from looking at the code itself
- Maximum 15 memories per batch (atomic facts mean more memories per session — this is expected)
- If nothing worth remembering, return empty array

Also generate a "session_summary" field using markdown-style structured sections. This replaces prose summaries with scannable sections that both humans and AI can parse. Format:

## Goals
- High-level objectives for this session (the "why")

## Done
- Bullet list of completed items (what was accomplished)

## In Progress
- Bullet list of ongoing work (skip section if nothing in progress)

## Key Changes
- file.ts: short description of what changed
- other-file.rs: what changed

## Blockers
- Any blockers or issues (skip section if none)

## Timeline
HH:MM – HH:MM UTC

Rules for session_summary:
- Each bullet should be a complete, self-contained statement
- Use specific technical terms (file names, function names, concepts)
- Skip empty sections entirely (e.g. no "## Blockers" if there are none)
- If continuing from a previous summary, merge and update sections (don't just append)
- Keep bullets concise — one line each, no sub-bullets
- You may add custom sections (e.g. "## Root Cause", "## Design Decisions", "## Debugging") when they help convey the session\'s story — don\'t force everything into the predefined sections

Also generate a "session_title" field: a concise 3-7 word title for the session that captures the current focus of work (e.g. "Search Quality Eval Harness", "GPU Terminal Drag Reorder", "Memory Digest Pipeline Fixes"). Update the title as the session's focus evolves.

Also generate an "at_a_glance" field: an array of 2-3 short bullet strings (each under 80 chars) summarizing what a human should know at a glance. Focus on: what was accomplished, what's in progress, any blockers.

If the conversation topic has fundamentally changed from the previous summary (completely different task, not just a natural progression), set "new_context" to true. This tells the system to archive the old summary and start fresh. Only set this when there is a clear context switch, not for gradual topic evolution.

Also generate a "topic_keywords" field: an array of 5-10 specific, searchable keywords that capture the technical topics of this session. These keywords power the search engine's temporal query expansion — when someone searches "what happened in this session?", these keywords become the search terms. Rules:
- Use specific technical terms, not generic verbs (e.g. "HNSW", "spreading-activation", "WebGPU", not "fixed", "implemented", "working")
- Include: library/tool names, algorithms, file names, architectural concepts, error types
- Exclude: common programming verbs, generic words like "code", "bug", "feature"
- Order by importance (most distinctive first)
- Example: ["TF-IDF", "temporal-decomposition", "session-summaries", "stopword-filtering", "nDCG", "eval-bench"]

For each memory, also extract named entities and relationships when clearly present:
- "entities": array of {"name": "Docker", "type": "tool"} — tools, libraries, frameworks, services, databases, languages, concepts, patterns mentioned in this fact
- "relations": array of {"source": "X", "relationship": "uses|depends_on|replaces|migrated_to|built_with|deployed_on|stores_in|integrates_with", "destination": "Y"} — explicit relationships between entities stated in this fact
- Entity types: tool, library, framework, service, concept, database, language, pattern
- Only extract entities that are SPECIFIC and NAMED (not generic terms like "database" or "API")
- Only extract relations when EXPLICITLY stated, never inferred from co-occurrence
- Both fields are optional — skip if no clear entities

Include a "phase" field indicating the dominant conversation phase: "exploration", "planning", "implementation", "debugging", or "review".

For each memory, also include a "memory_type" field classifying its shape. This drives downstream ranking — decisions outrank tombstones on shared topics. Pick exactly ONE:
- "decision" — a choice made with reasoning ("we chose X over Y because Z"). Highest value for resumption. The "why" + the parameters needed to act.
- "state" — a current/blocked/pending observation ("OAuth pending in this session", "MCP loaded but not authenticated"). Captures unresolved status the next session needs to know about.
- "handoff" — an instruction left for the next session ("do /exit and reopen so the MCP loads", "next step: call mcp__plugin_posthog_posthog__authenticate"). Gold for the "where you left off" injection.
- "task_summary" — a completion tombstone, TASK #N marker, or status update ("TASK #3: Wire SessionEnd hook [completed]"). Low-signal — surfaces what happened, not why.
- "conversation_excerpt" — raw turn chunk that captures context without a clear decision/state/handoff/task classification. Default fallback.

Pick the type that best describes the memory; if uncertain, use "conversation_excerpt".

Return ONLY a JSON object with this exact format (no markdown fences, no extra text):
{"memories":[{"text":"...","memory_type":"decision","categories":["architecture","decisions"],"prompt":"user request that led to this","event_date":"2026-03-10 (optional, only when inferable)","status":"planned|completed (only for decisions, omit for other categories)","files_touched":["path/to/file.ts"],"code_change_ids":["uuid1"],"entities":[{"name":"Docker","type":"tool"}],"relations":[{"source":"Docker","relationship":"deploys","destination":"application"}]}],"session_summary":"## Goals\n- Improve session modal UX\n\n## Done\n- Completed X\n- Fixed Y\n\n## Key Changes\n- file.ts: description\n\n## Timeline\nHH:MM \u2013 HH:MM UTC","session_title":"Short Descriptive Title","at_a_glance":["Completed X","Working on Y","Blocked by Z"],"topic_keywords":["specific-tech-term","algorithm-name","library-name"],"new_context":false,"phase":"implementation"}

Valid categories: architecture, frontend, backend, security, performance, devops, conventions, preferences, lessons_learned, decisions
Valid memory_type values: decision, state, handoff, task_summary, conversation_excerpt
PROMPTEOF

# ── Known-entities hint (audit 2026-05-12) ───────────────
# Inject the top-N canonical entity names from the user's graph into the
# system prompt so the LLM extracts using existing canonical forms instead
# of inventing new case/hyphenation variants. Prevention layer paired with
# the graph_canonicalize bin + graph::canonicalize_for_graph() insert guard.
#
# Token budget: ~200 tokens for the entire block (≈120 entities at ~1.5 tok
# each). Fetched once per digest invocation, not per session, to amortize.
# Best-effort: any SQLite failure (DB locked, table missing, etc.) yields
# an empty block — the digester continues with the unhinted prompt.
KNOWN_ENTITIES_BLOCK=$(IM_DB_PATH="$HOME/.immorterm/memory/memory.db" IM_USER_ID="$PROJECT_ID" python3 - <<'PYEOF' 2>/dev/null || echo ""
import os
import sqlite3
import sys

db_path = os.environ.get("IM_DB_PATH", "")
user_id = os.environ.get("IM_USER_ID", "")
if not db_path or not user_id or not os.path.exists(db_path):
    sys.exit(0)

try:
    # `uri=true` + read-only mode = safe alongside the live daemon's writer.
    # WAL mode (daemon default) makes this concurrent-safe.
    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=2.0)
    conn.row_factory = sqlite3.Row
    # Top entities by total relation count (in + out). Cap at 120 names
    # to stay under the ~200-token budget. Exclude synthetic IDs
    # (session:/summary:/memory: prefixes) — they're per-session and
    # never useful as canonical-name hints.
    rows = conn.execute(
        """
        SELECT e.name, e.entity_type,
               COALESCE(o.c, 0) + COALESCE(i.c, 0) AS rel_count
        FROM entities e
        LEFT JOIN (SELECT source_id AS eid, COUNT(*) AS c FROM relations GROUP BY source_id) o
          ON o.eid = e.id
        LEFT JOIN (SELECT destination_id AS eid, COUNT(*) AS c FROM relations GROUP BY destination_id) i
          ON i.eid = e.id
        WHERE e.user_id = ?1
          AND e.entity_type NOT IN ('session', 'summary', 'memory')
          AND e.name NOT LIKE 'session:%'
          AND e.name NOT LIKE 'summary:%'
          AND e.name NOT LIKE 'memory:%'
        ORDER BY rel_count DESC, e.id ASC
        LIMIT 120
        """,
        (user_id,),
    ).fetchall()
    conn.close()
except Exception:
    sys.exit(0)

if not rows:
    sys.exit(0)

# Render as a compact comma-separated list grouped by type, keeping the
# canonical name verbatim so the LLM can copy-paste it.
by_type = {}
for r in rows:
    by_type.setdefault(r["entity_type"], []).append(r["name"])

lines = [
    "",
    "KNOWN CANONICAL ENTITIES (use these EXACT spellings when extracting; avoid new variants):",
]
for etype in sorted(by_type.keys()):
    names = by_type[etype][:30]  # secondary per-type cap defends against type imbalance
    lines.append(f"- {etype}: {', '.join(names)}")
print("\n".join(lines))
PYEOF
)

# Append to the system prompt if we got anything. Empty block means no
# graph yet (new project) — fall through with the unhinted prompt.
if [ -n "$KNOWN_ENTITIES_BLOCK" ]; then
  PROMPT="${PROMPT}${KNOWN_ENTITIES_BLOCK}"
  _IM_HINT_CHARS=$(printf %s "$KNOWN_ENTITIES_BLOCK" | wc -c | tr -d ' ')
  echo "[digest] Injected known-entities hint (${_IM_HINT_CHARS} chars)" >&2
fi

# ── Build session → immorterm_id (windowId) map ──────────
# Primary: registry.json (Rust daemon). Fallback: RESTORE_JSON (legacy).
SESSION_WINDOW_MAP=$(python3 -c "
import json, sys, os
m = {}
# Primary: ~/.immorterm/registry.json (Rust daemon)
registry = os.path.expanduser('~/.immorterm/registry.json')
if os.path.exists(registry):
    try:
        with open(registry) as f:
            data = json.load(f)
        for entry in data.get('sessions', []):
            sid = entry.get('claude_session_id', '')
            wid = entry.get('window_id', '')
            if sid and wid:
                m[sid] = wid
    except Exception:
        pass
# Fallback: restore-terminals.json (legacy, passed by daemon via RESTORE_JSON env)
if not m:
    rj = os.environ.get('RESTORE_JSON', '')
    if rj and os.path.exists(rj):
        try:
            with open(rj) as f:
                data = json.load(f)
            for group in data.get('terminals', []):
                for term in group.get('splitTerminals', []):
                    sid = term.get('claudeSessionId', '')
                    wid = term.get('windowId', '')
                    if sid and wid:
                        m[sid] = wid
        except Exception:
            pass
print(json.dumps(m))
" 2>/dev/null || echo '{}')

# ── Process each session ─────────────────────────────────
# Exclude session IDs spawned by immorterm-p — their JSONLs are short-lived
# wrapper artifacts. Digesting them produces recursive meta-memories.
IMMORTERM_P_IDS_FILE="$HOME/.immorterm/immorterm-p-session-ids.txt"
for SESSION_ID in "${SESSION_IDS[@]}"; do
  if [ -s "$IMMORTERM_P_IDS_FILE" ] && grep -qFx "$SESSION_ID" "$IMMORTERM_P_IDS_FILE" 2>/dev/null; then
    echo "[digest] Skipping immorterm-p session $SESSION_ID (wrapper artifact)" >&2
    continue
  fi
  # Look up immorterm_id (windowId) for this session.
  # Tier 1 (authoritative): per-session claude-env file written by SessionStart hook.
  # Filename IS the Claude UUID; contents carry IMMORTERM_ID=<wid>. Single-writer, never stale.
  # Tier 2 (fallback): registry.json / restore-terminals.json map — races and frequently empty.
  IMMORTERM_ID=""
  CLAUDE_ENV_FILE="$HOME/.immorterm/claude-env/$SESSION_ID.env"
  if [ -f "$CLAUDE_ENV_FILE" ]; then
    IMMORTERM_ID=$(grep -E '^IMMORTERM_ID=' "$CLAUDE_ENV_FILE" | head -1 | cut -d= -f2- | tr -d '[:space:]')
  fi
  if [ -z "$IMMORTERM_ID" ]; then
    IMMORTERM_ID=$(echo "$SESSION_WINDOW_MAP" | python3 -c "import json,sys; print(json.load(sys.stdin).get(sys.argv[1],''))" "$SESSION_ID" 2>/dev/null || echo "")
  fi

  # ── Phase A T8: discover AI tool + transcript path from hub registry ──
  # Default to claude-code so a hub-down or unknown-window scenario
  # falls through to the existing Claude path discovery (zero behavior change).
  TOOL="claude-code"
  TRANSCRIPT_PATH=""
  if [ -n "$IMMORTERM_ID" ]; then
    HUB_URL="${IMMORTERM_HUB_URL:-http://localhost:1440}"
    REG_JSON=$(curl -s --max-time 3 "$HUB_URL/api/v1/registry/window/$IMMORTERM_ID" 2>/dev/null || echo "")
    if [ -n "$REG_JSON" ]; then
      TOOL=$(printf '%s' "$REG_JSON" | python3 -c 'import json, sys
try:
    print(json.load(sys.stdin).get("tool") or "claude-code")
except Exception:
    print("claude-code")' 2>/dev/null || echo "claude-code")
      TRANSCRIPT_PATH=$(printf '%s' "$REG_JSON" | python3 -c 'import json, sys
try:
    print(json.load(sys.stdin).get("transcript_path") or "")
except Exception:
    print("")' 2>/dev/null || echo "")
    fi
  fi

  # Route transcript path per tool. claude-code retains existing fallback.
  case "$TOOL" in
    claude-code)
      JSONL_PATH="${TRANSCRIPT_PATH:-$JSONL_DIR/$SESSION_ID.jsonl}"
      ;;
    codex|cursor|windsurf|cline|opencode|gemini|aider|copilot)
      JSONL_PATH="$TRANSCRIPT_PATH"
      ;;
    *)
      echo "[digest] unknown tool '$TOOL' for session $SESSION_ID, skipping" >&2
      continue
      ;;
  esac

  if [ -z "$JSONL_PATH" ] || [ ! -f "$JSONL_PATH" ]; then
    continue
  fi

  FILE_SIZE=$(stat -c %s "$JSONL_PATH" 2>/dev/null || stat -f %z "$JSONL_PATH" 2>/dev/null || echo 0)
  CHECKPOINT=$(get_checkpoint "$JSONL_PATH")

  # Skip if less than 100 new bytes
  NEW_BYTES=$((FILE_SIZE - CHECKPOINT))
  if [ "$NEW_BYTES" -lt 100 ]; then
    continue
  fi

  echo "[digest] Processing session $SESSION_ID (+${NEW_BYTES} bytes, tool=$TOOL)" >&2

  # ── Phase A T8: prefer immorterm-adapter binary for normalization ──
  # Byte-equivalent to the Python heredoc fallback for Claude (gated by
  # services/immorterm-adapter parity test against the Claude fixture).
  # For non-Claude tools the binary is the only path — fallback is Claude-only.
  ADAPTER_BIN="${IMMORTERM_ADAPTER_BIN:-$HOME/.immorterm/bin/immorterm-adapter}"
  MESSAGES=""
  if [ -x "$ADAPTER_BIN" ] && [ -f "$JSONL_PATH" ]; then
    MESSAGES=$("$ADAPTER_BIN" normalize "$JSONL_PATH" \
      --format digest \
      --byte-offset "$CHECKPOINT" \
      --max-total 30000 \
      --max-per-msg 2000 \
      2>/dev/null) || MESSAGES=""
  fi

  # Claude-only Python fallback (preserves zero-behavior-change exit criterion
  # for users who haven't installed ~/.immorterm/bin/immorterm-adapter yet).
  # Includes tool context (names + brief results) so post-compaction digests
  # understand what happened even when conversation is tool-heavy.
  if [ -z "$MESSAGES" ] && [ "$TOOL" = "claude-code" ]; then
  MESSAGES=$(python3 - "$JSONL_PATH" "$CHECKPOINT" 2>/dev/null <<'PYEOF'
import json, sys

jsonl_path = sys.argv[1]
byte_offset = int(sys.argv[2])
max_total = 30000  # 30KB cap
max_per_msg = 2000  # 2KB per message

messages = []
total_len = 0

def extract_content(entry, role):
    """Extract text and tool context from a message entry."""
    content = entry.get("content", entry.get("message", {}))
    if isinstance(content, dict):
        content = content.get("content", "")
    if isinstance(content, str):
        return content.strip() if content.strip() else None
    if not isinstance(content, list):
        return None

    parts = []
    for block in content:
        if not isinstance(block, dict):
            continue
        btype = block.get("type", "")

        if btype == "text":
            t = block.get("text", "").strip()
            if t:
                parts.append(t)

        elif btype == "tool_use" and role == "assistant":
            # Include tool name + brief input summary
            name = block.get("name", "unknown")
            inp = block.get("input", {})
            if name in ("Read", "Glob", "Grep"):
                path = inp.get("file_path", inp.get("pattern", inp.get("path", "")))
                parts.append(f"[Tool: {name} {path}]")
            elif name in ("Edit", "Write"):
                path = inp.get("file_path", "")
                parts.append(f"[Tool: {name} {path}]")
            elif name == "Bash":
                cmd = inp.get("command", "")[:80]
                parts.append(f"[Tool: Bash `{cmd}`]")
            elif name == "Task":
                desc = inp.get("description", "")[:60]
                parts.append(f"[Tool: Task({desc})]")
            else:
                parts.append(f"[Tool: {name}]")

        elif btype == "tool_result" and role == "user":
            # Include brief tool result preview (first 120 chars)
            result = block.get("content", "")
            if isinstance(result, list):
                result = " ".join(b.get("text", "") for b in result if isinstance(b, dict))
            if isinstance(result, str) and result.strip():
                preview = result.strip()[:120].replace("\n", " ")
                parts.append(f"[Result: {preview}]")

    return " ".join(parts) if parts else None

try:
    with open(jsonl_path, "r", errors="ignore") as f:
        if byte_offset > 0:
            f.seek(byte_offset)
            f.readline()  # skip partial line
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                entry = json.loads(line)
                role = entry.get("role", entry.get("type", ""))
                if role not in ("user", "assistant"):
                    continue
                text = extract_content(entry, role)
                if not text:
                    continue
                text = text[:max_per_msg]
                if total_len + len(text) > max_total:
                    break
                label = "User" if role == "user" else "Claude"
                messages.append(f"{label}: {text}")
                total_len += len(text)
            except json.JSONDecodeError:
                continue
except Exception as e:
    print(f"Error: {e}", file=sys.stderr)

print("\n\n".join(messages))
PYEOF
  )
  fi  # end Claude-only Python fallback

  # Count messages (skip if < 4)
  # Note: grep -c exits 1 when count is 0; using || inside $() would append a second "0" to stdout
  # Accept both `Claude:` (binary --format digest) and `AI:` (future placeholder per Phase B).
  MSG_COUNT=$(echo "$MESSAGES" | grep -cE "^(User|Claude|AI):" 2>/dev/null) || MSG_COUNT=0
  if [ "$MSG_COUNT" -lt 4 ]; then
    echo "[digest] Only $MSG_COUNT messages for $SESSION_ID, skipping" >&2
    # Still update checkpoint to avoid re-processing
    set_checkpoint "$JSONL_PATH" "$FILE_SIZE" 0
    continue
  fi

  # ── Query code changes for this session's time window ───
  CODE_CHANGES_CONTEXT=""
  WINDOW_TIMESTAMPS=$(python3 - "$JSONL_PATH" "$CHECKPOINT" 2>/dev/null <<'PYEOF'
import json, sys
from datetime import datetime, timezone, timedelta

jsonl_path = sys.argv[1]
byte_offset = int(sys.argv[2])
first_ts = None
last_ts = None

try:
    with open(jsonl_path, "r", errors="ignore") as f:
        if byte_offset > 0:
            f.seek(byte_offset)
            f.readline()
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                entry = json.loads(line)
                ts = entry.get("timestamp") or entry.get("created_at") or ""
                if not ts:
                    continue
                if not first_ts:
                    first_ts = ts
                last_ts = ts
            except Exception:
                continue
except Exception:
    pass

if first_ts and last_ts:
    try:
        for fmt in ["%Y-%m-%dT%H:%M:%S.%fZ", "%Y-%m-%dT%H:%M:%SZ", "%Y-%m-%dT%H:%M:%S.%f%z", "%Y-%m-%dT%H:%M:%S%z"]:
            try:
                start = datetime.strptime(first_ts, fmt)
                break
            except Exception:
                continue
        else:
            start = None
        for fmt in ["%Y-%m-%dT%H:%M:%S.%fZ", "%Y-%m-%dT%H:%M:%SZ", "%Y-%m-%dT%H:%M:%S.%f%z", "%Y-%m-%dT%H:%M:%S%z"]:
            try:
                end = datetime.strptime(last_ts, fmt)
                break
            except Exception:
                continue
        else:
            end = None
        if start and end:
            start = start - timedelta(minutes=1)
            end = end + timedelta(minutes=1)
            print(f"{start.strftime('%Y-%m-%dT%H:%M:%SZ')}|{end.strftime('%Y-%m-%dT%H:%M:%SZ')}")
        else:
            print(f"{first_ts}|{last_ts}")
    except Exception:
        print(f"{first_ts}|{last_ts}")
else:
    print("")
PYEOF
  )

  if [ -n "$WINDOW_TIMESTAMPS" ]; then
    WINDOW_START=$(echo "$WINDOW_TIMESTAMPS" | cut -d'|' -f1)
    WINDOW_END=$(echo "$WINDOW_TIMESTAMPS" | cut -d'|' -f2)

    CODE_CHANGES_RAW=$(_IM_URL="$IMMORTERM_MEMORY_URL" _IM_SID="$SESSION_ID" _IM_START="$WINDOW_START" _IM_END="$WINDOW_END" _IM_PID="$PROJECT_ID" \
      python3 -c "
import os, urllib.request, urllib.parse
url = os.environ['_IM_URL'] + '/api/v1/code-changes/window?' + urllib.parse.urlencode({
    'session_id': os.environ['_IM_SID'], 'start': os.environ['_IM_START'],
    'end': os.environ['_IM_END'], 'user_id': os.environ['_IM_PID'],
})
try:
    resp = urllib.request.urlopen(url, timeout=5)
    print(resp.read().decode())
except Exception:
    print('')
" 2>/dev/null || echo "")

    CODE_CHANGES_CONTEXT=$(CODE_CHANGES_JSON="$CODE_CHANGES_RAW" python3 - 2>/dev/null <<'PYEOF'
import json, os

raw = os.environ.get("CODE_CHANGES_JSON", "").strip()
if not raw:
    exit()

try:
    data = json.loads(raw)
    changes = data if isinstance(data, list) else data.get("changes", [])
except Exception:
    exit()

if not changes:
    exit()

file_groups = {}
for c in changes:
    fp = c.get("file_path", "unknown")
    if fp not in file_groups:
        file_groups[fp] = {"edits": 0, "added": 0, "removed": 0, "ids": [], "action": c.get("file_action", "modified")}
    file_groups[fp]["edits"] += 1
    file_groups[fp]["added"] += c.get("lines_added", 0)
    file_groups[fp]["removed"] += c.get("lines_removed", 0)
    file_groups[fp]["ids"].append(c.get("id", ""))

lines = ["FILES MODIFIED IN THIS WINDOW:"]
for fp, info in file_groups.items():
    ids_str = ", ".join(info["ids"][:5])
    if len(info["ids"]) > 5:
        ids_str += f" (+{len(info['ids'])-5} more)"
    lines.append(f"- {fp} ({info['action']}, {info['edits']} edit(s): +{info['added']}/-{info['removed']} lines) [change_ids: {ids_str}]")

lines.append("")
lines.append("For each extracted memory, associate it with relevant files and change IDs from the list above.")
print("\n".join(lines))
PYEOF
    )

    if [ -n "$CODE_CHANGES_CONTEXT" ]; then
      echo "[digest] Found code changes context for session $SESSION_ID" >&2
    fi
  fi

  # ── Branch detection ─────────────────────────────────────
  # Most recent branch from code_changes window → IMMORTERM_DIGEST_BRANCH env override → empty
  DIGEST_BRANCH=""
  if [ -n "${WINDOW_START:-}" ] && [ -n "${WINDOW_END:-}" ]; then
    DIGEST_BRANCH=$(_IM_URL="$IMMORTERM_MEMORY_URL" _IM_SID="$SESSION_ID" _IM_START="$WINDOW_START" _IM_END="$WINDOW_END" _IM_PID="$PROJECT_ID" \
      python3 -c "
import os, json, urllib.request, urllib.parse
url = os.environ['_IM_URL'] + '/api/v1/code-changes/?' + urllib.parse.urlencode({
    'session_id': os.environ['_IM_SID'], 'start_date': os.environ['_IM_START'],
    'end_date': os.environ['_IM_END'], 'user_id': os.environ['_IM_PID'], 'limit': 10,
})
try:
    resp = urllib.request.urlopen(url, timeout=3)
    data = json.loads(resp.read())
    changes = data if isinstance(data, list) else data.get('changes', [])
    for c in changes:
        b = (c.get('branch') or '').strip()
        if b:
            print(b); break
except Exception:
    pass
" 2>/dev/null || echo "")
  fi
  if [ -z "$DIGEST_BRANCH" ] && [ -n "${IMMORTERM_DIGEST_BRANCH:-}" ]; then
    DIGEST_BRANCH="$IMMORTERM_DIGEST_BRANCH"
  fi

  # Fetch existing session summary (if any) for Claude to update
  EXISTING_SUMMARY=""
  EXISTING_SUMMARY_ID=$(get_summary_memory_id "$JSONL_PATH" "$SESSION_ID")
  if [ -n "$EXISTING_SUMMARY_ID" ]; then
    EXISTING_SUMMARY=$(curl -s --max-time 3 "$IMMORTERM_MEMORY_URL/api/v1/memories/$EXISTING_SUMMARY_ID/" 2>/dev/null | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('content','') or d.get('memory',''))" 2>/dev/null || echo "")
  fi

  # Build Claude input with timestamp, trigger reason, and existing summary
  CURRENT_TIME=$(date -u +"%H:%M UTC")
  CLAUDE_INPUT="[Current time: $CURRENT_TIME]
[Digest trigger: $DIGEST_TRIGGER]

"
  if [ -n "$EXISTING_SUMMARY" ]; then
    CLAUDE_INPUT="${CLAUDE_INPUT}[PREVIOUS SESSION SUMMARY - update this based on new conversation below]
$EXISTING_SUMMARY

---NEW CONVERSATION SINCE LAST DIGEST---

"
  fi
  # Inject code changes context if available
  if [ -n "$CODE_CHANGES_CONTEXT" ]; then
    CLAUDE_INPUT="${CLAUDE_INPUT}${CODE_CHANGES_CONTEXT}

"
  fi
  CLAUDE_INPUT="${CLAUDE_INPUT}${MESSAGES}"

  CLAUDE_INPUT_LEN=${#CLAUDE_INPUT}
  echo "[digest] Feeding $MSG_COUNT messages to digest LLM (input: ${CLAUDE_INPUT_LEN} chars)" >&2

  # Wrap content in XML tags so model treats it as DATA to analyze, not conversation to continue.
  DELIMITED_INPUT="<transcript_to_analyze>
${CLAUDE_INPUT}
</transcript_to_analyze>

Analyze the transcript above and extract memories. Return ONLY the JSON object."

  # Pipe to digest LLM via shim (Phase A T8/T10/T12).
  # The shim enforces upstream timeouts per provider — no outer `timeout`
  # wrapper (which would fork a subshell without the sourced function).
  # No positional prompt arg — instruction is appended after closing tag above.
  _CLAUDE_T0=$(date +%s)
  RAW_RESULT=$(
    export IMMORTERM_DIGEST_PROVIDER="${IMMORTERM_DIGEST_PROVIDER:-anthropic-cli}";
    export IMMORTERM_DIGEST_MODEL="${IMMORTERM_DIGEST_MODEL:-$DIGEST_MODEL}";
    printf '%s' "$DELIMITED_INPUT" | digest_llm_invoke "$PROMPT" 2>/dev/null
  )
  CLAUDE_EXIT=$?
  _CLAUDE_ELAPSED=$(( $(date +%s) - _CLAUDE_T0 ))
  USAGE=$(RAW_CLAUDE_RESULT="$RAW_RESULT" python3 - <<'PYEOF' 2>/dev/null
import json, os
raw = os.environ.get("RAW_CLAUDE_RESULT", "").strip()
try:
    w = json.loads(raw)
    u = w.get("usage", {}) or {}
    print(f'{int(u.get("input_tokens", 0))} {int(u.get("output_tokens", 0))} {int(u.get("cache_read_input_tokens", 0))} {int(u.get("cache_creation_input_tokens", 0))} {float(w.get("total_cost_usd", 0)):.6f}')
except Exception:
    print("0 0 0 0 0.000000")
PYEOF
  )
  read -r IN_TOK OUT_TOK CACHE_READ CACHE_CREATE COST_USD <<<"$USAGE"
  IN_TOK=${IN_TOK:-0}; OUT_TOK=${OUT_TOK:-0}; CACHE_READ=${CACHE_READ:-0}; CACHE_CREATE=${CACHE_CREATE:-0}; COST_USD=${COST_USD:-0}
  printf '{"ts":"%s","stage":"immorterm_p","project_id":"%s","session_id":"%s","model":"%s","input_chars":%d,"msg_count":%d,"elapsed_s":%d,"exit":%d,"input_tokens":%d,"output_tokens":%d,"cache_read_tokens":%d,"cache_creation_tokens":%d,"cost_usd":%s}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$PROJECT_ID" "$SESSION_ID" "$DIGEST_MODEL" "$CLAUDE_INPUT_LEN" "$MSG_COUNT" "$_CLAUDE_ELAPSED" "$CLAUDE_EXIT" "$IN_TOK" "$OUT_TOK" "$CACHE_READ" "$CACHE_CREATE" "$COST_USD" \
    >> "$HOME/.immorterm/digest-timings.jsonl" 2>/dev/null || true
  if [ "$CLAUDE_EXIT" -ne 0 ]; then
    if [ "$CLAUDE_EXIT" = "124" ]; then
      echo "[digest] digest LLM timed out (300s) for session $SESSION_ID after ${_CLAUDE_ELAPSED}s" >&2
    else
      echo "[digest] digest LLM failed (exit $CLAUDE_EXIT) for session $SESSION_ID after ${_CLAUDE_ELAPSED}s" >&2
    fi
    continue
  fi

  # Strip markdown fences from the digest output (immorterm-p returns unwrapped result;
  # legacy claude -p returned {"result":"..."} wrapper — the fallback to raw handles both).
  RESULT=$(RAW_CLAUDE_RESULT="$RAW_RESULT" python3 - <<'PYEOF'
import json, sys, re, os
raw = os.environ.get("RAW_CLAUDE_RESULT", "").strip()
if not raw:
    print("{}", file=sys.stderr)
    print('{"memories":[],"session_summary":"","session_title":"","at_a_glance":[]}')
    sys.exit(0)
try:
    wrapper = json.loads(raw)
    content = wrapper.get("result", raw)
except Exception:
    content = raw
# Strip markdown code fences
content = re.sub(r"^```(?:json)?\s*\n?", "", content.strip())
content = re.sub(r"\n?```\s*$", "", content.strip())
print(content)
PYEOF
  )

  # Parse and POST each memory to ImmorTerm-Memory (heredoc avoids quoting issues)
  # Output format: "saved_count|summary_memory_id" (summary_id may be empty)
  # Temp file where save block emits (id, text, branch, category) per new memory.
  # Consumed by the audit pass below to fetch semantic-neighbor candidates.
  SAVED_MEMS_FILE="$(mktemp -t immorterm-audit.XXXXXX)"
  SAVE_OUTPUT=$(DIGEST_RESULT="$RESULT" CHECKPOINT_FILE="$CHECKPOINT_FILE" DIGEST_SESSION_ID="$SESSION_ID" DIGEST_IMMORTERM_ID="${IMMORTERM_ID:-}" DIGEST_TOOL="${TOOL:-claude-code}" EXISTING_SUMMARY="$EXISTING_SUMMARY" DIGEST_TRIGGER="$DIGEST_TRIGGER" DIGEST_BRANCH="$DIGEST_BRANCH" SAVED_MEMS_FILE="$SAVED_MEMS_FILE" python3 - "$IMMORTERM_MEMORY_URL" "$PROJECT_ID" "$JSONL_PATH" "$CHECKPOINT" "$FILE_SIZE" 2>/dev/null <<'PYEOF'
import json, sys, os
from urllib.request import Request, urlopen
from urllib.error import URLError
from datetime import datetime, timezone

openmemory_url = sys.argv[1]
user_id = sys.argv[2]
jsonl_path = sys.argv[3] if len(sys.argv) > 3 else ""
byte_offset = int(sys.argv[4]) if len(sys.argv) > 4 else 0
byte_end = int(sys.argv[5]) if len(sys.argv) > 5 else 0
result_json = os.environ.get("DIGEST_RESULT", "").strip()
session_id = os.environ.get("DIGEST_SESSION_ID", "").strip()
immorterm_id = os.environ.get("DIGEST_IMMORTERM_ID", "").strip()
digest_tool = os.environ.get("DIGEST_TOOL", "claude-code").strip() or "claude-code"
digest_trigger = os.environ.get("DIGEST_TRIGGER", "manual").strip()
digest_branch = os.environ.get("DIGEST_BRANCH", "").strip()
saved_mems_file = os.environ.get("SAVED_MEMS_FILE", "").strip()

try:
    result = json.loads(result_json)
    memories = result.get("memories", [])
except Exception:
    print("0|")
    sys.exit(0)

# Extract session phase from LLM response
session_phase = result.get("phase", "").strip()

saved = 0
saved_mems_log = []  # For audit pass — (id, text, branch, categories)
timestamp = datetime.now(timezone.utc).isoformat()
byte_length = byte_end - byte_offset if byte_end > byte_offset else 0

VALID_MEMORY_TYPES = {"decision", "state", "handoff", "task_summary", "conversation_excerpt"}
# task-1778532379426: unconditional metadata.type overwrite. All 5
# memory_type values now route to type_boost() rows in
# services/memory/src/query_classifier.rs:
#   - decision      -> (_, "decisions") => 1.4x
#   - state         -> ("state", _) => 1.2x
#   - handoff       -> ("handoff", _) => 1.4x
#   - task_summary  -> ("task_summary", _) => 0.7x (T8 tombstone demotion)
#   - conversation_excerpt -> ("conversation_excerpt", _) => 1.0x
# T2-revised's selective-overwrite gate is removed; raw classification
# always lands in metadata.memory_type AND drives the outer metadata.type.

for mem in memories:
    text = mem.get("text", "").strip()
    # Support both old "category" (string) and new "categories" (array) from LLM output
    categories = mem.get("categories", [])
    if not categories:
        cat = mem.get("category", "decisions")
        categories = [cat] if cat else ["decisions"]
    categories = [c for c in categories if isinstance(c, str)][:3]
    prompt = mem.get("prompt", "").strip()
    status = mem.get("status", "").strip()
    event_date = mem.get("event_date", "").strip()
    files_touched = mem.get("files_touched", [])
    code_change_ids = mem.get("code_change_ids", [])
    # T2-revised: LLM-classified memory shape (decision/state/handoff/task_summary/conversation_excerpt).
    # Normalize + validate against the allowed enum. Anything unrecognized falls
    # back to "conversation_excerpt" so downstream consumers (T6/T7 structured
    # injection, T4 telemetry) always see a known value.
    raw_memory_type = mem.get("memory_type", "")
    if isinstance(raw_memory_type, str):
        memory_type = raw_memory_type.strip().lower()
    else:
        memory_type = ""
    if memory_type not in VALID_MEMORY_TYPES:
        memory_type = "conversation_excerpt"
    if not text:
        continue
    # task-1778532379426: unconditional metadata.type overwrite. Every
    # memory_type drives the outer type directly — type_boost() in
    # query_classifier.rs has rows for all 5 classifications.
    outer_type = memory_type
    metadata = {
        "type": outer_type,
        "memory_type": memory_type,
        "categories": categories,
        "category": categories[0] if categories else "decisions",
        "timestamp": timestamp,
        "source": "memory_digester",
        "digest_trigger": digest_trigger,
        "tool": digest_tool,
    }
    # Branch-aware memory: record the branch this memory was captured on.
    if digest_branch:
        metadata["branch"] = digest_branch
    if session_phase:
        metadata["session_phase"] = session_phase
    if session_id:
        metadata["session_id"] = session_id
    if immorterm_id:
        metadata["immorterm_id"] = immorterm_id
    if prompt:
        metadata["prompt"] = prompt
    if status and "decisions" in categories:
        metadata["status"] = status
    if event_date:
        metadata["event_date"] = event_date
    # Code-bound memory: associate with files and change IDs
    if files_touched and isinstance(files_touched, list):
        metadata["files_touched"] = files_touched
    if code_change_ids and isinstance(code_change_ids, list):
        metadata["code_change_ids"] = code_change_ids
    # Include conversation context pointers for preview retrieval
    if jsonl_path:
        metadata["jsonl_path"] = jsonl_path
    if byte_offset > 0:
        metadata["byte_offset"] = byte_offset
    if byte_length > 0:
        metadata["byte_length"] = byte_length
    # Entity graph data (LLM-extracted, highest quality)
    entities = mem.get("entities", [])
    relations = mem.get("relations", [])
    # Validate structure: only pass well-formed entries
    entities = [e for e in entities if isinstance(e, dict) and e.get("name") and e.get("type")]
    relations = [r for r in relations if isinstance(r, dict) and r.get("source") and r.get("destination")]
    payload_dict = {
        "user_id": user_id,
        "text": text,
        "infer": False,
        "metadata": metadata
    }
    if entities:
        payload_dict["entities"] = entities
    if relations:
        payload_dict["relations"] = relations
    if session_id:
        payload_dict["session_id"] = session_id
    if immorterm_id:
        payload_dict["immorterm_id"] = immorterm_id
    payload = json.dumps(payload_dict).encode()
    try:
        req = Request(
            f"{openmemory_url}/api/v1/memories/",
            data=payload,
            headers={"Content-Type": "application/json"},
            method="POST"
        )
        resp = urlopen(req, timeout=5)
        if resp.status in (200, 201):
            saved += 1
            try:
                resp_body = json.loads(resp.read())
                new_id = resp_body.get("id", "")
                if new_id:
                    saved_mems_log.append({
                        "id": new_id,
                        "text": text,
                        "branch": digest_branch or "",
                        "categories": categories,
                    })
            except Exception:
                pass
    except Exception:
        pass

# Persist saved memories for the audit pass to consume.
if saved_mems_file and saved_mems_log:
    try:
        with open(saved_mems_file, "w") as f:
            json.dump(saved_mems_log, f)
    except Exception:
        pass

# Handle session summary
session_summary = result.get("session_summary", "").strip()
session_title = result.get("session_title", "").strip()
at_a_glance = result.get("at_a_glance", [])
topic_keywords = result.get("topic_keywords", [])
new_context = result.get("new_context", False)
existing_summary = os.environ.get("EXISTING_SUMMARY", "").strip()

if session_summary:
    summary_metadata = {
        "type": "session_summary",
        "timestamp": timestamp,
        "source": "memory_digester",
        "tool": digest_tool,
    }
    if session_title:
        summary_metadata["session_title"] = session_title
    if at_a_glance and isinstance(at_a_glance, list):
        summary_metadata["at_a_glance"] = at_a_glance
    if topic_keywords and isinstance(topic_keywords, list):
        summary_metadata["topic_keywords"] = topic_keywords
    if session_id:
        summary_metadata["session_id"] = session_id
    if immorterm_id:
        summary_metadata["immorterm_id"] = immorterm_id
    if jsonl_path:
        summary_metadata["jsonl_path"] = jsonl_path

    # The digest prompt instructs the LLM to "merge and update sections" when
    # continuing from a previous summary. The supersede-summary endpoint archives
    # old versions, so no data is lost. No append protection needed.

    # Use supersede-summary endpoint: archives old summary, inserts new with supersedes_id chain.
    # This is idempotent — first call creates v1, subsequent calls create v2, v3, etc.
    # No need to track summary_memory_id in checkpoint anymore.
    summary_id = None
    try:
        supersede_payload = json.dumps({
            "user_id": user_id,
            "session_id": session_id or "",
            "text": session_summary,
            "metadata": summary_metadata,
            "immorterm_id": immorterm_id or None,
        }).encode()
        req = Request(
            f"{openmemory_url}/api/v1/memories/supersede-summary",
            data=supersede_payload,
            headers={"Content-Type": "application/json"},
            method="POST"
        )
        resp = urlopen(req, timeout=5)
        if resp.status in (200, 201):
            resp_data = json.loads(resp.read())
            summary_id = resp_data.get("memory_id", "")
    except Exception:
        # Fallback: create via plain POST if supersede endpoint unavailable
        try:
            fallback_payload = json.dumps({
                "user_id": user_id,
                "text": session_summary,
                "infer": False,
                "metadata": summary_metadata,
                "session_id": session_id or None,
                "immorterm_id": immorterm_id or None,
            }).encode()
            req = Request(
                f"{openmemory_url}/api/v1/memories/",
                data=fallback_payload,
                headers={"Content-Type": "application/json"},
                method="POST"
            )
            urlopen(req, timeout=5)
        except Exception:
            pass

print(f"{saved}|{summary_id or ''}")
PYEOF
  )

  # Parse output: "saved_count|summary_memory_id"
  MEMORIES_SAVED=$(echo "$SAVE_OUTPUT" | cut -d'|' -f1)
  SUMMARY_MEM_ID=$(echo "$SAVE_OUTPUT" | cut -d'|' -f2)

  echo "[digest] Saved ${MEMORIES_SAVED:-0} memories for session $SESSION_ID" >&2
  if [ -n "$SUMMARY_MEM_ID" ]; then
    echo "[digest] Session summary memory ID: $SUMMARY_MEM_ID" >&2
  fi

  # Update checkpoint (with optional summary_memory_id)
  set_checkpoint "$JSONL_PATH" "$FILE_SIZE" "${MEMORIES_SAVED:-0}" "$SUMMARY_MEM_ID"

  # ── Layer 2: POST registry snapshot to sessions table ──
  if [ -n "$IMMORTERM_ID" ]; then
    python3 -c "
import json, sys, os
from urllib.request import Request, urlopen
registry = os.path.expanduser('~/.immorterm/registry.json')
if not os.path.exists(registry):
    sys.exit(0)
try:
    with open(registry) as f:
        data = json.load(f)
except Exception:
    sys.exit(0)
iid = sys.argv[1]
sid = sys.argv[2]
url = sys.argv[3]
entry = next((e for e in data.get('sessions', []) if e.get('window_id') == iid), None)
if not entry:
    sys.exit(0)
snapshot = json.dumps(entry)
# Use register (INSERT ON CONFLICT UPDATE) — creates session if missing, updates if exists
payload = json.dumps({
    'session_id': sid,
    'user_id': sys.argv[4],
    'immorterm_id': iid,
    'terminal_name': entry.get('display_name', ''),
    'registry_snapshot': snapshot,
}).encode()
try:
    req = Request(f'{url}/api/v1/sessions/register', data=payload,
                  headers={'Content-Type': 'application/json'}, method='POST')
    urlopen(req, timeout=3)
except Exception:
    pass
" "$IMMORTERM_ID" "$SESSION_ID" "$IMMORTERM_MEMORY_URL" "$PROJECT_ID" 2>/dev/null &
  fi

  # ── Layer 3: mark session ended + persist exit_reason ──
  # task-1778536620488: when the session-end hook fires, it exports
  # DIGEST_EXIT_REASON so we can POST /sessions/end here. This writes
  # ended_at + status='ended' + metadata.exit_reason atomically. Both
  # are required by T6+T7 Signal 6 — without `ended_at` the resumption
  # query returns None for every session (silent prod bug).
  #
  # Idempotent: COALESCE in the server preserves the first-set ended_at
  # if the hook fires multiple times (Stop racing SessionEnd is common).
  if [ -n "${DIGEST_EXIT_REASON:-}" ]; then
    _IM_END_PAYLOAD=$(IM_SID="$SESSION_ID" IM_UID="$PROJECT_ID" IM_REASON="$DIGEST_EXIT_REASON" python3 -c "
import json, os
print(json.dumps({
    'session_id': os.environ['IM_SID'],
    'user_id': os.environ['IM_UID'],
    'exit_reason': os.environ['IM_REASON'],
}))
" 2>/dev/null)
    if [ -n "$_IM_END_PAYLOAD" ]; then
      curl -s --max-time 3 -X POST "$IMMORTERM_MEMORY_URL/api/v1/sessions/end" \
        -H 'Content-Type: application/json' \
        -d "$_IM_END_PAYLOAD" >/dev/null 2>&1 || true
    fi
  fi

  # ── Audit pass: content supersession cascade ───────────────
  # Cosine ≥ 0.80 (search gate) AND LLM verdict agree → flip via /memories/{id}/supersede.
  # Cross-branch weak rule: feature-branch memories cannot supersede main/merged memories.
  if [ -f "$SAVED_MEMS_FILE" ] && [ -s "$SAVED_MEMS_FILE" ]; then
    AUDIT_INPUT=$(SAVED_MEMS_FILE="$SAVED_MEMS_FILE" DIGEST_BRANCH="$DIGEST_BRANCH" IMMORTERM_PROD_BRANCH="${IMMORTERM_PROD_BRANCH:-}" \
      python3 - "$IMMORTERM_MEMORY_URL" "$PROJECT_ID" 2>/dev/null <<'PYEOF'
import os, sys, json, urllib.request, urllib.parse

mem_url = sys.argv[1]
user_id = sys.argv[2]
saved_file = os.environ.get("SAVED_MEMS_FILE", "")
new_branch = (os.environ.get("DIGEST_BRANCH", "") or "").strip()
prod_extra = (os.environ.get("IMMORTERM_PROD_BRANCH", "") or "").strip()
prod_branches = {"main", "master"}
if prod_extra:
    prod_branches.add(prod_extra)

try:
    with open(saved_file) as f:
        saved = json.load(f)
except Exception:
    sys.exit(0)

if not saved:
    sys.exit(0)

def search(query, limit):
    body = json.dumps({
        "user_id": user_id, "query": query, "limit": limit, "scope": "all",
    }).encode()
    try:
        req = urllib.request.Request(
            mem_url + "/api/v1/memories/search", data=body,
            headers={"Content-Type": "application/json"}, method="POST",
        )
        resp = urllib.request.urlopen(req, timeout=5)
        return json.loads(resp.read())
    except Exception:
        return {}

new_is_prod = new_branch in prod_branches if new_branch else False

def branch_compatible(cand):
    cb = (cand.get("branch") or "").strip()
    merged = bool(cand.get("merged_to_main", False)) or int(cand.get("merged_to_main", 0) or 0) == 1
    if not cb:
        return True
    if new_is_prod:
        return True
    if cb == new_branch:
        return True
    if cb in prod_branches or merged:
        return False
    return True

audit_set = []
seen_candidate_ids = set()
TOTAL_CAP = 10

for new_mem in saved:
    if len(seen_candidate_ids) >= TOTAL_CAP:
        break
    query = (new_mem.get("text") or "").strip()
    if len(query) < 10:
        continue
    results = search(query, limit=6)
    hits = results.get("memories", []) if isinstance(results, dict) else []
    if not hits:
        continue
    per_new = []
    for hit in hits:
        hid = hit.get("id") or hit.get("memory_id") or ""
        if not hid or hid == new_mem.get("id"):
            continue
        if hid in seen_candidate_ids:
            continue
        if (hit.get("state") or "active") != "active":
            continue
        score = float(hit.get("score", 0.0) or 0.0)
        if score < 0.80:
            continue
        if not branch_compatible(hit):
            continue
        per_new.append({
            "candidate_id": hid,
            "text": (hit.get("content") or hit.get("memory") or "").strip()[:400],
            "score": round(score, 3),
            "branch": (hit.get("branch") or "").strip(),
            "merged_to_main": bool(hit.get("merged_to_main", False)),
        })
        seen_candidate_ids.add(hid)
        if len(seen_candidate_ids) >= TOTAL_CAP:
            break
    if per_new:
        audit_set.append({
            "new": {"id": new_mem.get("id"), "text": query[:400], "branch": new_branch},
            "candidates": per_new,
        })

if not audit_set:
    sys.exit(0)
print(json.dumps({"audit_set": audit_set}))
PYEOF
    )

    if [ -n "$AUDIT_INPUT" ] && [ "$AUDIT_INPUT" != "{}" ]; then
      AUDIT_PROMPT='You are a memory-supersession auditor. For each NEW memory below, review the CANDIDATES (existing memories that are semantically similar). Decide for each candidate whether the new memory supersedes it.

A candidate is SUPERSEDED only if the new memory clearly contradicts or replaces it — same fact now stated differently, decision reversed, approach changed. If the candidate and new memory are merely related but independently true, mark NOT superseded.

Be conservative. When in doubt, leave it alone. False supersession silently removes valid memories.

Return ONLY a JSON object (no markdown fences):
{"verdicts":[{"candidate_id":"<id>","superseded":true|false,"reason":"<short>"}]}
Include every candidate_id exactly once.'

      # Phase A T12: route audit pass through digest_llm_invoke shim.
      # Audit defaults to a faster/cheaper model than the main digest
      # (haiku-class) but follows the main digest provider so a user on
      # openai-api gets gpt-4o-mini for both unless IMMORTERM_AUDIT_MODEL
      # is set explicitly. The shim itself enforces an upstream timeout
      # (300s for anthropic-cli; per-provider for others), so no outer
      # `timeout` wrapper is needed — and one would break the shell
      # function call anyway (it would fork a subshell without the
      # sourced function in scope).
      AUDIT_RESULT=$(
        export IMMORTERM_DIGEST_PROVIDER="${IMMORTERM_DIGEST_PROVIDER:-anthropic-cli}";
        export IMMORTERM_DIGEST_MODEL="${IMMORTERM_AUDIT_MODEL:-haiku}";
        printf '%s' "$AUDIT_INPUT" | digest_llm_invoke "$AUDIT_PROMPT" 2>/dev/null
      )
      AUDIT_EXIT=$?

      if [ "$AUDIT_EXIT" -eq 0 ] && [ -n "$AUDIT_RESULT" ]; then
        SUPERSEDED_COUNT=$(AUDIT_RAW="$AUDIT_RESULT" AUDIT_INPUT="$AUDIT_INPUT" python3 - "$IMMORTERM_MEMORY_URL" "$PROJECT_ID" 2>/dev/null <<'PYEOF'
import os, sys, json, re, urllib.request

mem_url = sys.argv[1]
user_id = sys.argv[2]

raw = os.environ.get("AUDIT_RAW", "").strip()
try:
    wrapper = json.loads(raw)
    content = wrapper.get("result", raw)
except Exception:
    content = raw
content = re.sub(r"^```(?:json)?\s*\n?", "", content.strip())
content = re.sub(r"\n?```\s*$", "", content.strip())
try:
    verdicts = json.loads(content).get("verdicts", [])
except Exception:
    print(0)
    sys.exit(0)

try:
    audit_in = json.loads(os.environ.get("AUDIT_INPUT", "{}"))
except Exception:
    audit_in = {}
cand_to_new = {}
for entry in audit_in.get("audit_set", []):
    new_id = entry.get("new", {}).get("id", "")
    for c in entry.get("candidates", []):
        cid = c.get("candidate_id", "")
        if cid and new_id:
            cand_to_new[cid] = new_id

flipped = 0
for v in verdicts:
    if not v.get("superseded"):
        continue
    cid = v.get("candidate_id", "")
    if not cid:
        continue
    new_id = cand_to_new.get(cid)
    body = json.dumps({
        "user_id": user_id,
        "superseded_by_id": new_id,
        "reason": "content_replaced" if new_id else "content_stale",
    }).encode()
    try:
        req = urllib.request.Request(
            f"{mem_url}/api/v1/memories/{cid}/supersede",
            data=body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        resp = urllib.request.urlopen(req, timeout=5)
        if resp.status in (200, 201):
            flipped += 1
    except Exception:
        pass

print(flipped)
PYEOF
        )
        if [ -n "$SUPERSEDED_COUNT" ] && [ "$SUPERSEDED_COUNT" -gt 0 ]; then
          echo "[digest] Superseded $SUPERSEDED_COUNT memories for session $SESSION_ID" >&2
        fi
      fi
    fi
  fi
  rm -f "$SAVED_MEMS_FILE" 2>/dev/null

  # Accumulate metrics
  TOTAL_ENTRIES_PROCESSED=$(( TOTAL_ENTRIES_PROCESSED + MSG_COUNT ))
  TOTAL_FACTS_EXTRACTED=$(( TOTAL_FACTS_EXTRACTED + ${MEMORIES_SAVED:-0} ))
  TOTAL_SESSIONS_PROCESSED=$(( TOTAL_SESSIONS_PROCESSED + 1 ))

done

# ── Digest metrics summary ────────────────────────────────
echo "[digest] Digest cycle complete [trigger: $DIGEST_TRIGGER, sessions: $TOTAL_SESSIONS_PROCESSED, entries: $TOTAL_ENTRIES_PROCESSED, facts: $TOTAL_FACTS_EXTRACTED]" >&2
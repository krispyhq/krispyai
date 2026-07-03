#!/bin/bash
# Owner: ImmorTerm Memory
# ImmorTerm Memory: Plan Pre-Save (PRIMARY plan saver — replaces PostToolUse extraction)
# Event: PreToolUse (matcher: ExitPlanMode)
# Purpose: Save the approved plan to ImmorTerm-Memory with correct session_id BEFORE
#          ExitPlanMode executes. PreToolUse fires 100% reliably (unlike PostToolUse,
#          see Issue #12499). The plan file already exists at this point — Claude
#          writes it during plan mode, before calling ExitPlanMode.
#
# This hook is SYNCHRONOUS (async: false) — must complete before ExitPlanMode runs.
# Timeout: 10s (network POST to ImmorTerm-Memory takes ~1-2s typically).

IMMORTERM_MEMORY_URL="http://127.0.0.1:${IMMORTERM_MEMORY_PORT:-8765}"

# Derive project root from this script's location
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Per-project log/state directories
_LOG_DIR="$PROJECT_ROOT/.immorterm/terminals/hooks/logs"
_ERR_DIR="$PROJECT_ROOT/.immorterm/terminals/hooks/errors"
_STATE_DIR="$PROJECT_ROOT/.immorterm/terminals/hooks/state"
mkdir -p "$_LOG_DIR" "$_ERR_DIR" "$_STATE_DIR"

LOG_FILE="$_LOG_DIR/plan-pretool-diag.log"
ERR_FILE="$_ERR_DIR/plan-presave.log"
STATE_FILE="$_STATE_DIR/last-plan-save.json"

log() {
  local msg
  msg=$(printf '%s' "$*" | tr -d '\n\r' | tr -cd '[:print:]')
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $msg" >> "$LOG_FILE" 2>/dev/null
}

# Read stdin for session context
STDIN_DATA=$(cat 2>/dev/null || echo '{}')

# Extract session_id from hook input (PreToolUse provides this reliably)
SESSION_ID=$(echo "$STDIN_DATA" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    print(data.get('session_id', ''))
except Exception:
    print('')
" 2>/dev/null)

# Stable terminal identifier from env (survives compaction; set by VS Code extension)
IMMORTERM_ID="${IMMORTERM_ID:-${IMMORTERM_WINDOW_ID:-}}"

# Diagnostic log line (preserves the old diag hook's output for continuity)
log "ExitPlanMode PRE-TOOL: session=$SESSION_ID (presave mode)"

# ── Find newest plan file ───────────────────────────────────────────────────
PLAN_FILE=""
GLOBAL_PLANS_DIR="$HOME/.claude/plans"
PROJECT_PLANS_DIR="$PROJECT_ROOT/.claude/plans"

# Check global plans dir first (where Claude Code actually writes plans)
if [ -d "$GLOBAL_PLANS_DIR" ]; then
  PLAN_FILE=$(ls -t "$GLOBAL_PLANS_DIR"/*.md 2>/dev/null | head -1)
  [ -n "$PLAN_FILE" ] && log "Found plan in global dir: $PLAN_FILE"
fi
# Fallback: check project-level plans dir
if [ -z "$PLAN_FILE" ] && [ -d "$PROJECT_PLANS_DIR" ]; then
  PLAN_FILE=$(ls -t "$PROJECT_PLANS_DIR"/*.md 2>/dev/null | head -1)
  [ -n "$PLAN_FILE" ] && log "Found plan in project dir: $PLAN_FILE"
fi

if [ -z "$PLAN_FILE" ] || [ ! -f "$PLAN_FILE" ]; then
  log "No plan file found. Searched: $GLOBAL_PLANS_DIR, $PROJECT_PLANS_DIR"
  exit 0
fi

PLAN_FILENAME=$(basename "$PLAN_FILE")

# Read the full plan content
PLAN_CONTENT=$(cat "$PLAN_FILE" 2>/dev/null)
if [ -z "$PLAN_CONTENT" ]; then
  log "Plan file empty: $PLAN_FILE"
  exit 0
fi

# Get plan mtime (macOS / Linux portable)
if stat -f %m "$PLAN_FILE" >/dev/null 2>&1; then
  PLAN_MTIME=$(stat -f %m "$PLAN_FILE")
else
  PLAN_MTIME=$(stat -c %Y "$PLAN_FILE")
fi

# ── Save full plan to ImmorTerm-Memory ────────────────────────────────────────────
PLAN_TITLE=$(echo "$PLAN_CONTENT" | grep -m1 '^#' | sed -E 's/^#+[[:space:]]*//' || echo "")
if [ -z "$PLAN_TITLE" ]; then
  PLAN_TITLE=$(echo "$PLAN_CONTENT" | grep -m1 '[^[:space:]]' | head -c 80)
fi

# Source shared env for IMMORTERM_PROJECT_ID (never hardcoded)
source "$SCRIPT_DIR/_immorterm-env.sh"
PROJECT_ID="$IMMORTERM_PROJECT_ID"

# Content hash for dedup (first 500 chars, MD5)
CONTENT_HASH=$(echo "$PLAN_CONTENT" | head -c 500 | md5 -q 2>/dev/null || echo "$PLAN_CONTENT" | head -c 500 | md5sum 2>/dev/null | cut -d' ' -f1)

# POST plan to ImmorTerm-Memory with correct session_id
SAVE_RESULT=$(_IM_URL="$IMMORTERM_MEMORY_URL" _IM_PID="$PROJECT_ID" _IM_SID="$SESSION_ID" \
  _IM_IID="$IMMORTERM_ID" \
  _IM_TITLE="$PLAN_TITLE" _IM_FILE="$PLAN_FILENAME" _IM_HASH="$CONTENT_HASH" \
  _PLAN_CONTENT="$PLAN_CONTENT" python3 - <<'PYEOF' 2>>"$ERR_FILE"
import os, json
from urllib.request import Request, urlopen
from datetime import datetime, timezone

url = os.environ["_IM_URL"]
user_id = os.environ["_IM_PID"]
session_id = os.environ.get("_IM_SID", "")
immorterm_id = os.environ.get("_IM_IID", "")
title = os.environ.get("_IM_TITLE", "Untitled Plan")
plan_file = os.environ.get("_IM_FILE", "")
content_hash = os.environ.get("_IM_HASH", "")
content = os.environ.get("_PLAN_CONTENT", "")

if not content:
    print("empty")
    exit()

# Prefix with PLAN: for searchability
text = f"PLAN: {title}\n\n{content}"

# Cap at 100KB to avoid payload issues
if len(text) > 100000:
    text = text[:100000] + "\n\n... [truncated at 100KB]"

timestamp = datetime.now(timezone.utc).isoformat()

metadata = {
    "type": "plan",
    "category": "plan",
    "status": "planned",
    "source": "pretooluse_save",
    "plan_file": plan_file,
    "content_hash": content_hash,
    "event_date": timestamp,
    "timestamp": timestamp,
}
if session_id:
    metadata["session_id"] = session_id
if immorterm_id:
    metadata["immorterm_id"] = immorterm_id

# Entity graph: session --HAS_PLAN--> plan
session_entity = f"session:{immorterm_id}" if immorterm_id else f"session:{session_id}"
plan_entity = f"plan:{plan_file or content_hash[:12]}"

body = {
    "user_id": user_id,
    "text": text,
    "infer": False,
    "metadata": metadata,
    "entities": [
        {"name": session_entity, "type": "session"},
        {"name": plan_entity, "type": "plan"},
    ],
    "relations": [
        {"source": session_entity, "relationship": "HAS_PLAN", "destination": plan_entity},
    ],
}
if session_id:
    body["session_id"] = session_id
if immorterm_id:
    body["immorterm_id"] = immorterm_id

payload = json.dumps(body).encode()

try:
    req = Request(
        f"{url}/api/v1/memories/",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST"
    )
    resp = urlopen(req, timeout=8)
    if resp.status in (200, 201):
        print("saved")
    else:
        print(f"http_{resp.status}")
except Exception as e:
    print(f"error:{e}")
PYEOF
)

log "Plan save result: $SAVE_RESULT (title: $PLAN_TITLE, file: $PLAN_FILENAME, session: $SESSION_ID, immorterm: $IMMORTERM_ID)"

# ── Write state breadcrumb for sweep dedup ──────────────────────────────────
SAVED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
python3 -c "
import json, sys
state = {
    'plan_file': sys.argv[1],
    'session_id': sys.argv[2],
    'mtime': int(sys.argv[3]),
    'content_hash': sys.argv[4],
    'saved_at': sys.argv[5],
    'save_result': sys.argv[6],
    'immorterm_id': sys.argv[7],
}
print(json.dumps(state, indent=2))
" "$PLAN_FILENAME" "$SESSION_ID" "$PLAN_MTIME" "$CONTENT_HASH" "$SAVED_AT" "$SAVE_RESULT" "$IMMORTERM_ID" \
  > "$STATE_FILE" 2>>"$ERR_FILE"

log "State breadcrumb written: $STATE_FILE"

# ── Inject rolling session summary ────────────────────────────────
# Output the rolling summary to stdout so Claude has session context
# when transitioning from plan mode to implementation mode.
ROLLING_SUMMARY=$(_IM_URL="$IMMORTERM_MEMORY_URL" _IM_PID="$PROJECT_ID" \
  _IM_SID="$SESSION_ID" python3 -c "
import os, json, urllib.request

url = os.environ['_IM_URL']
pid = os.environ['_IM_PID']
sid = os.environ.get('_IM_SID', '')
if not sid:
    exit()

def get_text(m):
    return m.get('content', m.get('memory', m.get('text', m.get('data', ''))))

# Try 1: checkpoint file -> memory ID -> fetch text
try:
    cp_path = os.path.expanduser('~/.immorterm/digest-checkpoints.json')
    with open(cp_path) as f:
        cp = json.load(f)
    for fpath, fdata in cp.get('files', {}).items():
        if sid in fpath:
            mid = fdata.get('summary_memory_id', '')
            if mid:
                req = urllib.request.Request(f'{url}/api/v1/memories/{mid}')
                with urllib.request.urlopen(req, timeout=3) as resp:
                    text = get_text(json.loads(resp.read()))
                    if text:
                        print(text)
                        exit()
            break
except Exception:
    pass

# Try 2: lookup-by-meta endpoint (works with both Rust and Docker API)
try:
    import urllib.parse
    params = urllib.parse.urlencode({
        'user_id': pid, 'memory_type': 'session_summary', 'session_id': sid
    })
    req = urllib.request.Request(f'{url}/api/v1/memories/lookup-by-meta?{params}')
    with urllib.request.urlopen(req, timeout=3) as resp:
        data = json.loads(resp.read())
        mems = data.get('memories', [])
        if mems:
            text = get_text(mems[0])
            if text:
                print(text)
                exit()
        elif data.get('memory_id'):
            mid = data['memory_id']
            req2 = urllib.request.Request(f'{url}/api/v1/memories/{mid}')
            with urllib.request.urlopen(req2, timeout=3) as resp2:
                text = get_text(json.loads(resp2.read()))
                if text:
                    print(text)
                    exit()
except Exception:
    pass
" 2>/dev/null)

if [ -n "$ROLLING_SUMMARY" ]; then
  log "Rolling summary fetched (${#ROLLING_SUMMARY} chars), injecting into context"
  echo "<immorterm-session-context>"
  echo "### Session Summary (for implementation context)"
  echo ""
  echo "$ROLLING_SUMMARY"
  echo "</immorterm-session-context>"
else
  log "No rolling summary available"
fi

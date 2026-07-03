#!/bin/bash
# Owner: ImmorTerm Memory
# ImmorTerm Memory: Plan Sweep (Stop hook — fallback for missed PreToolUse:ExitPlanMode)
# Event: Stop (fires every agent turn)
# Purpose: Catch plans that PreToolUse:ExitPlanMode missed (safety net)
#
# How it works:
# 1. On each Stop event, stat the newest file in ~/.claude/plans/
# 2. Compare its mtime against a stored marker file
# 3. If newer → check state breadcrumb from PreToolUse presave
# 4. If presave already handled it → update marker + exit
# 5. If not → save to ImmorTerm-Memory using session_id from state file + update marker
# 6. If not newer → exit immediately (~3ms total, just stat + compare)

IMMORTERM_MEMORY_URL="http://127.0.0.1:${IMMORTERM_MEMORY_PORT:-8765}"

# Derive project root from this script's location
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Per-project log/state directories
_LOG_DIR="$PROJECT_ROOT/.immorterm/terminals/hooks/logs"
_ERR_DIR="$PROJECT_ROOT/.immorterm/terminals/hooks/errors"
_STATE_DIR="$PROJECT_ROOT/.immorterm/terminals/hooks/state"
mkdir -p "$_LOG_DIR" "$_ERR_DIR" "$_STATE_DIR"

LOG_FILE="$_LOG_DIR/plan-sweep.log"
ERR_FILE="$_ERR_DIR/plan-sweep.log"
MARKER_FILE="$_STATE_DIR/last-plan-mtime"
PRESAVE_STATE="$_STATE_DIR/last-plan-save.json"

log() {
  local msg
  msg=$(printf '%s' "$*" | tr -d '\n\r' | tr -cd '[:print:]')
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $msg" >> "$LOG_FILE" 2>/dev/null
}

# ── Fast path: find newest plan file and compare mtime ──────────────────────
GLOBAL_PLANS_DIR="$HOME/.claude/plans"

# No plans dir → nothing to do
if [ ! -d "$GLOBAL_PLANS_DIR" ]; then
  exit 0
fi

# Get newest .md file (by mtime)
NEWEST_PLAN=$(ls -t "$GLOBAL_PLANS_DIR"/*.md 2>/dev/null | head -1)
if [ -z "$NEWEST_PLAN" ] || [ ! -f "$NEWEST_PLAN" ]; then
  exit 0
fi

# Get mtime of newest plan (platform-portable: stat -f on macOS, stat -c on Linux)
if stat -f %m "$NEWEST_PLAN" >/dev/null 2>&1; then
  PLAN_MTIME=$(stat -f %m "$NEWEST_PLAN")
else
  PLAN_MTIME=$(stat -c %Y "$NEWEST_PLAN")
fi

# Compare against stored marker
if [ -f "$MARKER_FILE" ]; then
  LAST_MTIME=$(cat "$MARKER_FILE" 2>/dev/null)
  if [ "$PLAN_MTIME" = "$LAST_MTIME" ]; then
    # Same plan as last check → fast exit (~3ms total)
    exit 0
  fi
fi

# ── New plan detected! ──────────────────────────────────────────────────────
PLAN_FILENAME=$(basename "$NEWEST_PLAN")
log "New plan detected: $PLAN_FILENAME (mtime=$PLAN_MTIME)"

# ── Check presave state breadcrumb first ────────────────────────────────────
if [ -f "$PRESAVE_STATE" ]; then
  PRESAVE_INFO=$(python3 -c "
import json, sys
try:
    with open(sys.argv[1]) as f:
        state = json.load(f)
    pf = state.get('plan_file', '')
    mt = str(state.get('mtime', ''))
    ch = state.get('content_hash', '')
    sid = state.get('session_id', '')
    sr = state.get('save_result', '')
    print(f'{pf}|{mt}|{ch}|{sid}|{sr}')
except Exception:
    print('||||')
" "$PRESAVE_STATE" 2>/dev/null)

  IFS='|' read -r PS_FILE PS_MTIME PS_HASH PS_SESSION PS_RESULT <<< "$PRESAVE_INFO"

  if [ "$PS_FILE" = "$PLAN_FILENAME" ] && [ "$PS_MTIME" = "$PLAN_MTIME" ] && { [ "$PS_RESULT" = "saved" ] || [ "$PS_RESULT" = "queued" ]; }; then
    log "Plan already saved by PreToolUse hook (file=$PS_FILE, session=$PS_SESSION), updating marker only"
    echo "$PLAN_MTIME" > "$MARKER_FILE"
    exit 0
  fi
fi

# ── Read plan content and compute hash ──────────────────────────────────────
PLAN_CONTENT=$(cat "$NEWEST_PLAN" 2>/dev/null)
if [ -z "$PLAN_CONTENT" ]; then
  log "Plan file empty, skipping"
  echo "$PLAN_MTIME" > "$MARKER_FILE"
  exit 0
fi

PLAN_TITLE=$(echo "$PLAN_CONTENT" | grep -m1 '^#' | sed -E 's/^#+[[:space:]]*//' || echo "")
if [ -z "$PLAN_TITLE" ]; then
  PLAN_TITLE=$(echo "$PLAN_CONTENT" | grep -m1 '[^[:space:]]' | head -c 80)
fi

# Content hash for dedup (first 500 chars, MD5)
CONTENT_HASH=$(echo "$PLAN_CONTENT" | head -c 500 | md5 -q 2>/dev/null || echo "$PLAN_CONTENT" | head -c 500 | md5sum 2>/dev/null | cut -d' ' -f1)

# ── Determine session_id ────────────────────────────────────────────────────
SESSION_ID=""
if [ -n "$PS_SESSION" ]; then
  SESSION_ID="$PS_SESSION"
  log "Using session_id from presave state: $SESSION_ID"
else
  STDIN_DATA=$(cat 2>/dev/null || echo '{}')
  SESSION_ID=$(echo "$STDIN_DATA" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    print(data.get('session_id', ''))
except Exception:
    print('')
" 2>/dev/null)
  [ -n "$SESSION_ID" ] && log "Using session_id from stdin (fallback): $SESSION_ID"
fi

# Source shared env for IMMORTERM_PROJECT_ID
source "$SCRIPT_DIR/_immorterm-env.sh"
PROJECT_ID="$IMMORTERM_PROJECT_ID"

# Stable terminal identifier from env (survives compaction; set by VS Code extension)
IMMORTERM_ID="${IMMORTERM_ID:-${IMMORTERM_WINDOW_ID:-}}"

# ── Check if already saved (filename + content hash dedup) ──────────────────
ALREADY_SAVED=$(_IM_URL="$IMMORTERM_MEMORY_URL" _IM_PID="$PROJECT_ID" _IM_FILE="$PLAN_FILENAME" \
  _IM_HASH="$CONTENT_HASH" python3 - <<'PYEOF' 2>>"$ERR_FILE"
import os, json
from urllib.request import Request, urlopen

url = os.environ["_IM_URL"]
user_id = os.environ["_IM_PID"]
plan_file = os.environ["_IM_FILE"]
content_hash = os.environ.get("_IM_HASH", "")

try:
    payload = json.dumps({
        "query": f"PLAN: {plan_file}",
        "user_id": user_id,
        "filters": {"type": "plan"},
        "limit": 5
    }).encode()
    req = Request(
        f"{url}/api/v1/memories/search/",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST"
    )
    resp = urlopen(req, timeout=5)
    results = json.loads(resp.read())
    memories = results.get("results", results.get("memories", []))
    for m in memories:
        meta = m.get("metadata", m)
        saved_file = meta.get("plan_file", "")
        saved_hash = meta.get("content_hash", "")
        if saved_file == plan_file:
            if content_hash and saved_hash and saved_hash == content_hash:
                print("yes_hash")
                exit()
            elif not content_hash or not saved_hash:
                print("yes_name")
                exit()
    print("no")
except Exception as e:
    print(f"error:{e}")
PYEOF
)

if [ "$ALREADY_SAVED" = "yes_hash" ] || [ "$ALREADY_SAVED" = "yes_name" ]; then
  log "Plan already saved by PreToolUse hook ($ALREADY_SAVED match), updating marker only"
  echo "$PLAN_MTIME" > "$MARKER_FILE"
  exit 0
fi

log "Plan NOT in memory — saving via sweep (PreToolUse hook missed this one)"

# POST the plan to ImmorTerm-Memory
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

text = f"PLAN: {title}\n\n{content}"
if len(text) > 100000:
    text = text[:100000] + "\n\n... [truncated at 100KB]"

timestamp = datetime.now(timezone.utc).isoformat()

metadata = {
    "type": "plan",
    "category": "plan",
    "status": "planned",
    "source": "plan_sweep",
    "plan_file": plan_file,
    "content_hash": content_hash,
    "timestamp": timestamp,
}
if session_id:
    metadata["session_id"] = session_id
if immorterm_id:
    metadata["immorterm_id"] = immorterm_id

payload = json.dumps({
    "user_id": user_id,
    "text": text,
    "infer": False,
    "metadata": metadata,
}).encode()

try:
    req = Request(
        f"{url}/api/v1/memories/",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST"
    )
    resp = urlopen(req, timeout=10)
    if resp.status in (200, 201):
        print("saved")
    else:
        print(f"http_{resp.status}")
except Exception as e:
    print(f"error:{e}")
PYEOF
)

log "Plan save result: $SAVE_RESULT (title: $PLAN_TITLE, file: $PLAN_FILENAME, source: sweep, immorterm: $IMMORTERM_ID)"

# Update marker regardless of save result (avoid infinite retries)
echo "$PLAN_MTIME" > "$MARKER_FILE"

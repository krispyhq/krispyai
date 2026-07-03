#!/bin/bash
# Owner: ImmorTerm Memory
# ImmorTerm Memory: Code Change Capture (ASYNC PostToolUse hook)
# Matcher: Write|Edit|MultiEdit
# Project: lonormaly-krispyai
#
# Captures file diffs from Write/Edit/MultiEdit operations and stores them
# in the code_changes table via the ImmorTerm-Memory REST API.
# This is the real-time capture half of the Code-Bound Memory system.

IMMORTERM_MEMORY_URL="http://127.0.0.1:${IMMORTERM_MEMORY_PORT:-8765}"
MAX_DIFF_SIZE=50000  # 50KB cap per diff

# Derive project root from this script's location
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Per-project hook log convention
_LOG_DIR="$PROJECT_ROOT/.immorterm/terminals/hooks/logs"
_ERR_DIR="$PROJECT_ROOT/.immorterm/terminals/hooks/errors"
mkdir -p "$_LOG_DIR" "$_ERR_DIR"
LOG_FILE="$_LOG_DIR/code-capture.log"
ERR_FILE="$_ERR_DIR/code-capture.log"

log() {
  local msg
  msg=$(printf '%s' "$*" | tr -d '\n\r' | tr -cd '[:print:]')
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $msg" >> "$LOG_FILE" 2>/dev/null
}

# Read stdin JSON from Claude Code hooks API
STDIN_DATA=$(cat 2>/dev/null || echo '{}')

if [ -z "$STDIN_DATA" ] || [ "$STDIN_DATA" = '{}' ]; then
  log "No stdin data received"
  exit 0
fi

# Stable terminal identifier from env (survives compaction; set by VS Code extension)
IMMORTERM_ID="${IMMORTERM_ID:-${IMMORTERM_WINDOW_ID:-}}"

# Parse the hook input using Python (env var avoids process table exposure)
PARSED=$(IMMORTERM_PROJECT_ID="${IMMORTERM_PROJECT_ID:-lonormaly-krispyai}" _IM_IID="$IMMORTERM_ID" _HOOK_INPUT="$STDIN_DATA" python3 - <<'PYEOF' 2>>"$ERR_FILE"
import json, sys, os, hashlib, subprocess, uuid
from datetime import datetime, timezone

try:
    data = json.loads(os.environ.get("_HOOK_INPUT", "{}"))
except (json.JSONDecodeError, ValueError):
    sys.exit(0)

session_id = data.get("session_id", "")
tool_name = data.get("tool_name", "")
tool_input = data.get("tool_input", {})
tool_response = data.get("tool_response", {})

# Extract file path
file_path = tool_input.get("file_path", "") or tool_response.get("filePath", "")
if not file_path or not session_id:
    sys.exit(0)

# Check if the tool response indicates success
if isinstance(tool_response, dict):
    if tool_response.get("error"):
        sys.exit(0)

timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
change_id = str(uuid.uuid4())

# Capture current git branch for branch-aware memory scoping.
# Falls back to empty string if not in a git repo or git unavailable.
branch = ""
try:
    br = subprocess.run(
        ["git", "rev-parse", "--abbrev-ref", "HEAD"],
        capture_output=True, text=True, timeout=3,
        cwd=os.path.dirname(file_path) or ".",
    )
    if br.returncode == 0:
        branch = br.stdout.strip()
except Exception:
    pass

diff_content = ""
lines_added = 0
lines_removed = 0
file_action = "modified"
after_hash = ""
before_hash = ""

if tool_name == "Edit":
    old_string = tool_input.get("old_string", "")
    new_string = tool_input.get("new_string", "")
    if old_string or new_string:
        diff_lines = []
        for line in old_string.splitlines(True):
            diff_lines.append(f"-{line.rstrip()}")
            lines_removed += 1
        for line in new_string.splitlines(True):
            diff_lines.append(f"+{line.rstrip()}")
            lines_added += 1
        diff_content = "\n".join(diff_lines)

elif tool_name == "MultiEdit":
    edits = tool_input.get("edits", [])
    diff_parts = []
    for edit in edits:
        old_s = edit.get("old_string", "")
        new_s = edit.get("new_string", "")
        if old_s or new_s:
            for line in old_s.splitlines(True):
                diff_parts.append(f"-{line.rstrip()}")
                lines_removed += 1
            for line in new_s.splitlines(True):
                diff_parts.append(f"+{line.rstrip()}")
                lines_added += 1
            diff_parts.append("---")
    diff_content = "\n".join(diff_parts)

elif tool_name == "Write":
    try:
        result = subprocess.run(
            ["git", "diff", "HEAD", "--", file_path],
            capture_output=True, text=True, timeout=5,
            cwd=os.path.dirname(file_path) or "."
        )
        if result.returncode == 0 and result.stdout.strip():
            diff_content = result.stdout.strip()
            for line in diff_content.splitlines():
                if line.startswith("+") and not line.startswith("+++"):
                    lines_added += 1
                elif line.startswith("-") and not line.startswith("---"):
                    lines_removed += 1
            if lines_removed == 0 and "new file mode" in diff_content:
                file_action = "added"
        else:
            status = subprocess.run(
                ["git", "status", "--porcelain", "--", file_path],
                capture_output=True, text=True, timeout=5,
                cwd=os.path.dirname(file_path) or "."
            )
            if status.stdout.strip().startswith("??"):
                file_action = "added"
                try:
                    with open(file_path, "r", errors="ignore") as f:
                        content = f.read()
                    lines_added = len(content.splitlines())
                    diff_content = "\n".join(f"+{line}" for line in content.splitlines()[:200])
                    if len(content.splitlines()) > 200:
                        diff_content += f"\n... ({len(content.splitlines()) - 200} more lines)"
                except Exception:
                    diff_content = f"+[New file: {file_path}]"
            else:
                diff_content = f"[Write to {file_path} - no diff available]"
    except Exception as e:
        diff_content = f"[Write to {file_path} - git diff failed: {e}]"

try:
    with open(file_path, "rb") as f:
        after_hash = hashlib.sha256(f.read()).hexdigest()[:16]
except Exception:
    pass

max_diff = int(os.environ.get("MAX_DIFF_SIZE", "50000"))
if len(diff_content) > max_diff:
    diff_content = diff_content[:max_diff] + f"\n... [truncated at {max_diff} chars]"

if not diff_content:
    sys.exit(0)

result = {
    "id": change_id,
    "session_id": session_id,
    "user_id": os.environ.get("IMMORTERM_PROJECT_ID", "unknown"),
    "file_path": file_path,
    "tool_name": tool_name,
    "file_action": file_action,
    "diff_content": diff_content,
    "lines_added": lines_added,
    "lines_removed": lines_removed,
    "before_hash": before_hash,
    "after_hash": after_hash,
    "timestamp": timestamp,
    "immorterm_id": os.environ.get("_IM_IID", ""),
    "branch": branch,
}
print(json.dumps(result))
PYEOF
)

if [ -z "$PARSED" ]; then
  log "No parseable change data"
  exit 0
fi

# POST to ImmorTerm-Memory code-changes endpoint (retry up to 3 times on connection failure)
_CC_RETRIES=0
while [ "$_CC_RETRIES" -lt 3 ]; do
  HTTP_RESPONSE=$(curl -s -w "\n%{http_code}" \
    -X POST "$IMMORTERM_MEMORY_URL/api/v1/code-changes/" \
    -H "Content-Type: application/json" \
    --max-time 5 \
    -d "$PARSED" 2>/dev/null)

  HTTP_CODE=$(echo "$HTTP_RESPONSE" | tail -1)
  BODY=$(echo "$HTTP_RESPONSE" | sed '$d')

  if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "201" ]; then
    FILE_PATH=$(echo "$PARSED" | python3 -c "import json,sys; print(json.load(sys.stdin).get('file_path','?'))" 2>>"$ERR_FILE")
    ACTION=$(echo "$PARSED" | python3 -c "import json,sys; print(json.load(sys.stdin).get('file_action','?'))" 2>>"$ERR_FILE")
    log "Captured: $ACTION $FILE_PATH"
    break
  elif [ "$HTTP_CODE" = "000" ]; then
    _CC_RETRIES=$((_CC_RETRIES + 1))
    [ "$_CC_RETRIES" -lt 3 ] && sleep 2
  else
    log "Error (HTTP $HTTP_CODE): $BODY"
    break
  fi
done
if [ "$_CC_RETRIES" -ge 3 ]; then
  log "Error (HTTP 000): server unreachable after 3 retries"
fi

# ── File Checkpoint Capture (background, non-blocking) ────────────────────
# Reconstruct the pre-edit file content and POST as a checkpoint.
# The server deduplicates: only the FIRST edit per session per file is stored.
# For Edit/MultiEdit: reverse the diff (swap new_string → old_string).
# For Write: fallback to git show HEAD:<file> (last committed version).
(
CHECKPOINT_LOG="$_LOG_DIR/checkpoint.log"
cp_log() {
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*" >> "$CHECKPOINT_LOG" 2>/dev/null
}

CHECKPOINT_DATA=$(_HOOK_INPUT="$STDIN_DATA" _IM_IID="$IMMORTERM_ID" python3 - <<'PYEOF' 2>>"$ERR_FILE"
import json, sys, os, gzip, base64, subprocess

try:
    data = json.loads(os.environ.get("_HOOK_INPUT", "{}"))
except (json.JSONDecodeError, ValueError):
    sys.exit(0)

session_id = data.get("session_id", "")
tool_name = data.get("tool_name", "")
tool_input = data.get("tool_input", {})
file_path = tool_input.get("file_path", "")

if not file_path or not session_id:
    sys.exit(0)

try:
    if os.path.exists(file_path) and os.path.getsize(file_path) > 200 * 1024:
        sys.exit(0)
except Exception:
    pass

user_id = os.environ.get("IMMORTERM_PROJECT_ID", "unknown")
pre_edit_content = None
change_type = "modified"

if tool_name == "Edit":
    old_string = tool_input.get("old_string", "")
    new_string = tool_input.get("new_string", "")
    if old_string and new_string and file_path and os.path.exists(file_path):
        try:
            with open(file_path, "r", errors="ignore") as f:
                current = f.read()
            pre_edit_content = current.replace(new_string, old_string, 1)
        except Exception:
            pass

elif tool_name == "MultiEdit":
    edits = tool_input.get("edits", [])
    if edits and file_path and os.path.exists(file_path):
        try:
            with open(file_path, "r", errors="ignore") as f:
                current = f.read()
            for edit in reversed(edits):
                old_s = edit.get("old_string", "")
                new_s = edit.get("new_string", "")
                if old_s and new_s:
                    current = current.replace(new_s, old_s, 1)
            pre_edit_content = current
        except Exception:
            pass

elif tool_name == "Write":
    try:
        result = subprocess.run(
            ["git", "show", "HEAD:" + os.path.relpath(file_path)],
            capture_output=True, text=True, timeout=5,
            cwd=os.path.dirname(file_path) or "."
        )
        if result.returncode == 0:
            pre_edit_content = result.stdout
        else:
            change_type = "added"
            sys.exit(0)
    except Exception:
        sys.exit(0)

if pre_edit_content is None:
    sys.exit(0)

try:
    compressed = gzip.compress(pre_edit_content.encode("utf-8"))
    b64 = base64.b64encode(compressed).decode("ascii")
except Exception:
    sys.exit(0)

payload = {
    "session_id": session_id,
    "user_id": user_id,
    "file_path": file_path,
    "content_base64": b64,
    "change_type": change_type,
    "file_size_bytes": len(pre_edit_content),
    "immorterm_id": os.environ.get("_IM_IID", ""),
}
print(json.dumps(payload))
PYEOF
)

if [ -n "$CHECKPOINT_DATA" ]; then
  _CP_RETRIES=0
  while [ "$_CP_RETRIES" -lt 3 ]; do
    CP_RESPONSE=$(curl -s -w "\n%{http_code}" \
      -X POST "$IMMORTERM_MEMORY_URL/api/v1/file-checkpoints/" \
      -H "Content-Type: application/json" \
      --max-time 5 \
      -d "$CHECKPOINT_DATA" 2>/dev/null)

    CP_CODE=$(echo "$CP_RESPONSE" | tail -1)
    CP_BODY=$(echo "$CP_RESPONSE" | sed '$d')

    if [ "$CP_CODE" = "200" ] || [ "$CP_CODE" = "201" ]; then
      CP_ACTION=$(echo "$CP_BODY" | python3 -c "import json,sys; print(json.load(sys.stdin).get('action','?'))" 2>>"$ERR_FILE")
      CP_FILE=$(echo "$CHECKPOINT_DATA" | python3 -c "import json,sys; print(json.load(sys.stdin).get('file_path','?'))" 2>>"$ERR_FILE")
      cp_log "Checkpoint $CP_ACTION: $CP_FILE"
      break
    elif [ "$CP_CODE" = "000" ]; then
      _CP_RETRIES=$((_CP_RETRIES + 1))
      [ "$_CP_RETRIES" -lt 3 ] && sleep 2
    else
      cp_log "Checkpoint error (HTTP $CP_CODE): $CP_BODY"
      break
    fi
  done
  if [ "$_CP_RETRIES" -ge 3 ]; then
    cp_log "Checkpoint error (HTTP 000): server unreachable after 3 retries"
  fi
fi
) &

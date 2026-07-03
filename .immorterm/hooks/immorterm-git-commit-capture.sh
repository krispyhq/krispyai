#!/bin/bash
# Owner: ImmorTerm Memory
# ImmorTerm Memory: Git Commit Capture (ASYNC post-commit hook)
# Called from .husky/post-commit or .git/hooks/post-commit trampoline
# Project: lonormaly-krispyai
#
# Captures git commit metadata and stores it in the git_commits table
# via the ImmorTerm-Memory REST API. This runs backgrounded (&) so git
# returns immediately.

IMMORTERM_MEMORY_URL="http://127.0.0.1:${IMMORTERM_MEMORY_PORT:-8765}"

# Derive project root from this script's location
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Per-project hook log convention
_LOG_DIR="$PROJECT_ROOT/.immorterm/terminals/hooks/logs"
_ERR_DIR="$PROJECT_ROOT/.immorterm/terminals/hooks/errors"
mkdir -p "$_LOG_DIR" "$_ERR_DIR"
LOG_FILE="$_LOG_DIR/git-commit.log"
ERR_FILE="$_ERR_DIR/git-commit.log"

log() {
  local msg
  msg=$(printf '%s' "$*" | tr -d '\n\r' | tr -cd '[:print:]')
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $msg" >> "$LOG_FILE" 2>/dev/null
}

# Gather commit data via git CLI
COMMIT_HASH=$(git rev-parse HEAD 2>/dev/null)
if [ -z "$COMMIT_HASH" ]; then
  log "Failed to get HEAD commit hash"
  exit 0
fi

# Build JSON payload using Python (handles escaping safely)
PAYLOAD=$(python3 - "$COMMIT_HASH" <<'PYEOF' 2>>"$ERR_FILE"
import json, sys, os, subprocess

commit_hash = sys.argv[1]

def git(*args):
    r = subprocess.run(["git"] + list(args), capture_output=True, text=True, timeout=5)
    return r.stdout.strip() if r.returncode == 0 else ""

# Commit message (full body)
commit_message = git("log", "-1", "--format=%B", commit_hash)

# Branch name
branch = git("branch", "--show-current") or git("rev-parse", "--abbrev-ref", "HEAD")

# Author
author = git("log", "-1", "--format=%an <%ae>", commit_hash)

# Files changed (capped at 100)
files_raw = git("diff-tree", "--no-commit-id", "--name-only", "-r", commit_hash)
files_list = [f for f in files_raw.splitlines() if f][:100]

# Line stats
numstat_raw = git("diff-tree", "--no-commit-id", "--numstat", "-r", commit_hash)
lines_added = 0
lines_removed = 0
for line in numstat_raw.splitlines():
    parts = line.split("\t")
    if len(parts) >= 2:
        try:
            a = int(parts[0]) if parts[0] != "-" else 0
            r = int(parts[1]) if parts[1] != "-" else 0
            lines_added += a
            lines_removed += r
        except ValueError:
            pass

# Merge detection
is_merge = 0
try:
    subprocess.run(["git", "rev-parse", commit_hash + "^2"],
                   capture_output=True, timeout=5, check=True)
    is_merge = 1
except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
    pass

# Parent hashes
parent_hashes = git("log", "-1", "--format=%P", commit_hash)

# Timestamp (author date, ISO-8601)
timestamp = git("log", "-1", "--format=%aI", commit_hash)

# Session linking (inherited from Claude's Bash env via CLAUDE_ENV_FILE)
session_id = os.environ.get("SESSION_ID", "")
immorterm_id = os.environ.get("IMMORTERM_ID", "") or os.environ.get("IMMORTERM_WINDOW_ID", "")
user_id = os.environ.get("IMMORTERM_PROJECT_ID", "lonormaly-krispyai")

# ── Contributing Sessions ─────────────────────────────────────────────
# Query the code_changes table to find which Claude sessions recently
# edited the files being committed. This links commits to ALL sessions
# that produced the code, not just the one that ran "git commit".
contributing_sessions = []
try:
    import urllib.request, urllib.parse

    # Time window: since previous commit, or 7 days for first commit
    # IMPORTANT: Convert to UTC — DB stores UTC timestamps, and SQLite
    # compares ISO-8601 strings lexicographically. Mixing timezone offsets
    # (e.g. +07:00 vs +00:00) breaks the comparison silently.
    from datetime import datetime, timedelta, timezone
    prev_timestamp = ""
    try:
        raw_ts = git("log", "-1", "--format=%aI", "HEAD~1")
        if raw_ts:
            dt = datetime.fromisoformat(raw_ts)
            prev_timestamp = dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S+00:00")
    except Exception:
        pass
    if not prev_timestamp:
        prev_timestamp = (datetime.now(timezone.utc) - timedelta(days=7)).strftime("%Y-%m-%dT%H:%M:%S+00:00")

    seen_sessions = set()
    seen_immorterm_ids = set()
    contributing_immorterm_ids = []
    api_base = os.environ.get("IMMORTERM_MEMORY_URL", "http://127.0.0.1:8765")
    for fpath in files_list[:30]:  # Cap at 30 files to keep it fast
        try:
            url = (f"{api_base}/api/v1/code-changes/"
                   f"?file_path={urllib.parse.quote(fpath)}"
                   f"&start_date={urllib.parse.quote(prev_timestamp)}"
                   f"&user_id={urllib.parse.quote(user_id)}"
                   f"&limit=50")
            resp = urllib.request.urlopen(url, timeout=3)
            data = json.loads(resp.read())
            for change in data.get("changes", []):
                sid = change.get("session_id", "")
                if sid and sid not in seen_sessions:
                    seen_sessions.add(sid)
                    contributing_sessions.append(sid)
                iid = change.get("immorterm_id", "")
                if iid and iid not in seen_immorterm_ids:
                    seen_immorterm_ids.add(iid)
                    contributing_immorterm_ids.append(iid)
        except Exception:
            pass  # Graceful: API unreachable → empty list
except Exception:
    pass  # Outer safety net — commit still gets stored without session links
# ── End Contributing Sessions ─────────────────────────────────────────

# Prefer the most recent contributing session over the committer's env SESSION_ID.
# The committer's session may be a post-compaction UUID that differs from the
# editing session. Contributing sessions come from actual code_changes records.
effective_session = contributing_sessions[0] if contributing_sessions else session_id
effective_immorterm = contributing_immorterm_ids[0] if contributing_immorterm_ids else immorterm_id

payload = {
    "commit_hash": commit_hash,
    "commit_message": commit_message,
    "branch": branch,
    "author": author,
    "session_id": effective_session,
    "immorterm_id": effective_immorterm,
    "user_id": user_id,
    "files_changed": json.dumps(files_list),
    "files_count": len(files_list),
    "lines_added": lines_added,
    "lines_removed": lines_removed,
    "is_merge": is_merge,
    "parent_hashes": parent_hashes,
    "contributing_sessions": json.dumps(contributing_sessions),
    "contributing_immorterm_ids": json.dumps(contributing_immorterm_ids),
    "timestamp": timestamp,
}

print(json.dumps(payload))
PYEOF
)

if [ -z "$PAYLOAD" ]; then
  log "Failed to build commit payload"
  exit 0
fi

# POST to ImmorTerm-Memory git-commits endpoint
HTTP_RESPONSE=$(curl -s -w "\n%{http_code}" \
  -X POST "$IMMORTERM_MEMORY_URL/api/v1/git-commits/" \
  -H "Content-Type: application/json" \
  --max-time 5 \
  -d "$PAYLOAD" 2>/dev/null)

HTTP_CODE=$(echo "$HTTP_RESPONSE" | tail -1)
BODY=$(echo "$HTTP_RESPONSE" | sed '$d')

if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "201" ]; then
  BRANCH=$(echo "$PAYLOAD" | python3 -c "import json,sys; print(json.load(sys.stdin).get('branch','?'))" 2>>"$ERR_FILE")
  MSG=$(echo "$PAYLOAD" | python3 -c "import json,sys; m=json.load(sys.stdin).get('commit_message',''); print(m[:60])" 2>>"$ERR_FILE")
  log "Captured: $COMMIT_HASH ($BRANCH) $MSG"
else
  log "Error (HTTP $HTTP_CODE): $BODY"
fi

# ── Mark-merged trigger (prod-branch merges) ─────────────────────────────
# When a merge commit lands on the prod branch, promote the contributing
# sessions' memories from conjecture (feature-branch) to fact (merged-to-main).
# Default prod branches: main, master. Override via $IMMORTERM_PROD_BRANCH.
(
MERGE_LOG="$_LOG_DIR/mark-merged.log"
mm_log() {
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*" >> "$MERGE_LOG" 2>/dev/null
}

MARK_MERGED=$(PAYLOAD_JSON="$PAYLOAD" COMMIT_HASH="$COMMIT_HASH" \
  IMMORTERM_PROD_BRANCH="${IMMORTERM_PROD_BRANCH:-}" \
  python3 - <<'PYEOF' 2>>"$ERR_FILE"
import json, os, sys

try:
    payload = json.loads(os.environ.get("PAYLOAD_JSON", "{}"))
except Exception:
    sys.exit(0)

is_merge = int(payload.get("is_merge", 0) or 0)
branch = (payload.get("branch") or "").strip()
user_id = payload.get("user_id", "")

# Default prod branch set: main, master. Env override adds one more.
prod_branches = {"main", "master"}
extra = os.environ.get("IMMORTERM_PROD_BRANCH", "").strip()
if extra:
    prod_branches.add(extra)

if is_merge != 1 or branch not in prod_branches:
    sys.exit(0)

# contributing_immorterm_ids is stored as a JSON-encoded string
raw_ids = payload.get("contributing_immorterm_ids", "[]")
try:
    ids = json.loads(raw_ids) if isinstance(raw_ids, str) else (raw_ids or [])
    ids = [i for i in ids if isinstance(i, str) and i]
except Exception:
    ids = []

if not ids:
    sys.exit(0)

out = {
    "user_id": user_id,
    "contributing_immorterm_ids": ids,
    "commit_hash": os.environ.get("COMMIT_HASH", ""),
    "merged_at": payload.get("timestamp") or None,
}
print(json.dumps(out))
PYEOF
)

if [ -n "$MARK_MERGED" ]; then
  MM_RESPONSE=$(curl -s -w "\n%{http_code}" \
    -X POST "$IMMORTERM_MEMORY_URL/api/v1/memories/mark-merged" \
    -H "Content-Type: application/json" \
    --max-time 5 \
    -d "$MARK_MERGED" 2>/dev/null)

  MM_CODE=$(echo "$MM_RESPONSE" | tail -1)
  MM_BODY=$(echo "$MM_RESPONSE" | sed '$d')

  if [ "$MM_CODE" = "200" ] || [ "$MM_CODE" = "201" ]; then
    UPDATED=$(echo "$MM_BODY" | python3 -c "import json,sys; print(json.load(sys.stdin).get('updated',0))" 2>>"$ERR_FILE")
    mm_log "Promoted $UPDATED memories to merged_to_main for $COMMIT_HASH"
  else
    mm_log "mark-merged error (HTTP $MM_CODE): $MM_BODY"
  fi
fi
) &

# ── File Checkpoint Git Dedup ─────────────────────────────────────────────
# For each committed file, swap the gzipped blob in file_checkpoints with a
# git ref (~50 bytes vs ~4KB). This keeps the DB lean while preserving
# recovery ability via git show <ref>.
USER_ID=$(echo "$PAYLOAD" | python3 -c "import json,sys; print(json.load(sys.stdin).get('user_id',''))" 2>>"$ERR_FILE")
FILES_JSON=$(echo "$PAYLOAD" | python3 -c "import json,sys; print(json.load(sys.stdin).get('files_changed','[]'))" 2>>"$ERR_FILE")

if [ -n "$FILES_JSON" ] && [ "$FILES_JSON" != "[]" ]; then
  python3 - "$COMMIT_HASH" "$FILES_JSON" "$USER_ID" "$IMMORTERM_MEMORY_URL" <<'PYEOF' 2>>"$ERR_FILE" &
import json, sys, os
from urllib.request import Request, urlopen

commit_hash = sys.argv[1]
files_list = json.loads(sys.argv[2])
user_id = sys.argv[3]
api_url = sys.argv[4]
session_id = os.environ.get("SESSION_ID", "")

for file_path in files_list:
    git_ref = f"{commit_hash}~1:{file_path}"
    payload = json.dumps({
        "session_id": session_id,
        "file_path": file_path,
        "user_id": user_id,
        "git_ref": git_ref,
    })
    try:
        req = Request(
            f"{api_url}/api/v1/file-checkpoints/dedup",
            data=payload.encode(),
            headers={"Content-Type": "application/json"},
            method="POST"
        )
        urlopen(req, timeout=3)
    except Exception:
        pass
PYEOF
fi

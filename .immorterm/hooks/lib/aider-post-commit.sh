#!/bin/bash
# ImmorTerm: Aider post-commit hook (Phase A T4)
# Aider has no event hooks; we detect Aider activity via filesystem markers and
# diff its markdown transcript against a stored checkpoint, synthesizing a
# Claude-shape Stop event when the chat advances. The aider transcript adapter
# (T6) handles parsing the markdown.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOKS_DIR="$(dirname "$SCRIPT_DIR")"  # parent of lib/

export IMMORTERM_AI_TOOL=aider

# Resolve git root (post-commit always runs inside the repo, but be defensive).
GIT_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || echo "")"
if [ -z "$GIT_ROOT" ]; then
  exit 0
fi

CHAT_HISTORY="$GIT_ROOT/.aider.chat.history.md"
TAGS_CACHE="$GIT_ROOT/.aider.tags.cache.v3"

# Detection: Aider activity must be evident. Either the tags-cache dir exists or
# the chat history was modified within the last 60 seconds. Otherwise this is a
# non-Aider commit and we exit silently.
detected=0
if [ -d "$TAGS_CACHE" ]; then
  detected=1
fi
if [ -f "$CHAT_HISTORY" ]; then
  # Portable mtime: BSD stat (-f) on macOS, GNU stat (-c) on Linux.
  if mtime=$(stat -f %m "$CHAT_HISTORY" 2>/dev/null); then
    :
  else
    mtime=$(stat -c %Y "$CHAT_HISTORY" 2>/dev/null || echo 0)
  fi
  now=$(date -u +%s)
  age=$(( now - mtime ))
  if [ "$age" -ge 0 ] && [ "$age" -le 60 ]; then
    detected=1
  fi
fi

if [ "$detected" -eq 0 ]; then
  exit 0
fi

if [ ! -f "$CHAT_HISTORY" ]; then
  # Aider activity detected but no chat history — nothing to digest.
  exit 0
fi

# Stable repo hash for the checkpoint filename.
REPO_HASH=$(printf '%s' "$GIT_ROOT" | python3 -c 'import sys,hashlib;print(hashlib.sha256(sys.stdin.read().encode()).hexdigest()[:16])' 2>/dev/null || printf 'unknownrepohash')

CHECKPOINT_DIR="$HOME/.immorterm/aider-checkpoints"
CHECKPOINT_FILE="$CHECKPOINT_DIR/$REPO_HASH.json"
mkdir -p "$CHECKPOINT_DIR"

# Read previous mtime/size if present.
PREV_SIZE=0
PREV_MTIME=0
if [ -f "$CHECKPOINT_FILE" ]; then
  read -r PREV_SIZE PREV_MTIME <<<"$(python3 - "$CHECKPOINT_FILE" <<'PYEOF' 2>/dev/null || echo "0 0"
import json, sys
try:
    with open(sys.argv[1]) as f:
        d = json.load(f)
    print(int(d.get("size", 0)), int(d.get("mtime", 0)))
except Exception:
    print(0, 0)
PYEOF
)"
  PREV_SIZE="${PREV_SIZE:-0}"
  PREV_MTIME="${PREV_MTIME:-0}"
fi

# Current size and mtime (portable).
if cur_size=$(stat -f %z "$CHAT_HISTORY" 2>/dev/null); then
  cur_mtime=$(stat -f %m "$CHAT_HISTORY" 2>/dev/null || echo 0)
else
  cur_size=$(stat -c %s "$CHAT_HISTORY" 2>/dev/null || echo 0)
  cur_mtime=$(stat -c %Y "$CHAT_HISTORY" 2>/dev/null || echo 0)
fi

# Only synthesize a Stop event if the file actually advanced.
if [ "$cur_size" -le "$PREV_SIZE" ] && [ "$cur_mtime" -le "$PREV_MTIME" ]; then
  exit 0
fi

# Synthesize Claude-shape Stop event and pipe to digest hook.
STOP_PAYLOAD=$(GIT_ROOT="$GIT_ROOT" REPO_HASH="$REPO_HASH" python3 - <<'PYEOF' 2>/dev/null || echo ""
import json, os
out = {
  "session_id": os.environ["REPO_HASH"],
  "hook_event_name": "Stop",
  "cwd": os.environ["GIT_ROOT"],
}
print(json.dumps(out))
PYEOF
)

if [ -n "$STOP_PAYLOAD" ] && [ -x "$HOOKS_DIR/immorterm-memory-digest.sh" ]; then
  bash "$HOOKS_DIR/immorterm-memory-digest.sh" <<<"$STOP_PAYLOAD" >/dev/null 2>&1 || true
fi

# Update checkpoint atomically.
TMP_CHECKPOINT="$CHECKPOINT_FILE.tmp"
size="$cur_size" mtime="$cur_mtime" python3 - >"$TMP_CHECKPOINT" <<'PYEOF' 2>/dev/null || true
import json, os
print(json.dumps({"size": int(os.environ.get("size", 0)), "mtime": int(os.environ.get("mtime", 0))}))
PYEOF

if [ -s "$TMP_CHECKPOINT" ]; then
  mv "$TMP_CHECKPOINT" "$CHECKPOINT_FILE"
else
  rm -f "$TMP_CHECKPOINT"
fi

exit 0

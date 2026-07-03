#!/bin/bash
# Owner: ImmorTerm Memory
# ImmorTerm Memory: Background Save Helper
# Usage: bash .immorterm/hooks/immorterm-bg-memory-save.sh <category[,category2,...]> <text>
#
# Called via Bash(run_in_background: true) to save memories without
# blocking the conversation. This replaces synchronous MCP add_memories calls.
#
# Example:
#   Bash(run_in_background: true):
#     bash .immorterm/hooks/immorterm-bg-memory-save.sh "architecture" "We chose X because Y"

IMMORTERM_MEMORY_URL="http://127.0.0.1:${IMMORTERM_MEMORY_PORT:-8765}/api/v1/memories/"
# PROJECT_ID from CLAUDE_ENV_FILE (set by SessionStart hook), with fallback
USER_ID="${IMMORTERM_PROJECT_ID:-lonormaly-krispyai}"
TIMESTAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)
# SESSION_ID is set via CLAUDE_ENV_FILE by the SessionStart hook
SESSION_ID="${SESSION_ID:-}"
# IMMORTERM_ID is set via CLAUDE_ENV_FILE by the SessionStart hook
IMMORTERM_ID="${IMMORTERM_ID:-}"

CATEGORIES_RAW="${1:?Usage: $0 <category[,category2,...]> <text>}"
shift
TEXT="$*"

if [ -z "$TEXT" ]; then
  echo "Error: No memory text provided" >&2
  exit 1
fi

# Build entire JSON payload in Python — avoids all shell quoting/escaping issues.
# All data passes via environment variables; Python's json.dumps handles escaping.
PAYLOAD=$(
  _IM_TEXT="$TEXT" \
  _IM_CATS="$CATEGORIES_RAW" \
  _IM_USER="$USER_ID" \
  _IM_TS="$TIMESTAMP" \
  _IM_SID="$SESSION_ID" \
  _IM_IID="$IMMORTERM_ID" \
  python3 << 'PYEOF'
import os, json

text = os.environ["_IM_TEXT"].strip()
cats_raw = os.environ["_IM_CATS"]
user_id = os.environ["_IM_USER"]
timestamp = os.environ["_IM_TS"]
session_id = os.environ.get("_IM_SID", "")
immorterm_id = os.environ.get("_IM_IID", "")

cats =[c.strip() for c in cats_raw.split(",") if c.strip()]
first_cat = cats[0] if cats else "decisions"

# Auto-detect decision status from text prefix
status = ""
if text.startswith("PLANNED:"):
    status = "planned"
elif text.startswith("IN_PROGRESS:"):
    status = "in_progress"
elif text.startswith("COMPLETED:"):
    status = "completed"

metadata = {
    "type": "history_ref",
    "timestamp": timestamp,
    "categories": cats,
    "category": first_cat,
}
if session_id:
    metadata["session_id"] = session_id
if immorterm_id:
    metadata["immorterm_id"] = immorterm_id
if status:
    metadata["status"] = status

payload = {
    "user_id": user_id,
    "text": text,
    "metadata": metadata,
    "infer": False,
}
print(json.dumps(payload))
PYEOF
)

if [ -z "$PAYLOAD" ]; then
  echo "Error: Failed to build JSON payload" >&2
  exit 1
fi

# Save to ImmorTerm-Memory
RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "$IMMORTERM_MEMORY_URL" \
  -H "Content-Type: application/json" \
  --max-time 5 \
  -d "$PAYLOAD" 2>/dev/null)

HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | sed '$d')

if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "201" ]; then
  echo "Memory saved: [$CATEGORIES_RAW] ${TEXT:0:80}..."
else
  echo "Error saving memory (HTTP $HTTP_CODE): $BODY" >&2
  exit 1
fi

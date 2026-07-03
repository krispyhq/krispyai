#!/bin/bash
# Owner: ImmorTerm Memory
# ImmorTerm Memory: Knowledge Digestion Save Helper
# Usage: bash .immorterm/hooks/immorterm-digest-save.sh <json-file-path>
#
# Accepts a JSON file with the full memory payload including entities and relations
# for the Neo4j knowledge graph. Used by the knowledge-digester agent.
#
# JSON format:
# {
#   "text": "Memory content...",
#   "metadata": { "type": "framework-deep-dive", "pack": "...", ... },
#   "entities": [{"name": "...", "type": "..."}],
#   "relations": [{"source": "...", "relationship": "...", "destination": "..."}]
# }

IMMORTERM_MEMORY_URL="http://127.0.0.1:${IMMORTERM_MEMORY_PORT:-8765}/api/v1/memories/"
# Source shared env for IMMORTERM_PROJECT_ID (never hardcoded)
source "$(cd "$(dirname "$0")" && pwd)/_immorterm-env.sh"
USER_ID="$IMMORTERM_PROJECT_ID"
# SESSION_ID is set via CLAUDE_ENV_FILE by the SessionStart hook
SESSION_ID="${SESSION_ID:-}"
IMMORTERM_ID="${IMMORTERM_ID:-}"

JSON_FILE="${1:?Usage: $0 <json-file-path>}"

if [ ! -f "$JSON_FILE" ]; then
  echo "Error: File not found: $JSON_FILE" >&2
  exit 1
fi

# Validate JSON and inject user_id + infer=false + session_id + immorterm_id (env vars avoid injection)
PAYLOAD=$(_IM_USER="$USER_ID" _IM_SID="$SESSION_ID" _IM_IID="$IMMORTERM_ID" python3 -c "
import json, sys, os
with open(sys.argv[1]) as f:
    data = json.load(f)
data['user_id'] = os.environ['_IM_USER']
data['infer'] = False
sid = os.environ.get('_IM_SID', '')
if sid:
    data.setdefault('metadata', {})['session_id'] = sid
iid = os.environ.get('_IM_IID', '')
if iid:
    data.setdefault('metadata', {})['immorterm_id'] = iid
print(json.dumps(data))
" "$JSON_FILE" 2>/dev/null)

if [ -z "$PAYLOAD" ]; then
  echo "Error: Failed to process JSON from $JSON_FILE" >&2
  exit 1
fi

# Save to ImmorTerm-Memory
RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "$IMMORTERM_MEMORY_URL" \
  -H "Content-Type: application/json" \
  --max-time 10 \
  -d "$PAYLOAD" 2>/dev/null)

HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | sed '$d')

# Log result
TEXT_PREVIEW=$(python3 -c "
import json, sys
data = json.loads(sys.argv[1])
text = data.get('text', '')[:80]
mtype = data.get('metadata', {}).get('type', 'unknown')
pack = data.get('metadata', {}).get('pack', 'unknown')
print(f'[{mtype}] {pack}: {text}...')
" "$PAYLOAD" 2>/dev/null)

if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "201" ]; then
  echo "Saved: $TEXT_PREVIEW"
else
  echo "Error saving memory (HTTP $HTTP_CODE): $BODY" >&2
  exit 1
fi

#!/bin/bash
# Owner: ImmorTerm Memory
# ImmorTerm: Task Context Injection (UserPromptSubmit)
# Checks for pending task signal files and injects task context.
# Signal file: ~/.immorterm/pending-task/{IMMORTERM_ID}.json

source "$(cd "$(dirname "$0")" && pwd)/_immorterm-env.sh" 2>/dev/null

# Check for task signal
TASK_FILE="$HOME/.immorterm/pending-task/${IMMORTERM_ID}.json"
[ -f "$TASK_FILE" ] || exit 0

# Skip stale signal files (older than 1 hour)
FILE_AGE=$(( $(date +%s) - $(stat -c %Y "$TASK_FILE" 2>/dev/null || stat -f %m "$TASK_FILE" 2>/dev/null || echo 0) ))
if [ "$FILE_AGE" -gt 3600 ]; then
  rm -f "$TASK_FILE"
  exit 0
fi

TASK_ID=$(jq -r '.task_id // ""' "$TASK_FILE" 2>/dev/null)
TASK_TITLE=$(jq -r '.task_title // ""' "$TASK_FILE" 2>/dev/null)
TASK_TYPE=$(jq -r '.task_type // "other"' "$TASK_FILE" 2>/dev/null)
TASK_CWD=$(jq -r '.context.cwd // ""' "$TASK_FILE" 2>/dev/null)
TASK_TEXT=$(jq -r '.context.selectedText // ""' "$TASK_FILE" 2>/dev/null)
TASK_DESCRIPTION=$(jq -r '.task_description // ""' "$TASK_FILE" 2>/dev/null)
# Origin session IDs — where the task was originally created
SOURCE_SESSION_ID=$(jq -r '.context.sourceSessionId // ""' "$TASK_FILE" 2>/dev/null)
SOURCE_IMMORTERM_ID=$(jq -r '.context.sourceImmorTermId // ""' "$TASK_FILE" 2>/dev/null)
SOURCE_SUMMARY_ID=$(jq -r '.context.sourceMemorySummaryId // ""' "$TASK_FILE" 2>/dev/null)
# Byte-offset pointer into the origin Claude JSONL transcript (O(1) slice retrieval)
SOURCE_BYTE_OFFSET=$(jq -r '.context.sourceMemoryByteOffset // ""' "$TASK_FILE" 2>/dev/null)
SOURCE_BYTE_LENGTH=$(jq -r '.context.sourceMemoryByteLength // ""' "$TASK_FILE" 2>/dev/null)
SOURCE_JSONL_PATH=$(jq -r '.context.sourceMemoryJsonlPath // ""' "$TASK_FILE" 2>/dev/null)

# Read linked sessions
LINKED=$(jq -r '
  if (.linked_sessions // []) | length > 0 then
    [.linked_sessions[] | "- Session \"\(.session_name)\" (immorterm_id: \(.immorterm_id))"] | join("\n")
  else empty end
' "$TASK_FILE" 2>/dev/null)

# Always delete signal file first — extension watches for deletion
rm -f "$TASK_FILE"

[ -n "$TASK_ID" ] || exit 0

# ── Build output ─────────────────────────────────────────────
printf '<immorterm-task source="task-drop" task-id="%s">\n' "$TASK_ID"
printf 'Task assigned to you:\n'

# Type label
case "$TASK_TYPE" in
  bug)         printf 'Type: Bug\n' ;;
  feature)     printf 'Type: Feature\n' ;;
  investigate) printf 'Type: Investigate\n' ;;
  *)           printf 'Type: Other\n' ;;
esac

printf 'Title: %s\n' "$TASK_TITLE"
[ -n "$TASK_DESCRIPTION" ] && printf 'Description: %s\n' "$TASK_DESCRIPTION"

# Context captured at creation time
if [ -n "$TASK_CWD" ] || [ -n "$TASK_TEXT" ]; then
  printf '\nContext captured when this task was created:\n'
  [ -n "$TASK_CWD" ] && printf '%s\n' "- Working directory: $TASK_CWD"
  [ -n "$TASK_TEXT" ] && printf '%s\n' "- Terminal output: $TASK_TEXT"
fi

# Origin session — where the task was created (for deep context retrieval)
if [ -n "$SOURCE_SESSION_ID" ] || [ -n "$SOURCE_IMMORTERM_ID" ]; then
  printf '\nOrigin session (where this task was created):\n'
  [ -n "$SOURCE_SESSION_ID" ] && printf '%s\n' "- Claude Code session: $SOURCE_SESSION_ID"
  [ -n "$SOURCE_IMMORTERM_ID" ] && printf '%s\n' "- ImmorTerm ID: $SOURCE_IMMORTERM_ID"
  if [ -n "$SOURCE_JSONL_PATH" ] && [ -n "$SOURCE_BYTE_OFFSET" ]; then
    if [ -n "$SOURCE_BYTE_LENGTH" ]; then
      printf '%s\n' "- Transcript pointer: $SOURCE_JSONL_PATH @ byte_offset=$SOURCE_BYTE_OFFSET (length=$SOURCE_BYTE_LENGTH)"
    else
      printf '%s\n' "- Transcript pointer: $SOURCE_JSONL_PATH @ byte_offset=$SOURCE_BYTE_OFFSET"
    fi
  fi
  printf 'To understand the context that inspired this task:\n'
  if [ -n "$SOURCE_SUMMARY_ID" ]; then
    printf '  get_memory_context(memory_id="%s")  # O(1) — uses byte_offset internally\n' "$SOURCE_SUMMARY_ID"
  fi
  [ -n "$SOURCE_SESSION_ID" ] && printf '  get_session_context(session_id="%s")  # summary + facts + decisions\n' "$SOURCE_SESSION_ID"
  printf '  search_memory(query="%s")\n' "$TASK_TITLE"
fi

# Linked sessions — other sessions that previously worked on this task
if [ -n "$LINKED" ]; then
  printf '\nPreviously worked on by:\n'
  printf '%s\n' "$LINKED"
  printf '\nUse get_conversation_turns() with the immorterm_id above to review their work.\n'
fi

printf '\nACTION REQUIRED — use these MCP tools to manage this task:\n'
printf '1. FIRST: immorterm_update_task(task_id="%s", status="in_progress", lane="now")  — accept the task\n' "$TASK_ID"
printf '2. WHEN DONE: Ask the user if they have tested the change and if they are satisfied.\n'
printf '   - If user confirms: immorterm_update_task(task_id="%s", status="done")\n' "$TASK_ID"
printf '   - If user is NOT required to test (pure code/config change): mark done yourself immediately\n'
printf '   - NEVER silently skip marking done — this is the most important step\n'
printf 'Other tools: immorterm_list_tasks(), immorterm_create_task(title="...")\n'

printf '</immorterm-task>\n'

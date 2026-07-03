#!/bin/bash
# Owner: ImmorTerm Memory
# ImmorTerm: Unified Share Queue (UserPromptSubmit)
# Consumes ALL pending shares for THIS terminal from its OWN per-terminal
# queue directory and injects each as prompt context.
#
#   Queue dir: ~/.immorterm/pending-share/${IMMORTERM_ID}/
#   One file per shared item: {itemId}.json
#   { id, kind: "session"|"task"|"file-explain"|"file-diff", timestamp, ... }
#
# SCOPING GUARANTEE: a terminal only ever reads its OWN ${IMMORTERM_ID}
# directory, so one terminal can NEVER consume another's shares. The empty-id
# guard below closes the historical collision where an unset IMMORTERM_ID made
# every terminal read a single shared file.

source "$(cd "$(dirname "$0")" && pwd)/_immorterm-env.sh" 2>/dev/null
MEMORY_URL="${IMMORTERM_MEMORY_URL:-http://127.0.0.1:${IMMORTERM_MEMORY_PORT:-8765}}"
USER_ID="${IMMORTERM_PROJECT_ID:-lonormaly-immorterm}"

# HARD GUARD — without a stable terminal id we cannot scope safely. Do nothing.
[ -n "$IMMORTERM_ID" ] || exit 0

# RACE GUARD — this script is registered TWICE on UserPromptSubmit: directly in
# the global ~/.claude/settings.json AND via the per-project dispatcher
# (immorterm-user-prompt.sh). They race on the drain; the global one usually
# wins but its stdout is NOT reliably captured as prompt context, so it would
# consume the queue and drop the injection. When a project dispatcher exists,
# DEFER to it (the dispatcher sets IMMORTERM_DISPATCHED=1 and its stdout IS
# captured). Resolve the project dir from the hook's stdin JSON `.cwd` (the
# process cwd is NOT guaranteed to be the project dir); fall back to $PWD.
if [ -z "$IMMORTERM_DISPATCHED" ]; then
  _defer_cwd="$PWD"
  if [ ! -t 0 ]; then
    _defer_stdin=$(cat 2>/dev/null)
    _defer_jcwd=$(jq -r '.cwd // ""' <<<"$_defer_stdin" 2>/dev/null)
    [ -n "$_defer_jcwd" ] && _defer_cwd="$_defer_jcwd"
  fi
  [ -f "$_defer_cwd/.immorterm/hooks/immorterm-user-prompt.sh" ] && exit 0
fi

QUEUE_DIR="$HOME/.immorterm/pending-share/${IMMORTERM_ID}"
[ -d "$QUEUE_DIR" ] || exit 0

shopt -s nullglob

# ── Per-kind emitters (operate on a JSON string in $1) ───────────────

emit_session() {
  local DATA="$1"
  local SOURCE_ID SOURCE_NAME SHARE_MODE
  SOURCE_ID=$(jq -r '.source_immorterm_id // ""' <<<"$DATA" 2>/dev/null)
  SOURCE_NAME=$(jq -r '.source_name // ""' <<<"$DATA" 2>/dev/null)
  SHARE_MODE=$(jq -r '.mode // "static"' <<<"$DATA" 2>/dev/null)
  [ -n "$SOURCE_ID" ] || return 0

  local CTX_RESULT TITLE AT_A_GLANCE SUMMARY
  CTX_RESULT=$(curl -s --max-time 1 \
    "${MEMORY_URL}/api/v1/sessions/context?immorterm_id=${SOURCE_ID}&user_id=${USER_ID}" 2>/dev/null)
  TITLE=$(echo "$CTX_RESULT" | jq -r '.title // empty' 2>/dev/null)
  AT_A_GLANCE=$(echo "$CTX_RESULT" | jq -r '
    if (.at_a_glance // null) | type == "array" and length > 0 then
      [.at_a_glance[] | "- \(.)"] | join("\n")
    else empty end' 2>/dev/null)
  if [ -z "$AT_A_GLANCE" ]; then
    SUMMARY=$(echo "$CTX_RESULT" | jq -r 'if (.summary // "") | length > 0 then .summary[:1500] else empty end' 2>/dev/null)
  fi

  printf '<immorterm-memory source="session-share" scope="cross-session">\n'
  printf 'Context shared from another ImmorTerm session:\n'
  printf 'Session: %s\n' "${SOURCE_NAME}"
  printf 'immorterm_id: %s\n' "${SOURCE_ID}"
  [ -n "$TITLE" ] && printf 'Title: %s\n' "$TITLE"
  if [ -n "$AT_A_GLANCE" ]; then
    printf '\nAt a glance:\n%s\n' "$AT_A_GLANCE"
  elif [ -n "$SUMMARY" ]; then
    printf '\nSummary:\n%s\n' "$SUMMARY"
  fi
  printf '\nTools for deeper exploration:\n'
  echo "- get_conversation_turns(immorterm_id=\"${SOURCE_ID}\") - read actual conversation exchanges"
  echo "- get_plan(immorterm_id=\"${SOURCE_ID}\") - full implementation plan"
  echo "- list_tasks(immorterm_id=\"${SOURCE_ID}\") - task list with status"
  echo "- search_memory(query, immorterm_id=\"${SOURCE_ID}\") - search session memories"
  if [ "$SHARE_MODE" = "interactive" ]; then
    printf '\n## Interactive Session Link Active\n'
    printf 'A live bidirectional channel is active with "%s".\n' "${SOURCE_NAME}"
    printf 'Messages from that session will appear as <channel> events in your context.\n'
    printf 'Use the reply() tool to send messages back.\n'
  fi
  printf '</immorterm-memory>\n'
}

emit_task() {
  local DATA="$1"
  local TASK_ID TASK_TITLE TASK_TYPE TASK_CWD TASK_TEXT TASK_DESCRIPTION
  local SOURCE_SESSION_ID SOURCE_IMMORTERM_ID SOURCE_SUMMARY_ID LINKED
  TASK_ID=$(jq -r '.task_id // ""' <<<"$DATA" 2>/dev/null)
  TASK_TITLE=$(jq -r '.task_title // ""' <<<"$DATA" 2>/dev/null)
  TASK_TYPE=$(jq -r '.task_type // "other"' <<<"$DATA" 2>/dev/null)
  TASK_CWD=$(jq -r '.context.cwd // ""' <<<"$DATA" 2>/dev/null)
  TASK_TEXT=$(jq -r '.context.selectedText // ""' <<<"$DATA" 2>/dev/null)
  TASK_DESCRIPTION=$(jq -r '.task_description // ""' <<<"$DATA" 2>/dev/null)
  SOURCE_SESSION_ID=$(jq -r '.context.sourceSessionId // ""' <<<"$DATA" 2>/dev/null)
  SOURCE_IMMORTERM_ID=$(jq -r '.context.sourceImmorTermId // ""' <<<"$DATA" 2>/dev/null)
  SOURCE_SUMMARY_ID=$(jq -r '.context.sourceMemorySummaryId // ""' <<<"$DATA" 2>/dev/null)
  LINKED=$(jq -r 'if (.linked_sessions // []) | length > 0 then [.linked_sessions[] | "- Session \"\(.session_name)\" (immorterm_id: \(.immorterm_id))"] | join("\n") else empty end' <<<"$DATA" 2>/dev/null)
  [ -n "$TASK_ID" ] || return 0

  printf '<immorterm-task source="task-drop" task-id="%s">\n' "$TASK_ID"
  printf 'Task assigned to you:\n'
  case "$TASK_TYPE" in
    bug)         printf 'Type: Bug\n' ;;
    feature)     printf 'Type: Feature\n' ;;
    investigate) printf 'Type: Investigate\n' ;;
    *)           printf 'Type: Other\n' ;;
  esac
  printf 'Title: %s\n' "$TASK_TITLE"
  [ -n "$TASK_DESCRIPTION" ] && printf 'Description: %s\n' "$TASK_DESCRIPTION"
  if [ -n "$TASK_CWD" ] || [ -n "$TASK_TEXT" ]; then
    printf '\nContext captured when this task was created:\n'
    [ -n "$TASK_CWD" ] && printf -- '- Working directory: %s\n' "$TASK_CWD"
    [ -n "$TASK_TEXT" ] && printf -- '- Terminal output: %s\n' "$TASK_TEXT"
  fi
  if [ -n "$SOURCE_SESSION_ID" ] || [ -n "$SOURCE_IMMORTERM_ID" ]; then
    printf '\nOrigin session (where this task was created):\n'
    [ -n "$SOURCE_SESSION_ID" ] && printf -- '- Claude Code session: %s\n' "$SOURCE_SESSION_ID"
    [ -n "$SOURCE_IMMORTERM_ID" ] && printf -- '- ImmorTerm ID: %s\n' "$SOURCE_IMMORTERM_ID"
    printf 'To understand the context that inspired this task:\n'
    [ -n "$SOURCE_SUMMARY_ID" ] && printf '  get_memory_context(memory_id="%s")\n' "$SOURCE_SUMMARY_ID"
    [ -n "$SOURCE_SESSION_ID" ] && printf '  get_session_context(session_id="%s")\n' "$SOURCE_SESSION_ID"
    printf '  search_memory(query="%s")\n' "$TASK_TITLE"
  fi
  if [ -n "$LINKED" ]; then
    printf '\nPreviously worked on by:\n%s\n' "$LINKED"
    printf '\nUse get_conversation_turns() with the immorterm_id above to review their work.\n'
  fi
  printf '\nACTION REQUIRED — use these MCP tools to manage this task:\n'
  printf '1. FIRST: immorterm_update_task(task_id="%s", status="in_progress", lane="now")  — accept the task\n' "$TASK_ID"
  printf '2. WHEN DONE: confirm with the user, then immorterm_update_task(task_id="%s", status="done")\n' "$TASK_ID"
  printf '</immorterm-task>\n'
}

emit_file() {
  local DATA="$1"
  local FILE_PATH REL_PATH DISP
  FILE_PATH=$(jq -r '.file_path // ""' <<<"$DATA" 2>/dev/null)
  REL_PATH=$(jq -r '.rel_path // ""' <<<"$DATA" 2>/dev/null)
  [ -n "$FILE_PATH" ] || return 0
  DISP="${REL_PATH:-$FILE_PATH}"

  # Mirrors the session-share injection style — a hidden context block that
  # explicitly names the ImmorTerm Memory MCP tools Claude should reach for.
  printf '<immorterm-file source="file-attach" path="%s">\n' "$DISP"
  printf 'The user attached this file from the ImmorTerm file browser: %s\n' "$FILE_PATH"
  printf '\nUse the ImmorTerm Memory MCP tools to understand it (prefer these over raw git):\n'
  echo "- explain_change(file_path=\"${FILE_PATH}\") - recent edits, decisions & WHY it changed"
  echo "- get_code_diff(file_path=\"${FILE_PATH}\") - latest tracked diff"
  echo "- list_file_versions(file_path=\"${FILE_PATH}\") - edit history (who changed it and when)"
  echo "- list_git_commits(file_path=\"${FILE_PATH}\") - recent commits touching it"
  printf 'Then read the file itself for current contents.\n'
  printf '</immorterm-file>\n'
}

# ── Drain the queue → per-item <immorterm-…> injection blocks ──────────
# Each dropped file/session/task injects its own hidden context block (same
# shape as the session-share block), naming the ImmorTerm Memory MCP tools.
# A directory LOCK serializes the two hook registrations (global direct +
# per-project wrapper) so exactly one drains — no double-inject. Within the
# lock each item is claimed (mv → .consuming) and deleted only AFTER its
# block is captured, so a mid-drain timeout leaves items + a stale lock the
# next prompt reclaims and retries (never consume-without-inject).

LOCK="$QUEUE_DIR/.lock"
if [ -d "$LOCK" ]; then
  lage=$(( $(date +%s) - $(stat -c %Y "$LOCK" 2>/dev/null || stat -f %m "$LOCK" 2>/dev/null || echo 0) ))
  if [ "$lage" -gt 30 ]; then rmdir "$LOCK" 2>/dev/null; else exit 0; fi
fi
mkdir "$LOCK" 2>/dev/null || exit 0   # another invocation is draining — skip

# Reclaim claims orphaned by a killed previous run.
for c in "$QUEUE_DIR"/*.consuming; do
  [ -e "$c" ] || continue
  mv "$c" "${c%.consuming}.json" 2>/dev/null
done

BLOCKS=""

for f in "$QUEUE_DIR"/*.json; do
  [ -e "$f" ] || continue
  claim="${f%.json}.consuming"
  mv "$f" "$claim" 2>/dev/null || continue
  DATA=$(cat "$claim" 2>/dev/null)
  AGE=$(( $(date +%s) - $(stat -c %Y "$claim" 2>/dev/null || stat -f %m "$claim" 2>/dev/null || echo 0) ))
  if [ "$AGE" -gt 3600 ] || [ -z "$DATA" ]; then rm -f "$claim"; continue; fi
  KIND=$(jq -r '.kind // "session"' <<<"$DATA" 2>/dev/null)
  block=""
  case "$KIND" in
    session)                   block=$(emit_session "$DATA") ;;
    task)                      block=$(emit_task "$DATA") ;;
    file|file-explain|file-diff) block=$(emit_file "$DATA") ;;
  esac
  [ -n "$block" ] && BLOCKS+="$block"$'\n'
  rm -f "$claim"   # consume only AFTER the block was captured
done

rmdir "$LOCK" 2>/dev/null
rmdir "$QUEUE_DIR" 2>/dev/null

[ -n "$BLOCKS" ] && printf '%s' "$BLOCKS"
exit 0

#!/bin/bash
# Owner: ImmorTerm Memory
# ImmorTerm: UserPromptSubmit dispatcher
# Stdin is JSON from Claude Code: {"session_id":"...","prompt":"...","hook_event_name":"UserPromptSubmit",...}

# Buffer stdin — both hooks need it
INPUT=$(cat)

# Extract session_id to load env vars persisted by SessionStart hook
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // ""' 2>/dev/null)

# Clear inherited IMMORTERM_PROJECT_ID — it may leak from the parent VS Code
# window's project (e.g. immorterm project ID appearing in lonormaly sessions).
# We re-derive it from the env file or _immorterm-env.sh below.
unset IMMORTERM_PROJECT_ID

ENV_FILE="$HOME/.immorterm/claude-env/$SESSION_ID.env"
if [ -f "$ENV_FILE" ]; then
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  export IMMORTERM_ID IMMORTERM_PROJECT_ID
fi

# If env file didn't set PROJECT_ID (old session, SessionStart didn't run),
# re-derive from _immorterm-env.sh (.mcp.json -> basename -> baked fallback)
if [ -z "$IMMORTERM_PROJECT_ID" ]; then
  HOOKS_DIR_TMP="$(cd "$(dirname "$0")" && pwd)"
  if [ -f "$HOOKS_DIR_TMP/_immorterm-env.sh" ]; then
    # shellcheck disable=SC1091
    source "$HOOKS_DIR_TMP/_immorterm-env.sh"
    export IMMORTERM_PROJECT_ID
  fi
fi

# Fallback: if no env file (older session), discover IMMORTERM_ID from registry
# by matching pending-share signal files against sessions in the same project dir
if [ -z "$IMMORTERM_ID" ]; then
  SHARE_DIR="$HOME/.immorterm/pending-share"
  REGISTRY="$HOME/.immorterm/registry.json"
  if [ -d "$SHARE_DIR" ] && [ -f "$REGISTRY" ]; then
    PROJECT_DIR="$(pwd)"
    for f in "$SHARE_DIR"/*.json; do
      [ -f "$f" ] || continue
      CANDIDATE=$(basename "$f" .json)
      MATCH=$(jq -r --arg wid "$CANDIDATE" --arg pdir "$PROJECT_DIR" \
        '.sessions[] | select(.window_id == $wid and .project_dir == $pdir) | .window_id' \
        "$REGISTRY" 2>/dev/null)
      if [ -n "$MATCH" ]; then
        IMMORTERM_ID="$MATCH"
        export IMMORTERM_ID
        mkdir -p "$HOME/.immorterm/claude-env"
        printf 'IMMORTERM_ID=%s\n' "$IMMORTERM_ID" > "$HOME/.immorterm/claude-env/$SESSION_ID.env"
        break
      fi
    done
  fi
fi

HOOKS_DIR="$(cd "$(dirname "$0")" && pwd)"

# Emit each section AS SOON as it is produced. share-context CONSUMES the
# pending-share queue, so its output MUST be flushed BEFORE the slow ambient
# memory search below — otherwise a 5s-timeout kill during that search drops
# an already-consumed share (consume-without-inject). Order: fast → slow.

# 1. Session/file/task share context — outputs <immorterm-*> if pending.
SHARE_OUTPUT=$(IMMORTERM_DISPATCHED=1 bash "$HOOKS_DIR/immorterm-share-context.sh" 2>/dev/null)
[ -n "$SHARE_OUTPUT" ] && printf '%s\n' "$SHARE_OUTPUT"

# 2. Task context — outputs <immorterm-task> if pending.
TASK_OUTPUT=$(bash "$HOOKS_DIR/immorterm-task-context.sh" 2>/dev/null)
[ -n "$TASK_OUTPUT" ] && printf '%s\n' "$TASK_OUTPUT"

# 3. Speak Mode — AI character system prompt if overridden, else silent.
SPEAK_OUTPUT=$(bash "$HOOKS_DIR/immorterm-speak-mode.sh" 2>/dev/null)
[ -n "$SPEAK_OUTPUT" ] && printf '%s\n' "$SPEAK_OUTPUT"

# 4. Ambient memory search (SLOW + can stall). HARD-CAP it at 3s so THIS
# dispatcher always EXITS NORMALLY within the 5s hook budget — a timeout-KILL
# discards a hook's ENTIRE stdout, including everything flushed above. stdin is
# buffered to a temp file because a backgrounded proc gets /dev/null otherwise.
_mem_in=$(mktemp 2>/dev/null); _mem_out=$(mktemp 2>/dev/null)
if [ -n "$_mem_in" ] && [ -n "$_mem_out" ]; then
  printf '%s' "$INPUT" > "$_mem_in"
  "$HOME/.immorterm/bin/immorterm-memory" search < "$_mem_in" > "$_mem_out" 2>/dev/null &
  _mem_pid=$!
  ( sleep 2; kill -TERM "$_mem_pid" 2>/dev/null ) & _mem_killer=$!
  wait "$_mem_pid" 2>/dev/null
  kill -TERM "$_mem_killer" 2>/dev/null
  MEMORY_OUTPUT=$(cat "$_mem_out" 2>/dev/null)
  rm -f "$_mem_in" "$_mem_out"
  [ -n "$MEMORY_OUTPUT" ] && printf '%s\n' "$MEMORY_OUTPUT"
fi
exit 0

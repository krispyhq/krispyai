#!/bin/bash
# Owner: ImmorTerm Memory
# ImmorTerm: Speak Mode injector (UserPromptSubmit sub-hook).
#
# Resolves the effective AI character via cascade (session > project > default)
# and prints an XML-boundary-wrapped block to stdout, consumed by Claude Code
# as additional user-prompt context. Silent when the effective mode is "default".

set -u

PROJECT_DIR="$(pwd)"
PROJECT_CONFIG="$PROJECT_DIR/.immorterm/config.json"
SESSION_STATUS="$HOME/.immorterm/session-status.json"
REGISTRY="$HOME/.immorterm/registry.json"
RESET_MARKER_DIR="$HOME/.immorterm/pending-resets"
PERSONA_STAMP_DIR="$HOME/.immorterm/persona-stamps"

# One-shot persona-reset: fires once per toggle-off, zero tokens thereafter.
# Also clears the persona stamp so a subsequent re-enable emits a full re-inject.
if [ -n "${IMMORTERM_ID:-}" ] && [ -f "$RESET_MARKER_DIR/$IMMORTERM_ID" ]; then
  rm -f "$RESET_MARKER_DIR/$IMMORTERM_ID"
  rm -f "$PERSONA_STAMP_DIR/$IMMORTERM_ID"
  printf '<speak_mode id="reset">\nRespond in your natural voice. No character persona.\n\nIf any earlier turn in this conversation was in a character voice (caveman, pirate, or any other persona), drop it immediately. Do not continue prior stylistic patterns. Use complete sentences, standard grammar, articles, and your native professional voice.\n\nThis instruction overrides persona-style patterns from earlier turns and takes effect starting with this response. Future prompts will not repeat this reset.\n</speak_mode>\n'
fi

SPEAK_MODE=""
if [ -n "${IMMORTERM_ID:-}" ] && [ -f "$SESSION_STATUS" ] && command -v jq >/dev/null 2>&1; then
  SPEAK_MODE=$(jq -r --arg wid "$IMMORTERM_ID" \
    '.sessions[$wid].speak_mode // empty' \
    "$SESSION_STATUS" 2>/dev/null)
fi

if [ -z "$SPEAK_MODE" ] && [ -n "${IMMORTERM_ID:-}" ] && [ -f "$REGISTRY" ] && command -v jq >/dev/null 2>&1; then
  SPEAK_MODE=$(jq -r --arg wid "$IMMORTERM_ID" \
    '.sessions[]? | select(.window_id == $wid) | .speak_mode // empty' \
    "$REGISTRY" 2>/dev/null | head -1)
fi

if [ -z "$SPEAK_MODE" ] && [ -f "$PROJECT_CONFIG" ] && command -v jq >/dev/null 2>&1; then
  SPEAK_MODE=$(jq -r '.speakMode // empty' "$PROJECT_CONFIG" 2>/dev/null)
fi

if [ -z "$SPEAK_MODE" ] || [ "$SPEAK_MODE" = "default" ]; then
  exit 0
fi

CHAR_FILE=""
CANDIDATES=()
[ -n "${IMMORTERM_CHARACTERS_DIR:-}" ] && CANDIDATES+=("$IMMORTERM_CHARACTERS_DIR/$SPEAK_MODE.md")
CANDIDATES+=("$HOME/.immorterm/characters/$SPEAK_MODE.md")

DEV_DIR="$PROJECT_DIR"
while [ "$DEV_DIR" != "/" ] && [ "$DEV_DIR" != "" ]; do
  if [ -d "$DEV_DIR/apps/immorterm-ai/characters" ]; then
    CANDIDATES+=("$DEV_DIR/apps/immorterm-ai/characters/$SPEAK_MODE.md")
    break
  fi
  DEV_DIR="$(dirname "$DEV_DIR")"
done

for candidate in "${CANDIDATES[@]}"; do
  if [ -f "$candidate" ]; then
    CHAR_FILE="$candidate"
    break
  fi
done

[ -z "$CHAR_FILE" ] && exit 0

BODY=$(awk '
  BEGIN { state = "pre" }
  /^---[[:space:]]*$/ {
    if (state == "pre") { state = "fm"; next }
    if (state == "fm")  { state = "body"; next }
  }
  state == "body" { print }
  state == "pre"  { state = "body"; print }
' "$CHAR_FILE")

BODY=$(printf '%s' "$BODY" | awk 'NF { found=1 } found')

[ -z "$BODY" ] && exit 0

# Persona stamp: full inject on first turn (or character switch), minimal
# reminder on subsequent turns — anchors model against drift without paying
# the ~800-token full cost every prompt.
STAMP_FILE=""
STAMPED=""
if [ -n "${IMMORTERM_ID:-}" ]; then
  STAMP_FILE="$PERSONA_STAMP_DIR/$IMMORTERM_ID"
  [ -f "$STAMP_FILE" ] && STAMPED=$(cat "$STAMP_FILE" 2>/dev/null)
fi

if [ "$STAMPED" = "$SPEAK_MODE" ]; then
  printf '<speak_mode id="%s">Stay in character (%s). Full rules set earlier this session — do not drift back to your native voice.</speak_mode>\n' "$SPEAK_MODE" "$SPEAK_MODE"
  exit 0
fi

printf '<speak_mode id="%s">\n%s\n</speak_mode>\n' "$SPEAK_MODE" "$BODY"
if [ -n "$STAMP_FILE" ]; then
  mkdir -p "$PERSONA_STAMP_DIR" 2>/dev/null
  printf '%s' "$SPEAK_MODE" > "$STAMP_FILE"
fi
exit 0

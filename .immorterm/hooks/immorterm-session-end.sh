#!/bin/bash
# Owner: ImmorTerm Memory
# ImmorTerm Memory: Session End — vendor-agnostic Stop/SessionEnd hook
# Fired by:
#   - Claude Code SessionEnd event (on /exit, /clear, session swap) — sync flush path.
#     Requires env CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS≥30000 or hook is killed at 1.5s.
#   - Every vendor's Stop event (per-turn) — async path so the user isn't blocked.
# Both paths run plan-sweep + trigger the digester; the digester's internal lock
# prevents pile-ups if Stop fires repeatedly during a long agent turn.

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Buffer stdin so we can fan it out to multiple consumers AND inspect the event name.
STDIN_BUF=$(cat)

# Detect event type — Claude Code stdin includes hook_event_name. On SessionEnd
# we run the digester synchronously so the JSONL is fully captured before the
# process exits. On Stop (per-turn) we background it so the user isn't stalled.
EVENT_NAME=$(printf '%s' "$STDIN_BUF" | jq -r '.hook_event_name // ""' 2>/dev/null || echo "")

# 1. Plan sweep — catches plans missed by PreToolUse:ExitPlanMode.
if [ -x "$SCRIPT_DIR/immorterm-plan-sweep.sh" ]; then
  printf '%s' "$STDIN_BUF" | bash "$SCRIPT_DIR/immorterm-plan-sweep.sh" >/dev/null 2>&1 || true
fi

# 2. Digester — sync on SessionEnd (must flush before process death),
#    async on Stop (don't make the user wait for digestion mid-session).
#
# DIGEST_EXIT_REASON: pass the hook event name through to the digester so
# it can write `sessions.metadata.exit_reason` + `ended_at` + status='ended'
# via POST /api/v1/sessions/end. Required by T6+T7 resumption: without
# `ended_at`, Signal 6 silently returns None for ALL sessions. Without
# `exit_reason`, the formatted_block renders "via Stop" generically.
if [ -x "$SCRIPT_DIR/immorterm-memory-digest.sh" ]; then
  if [ "$EVENT_NAME" = "SessionEnd" ]; then
    printf '%s' "$STDIN_BUF" | DIGEST_EXIT_REASON="$EVENT_NAME" bash "$SCRIPT_DIR/immorterm-memory-digest.sh" >/dev/null 2>&1 || true
  else
    printf '%s' "$STDIN_BUF" | DIGEST_EXIT_REASON="$EVENT_NAME" nohup bash "$SCRIPT_DIR/immorterm-memory-digest.sh" >/dev/null 2>&1 &
    disown 2>/dev/null || true
  fi
fi

exit 0

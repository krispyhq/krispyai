#!/bin/bash
# ImmorTerm: Cline → Claude-shape adapter (Phase A T3)
# Re-keys Cline's hook stdin into Claude Code's shape and pipes to the matching
# ImmorTerm hook script for that event. The Cline trampoline calls this script
# with the event name as $1 (e.g. PostToolUse).
# Reference: https://docs.cline.bot/customization/hooks
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOKS_DIR="$(dirname "$SCRIPT_DIR")"  # parent of lib/

export IMMORTERM_AI_TOOL=cline

EVENT_NAME="${1:-}"  # passed in by trampoline

INPUT="$(cat)"

REKEYED=$(IMMORTERM_INPUT="$INPUT" EVENT_NAME="$EVENT_NAME" python3 - <<'PYEOF' 2>/dev/null || true
import json, os
event_name = os.environ.get("EVENT_NAME", "")
try:
    data = json.loads(os.environ.get("IMMORTERM_INPUT", "") or "{}")
except Exception:
    data = {}

session_id = data.get("taskId") or ""
hook_event = data.get("hookName") or event_name or ""
roots = data.get("workspaceRoots") or []
cwd = roots[0] if roots else (data.get("cwd") or os.getcwd())

post = data.get("postToolUse") or {}
pre = data.get("preToolUse") or {}

out = {"session_id": session_id, "hook_event_name": hook_event, "cwd": cwd}

if hook_event in ("PostToolUse", "post_tool_use"):
    out["hook_event_name"] = "PostToolUse"
    out["tool_name"] = post.get("toolName") or pre.get("toolName") or ""
    out["tool_input"] = post.get("parameters") or {}
    out["tool_response"] = post.get("result")
elif hook_event in ("PreToolUse", "pre_tool_use"):
    out["hook_event_name"] = "PreToolUse"
    out["tool_name"] = pre.get("toolName") or ""
    out["tool_input"] = pre.get("parameters") or {}
elif hook_event in ("UserPromptSubmit", "userPromptSubmit"):
    out["hook_event_name"] = "UserPromptSubmit"
    out["prompt"] = (data.get("userPromptSubmit") or {}).get("prompt") or data.get("prompt") or ""
elif hook_event in ("TaskStart", "taskStart", "TaskResume", "taskResume"):
    out["hook_event_name"] = "SessionStart"
elif hook_event in ("TaskComplete", "taskComplete", "TaskCancel", "taskCancel"):
    out["hook_event_name"] = "Stop"
elif hook_event in ("PreCompact", "preCompact"):
    out["hook_event_name"] = "PreCompact"

print(json.dumps(out))
PYEOF
)

if [ -z "$REKEYED" ]; then
  # Cline expects a JSON response; default to non-cancel.
  printf '{"cancel":false}\n'
  exit 0
fi

EVT=$(IMMORTERM_REKEYED="$REKEYED" python3 -c 'import os,json;d=json.loads(os.environ.get("IMMORTERM_REKEYED","") or "{}");print(d.get("hook_event_name",""))' 2>/dev/null || echo "")

# Capture upstream stdout — Cline expects JSON-stdout response.
UPSTREAM_OUT=""
RC=0

run_upstream() {
  local target="$1"
  if [ -x "$target" ] || [ -f "$target" ]; then
    UPSTREAM_OUT=$(bash "$target" <<<"$REKEYED" 2>/dev/null) || RC=$?
  fi
}

case "$EVT" in
  PostToolUse)
    run_upstream "$HOOKS_DIR/immorterm-code-change-capture.sh"
    ;;
  PreToolUse)
    : # no PreToolUse upstream; fall through to default response
    ;;
  UserPromptSubmit)
    run_upstream "$HOOKS_DIR/immorterm-user-prompt.sh"
    ;;
  SessionStart)
    run_upstream "$HOOKS_DIR/immorterm-memory-guide.sh"
    ;;
  Stop)
    run_upstream "$HOOKS_DIR/immorterm-plan-sweep.sh"
    ;;
  PreCompact)
    run_upstream "$HOOKS_DIR/immorterm-pre-compact.sh"
    ;;
esac

# Pass through upstream JSON if it was valid JSON; else default response.
if [ -n "$UPSTREAM_OUT" ] && printf '%s' "$UPSTREAM_OUT" | python3 -c 'import sys,json;json.loads(sys.stdin.read())' >/dev/null 2>&1; then
  printf '%s\n' "$UPSTREAM_OUT"
else
  printf '{"cancel":false}\n'
fi

exit 0

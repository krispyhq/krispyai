#!/bin/bash
# ImmorTerm: Windsurf → Claude-shape adapter (Phase A T3)
# Re-keys Windsurf's hook stdin into Claude Code's shape, then pipes to the
# matching ImmorTerm hook script for that event.
# Reference: https://docs.windsurf.com/windsurf/cascade/hooks
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOKS_DIR="$(dirname "$SCRIPT_DIR")"  # parent of lib/

export IMMORTERM_AI_TOOL=windsurf

INPUT="$(cat)"

REKEYED=$(IMMORTERM_INPUT="$INPUT" python3 - <<'PYEOF' 2>/dev/null || true
import json, os
try:
    data = json.loads(os.environ.get("IMMORTERM_INPUT", "") or "{}")
except Exception:
    data = {}

action = data.get("agent_action_name") or ""
session_id = data.get("trajectory_id") or data.get("execution_id") or ""
tool_info = data.get("tool_info") or {}
tool_name_raw = tool_info.get("name") if isinstance(tool_info, dict) else ""
tool_input = tool_info.get("input") if isinstance(tool_info, dict) else None
if tool_input is None and isinstance(tool_info, dict):
    tool_input = {k: v for k, v in tool_info.items() if k not in ("name", "input")}
is_edit = bool(tool_info.get("is_edit")) if isinstance(tool_info, dict) else False
cwd = data.get("cwd") or os.getcwd()

# action → (claude_event, default_tool)
mapping = {
    "pre_read_code":              ("PreToolUse",       "Read"),
    "post_read_code":             ("PostToolUse",      "Read"),
    "pre_write_code":             ("PreToolUse",       "Write"),
    "post_write_code":            ("PostToolUse",      "Edit" if is_edit else "Write"),
    "pre_run_command":            ("PreToolUse",       "Bash"),
    "post_run_command":           ("PostToolUse",      "Bash"),
    "pre_user_prompt":            ("UserPromptSubmit", ""),
    "post_cascade_response":      ("Stop",             ""),
    "post_cascade_response_with_transcript": ("Stop", ""),
}
event, default_tool = mapping.get(action, ("", ""))

out = {"session_id": session_id, "cwd": cwd, "hook_event_name": event}
if event in ("PreToolUse", "PostToolUse"):
    out["tool_name"] = tool_name_raw or default_tool
    out["tool_input"] = tool_input or {}
    if event == "PostToolUse":
        out["tool_response"] = tool_info.get("result") if isinstance(tool_info, dict) else None
if event == "UserPromptSubmit":
    out["prompt"] = data.get("user_prompt") or data.get("prompt") or ""

print(json.dumps(out))
PYEOF
)

if [ -z "$REKEYED" ]; then
  exit 0
fi

EVT=$(IMMORTERM_REKEYED="$REKEYED" python3 -c 'import os,json;d=json.loads(os.environ.get("IMMORTERM_REKEYED","") or "{}");print(d.get("hook_event_name",""))' 2>/dev/null || echo "")

# Windsurf treats exit 2 as "cancel" for pre-hooks — propagate upstream's exit code.
RC=0
case "$EVT" in
  PostToolUse)
    bash "$HOOKS_DIR/immorterm-code-change-capture.sh" <<<"$REKEYED" || RC=$?
    ;;
  PreToolUse)
    exit 0
    ;;
  UserPromptSubmit)
    if [ -x "$HOOKS_DIR/immorterm-user-prompt.sh" ]; then
      bash "$HOOKS_DIR/immorterm-user-prompt.sh" <<<"$REKEYED" || RC=$?
    fi
    ;;
  SessionStart)
    bash "$HOOKS_DIR/immorterm-memory-guide.sh" <<<"$REKEYED" || RC=$?
    ;;
  Stop)
    if [ -x "$HOOKS_DIR/immorterm-plan-sweep.sh" ]; then
      bash "$HOOKS_DIR/immorterm-plan-sweep.sh" <<<"$REKEYED" || RC=$?
    fi
    ;;
  *)
    exit 0
    ;;
esac

exit "$RC"

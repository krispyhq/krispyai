#!/bin/bash
# ImmorTerm: Cursor → Claude-shape adapter (Phase A T3)
# Re-keys Cursor's hook stdin into Claude Code's shape, then pipes to the
# matching ImmorTerm hook script for that event.
# Reference: https://cursor.com/docs/hooks
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOKS_DIR="$(dirname "$SCRIPT_DIR")"  # parent of lib/

export IMMORTERM_AI_TOOL=cursor

INPUT="$(cat)"  # capture stdin once

REKEYED=$(IMMORTERM_INPUT="$INPUT" python3 - <<'PYEOF' 2>/dev/null || true
import json, os
try:
    data = json.loads(os.environ.get("IMMORTERM_INPUT", "") or "{}")
except Exception:
    data = {}

evt = data.get("hook_event_name") or data.get("event") or ""
session_id = data.get("conversation_id") or data.get("session_id") or ""
file_path = data.get("file_path") or ""
cwd = data.get("cwd") or (os.path.dirname(file_path) if file_path else os.getcwd())

# Map Cursor events → Claude shape.
# afterFileEdit, beforeShellExecution, afterShellExecution, userPromptSubmit,
# agentResponse, subagentStart, preCompact, stop
out = {"session_id": session_id, "cwd": cwd}

if evt == "afterFileEdit":
    out["hook_event_name"] = "PostToolUse"
    out["tool_name"] = "Edit"
    out["tool_input"] = {"file_path": file_path}
    out["tool_response"] = {"edits": data.get("edits", [])}
elif evt == "beforeShellExecution":
    out["hook_event_name"] = "PreToolUse"
    out["tool_name"] = "Bash"
    out["tool_input"] = {"command": data.get("command", "")}
elif evt == "afterShellExecution":
    out["hook_event_name"] = "PostToolUse"
    out["tool_name"] = "Bash"
    out["tool_input"] = {"command": data.get("command", "")}
    out["tool_response"] = {
        "stdout": data.get("stdout", ""),
        "stderr": data.get("stderr", ""),
        "exit_code": data.get("exit_code"),
    }
elif evt == "userPromptSubmit":
    out["hook_event_name"] = "UserPromptSubmit"
    out["prompt"] = data.get("prompt") or data.get("user_input") or ""
elif evt == "agentResponse":
    # No Claude equivalent — emit no-op marker so case dispatch skips.
    out["hook_event_name"] = "AgentResponseNoOp"
elif evt == "subagentStart":
    out["hook_event_name"] = "SubagentStart"
elif evt == "preCompact":
    out["hook_event_name"] = "PreCompact"
elif evt == "stop":
    out["hook_event_name"] = "Stop"
else:
    # Unknown event — best-effort passthrough.
    out["hook_event_name"] = evt or "Unknown"

print(json.dumps(out))
PYEOF
)

if [ -z "$REKEYED" ]; then
  exit 0
fi

EVT=$(IMMORTERM_REKEYED="$REKEYED" python3 -c 'import os,json;d=json.loads(os.environ.get("IMMORTERM_REKEYED","") or "{}");print(d.get("hook_event_name",""))' 2>/dev/null || echo "")

case "$EVT" in
  PostToolUse)
    bash "$HOOKS_DIR/immorterm-code-change-capture.sh" <<<"$REKEYED"
    ;;
  PreToolUse)
    # No PreToolUse hook in current ImmorTerm Claude pipeline — silently accept.
    exit 0
    ;;
  UserPromptSubmit)
    if [ -x "$HOOKS_DIR/immorterm-user-prompt.sh" ]; then
      bash "$HOOKS_DIR/immorterm-user-prompt.sh" <<<"$REKEYED"
    fi
    ;;
  SessionStart|SubagentStart)
    bash "$HOOKS_DIR/immorterm-memory-guide.sh" <<<"$REKEYED"
    ;;
  Stop)
    if [ -x "$HOOKS_DIR/immorterm-plan-sweep.sh" ]; then
      bash "$HOOKS_DIR/immorterm-plan-sweep.sh" <<<"$REKEYED"
    fi
    ;;
  PreCompact)
    if [ -x "$HOOKS_DIR/immorterm-pre-compact.sh" ]; then
      bash "$HOOKS_DIR/immorterm-pre-compact.sh" <<<"$REKEYED"
    fi
    ;;
  AgentResponseNoOp|"")
    exit 0
    ;;
  *)
    exit 0
    ;;
esac

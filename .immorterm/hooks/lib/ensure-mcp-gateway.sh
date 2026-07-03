#!/bin/bash
# MCP Gateway Daemon — Idempotent Spawn Helper
#
# Single source of truth for "make sure the MCP gateway is running".
# Mirror of ensure-digest-daemon.sh + ensure-immorterm-memory.sh.
#
# Called from:
#   1. SessionStart hook (immorterm-memory-guide.sh)
#
# Usage: ensure_mcp_gateway <workspace_path>
# Returns 0 if healthy or gateway not installed, 1 on failure.
#
# Strategy:
#   1. State file check: ~/.immorterm/mcp-gateway/state.json holds {pid, port}.
#      If pid alive (kill -0) → return 0.
#   2. If pid dead but state present → respawn at the recorded port.
#   3. If gateway dist not present → no-op (gateway not installed).

ensure_mcp_gateway() {
  local workspace_path="$1"
  local state_file="$HOME/.immorterm/mcp-gateway/state.json"
  local entry="$workspace_path/services/mcp-gateway/dist/index.js"
  local log_file="$HOME/.immorterm/mcp-gateway/gateway.log"
  local spawn_lock="$HOME/.immorterm/mcp-gateway.spawnlock"

  # Skip if gateway not installed in this workspace.
  [ -f "$entry" ] || return 0
  command -v node >/dev/null 2>&1 || return 1

  # Read state (port + pid). Default port 9100.
  local port=9100
  local pid=""
  if [ -f "$state_file" ]; then
    read -r pid port < <(python3 -c "
import json, sys
try:
    with open(sys.argv[1]) as f:
        d = json.load(f)
    print(d.get('pid', '') or '', d.get('port', 9100))
except Exception:
    print('', 9100)
" "$state_file" 2>/dev/null)
  fi

  # Tier 1: alive PID per state file? Done.
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    return 0
  fi

  # Single-flight.
  if [ -d "$spawn_lock" ]; then
    local lock_age=$(( $(date +%s) - $(stat -c %Y "$spawn_lock" 2>/dev/null || stat -f %m "$spawn_lock" 2>/dev/null || echo 0) ))
    if [ "$lock_age" -lt 30 ]; then
      return 0
    fi
    rmdir "$spawn_lock" 2>/dev/null || true
  fi
  mkdir "$spawn_lock" 2>/dev/null || return 0

  mkdir -p "$(dirname "$log_file")"
  printf '[%s] [ensure-mcp-gateway] spawning node %s start --port %s\n' \
    "$(date '+%Y-%m-%d %H:%M:%S')" "$entry" "$port" >> "$log_file"

  ( nohup node "$entry" start --port "$port" </dev/null >>"$log_file" 2>&1 &
    sleep 2
    rmdir "$spawn_lock" 2>/dev/null || true
  ) &
  disown 2>/dev/null || true
  return 0
}

if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  ensure_mcp_gateway "$@"
fi

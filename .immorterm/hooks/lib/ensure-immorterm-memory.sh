#!/bin/bash
# ImmorTerm-Memory Daemon — Idempotent Spawn Helper
#
# Single source of truth for "make sure the ImmorTerm-Memory service is running".
# Mirror of ensure-digest-daemon.sh, applied to the Rust memory binary.
#
# Called from:
#   1. SessionStart hook (immorterm-memory-guide.sh)
#
# Usage: ensure_immorterm_memory
# Returns 0 if healthy (already or after spawn), 1 on failure.
#
# Strategy:
#   1. Health check 127.0.0.1:$PORT/health (IPv4 explicit — bypasses any IPv6
#      squatter that shadows `localhost` on macOS).
#   2. If healthy: return 0.
#   3. If unhealthy: detect a port squatter via lsof and log a clear warning
#      (no auto-kill — too risky). Then spawn the binary if it's not running.
#   4. Re-check health after spawn; return 0 on success.

ensure_immorterm_memory() {
  local port="${IMMORTERM_MEMORY_PORT:-8765}"
  local url="http://127.0.0.1:${port}"
  local bin="$HOME/.immorterm/bin/immorterm-memory"
  local log_file="$HOME/.immorterm/memory-daemon.log"
  local spawn_lock="$HOME/.immorterm/immorterm-memory.spawnlock"

  # Tier 1: already healthy?
  if curl -sf -o /dev/null --connect-timeout 1 --max-time 2 "$url/health" 2>/dev/null; then
    return 0
  fi

  # Tier 2: surface port squatters before doing anything else.
  # macOS commonly hits this when an orphaned `python -m http.server` binds *:PORT
  # on IPv6, shadowing `localhost` resolution.
  if command -v lsof >/dev/null 2>&1; then
    local listeners
    listeners=$(lsof -nP -i ":$port" 2>/dev/null | awk '/LISTEN/ && $1 != "immorterm" {print $1"/"$2}' | tr '\n' ' ')
    if [ -n "$listeners" ]; then
      printf '[%s] [ensure-immorterm-memory] port %s squatted by: %s — manual kill required\n' \
        "$(date '+%Y-%m-%d %H:%M:%S')" "$port" "$listeners" >> "$log_file"
    fi
  fi

  # Tier 3: spawn if binary exists.
  if [ ! -x "$bin" ]; then
    return 1
  fi

  # Single-flight: atomic mkdir, 30s stale auto-clear.
  if [ -d "$spawn_lock" ]; then
    local lock_age=$(( $(date +%s) - $(stat -c %Y "$spawn_lock" 2>/dev/null || stat -f %m "$spawn_lock" 2>/dev/null || echo 0) ))
    if [ "$lock_age" -lt 30 ]; then
      return 0
    fi
    rmdir "$spawn_lock" 2>/dev/null || true
  fi
  mkdir "$spawn_lock" 2>/dev/null || return 0

  printf '[%s] [ensure-immorterm-memory] spawning %s serve --port %s --daemon\n' \
    "$(date '+%Y-%m-%d %H:%M:%S')" "$bin" "$port" >> "$log_file"

  ( nohup "$bin" serve --port "$port" --daemon </dev/null >>"$log_file" 2>&1 &
    sleep 2
    rmdir "$spawn_lock" 2>/dev/null || true
  ) &
  disown 2>/dev/null || true

  # Best-effort post-spawn verification (up to 3s).
  local i
  for i in 1 2 3; do
    sleep 1
    if curl -sf -o /dev/null --connect-timeout 1 --max-time 1 "$url/health" 2>/dev/null; then
      return 0
    fi
  done
  return 1
}

# If sourced, `ensure_immorterm_memory` is now available.
# If executed directly: `bash ensure-immorterm-memory.sh`
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  ensure_immorterm_memory "$@"
fi

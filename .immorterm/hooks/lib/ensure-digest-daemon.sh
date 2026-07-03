#!/bin/bash
# ImmorTerm Digest Daemon — Idempotent Spawn Helper
#
# Single source of truth for "make sure the digest daemon is running".
# Called from SessionStart hooks for every supported host (VS Code,
# Tauri, CLI). Daemon is a machine-singleton (one process owns all
# workspaces); project_id + workspace_path are accepted for back-compat
# call-site signatures but ignored (singleton needs no per-project args).
#
# Spawns the Rust binary at ~/.immorterm/bin/immorterm-digest.
# The legacy bash daemon has been retired — if the Rust binary is missing,
# this is a no-op and digest scheduling stops until the binary is installed.
#
# Usage: ensure_digest_daemon [project_id] [workspace_path]
# Returns 0 if daemon is running (already or newly spawned), 1 on failure.

ensure_digest_daemon() {
  local immorterm_dir="$HOME/.immorterm"
  local log_file="$immorterm_dir/digest-daemon.log"
  local rust_binary="$immorterm_dir/bin/immorterm-digest"
  local rust_socket="$immorterm_dir/sockets/immorterm-digest.sock"

  if [ ! -x "$rust_binary" ]; then
    return 1
  fi

  mkdir -p "$immorterm_dir"

  # Already running? Test-connect the socket. The daemon enforces
  # singleton via exclusive bind, so a successful connect means our
  # daemon is alive. A stale socket file with no listener will be
  # unlinked + replaced by the next spawn.
  if [ -S "$rust_socket" ] && nc -z -U "$rust_socket" 2>/dev/null; then
    return 0
  fi

  mkdir -p "$(dirname "$rust_socket")"

  # Spawn detached. If two callers race, one wins the exclusive
  # bind and the other exits harmlessly with a log entry.
  nohup "$rust_binary" serve </dev/null >>"$log_file" 2>&1 &
  disown 2>/dev/null || true
  return 0
}

# If sourced, `ensure_digest_daemon` is now available.
# If executed directly: `bash ensure-digest-daemon.sh [project_id] [workspace_path]`
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  ensure_digest_daemon "$@"
fi

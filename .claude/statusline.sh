#!/usr/bin/env bash
# ImmorTerm Status Line Script
# Receives JSON on stdin from Claude Code's statusLine feature.
#
# Three delivery paths:
# 0. OSC to PTY (fastest) — printf OSC 1337;ImmorTerm to /dev/tty. The daemon's VTE
#    parser intercepts it inline with PTY data. Zero sync delay.
# 1. IPC push — sends data directly to the daemon via `immorterm-ai claude-push`.
#    Event-driven, no temp files. The daemon stores it immediately.
# 2. Context file (fallback) — writes to <project>/.immorterm/claude-ctx/<windowId>.
#    The extension's session-manager.ts watches this path via fs.watchFile.
#
# Installed to <project>/.claude/statusline.sh by the ImmorTerm extension.

INPUT=$(cat)
[ -z "$INPUT" ] && exit 0

# Extract session_id - required field
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty' 2>/dev/null)
[ -z "$SESSION_ID" ] && exit 0

# ── Path 1: IPC push to daemon (instant, event-driven) ──
# If immorterm-ai binary is available and we're inside a daemon session,
# push the raw JSON directly. The daemon parses it and stores immediately.
# Check IMMORTERM_SESSION (Rust daemon) or STY (C binary screen session).
# The Rust daemon's claude-push handles both env vars internally.
#
# Uses the canonical absolute install path ($HOME/.immorterm/bin/) rather
# than relying on PATH. Claude Code's statusline hook is invoked outside
# our shell-init context, so ~/.immorterm/bin/ is often not on the PATH
# that statusline.sh sees. The silent `command -v` failure that resulted
# was the root cause of `claude_transcript_path` never landing in
# registry.json, which broke the entire digest-discovery chain.
if [ -n "${IMMORTERM_SESSION:-}" ] || [ -n "${STY:-}" ]; then
  IMMORTERM_AI_BIN="${IMMORTERM_AI_BIN:-$HOME/.immorterm/bin/immorterm-ai}"
  if [ -x "$IMMORTERM_AI_BIN" ]; then
    echo "$INPUT" | "$IMMORTERM_AI_BIN" claude-push 2>/dev/null &
  fi
fi

# ── Path 0: OSC to PTY (fastest — inline with terminal data) ──
# The daemon's VTE parser intercepts OSC 1337;ImmorTerm and drains the event
# directly from the PTY stream. No temp files, no IPC — zero sync delay.
MODEL=$(echo "$INPUT" | jq -r '.model.display_name // empty' 2>/dev/null)
COST=$(echo "$INPUT" | jq -r '.cost.total_cost_usd // 0' 2>/dev/null)
CTX_PCT=$(echo "$INPUT" | jq -r '.context_window.used_percentage // 0' 2>/dev/null)
TRANSCRIPT_PATH=$(echo "$INPUT" | jq -r '.transcript_path // empty' 2>/dev/null)
PERMISSION_MODE=$(echo "$INPUT" | jq -r '.permission_mode // empty' 2>/dev/null)

if [ -n "$SESSION_ID" ]; then
  printf '\033]1337;ImmorTerm;sid=%s;m=%s;c=%s;ctx=%s;tp=%s;pm=%s\a' \
    "$SESSION_ID" "$MODEL" "$COST" "$CTX_PCT" "$TRANSCRIPT_PATH" "$PERMISSION_MODE" \
    > /dev/tty 2>/dev/null
fi

# ── Path 2: Context file for extension ──
# Extension's session-manager.ts watches: <projectDir>/.immorterm/claude-ctx/<windowId>
DURATION_MS=$(echo "$INPUT" | jq -r '.cost.total_duration_ms // 0' 2>/dev/null)
RUNTIME_SECS=$((${DURATION_MS%.*} / 1000))

# Gather Claude Code process stats (best-effort via PPID)
# Claude Code (Node.js) spawns this script, so PPID = Claude process
RSS_KB=0
CPU_PCT=0
if [ -n "$PPID" ] && [ "$PPID" -gt 0 ] 2>/dev/null; then
  PS_OUT=$(ps -o rss=,pcpu= -p "$PPID" 2>/dev/null | awk '{print $1, $2}')
  RSS_KB=$(echo "$PS_OUT" | awk '{print $1}')
  CPU_PCT=$(echo "$PS_OUT" | awk '{print $2}')
  [ -z "$RSS_KB" ] && RSS_KB=0
  [ -z "$CPU_PCT" ] && CPU_PCT=0
fi

# Extract window ID — prefer IMMORTERM_WINDOW_ID (Rust daemon sets this directly),
# fall back to parsing STY env (legacy C binary: "PID.project-windowId")
# e.g. STY=32481.immorterm-50369-ADj1BNMV → WINDOW_ID=50369-ADj1BNMV
WINDOW_ID="${IMMORTERM_WINDOW_ID:-}"
if [ -z "$WINDOW_ID" ] && [ -n "$STY" ]; then
  WINDOW_ID=$(echo "$STY" | sed 's/^[0-9]*\.[^-]*-//')
fi

# Derive project dir from STY session name or SCREEN_PROJECT_DIR
PROJECT_DIR="${SCREEN_PROJECT_DIR:-}"
if [ -z "$PROJECT_DIR" ] && [ -n "$STY" ]; then
  # STY format: PID.projectname-windowId — but project dir isn't encoded there.
  # Fall back to PWD's git root or CWD
  PROJECT_DIR=$(git -C "$(pwd)" rev-parse --show-toplevel 2>/dev/null || echo "$(pwd)")
fi

# Write to project-scoped path that session-manager.ts watches (keyed by windowId)
if [ -n "$WINDOW_ID" ] && [ -n "$PROJECT_DIR" ]; then
  CTX_DIR="$PROJECT_DIR/.immorterm/claude-ctx"
  mkdir -p "$CTX_DIR"
  cat > "$CTX_DIR/$WINDOW_ID" <<EOF
SESSION_ID=$SESSION_ID
MODEL=$MODEL
COST=$COST
CTX_PCT=$CTX_PCT
RSS_KB=$RSS_KB
CPU_PCT=$CPU_PCT
RUNTIME_SECS=$RUNTIME_SECS
TIMESTAMP=$(date +%s)
WINDOW_ID=$WINDOW_ID
TRANSCRIPT_PATH=$TRANSCRIPT_PATH
EOF
fi

#!/bin/bash
# Owner: ImmorTerm Memory
# _immorterm-env.sh — Shared environment for all ImmorTerm hooks
# Source this to get a reliable IMMORTERM_PROJECT_ID (never hardcoded)
# AND a PATH that includes ~/.immorterm/bin/ for immorterm-* binaries.
#
# Derivation order:
#   1. CLAUDE_ENV_FILE (set by SessionStart hook) — fastest, covers 99% of cases
#   2. .mcp.json URL parsing — authoritative source, matches MCP server's user_id
#   3. Baked-in projectId from install time — last resort fallback

# PATH — ensure ImmorTerm binaries are discoverable from every hook that
# sources this. The canonical install location is ~/.immorterm/bin/; if
# this directory isn't on PATH, `command -v immorterm-ai` returns false
# and statusline.sh silently skips its claude-push IPC, which breaks the
# entire claude_tracker → registry.json → digest-daemon chain.
# Prepend (rather than append) so our bins win over any same-named
# system binaries. Idempotent — only prepend if not already present.
case ":$PATH:" in
  *":$HOME/.immorterm/bin:"*) ;;
  *) export PATH="$HOME/.immorterm/bin:$PATH" ;;
esac

if [ -z "${IMMORTERM_PROJECT_ID:-}" ]; then
  # Derive PROJECT_ROOT from this file's location (hooks are at <root>/.immorterm/hooks/)
  _IM_ENV_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
  _IM_ROOT="${PROJECT_ROOT:-$(cd "$_IM_ENV_DIR/../.." 2>/dev/null && pwd)}"
  _IM_MCP="$_IM_ROOT/.mcp.json"

  if [ -f "$_IM_MCP" ]; then
    IMMORTERM_PROJECT_ID=$(python3 -c "
import json, sys, re
try:
    with open(sys.argv[1]) as f:
        data = json.load(f)
    for server in data.get('mcpServers', {}).values():
        url = server.get('url', '')
        m = re.search(r'/mcp/[^/]+/([^/]+)', url)
        if m and m.group(1) != 'sse':
            print(m.group(1)); break
        m2 = re.search(r'/sse/([^/]+)', url)
        if m2: print(m2.group(1)); break
except Exception: pass
" "$_IM_MCP" 2>/dev/null)
  fi

  # Final fallback: baked-in projectId from install time
  : "${IMMORTERM_PROJECT_ID:=lonormaly-krispyai}"
  export IMMORTERM_PROJECT_ID
fi

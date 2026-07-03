#!/bin/bash
# Owner: ImmorTerm Memory
# ImmorTerm Memory: Pre-Compact Digest Trigger
# Event: PreCompact
# Project: lonormaly-krispyai
#
# Fires before context compaction. Triggers digest of current session
# so memories are captured before context is compressed.

set -euo pipefail

# Derive project root from this script's location (immune to CWD issues)
# Hooks live at <project_root>/.immorterm/hooks/ — go up 2 levels
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

STDIN_DATA=$(cat 2>/dev/null || echo '{}')

IFS='|' read -r SESSION_ID TRANSCRIPT_PATH CWD_PATH TRIGGER < <(echo "$STDIN_DATA" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    print(data.get('session_id', ''), data.get('transcript_path', ''), data.get('cwd', ''), data.get('trigger', ''), sep='|')
except Exception:
    print('|||')
" 2>/dev/null)

SESSION_ID="${SESSION_ID:-}"
CWD_PATH="${CWD_PATH:-$(pwd)}"
TRIGGER="${TRIGGER:-auto}"

if [ -z "$SESSION_ID" ]; then
  echo "[pre-compact] No session_id, skipping digest" >&2
  exit 0
fi

# Derive project ID
PROJECT_ID=""
MCP_JSON="$PROJECT_ROOT/.mcp.json"
if [ -f "$MCP_JSON" ]; then
  PROJECT_ID=$(python3 -c "
import json, sys, re
try:
    with open(sys.argv[1]) as f:
        data = json.load(f)
    for server in data.get('mcpServers', {}).values():
        url = server.get('url', '')
        m = re.search(r'/mcp/[^/]+/([^/]+)$', url)
        if m and m.group(1) != 'sse':
            print(m.group(1))
            break
        m2 = re.search(r'/sse/([^/]+)$', url)
        if m2:
            print(m2.group(1))
            break
except Exception:
    pass
" "$MCP_JSON" 2>/dev/null)
fi
if [ -z "$PROJECT_ID" ]; then
  PROJECT_ID="${IMMORTERM_PROJECT_ID:-$(basename "$PROJECT_ROOT" | tr '[:upper:]' '[:lower:]' | tr ' ' '-')}"
fi

# Find JSONL dir
JSONL_DIR=""
if [ -n "$TRANSCRIPT_PATH" ] && [ -f "$TRANSCRIPT_PATH" ]; then
  JSONL_DIR=$(dirname "$TRANSCRIPT_PATH")
else
  CWD_SLUG=$(echo "$PROJECT_ROOT" | tr '/' '-')
  JSONL_DIR="$HOME/.claude/projects/$CWD_SLUG"
fi

if [ -z "$JSONL_DIR" ] || [ ! -d "$JSONL_DIR" ]; then
  echo "[pre-compact] JSONL dir not found: $JSONL_DIR" >&2
  exit 0
fi

DIGEST_SCRIPT="$PROJECT_ROOT/.immorterm/hooks/immorterm-memory-digest.sh"
if [ ! -f "$DIGEST_SCRIPT" ]; then
  echo "[pre-compact] Digest script not found: $DIGEST_SCRIPT" >&2
  exit 0
fi

echo "[pre-compact] Triggering digest for session $SESSION_ID (trigger: $TRIGGER)" >&2
bash "$DIGEST_SCRIPT" "$PROJECT_ID" "$JSONL_DIR" "$SESSION_ID" 2>&1 | while IFS= read -r line; do
  echo "[pre-compact] $line" >&2
done || echo "[pre-compact] Digest exited non-zero (continuing to handoff)" >&2
echo "[pre-compact] Digest complete" >&2

# ── Handoff Note Generation ──────────────────────────────────────
# Assemble a JSON file with task list, user messages, session summary,
# current plan, and pending decisions. The post-compact hook reads this
# and injects it directly into the agent's context — zero MCP calls needed.

# Ensure handoff directory exists with restricted permissions
HANDOFF_DIR="$HOME/.immorterm/handoff"
mkdir -p "$HANDOFF_DIR" 2>/dev/null
chmod 700 "$HANDOFF_DIR" 2>/dev/null

# Clean up old handoff files (>1h) — restrict to regular files owned by current user
find "$HANDOFF_DIR" -maxdepth 1 -name "immorterm-handoff-*.json" -type f -user "$(whoami)" -mmin +60 -delete 2>/dev/null || true

# Resolve JSONL path for this session
JSONL_FILE=""
if [ -n "$TRANSCRIPT_PATH" ] && [ -f "$TRANSCRIPT_PATH" ]; then
  JSONL_FILE="$TRANSCRIPT_PATH"
else
  JSONL_FILE="$JSONL_DIR/$SESSION_ID.jsonl"
fi

if [ ! -f "$JSONL_FILE" ]; then
  echo "[pre-compact] JSONL not found for handoff: $JSONL_FILE" >&2
  echo "[pre-compact] Compaction may proceed (no handoff)" >&2
  exit 0
fi

echo "[pre-compact] Generating handoff note for session $SESSION_ID" >&2

HANDOFF_SESSION_ID="$SESSION_ID" \
HANDOFF_JSONL="$JSONL_FILE" \
HANDOFF_PROJECT_ID="$PROJECT_ID" \
HANDOFF_CWD="$PROJECT_ROOT" \
HANDOFF_DIR="$HANDOFF_DIR" \
python3 << 'HANDOFF_PYTHON'
import json, sys, os, urllib.request, urllib.error

session_id = os.environ["HANDOFF_SESSION_ID"]
jsonl_path = os.environ["HANDOFF_JSONL"]
project_id = os.environ["HANDOFF_PROJECT_ID"]
cwd_path = os.environ["HANDOFF_CWD"]

IMMORTERM_MEMORY_URL = os.environ.get("IMMORTERM_MEMORY_URL", "http://127.0.0.1:8765")
handoff_dir = os.environ.get("HANDOFF_DIR", os.path.expanduser("~/.immorterm/handoff"))
os.makedirs(handoff_dir, mode=0o700, exist_ok=True)
HANDOFF_PATH = os.path.join(handoff_dir, f"immorterm-handoff-{session_id}.json")

handoff = {
    "session_id": session_id,
    "project_id": project_id,
}

# ── 1. Fetch tasks from ImmorTerm-Memory API ───────────────────────────
# Tasks are persisted individually by the task-persist hook.
# Fetch from the API instead of replaying JSONL — authoritative source.
try:
    url = f"{IMMORTERM_MEMORY_URL}/api/v1/sessions/tasks?user_id={project_id}&session_id={session_id}"
    req = urllib.request.Request(url)
    resp = urllib.request.urlopen(req, timeout=5)
    data = json.loads(resp.read().decode())
    task_list = data if isinstance(data, list) else data.get("tasks", [])
    handoff["tasks"] = task_list
    print(f"[pre-compact] Handoff: {len(task_list)} tasks fetched from API", file=sys.stderr)
except Exception as e:
    handoff["tasks"] = []
    print(f"[pre-compact] Handoff: task fetch failed: {e}", file=sys.stderr)

# ── 2. Extract last 3 user messages ─────────────────────────────
try:
    user_messages = []

    with open(jsonl_path) as f:
        for line in f:
            try:
                msg = json.loads(line)
                if msg.get("type") != "user":
                    continue
                content = msg.get("message", {}).get("content", "")
                texts = []
                if isinstance(content, list):
                    for block in content:
                        if isinstance(block, dict) and block.get("type") == "text":
                            t = block.get("text", "").strip()
                            if t and len(t) > 10 and not t.startswith("<") and not t.startswith("SessionStart:"):
                                texts.append(t)
                elif isinstance(content, str) and len(content.strip()) > 10:
                    texts.append(content.strip())

                for t in texts:
                    user_messages.append(t[:300])
            except (json.JSONDecodeError, KeyError):
                continue

    handoff["user_messages"] = user_messages[-3:] if user_messages else []
    print(f"[pre-compact] Handoff: {len(handoff['user_messages'])} user messages captured", file=sys.stderr)
except Exception as e:
    handoff["user_messages"] = []
    print(f"[pre-compact] Handoff: user message parse failed: {e}", file=sys.stderr)

# ── 3. Fetch session summary from ImmorTerm-Memory ────────────────────
try:
    summary_text = ""
    checkpoint_file = os.path.expanduser("~/.immorterm/digest-checkpoints.json")
    if os.path.exists(checkpoint_file):
        with open(checkpoint_file) as f:
            checkpoints = json.load(f)
        for fpath, fdata in checkpoints.get("files", {}).items():
            if session_id in fpath:
                mid = fdata.get("summary_memory_id", "")
                if mid:
                    req = urllib.request.Request(
                        f"{IMMORTERM_MEMORY_URL}/api/v1/memories/{mid}",
                        headers={"Content-Type": "application/json"},
                    )
                    try:
                        with urllib.request.urlopen(req, timeout=3) as resp:
                            mem = json.loads(resp.read())
                            summary_text = mem.get("memory", mem.get("text", mem.get("data", "")))
                    except Exception:
                        pass
                break

    if not summary_text:
        search_payload = json.dumps({
            "query": "session summary",
            "user_id": project_id,
            "filters": {"type": "session_summary", "session_id": session_id},
            "page_size": 3,
        }).encode()
        req = urllib.request.Request(
            f"{IMMORTERM_MEMORY_URL}/api/v1/memories/search",
            data=search_payload,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=3) as resp:
                results = json.loads(resp.read())
                memories = results.get("results", results.get("memories", []))
                for m in memories:
                    meta = m.get("metadata", {})
                    if meta.get("type") != "session_summary":
                        continue
                    if meta.get("session_id") != session_id:
                        continue
                    summary_text = m.get("memory", m.get("text", m.get("data", "")))
                    break
        except Exception:
            pass

    handoff["session_summary"] = summary_text
    if summary_text:
        print(f"[pre-compact] Handoff: session summary fetched ({len(summary_text)} chars)", file=sys.stderr)
    else:
        print("[pre-compact] Handoff: no session summary found", file=sys.stderr)
except Exception as e:
    handoff["session_summary"] = ""
    print(f"[pre-compact] Handoff: summary fetch failed: {e}", file=sys.stderr)

# ── 4. Fetch current plan from ImmorTerm-Memory ────────────────────────
try:
    plan_text = ""
    search_payload = json.dumps({
        "query": "plan implementation",
        "user_id": project_id,
        "filters": {"type": "plan", "session_id": session_id},
        "page_size": 1,
    }).encode()
    req = urllib.request.Request(
        f"{IMMORTERM_MEMORY_URL}/api/v1/memories/search",
        data=search_payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=3) as resp:
            results = json.loads(resp.read())
            memories = results.get("results", results.get("memories", []))
            if memories:
                m = memories[0]
                plan_text = m.get("memory", m.get("text", m.get("data", "")))
                if len(plan_text) > 3000:
                    plan_text = plan_text[:3000] + "\n\n[... truncated ...]"
    except Exception:
        pass

    if not plan_text:
        # Check global plans dir first (where Claude Code actually writes plans)
        global_plans_dir = os.path.join(os.path.expanduser("~"), ".claude", "plans")
        project_plans_dir = os.path.join(cwd_path, ".claude", "plans")
        for plans_dir in [global_plans_dir, project_plans_dir]:
            if not os.path.isdir(plans_dir):
                continue
            plan_files = sorted(
                [os.path.join(plans_dir, f) for f in os.listdir(plans_dir) if f.endswith(".md")],
                key=lambda p: os.path.getmtime(p),
                reverse=True,
            )
            if plan_files:
                with open(plan_files[0]) as pf:
                    plan_text = pf.read()[:3000]
                if len(plan_text) >= 3000:
                    plan_text += "\n\n[... truncated ...]"
                break

    handoff["plan"] = plan_text
    if plan_text:
        print(f"[pre-compact] Handoff: plan fetched ({len(plan_text)} chars)", file=sys.stderr)
    else:
        print("[pre-compact] Handoff: no plan found", file=sys.stderr)
except Exception as e:
    handoff["plan"] = ""
    print(f"[pre-compact] Handoff: plan fetch failed: {e}", file=sys.stderr)

# ── 5. Fetch pending decisions from ImmorTerm-Memory ───────────────────
try:
    decisions = []
    search_payload = json.dumps({
        "query": "planned decision",
        "user_id": project_id,
        "filters": {"category": "decisions", "status": "planned"},
        "page_size": 10,
    }).encode()
    req = urllib.request.Request(
        f"{IMMORTERM_MEMORY_URL}/api/v1/memories/search",
        data=search_payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=3) as resp:
            results = json.loads(resp.read())
            memories = results.get("results", results.get("memories", []))
            for m in memories:
                text = m.get("memory", m.get("text", m.get("data", "")))
                sid = m.get("metadata", {}).get("session_id", m.get("session_id", ""))
                decisions.append({
                    "text": text[:300],
                    "session_id": sid,
                    "this_session": (sid == session_id),
                })
    except Exception:
        pass

    handoff["pending_decisions"] = decisions
    if decisions:
        print(f"[pre-compact] Handoff: {len(decisions)} pending decisions found", file=sys.stderr)
    else:
        print("[pre-compact] Handoff: no pending decisions", file=sys.stderr)
except Exception as e:
    handoff["pending_decisions"] = []
    print(f"[pre-compact] Handoff: decisions fetch failed: {e}", file=sys.stderr)

# ── Write handoff file ───────────────────────────────────────────
try:
    with open(HANDOFF_PATH, "w") as f:
        json.dump(handoff, f, indent=2)
    print(f"[pre-compact] Handoff written to {HANDOFF_PATH}", file=sys.stderr)
except Exception as e:
    print(f"[pre-compact] Handoff write failed: {e}", file=sys.stderr)
HANDOFF_PYTHON

echo "[pre-compact] Compaction may proceed" >&2

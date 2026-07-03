#!/bin/bash
# Owner: ImmorTerm Memory
# ImmorTerm Memory: Task Persistence (ASYNC PostToolUse hook)
# Matcher: TaskCreate|TaskUpdate|TaskList
# Project: lonormaly-krispyai
#
# Persists individual tasks to ImmorTerm-Memory as type='task' memories.
# Each task gets its own memory record with entity graph connections.
#
# TaskList events trigger reconciliation — any tasks in our map that
# aren't in Claude's actual task list get pruned (handles "Claude started
# fresh" and abandoned task scenarios).

IMMORTERM_MEMORY_URL="http://127.0.0.1:${IMMORTERM_MEMORY_PORT:-8765}"

# Derive project root from this script's location
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Per-project hook log convention
_LOG_DIR="$PROJECT_ROOT/.immorterm/terminals/hooks/logs"
_ERR_DIR="$PROJECT_ROOT/.immorterm/terminals/hooks/errors"
mkdir -p "$_LOG_DIR" "$_ERR_DIR"
LOG_FILE="$_LOG_DIR/task-persist.log"
ERR_FILE="$_ERR_DIR/task-persist.log"

log() {
  local msg
  msg=$(printf '%s' "$*" | tr -d '\n\r' | tr -cd '[:print:]')
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $msg" >> "$LOG_FILE" 2>/dev/null
}

# Read stdin JSON from Claude Code hooks API
STDIN_DATA=$(cat 2>/dev/null || echo '{}')

if [ -z "$STDIN_DATA" ] || [ "$STDIN_DATA" = '{}' ]; then
  log "No stdin data received"
  exit 0
fi

# All logic in Python for reliable JSON handling
# Pass via env var instead of sys.argv to avoid process table exposure
RESULT=$(IMMORTERM_PROJECT_ID="${IMMORTERM_PROJECT_ID:-lonormaly-krispyai}" _HOOK_INPUT="$STDIN_DATA" python3 - <<'PYEOF' 2>>"$ERR_FILE"
import json, sys, os, tempfile, shutil
from datetime import datetime, timezone
from urllib.request import Request, urlopen
from urllib.error import URLError

try:
    data = json.loads(os.environ.get("_HOOK_INPUT", "{}"))
except (json.JSONDecodeError, ValueError):
    sys.exit(0)

session_id = data.get("session_id", "")
tool_name = data.get("tool_name", "")
tool_input = data.get("tool_input", {})
tool_response = data.get("tool_response", {})

if not session_id or not tool_name:
    sys.exit(0)

openmemory_url = os.environ.get("IMMORTERM_MEMORY_URL", "http://127.0.0.1:8765")
project_id = os.environ.get("IMMORTERM_PROJECT_ID", "lonormaly-krispyai")
immorterm_id = os.environ.get("IMMORTERM_ID", "") or os.environ.get("IMMORTERM_WINDOW_ID", "")
now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

# ── Load or create temp file ────────────────────────────────────────
task_state_dir = os.path.expanduser("~/.immorterm/task-state")
os.makedirs(task_state_dir, mode=0o700, exist_ok=True)
temp_path = os.path.join(task_state_dir, f"tasks-{session_id}.json")

try:
    with open(temp_path, "r") as f:
        state = json.load(f)
except (FileNotFoundError, json.JSONDecodeError):
    state = {"tasks": {}, "memory_id": None}

# Always stamp identity so the extension can match the right file
state["session_id"] = session_id
state["immorterm_id"] = immorterm_id

tasks = state.get("tasks", {})
memory_id = state.get("memory_id")
changed = False

def archive_task_memory(memory_id):
    """Mark a task memory as deleted in ImmorTerm-Memory before removing from local state."""
    if not memory_id:
        return
    try:
        payload = json.dumps({"metadata": {"status": "deleted"}}).encode()
        r = Request(
            f"{openmemory_url}/api/v1/memories/{memory_id}",
            data=payload,
            headers={"Content-Type": "application/json"},
            method="PUT"
        )
        urlopen(r, timeout=5)
    except Exception:
        pass

# ── Handle each tool type ───────────────────────────────────────────

if tool_name == "TaskCreate":
    # Extract task_id from tool_response
    # Claude Code hook API sends structured: {"task": {"id": "N", "subject": "..."}}
    # Also handle legacy text format: "Task #N created successfully: <subject>"
    task_id = None

    if isinstance(tool_response, dict):
        # Structured response (current Claude Code format)
        task_obj = tool_response.get("task", {})
        if isinstance(task_obj, dict):
            task_id = str(task_obj.get("id", "")) or None

    if not task_id:
        # Fallback: parse from text response
        resp_text = ""
        if isinstance(tool_response, str):
            resp_text = tool_response
        elif isinstance(tool_response, dict):
            resp_text = tool_response.get("text", "") or tool_response.get("content", "") or str(tool_response)
        if "#" in resp_text:
            try:
                part = resp_text.split("#")[1].split()[0]
                task_id = part.strip(":").strip()
            except (IndexError, ValueError):
                pass

    if task_id:
        subject = tool_input.get("subject", "")
        description = tool_input.get("description", "")
        active_form = tool_input.get("activeForm", "")
        owner = tool_input.get("owner", "")
        metadata = tool_input.get("metadata", {})
        if not isinstance(metadata, dict):
            metadata = {}

        tasks[task_id] = {
            "id": task_id,
            "subject": subject,
            "description": description[:500] if description else "",
            "activeForm": active_form,
            "status": "pending",
            "owner": owner,
            "metadata": metadata,
            "blockedBy": [],
            "blocks": [],
            "created_at": now,
            "updated_at": now,
        }
        changed = True

elif tool_name == "TaskUpdate":
    task_id = tool_input.get("taskId", "")
    if task_id and task_id in tasks:
        new_status = tool_input.get("status", "")

        if new_status == "deleted":
            archive_task_memory(tasks[task_id].get("memory_id"))
            del tasks[task_id]
        else:
            if new_status:
                tasks[task_id]["status"] = new_status
            if tool_input.get("subject"):
                tasks[task_id]["subject"] = tool_input["subject"]
            if tool_input.get("description"):
                tasks[task_id]["description"] = tool_input["description"][:500]
            if tool_input.get("activeForm"):
                tasks[task_id]["activeForm"] = tool_input["activeForm"]
            if "owner" in tool_input:
                tasks[task_id]["owner"] = tool_input["owner"]
            new_meta = tool_input.get("metadata", {})
            if isinstance(new_meta, dict) and new_meta:
                existing_meta = tasks[task_id].get("metadata", {})
                if not isinstance(existing_meta, dict):
                    existing_meta = {}
                for k, v in new_meta.items():
                    if v is None:
                        existing_meta.pop(k, None)
                    else:
                        existing_meta[k] = v
                tasks[task_id]["metadata"] = existing_meta
            add_blocked_by = tool_input.get("addBlockedBy", [])
            if isinstance(add_blocked_by, list) and add_blocked_by:
                existing = tasks[task_id].get("blockedBy", [])
                if not isinstance(existing, list):
                    existing = []
                tasks[task_id]["blockedBy"] = list(dict.fromkeys(existing + [str(x) for x in add_blocked_by]))
            add_blocks = tool_input.get("addBlocks", [])
            if isinstance(add_blocks, list) and add_blocks:
                existing = tasks[task_id].get("blocks", [])
                if not isinstance(existing, list):
                    existing = []
                tasks[task_id]["blocks"] = list(dict.fromkeys(existing + [str(x) for x in add_blocks]))
            tasks[task_id]["updated_at"] = now
        changed = True

elif tool_name == "TaskList":
    # Reconcile: remove tasks from our map that Claude no longer has
    # Claude Code hook API sends structured: {"tasks": [{"id": "N", ...}]}
    # Also handle legacy text format with "- #N: subject (status)" lines
    claude_task_ids = set()

    if isinstance(tool_response, dict):
        # Structured response
        task_list = tool_response.get("tasks", [])
        if isinstance(task_list, list):
            for t in task_list:
                if isinstance(t, dict) and t.get("id"):
                    claude_task_ids.add(str(t["id"]))

    if not claude_task_ids:
        # Fallback: parse text
        resp_text = ""
        if isinstance(tool_response, str):
            resp_text = tool_response
        elif isinstance(tool_response, dict):
            resp_text = tool_response.get("text", "") or tool_response.get("content", "") or str(tool_response)
        for line in resp_text.splitlines():
            line = line.strip()
            if "#" in line:
                try:
                    part = line.split("#")[1].split(":")[0].split()[0].strip()
                    if part.isdigit():
                        claude_task_ids.add(part)
                except (IndexError, ValueError):
                    continue

    if claude_task_ids:
        # Remove tasks from our map that Claude doesn't have
        orphans = [tid for tid in tasks if tid not in claude_task_ids]
        for tid in orphans:
            archive_task_memory(tasks[tid].get("memory_id"))
            del tasks[tid]
        if orphans:
            changed = True

if not changed:
    sys.exit(0)

# ── Persist each task as an individual memory ──────────────────────
# Each task is its own memory node in ImmorTerm-Memory, connected via entity graph:
#   session:{immorterm_id} --HAS_TASK--> task:{task_id}
# This makes tasks independently searchable and recallable.

session_entity = f"session:{immorterm_id}" if immorterm_id else f"session:{session_id}"
saved_count = 0
failed_count = 0

def persist_task(task, existing_memory_id=None):
    """POST (new) or PUT (update) a single task memory."""
    tid = task["id"]
    status_str = task.get("status", "pending")
    subject = task.get("subject", "")
    desc = task.get("description", "")

    # Human-readable + searchable content
    text = f"TASK #{tid}: {subject} [{status_str}]"
    if desc:
        text += f" — {desc}"

    task_meta = {
        "category": "tasks",
        "type": "task",
        "task_id": tid,
        "status": status_str,
        "session_id": session_id,
        "immorterm_id": immorterm_id or "",
        "event_date": now,
        "timestamp": now,
    }

    if existing_memory_id:
        # PUT update
        try:
            put_payload = json.dumps({
                "text": text,
                "metadata": task_meta,
            }).encode()
            r = Request(
                f"{openmemory_url}/api/v1/memories/{existing_memory_id}",
                data=put_payload,
                headers={"Content-Type": "application/json"},
                method="PUT"
            )
            urlopen(r, timeout=5)
            return existing_memory_id
        except Exception:
            return existing_memory_id  # keep cached ID even on PUT failure

    # POST new task memory with entity graph relations
    post_body = {
        "user_id": project_id,
        "text": text,
        "infer": False,
        "metadata": task_meta,
        "session_id": session_id,
        "entities": [
            {"name": session_entity, "type": "session"},
            {"name": f"task:{tid}", "type": "task"},
        ],
        "relations": [
            {"source": session_entity, "relationship": "HAS_TASK", "destination": f"task:{tid}"},
        ],
    }
    if immorterm_id:
        post_body["immorterm_id"] = immorterm_id

    try:
        post_payload = json.dumps(post_body).encode()
        r = Request(
            f"{openmemory_url}/api/v1/memories/",
            data=post_payload,
            headers={"Content-Type": "application/json"},
            method="POST"
        )
        resp = urlopen(r, timeout=5)
        if resp.status == 200:
            resp_data = json.loads(resp.read().decode())
            return resp_data.get("id")
    except Exception:
        pass
    return None

# Only persist the task(s) that actually changed this invocation
changed_tids = set()

if tool_name == "TaskCreate" and task_id:
    changed_tids.add(task_id)
elif tool_name == "TaskUpdate":
    tid_upd = tool_input.get("taskId", "")
    if tid_upd:
        changed_tids.add(tid_upd)
elif tool_name == "TaskList":
    # Reconciliation — persist any task without a memory_id yet
    changed_tids = {tid for tid, t in tasks.items() if not t.get("memory_id")}

for tid in changed_tids:
    if tid not in tasks:
        continue
    task = tasks[tid]
    existing_mid = task.get("memory_id")
    new_mid = persist_task(task, existing_mid)
    if new_mid:
        tasks[tid]["memory_id"] = str(new_mid)
        saved_count += 1
    else:
        failed_count += 1

# ── Atomic write temp file ──────────────────────────────────────────
state = {"tasks": tasks, "session_id": session_id, "immorterm_id": immorterm_id}
tmp_fd, tmp_path = tempfile.mkstemp(dir=task_state_dir, prefix="immorterm-tasks-")
try:
    with os.fdopen(tmp_fd, "w") as f:
        json.dump(state, f, indent=2)
    shutil.move(tmp_path, temp_path)
except Exception:
    try:
        os.unlink(tmp_path)
    except Exception:
        pass

status = "saved" if saved_count > 0 else "local-only"
print(f"{status}|{len(tasks)} tasks|saved={saved_count}|failed={failed_count}")
PYEOF
)

if [ -n "$RESULT" ]; then
  log "Task persist: $RESULT"
fi

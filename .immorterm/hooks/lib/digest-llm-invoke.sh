#!/usr/bin/env bash
# digest-llm-invoke.sh
#
# Provider-dispatch shim for the digest LLM call. Sourced by digest.sh
# (a.k.a. immorterm-memory-digest.sh). Exposes a single function:
#
#   digest_llm_invoke <system_prompt> <stdin_input>
#
# It reads $IMMORTERM_DIGEST_PROVIDER + $IMMORTERM_DIGEST_MODEL from env
# (set by digest.sh after reading services.digest.{provider,model} from
# the project config) and dispatches to the matching backend.
#
# Output contract: stdout is a JSON object matching what
# `claude -p --output-format json` returns today, so downstream
# parsers in digest.sh do not have to change:
#
#   {
#     "result": "<the LLM's text response, expected to itself be JSON>",
#     "usage": {"input_tokens": N, "output_tokens": M},
#     "total_cost_usd": 0.0
#   }
#
# Token counts and cost are best-effort for non-Anthropic providers;
# they are only logged, not load-bearing.
#
# Phase A Task 10 — Block 2 of vendor-agnostic digestion plan.
# See docs/plans/phase-a.md for context.

# NOTE: This file is meant to be SOURCED, not executed. We don't `set -e`
# here because the caller (digest.sh) has its own error handling.

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

# _digest_llm_die <message> <return-code>
# Print an error to stderr and return the given code (default 1).
_digest_llm_die() {
  local msg="$1"
  local code="${2:-1}"
  echo "[digest-llm] $msg" >&2
  return "$code"
}

# _digest_llm_have <cmd>  -> 0 if `cmd` is on PATH
_digest_llm_have() {
  command -v "$1" >/dev/null 2>&1
}

# Portable `timeout` shim. macOS doesn't ship GNU coreutils so the
# plain `timeout` binary is missing — defining it as a shell function
# lets every existing `timeout 300 cmd args...` call site keep working
# unchanged. Resolution order: gtimeout (Homebrew coreutils) → perl
# alarm (always on macOS) → unwrapped (caller's HTTP layer handles
# the real wall limit). Without this every CLI provider exited with
# "timeout: command not found" on a stock Mac, swallowing the actual
# error users would have needed to debug their auth / PATH setup.
if ! _digest_llm_have timeout; then
  if _digest_llm_have gtimeout; then
    timeout() { gtimeout "$@"; }
  elif _digest_llm_have perl; then
    # perl -e 'alarm shift; exec @ARGV' <secs> <cmd> [args...]
    # Sends SIGALRM at <secs> and execs the rest. exec replaces perl
    # with the target so signals + exit codes propagate cleanly.
    timeout() {
      local secs="$1"; shift
      perl -e 'alarm shift; exec @ARGV' "$secs" "$@"
    }
  else
    # No fallback available — run unwrapped. The /api/v1/digest/test
    # endpoint enforces its own 15s wall timeout so we won't leak
    # forever; just lose the per-provider 5min cap.
    timeout() { shift; "$@"; }
  fi
fi

# _digest_llm_envelope <result_text> [in_tokens] [out_tokens] [cost_usd]
# Emit the canonical envelope JSON on stdout. Uses jq when available
# to safely escape `result_text`; falls back to a python3 helper.
_digest_llm_envelope() {
  local result_text="$1"
  local in_tok="${2:-0}"
  local out_tok="${3:-0}"
  local cost="${4:-0}"

  if _digest_llm_have jq; then
    jq -cn \
      --arg result "$result_text" \
      --argjson in_tok "${in_tok:-0}" \
      --argjson out_tok "${out_tok:-0}" \
      --argjson cost "${cost:-0}" \
      '{result: $result, usage: {input_tokens: $in_tok, output_tokens: $out_tok}, total_cost_usd: $cost}'
    return 0
  fi

  # Fallback: python3 (always available on macOS / most Linux)
  if _digest_llm_have python3; then
    RESULT_TEXT="$result_text" IN_TOK="$in_tok" OUT_TOK="$out_tok" COST="$cost" \
      python3 - <<'PYEOF'
import json, os
print(json.dumps({
    "result": os.environ.get("RESULT_TEXT", ""),
    "usage": {
        "input_tokens": int(os.environ.get("IN_TOK", "0") or 0),
        "output_tokens": int(os.environ.get("OUT_TOK", "0") or 0),
    },
    "total_cost_usd": float(os.environ.get("COST", "0") or 0),
}, separators=(",", ":")))
PYEOF
    return 0
  fi

  _digest_llm_die "no jq or python3 available to build envelope" 2
  return 2
}

# _digest_llm_extract_json <field-path-args...>
# Read JSON on stdin and extract a path with jq, or fall back to python3.
# Usage: _digest_llm_extract_json '.choices[0].message.content'
_digest_llm_extract_json() {
  local path="$1"
  if _digest_llm_have jq; then
    jq -r "$path // empty" 2>/dev/null
    return $?
  fi
  if _digest_llm_have python3; then
    JQ_PATH="$path" python3 - <<'PYEOF'
import json, os, sys
data = json.loads(sys.stdin.read() or "{}")
path = os.environ["JQ_PATH"].lstrip(".")
cur = data
try:
    for part in path.split("."):
        if not part:
            continue
        # Handle simple [N] indexing
        if "[" in part and part.endswith("]"):
            name, idx = part[:-1].split("[", 1)
            if name:
                cur = cur[name]
            cur = cur[int(idx)]
        else:
            cur = cur[part]
    sys.stdout.write("" if cur is None else str(cur))
except Exception:
    pass
PYEOF
    return $?
  fi
  return 1
}

# ---------------------------------------------------------------------------
# Provider implementations
# ---------------------------------------------------------------------------

# All providers read transcript text from stdin and the system prompt
# from $1. They emit the canonical envelope on stdout.

_digest_llm_anthropic_cli() {
  local system_prompt="$1"
  local model="$2"
  # Subscription-safe path: dispatch through immorterm-p, which drives
  # interactive `claude` inside a headless ImmorTerm session. Anthropic
  # is removing `claude -p` from the subscription tier; interactive
  # `claude` stays.
  #
  # Output contract: the digest caller still expects the historic
  # claude-p shape `{"result":"...","usage":{...},"total_cost_usd":N}`.
  # immorterm-p emits the model's content directly + writes a separate
  # usage JSON to $IMMORTERM_P_USAGE_FILE. We re-assemble both into
  # the historic shape so callers parse it without changes.
  local impp="${IMMORTERM_P_BIN:-$HOME/.immorterm/bin/immorterm-p}"
  if [ ! -x "$impp" ] && ! _digest_llm_have immorterm-p; then
    _digest_llm_die "anthropic-cli: 'immorterm-p' not found at $impp or on PATH"
    return 1
  fi
  [ -x "$impp" ] || impp="immorterm-p"

  local err_tmp out_tmp usage_file
  err_tmp=$(mktemp -t immorterm-anthropic-cli-err.XXXXXX)
  out_tmp=$(mktemp -t immorterm-anthropic-cli-out.XXXXXX)
  usage_file=$(mktemp -t immorterm-p-usage.XXXXXX.json)

  # --pool digest: reuse ONE warm headless claude session across digests
  # instead of booting a fresh REPL per call (~8s boot eliminated; stable
  # system-prompt prefix stays warm in the server-side prompt cache). The
  # pooled session resets context with /clear between calls and self-reaps
  # after IMMORTERM_P_POOL_TTL idle. NOTE: --disable-slash-commands is
  # intentionally omitted — pool reset requires /clear. (immorterm-p also
  # drops it defensively in pool mode.)
  IMMORTERM_P_USAGE_FILE="$usage_file" timeout 300 "$impp" \
    --pool digest \
    --permission-mode bypassPermissions \
    --model "$model" \
    --allowed-tools "Write" \
    --append-system-prompt "$system_prompt" \
    > "$out_tmp" 2>"$err_tmp"
  local rc=$?

  if [ $rc -ne 0 ] && [ -s "$err_tmp" ]; then
    sed 's/^/[anthropic-cli] /' "$err_tmp" >&2
  fi

  if [ $rc -eq 0 ]; then
    # Wrap content + harvested usage into the historic claude-p JSON shape.
    python3 - "$out_tmp" "$usage_file" <<'PYEOF'
import json, sys
with open(sys.argv[1]) as f:
    content = f.read()
try:
    usage = json.load(open(sys.argv[2]))
except Exception:
    usage = {}
out = {
    "result": content.strip(),
    "usage": {
        "input_tokens": int(usage.get("input_tokens") or 0),
        "output_tokens": int(usage.get("output_tokens") or 0),
        "cache_read_input_tokens": int(usage.get("cache_read_input_tokens") or 0),
        "cache_creation_input_tokens": int(usage.get("cache_creation_input_tokens") or 0),
    },
    "total_cost_usd": float(usage.get("cost_usd") or 0.0),
    "model": usage.get("model") or "",
}
print(json.dumps(out))
PYEOF
  fi

  rm -f "$err_tmp" "$out_tmp" "$usage_file"
  return $rc
}

# ── Subscription-backed CLI providers ──────────────────────────────
# Each of these uses the user's existing vendor subscription (no API
# key billing on top). Auth happens once interactively; the cached
# OAuth credential is reused for headless calls.

_digest_llm_codex_cli() {
  local system_prompt="$1"
  local model="$2"
  if ! _digest_llm_have codex; then
    _digest_llm_die "codex-cli: 'codex' not on PATH (install: npm i -g @openai/codex)"
    return 1
  fi
  # `codex exec` is the one-shot non-interactive entrypoint. The
  # transcript rides through stdin via `-` (per OpenAI's docs); the
  # system prompt becomes the positional task description. Auth is
  # `codex login` (browser ChatGPT OAuth) — uses the user's Plus/
  # Pro/Business sub. Quota counts against weekly Codex CLI quota.
  local stdin_input
  stdin_input=$(cat)
  # Combine system prompt + transcript so codex sees both. Codex has
  # no first-class system-prompt flag for `exec`; concatenating with
  # a clear delimiter keeps semantics.
  local combined
  combined=$(printf '%s\n\n<transcript_to_analyze>\n%s\n</transcript_to_analyze>\n' "$system_prompt" "$stdin_input")
  local out_file
  out_file=$(mktemp -t immorterm-codex.XXXXXX) || {
    _digest_llm_die "codex-cli: failed to create tempfile"; return 1; }
  # `--output-last-message` writes ONLY the model's final assistant
  # message — perfect for our envelope; `--json` would dump the full
  # event stream which we'd have to parse anyway.
  local err_tmp
  err_tmp=$(mktemp -t immorterm-codex-cli.XXXXXX)
  printf '%s' "$combined" | timeout 300 codex exec - \
    --model "$model" \
    --output-last-message "$out_file" \
    >/dev/null 2>"$err_tmp"
  local rc=$?
  if [ $rc -ne 0 ]; then
    [ -s "$err_tmp" ] && sed 's/^/[codex-cli] /' "$err_tmp" >&2
    rm -f "$err_tmp" "$out_file"
    _digest_llm_die "codex-cli: 'codex exec' exited $rc (auth? run 'codex login')"
    return 1
  fi
  rm -f "$err_tmp"
  local text
  text=$(cat "$out_file")
  rm -f "$out_file"
  _digest_llm_envelope "$text" "0" "0" "0"
}

_digest_llm_cursor_cli() {
  local system_prompt="$1"
  local model="$2"
  if ! _digest_llm_have cursor-agent; then
    _digest_llm_die "cursor-cli: 'cursor-agent' not on PATH (install via Cursor → CLI)"
    return 1
  fi
  # `cursor-agent -p` is print-mode (one-shot). Auth is `cursor-agent`
  # first-run browser OAuth — uses Cursor Pro sub. Note: vendor docs
  # don't explicitly confirm CLI billing equals IDE billing, may count
  # against monthly quota.
  local stdin_input
  stdin_input=$(cat)
  local combined
  combined=$(printf '%s\n\n<transcript_to_analyze>\n%s\n</transcript_to_analyze>\n' "$system_prompt" "$stdin_input")
  local response
  local err_tmp
  err_tmp=$(mktemp -t immorterm-cursor-cli.XXXXXX)
  response=$(printf '%s' "$combined" | timeout 300 cursor-agent -p \
    --model "$model" \
    --output-format json 2>"$err_tmp")
  local rc=$?
  if [ $rc -ne 0 ] || [ -z "$response" ]; then
    [ -s "$err_tmp" ] && sed 's/^/[cursor-cli] /' "$err_tmp" >&2
    rm -f "$err_tmp"
    _digest_llm_die "cursor-cli: 'cursor-agent' exited $rc (auth? run 'cursor-agent' interactively first)"
    return 1
  fi
  rm -f "$err_tmp"
  # Cursor's --output-format json wraps the response. Extract the
  # text field; field path is `.content` per their docs.
  local text
  text=$(printf '%s' "$response" | _digest_llm_extract_json '.result // .content // .text // .message')
  if [ -z "$text" ]; then
    # Fall back to raw response if shape doesn't match — better than
    # erroring; downstream parser will surface schema issues.
    text="$response"
  fi
  _digest_llm_envelope "$text" "0" "0" "0"
}

_digest_llm_gemini_cli() {
  local system_prompt="$1"
  local model="$2"
  if ! _digest_llm_have gemini; then
    _digest_llm_die "gemini-cli: 'gemini' not on PATH (install: npm i -g @google/gemini-cli)"
    return 1
  fi
  # `gemini -p` is print-mode. Auth is `gemini` first-run browser
  # OAuth (cached at ~/.gemini). Free tier OAuth = 60 req/min,
  # 1000/day. Google AI Pro/Ultra subscribers should sign in with the
  # Google account associated with the sub. The OAuth cache MUST
  # exist before this hook runs — there's no headless device-code
  # flow today.
  local stdin_input
  stdin_input=$(cat)
  local combined
  combined=$(printf '%s\n\n<transcript_to_analyze>\n%s\n</transcript_to_analyze>\n' "$system_prompt" "$stdin_input")
  local response
  local err_tmp
  err_tmp=$(mktemp -t immorterm-gemini-cli.XXXXXX)
  response=$(printf '%s' "$combined" | timeout 300 gemini -p \
    --model "$model" \
    --output-format json 2>"$err_tmp")
  local rc=$?
  if [ $rc -ne 0 ] || [ -z "$response" ]; then
    [ -s "$err_tmp" ] && sed 's/^/[gemini-cli] /' "$err_tmp" >&2
    rm -f "$err_tmp"
    _digest_llm_die "gemini-cli: 'gemini' exited $rc (auth? run 'gemini' interactively first)"
    return 1
  fi
  rm -f "$err_tmp"
  local text
  text=$(printf '%s' "$response" | _digest_llm_extract_json '.response // .text // .result')
  if [ -z "$text" ]; then
    text="$response"
  fi
  _digest_llm_envelope "$text" "0" "0" "0"
}

_digest_llm_copilot_cli() {
  local system_prompt="$1"
  local model="$2"
  # GitHub Copilot CLI (standalone agentic, GA 2026-02). Install:
  # `npm i -g @github/copilot` or `brew install copilot-cli`. Auth is
  # `copilot /login` (or COPILOT_GITHUB_TOKEN env in CI). Uses Pro/
  # Pro+/Business/Enterprise sub; each call = 1 premium request.
  # NOTE: the legacy `gh copilot` extension was deprecated 2025-10
  # and never had a non-interactive shape — we don't fall back to it.
  if ! _digest_llm_have copilot; then
    _digest_llm_die "copilot-cli: 'copilot' not on PATH (install: npm i -g @github/copilot)"
    return 1
  fi

  # Bug-aware payload assembly: copilot-cli issue #683 — piped stdin
  # is silently dropped when -p is also supplied. So we inline the
  # transcript into the prompt argv instead of the natural pipe.
  local stdin_input
  stdin_input=$(cat)
  local combined
  combined=$(printf '%s\n\n<transcript_to_analyze>\n%s\n</transcript_to_analyze>\n' "$system_prompt" "$stdin_input")

  # `--silent` strips session metadata so we get just the assistant's
  # final reply. `--allow-all-tools` skips the folder-trust prompt
  # which otherwise hangs in non-interactive mode. `--no-ask-user`
  # disables clarification round-trips. Output is JSONL (one JSON
  # object per line); we extract the last non-empty line's `.content`
  # field as the response text.
  local response
  local err_tmp
  err_tmp=$(mktemp -t immorterm-copilot-cli.XXXXXX)
  response=$(timeout 300 copilot \
    --model "$model" \
    --silent \
    --no-ask-user \
    --allow-all-tools \
    --output-format json \
    -p "$combined" 2>"$err_tmp")
  local rc=$?
  if [ $rc -ne 0 ] || [ -z "$response" ]; then
    [ -s "$err_tmp" ] && sed 's/^/[copilot-cli] /' "$err_tmp" >&2
    rm -f "$err_tmp"
    _digest_llm_die "copilot-cli: 'copilot' exited $rc (auth? run 'copilot' interactively then '/login')"
    return 1
  fi
  rm -f "$err_tmp"

  # JSONL → take the last non-empty line, then extract a text field.
  # Field names vary by event type; we try the common ones in order.
  local last_line
  last_line=$(printf '%s' "$response" | awk 'NF{line=$0} END{print line}')
  local text
  if [ -n "$last_line" ]; then
    text=$(printf '%s' "$last_line" | _digest_llm_extract_json '.content // .text // .message // .result')
  fi
  if [ -z "$text" ]; then
    text="$response"
  fi
  _digest_llm_envelope "$text" "0" "0" "0"
}

_digest_llm_opencode_cli() {
  local system_prompt="$1"
  local model="$2"
  if ! _digest_llm_have opencode; then
    _digest_llm_die "opencode-cli: 'opencode' not on PATH (see opencode.ai/docs/install)"
    return 1
  fi
  # `opencode run` is the non-interactive one-shot. opencode is a
  # proxy — it routes to whatever provider the user configured in
  # opencode's own config (subscription or API). `--format json`
  # returns a clean envelope.
  local stdin_input
  stdin_input=$(cat)
  local combined
  combined=$(printf '%s\n\n<transcript_to_analyze>\n%s\n</transcript_to_analyze>\n' "$system_prompt" "$stdin_input")
  local response
  local err_tmp
  err_tmp=$(mktemp -t immorterm-opencode-cli.XXXXXX)
  response=$(printf '%s' "$combined" | timeout 300 opencode run \
    --model "$model" \
    --format json 2>"$err_tmp")
  local rc=$?
  if [ $rc -ne 0 ] || [ -z "$response" ]; then
    [ -s "$err_tmp" ] && sed 's/^/[opencode-cli] /' "$err_tmp" >&2
    rm -f "$err_tmp"
    _digest_llm_die "opencode-cli: 'opencode run' exited $rc"
    return 1
  fi
  rm -f "$err_tmp"
  local text
  text=$(printf '%s' "$response" | _digest_llm_extract_json '.result // .response // .text // .message')
  if [ -z "$text" ]; then
    text="$response"
  fi
  _digest_llm_envelope "$text" "0" "0" "0"
}

_digest_llm_anthropic_api() {
  local system_prompt="$1"
  local model="$2"
  if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
    _digest_llm_die "anthropic-api: ANTHROPIC_API_KEY is not set"
    return 1
  fi
  if ! _digest_llm_have curl; then
    _digest_llm_die "anthropic-api: 'curl' not on PATH"
    return 1
  fi
  if ! _digest_llm_have jq; then
    _digest_llm_die "anthropic-api: 'jq' required to build/parse JSON"
    return 1
  fi

  local stdin_input
  stdin_input=$(cat)

  local body
  body=$(jq -cn \
    --arg model "$model" \
    --arg sys "$system_prompt" \
    --arg user "$stdin_input" \
    '{model: $model, max_tokens: 4096, system: $sys, messages: [{role: "user", content: $user}]}')

  local response
  response=$(curl -sS --max-time 300 \
    -H "x-api-key: $ANTHROPIC_API_KEY" \
    -H "anthropic-version: 2023-06-01" \
    -H "content-type: application/json" \
    -d "$body" \
    https://api.anthropic.com/v1/messages)

  if [ -z "$response" ]; then
    _digest_llm_die "anthropic-api: empty response from api.anthropic.com"
    return 1
  fi

  local err
  err=$(printf '%s' "$response" | jq -r '.error.message // empty' 2>/dev/null)
  if [ -n "$err" ]; then
    _digest_llm_die "anthropic-api: $err"
    return 1
  fi

  local text in_tok out_tok
  text=$(printf '%s' "$response" | jq -r '[.content[]? | select(.type=="text") | .text] | join("")' 2>/dev/null)
  in_tok=$(printf '%s' "$response" | jq -r '.usage.input_tokens // 0' 2>/dev/null)
  out_tok=$(printf '%s' "$response" | jq -r '.usage.output_tokens // 0' 2>/dev/null)

  _digest_llm_envelope "$text" "$in_tok" "$out_tok" "0"
}

_digest_llm_openai_api() {
  local system_prompt="$1"
  local model="$2"
  if [ -z "${OPENAI_API_KEY:-}" ]; then
    _digest_llm_die "openai-api: OPENAI_API_KEY is not set"
    return 1
  fi
  if ! _digest_llm_have curl; then
    _digest_llm_die "openai-api: 'curl' not on PATH"
    return 1
  fi
  if ! _digest_llm_have jq; then
    _digest_llm_die "openai-api: 'jq' required to build/parse JSON"
    return 1
  fi

  local stdin_input
  stdin_input=$(cat)

  local body
  body=$(jq -cn \
    --arg model "$model" \
    --arg sys "$system_prompt" \
    --arg user "$stdin_input" \
    '{model: $model, messages: [{role: "system", content: $sys}, {role: "user", content: $user}]}')

  local response
  response=$(curl -sS --max-time 300 \
    -H "Authorization: Bearer $OPENAI_API_KEY" \
    -H "content-type: application/json" \
    -d "$body" \
    https://api.openai.com/v1/chat/completions)

  if [ -z "$response" ]; then
    _digest_llm_die "openai-api: empty response from api.openai.com"
    return 1
  fi

  local err
  err=$(printf '%s' "$response" | jq -r '.error.message // empty' 2>/dev/null)
  if [ -n "$err" ]; then
    _digest_llm_die "openai-api: $err"
    return 1
  fi

  local text in_tok out_tok
  text=$(printf '%s' "$response" | jq -r '.choices[0].message.content // ""' 2>/dev/null)
  in_tok=$(printf '%s' "$response" | jq -r '.usage.prompt_tokens // 0' 2>/dev/null)
  out_tok=$(printf '%s' "$response" | jq -r '.usage.completion_tokens // 0' 2>/dev/null)

  _digest_llm_envelope "$text" "$in_tok" "$out_tok" "0"
}

_digest_llm_gemini_api() {
  local system_prompt="$1"
  local model="$2"
  if [ -z "${GEMINI_API_KEY:-}" ]; then
    _digest_llm_die "gemini-api: GEMINI_API_KEY is not set"
    return 1
  fi
  if ! _digest_llm_have curl; then
    _digest_llm_die "gemini-api: 'curl' not on PATH"
    return 1
  fi
  if ! _digest_llm_have jq; then
    _digest_llm_die "gemini-api: 'jq' required to build/parse JSON"
    return 1
  fi

  local stdin_input
  stdin_input=$(cat)

  # Gemini API: system prompt goes into systemInstruction; user prompt into contents[].
  local body
  body=$(jq -cn \
    --arg sys "$system_prompt" \
    --arg user "$stdin_input" \
    '{
      systemInstruction: {parts: [{text: $sys}]},
      contents: [{role: "user", parts: [{text: $user}]}]
    }')

  local url="https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}"
  local response
  response=$(curl -sS --max-time 300 \
    -H "content-type: application/json" \
    -d "$body" \
    "$url")

  if [ -z "$response" ]; then
    _digest_llm_die "gemini-api: empty response from generativelanguage.googleapis.com"
    return 1
  fi

  local err
  err=$(printf '%s' "$response" | jq -r '.error.message // empty' 2>/dev/null)
  if [ -n "$err" ]; then
    _digest_llm_die "gemini-api: $err"
    return 1
  fi

  local text in_tok out_tok
  text=$(printf '%s' "$response" | jq -r '[.candidates[0].content.parts[]?.text] | join("")' 2>/dev/null)
  in_tok=$(printf '%s' "$response" | jq -r '.usageMetadata.promptTokenCount // 0' 2>/dev/null)
  out_tok=$(printf '%s' "$response" | jq -r '.usageMetadata.candidatesTokenCount // 0' 2>/dev/null)

  _digest_llm_envelope "$text" "$in_tok" "$out_tok" "0"
}

_digest_llm_ollama() {
  local system_prompt="$1"
  local model="$2"
  if ! _digest_llm_have curl; then
    _digest_llm_die "ollama: 'curl' not on PATH"
    return 1
  fi
  if ! _digest_llm_have jq; then
    _digest_llm_die "ollama: 'jq' required to build/parse JSON"
    return 1
  fi

  local stdin_input
  stdin_input=$(cat)

  local host="${OLLAMA_HOST:-http://localhost:11434}"
  local body
  body=$(jq -cn \
    --arg model "$model" \
    --arg sys "$system_prompt" \
    --arg user "$stdin_input" \
    '{
      model: $model,
      stream: false,
      messages: [{role: "system", content: $sys}, {role: "user", content: $user}]
    }')

  local response
  response=$(curl -sS --max-time 300 \
    -H "content-type: application/json" \
    -d "$body" \
    "${host%/}/api/chat")

  if [ -z "$response" ]; then
    _digest_llm_die "ollama: empty response from $host (is the daemon running?)"
    return 1
  fi

  local err
  err=$(printf '%s' "$response" | jq -r '.error // empty' 2>/dev/null)
  if [ -n "$err" ]; then
    _digest_llm_die "ollama: $err"
    return 1
  fi

  local text in_tok out_tok
  text=$(printf '%s' "$response" | jq -r '.message.content // ""' 2>/dev/null)
  in_tok=$(printf '%s' "$response" | jq -r '.prompt_eval_count // 0' 2>/dev/null)
  out_tok=$(printf '%s' "$response" | jq -r '.eval_count // 0' 2>/dev/null)

  _digest_llm_envelope "$text" "$in_tok" "$out_tok" "0"
}

_digest_llm_llm_cli() {
  local system_prompt="$1"
  local model="$2"
  if ! _digest_llm_have llm; then
    _digest_llm_die "llm-cli: 'llm' not on PATH (install via: pip install llm)"
    return 1
  fi
  # llm reads prompt from stdin when invoked without a positional arg.
  local text err_tmp
  err_tmp=$(mktemp -t immorterm-llm-cli.XXXXXX)
  text=$(timeout 300 llm -m "$model" --system "$system_prompt" 2>"$err_tmp")
  local rc=$?
  if [ $rc -ne 0 ]; then
    [ -s "$err_tmp" ] && sed 's/^/[llm-cli] /' "$err_tmp" >&2
  fi
  rm -f "$err_tmp"
  if [ $rc -ne 0 ]; then
    _digest_llm_die "llm-cli: 'llm' exited $rc"
    return 1
  fi
  _digest_llm_envelope "$text" "0" "0" "0"
}

# ---------------------------------------------------------------------------
# immorterm-p delivery wrapper
# ---------------------------------------------------------------------------
#
# When the user selects delivery=immorterm-p, we route the digest call
# through ~/.immorterm/bin/immorterm-p instead of executing the vendor CLI
# directly. The wrapper runs the CLI in a headless immorterm session and
# harvests the answer via a file the model writes — subscription-safe
# replacement for `claude -p`.
#
# Per-provider templates live in _digest_llm_immorterm_p_template. They are
# stored as IMMORTERM_P_CMD_TEMPLATE strings (placeholders {INFILE},
# {OUTFILE}, {SESSION_ID}, {SYSTEM_PROMPT} per immorterm-p.sh docs).
# A user override via IMMORTERM_P_TEMPLATE_<PROVIDER> wins, then a
# generic IMMORTERM_P_CMD_TEMPLATE wins, then the built-in default fires.

# Returns 0 + prints the template if one exists for the provider.
_digest_llm_immorterm_p_template() {
  local provider="$1"
  # Caller-supplied override per provider — uppercase + dash → underscore.
  local up
  up=$(printf '%s' "$provider" | tr 'a-z-' 'A-Z_')
  local override_var="IMMORTERM_P_TEMPLATE_${up}"
  # Indirect expansion: portable bash (avoid zsh-only ${(P)var}).
  local override_val
  eval "override_val=\${$override_var:-}"
  if [ -n "$override_val" ]; then
    printf '%s' "$override_val"
    return 0
  fi
  case "$provider" in
    anthropic-cli)
      # Default — claude with append-system-prompt + session-id. immorterm-p
      # ALSO has this baked as its zero-template fallback, so we leave the
      # template empty and let the wrapper use its hardcoded Claude path.
      printf ''
      return 0 ;;
    codex-cli)
      # `codex exec -` reads stdin; we instead point it at a file via
      # `--input-file` (Codex CLI 0.x+). Combine system prompt + stdin
      # equivalents into the prompt file path itself; the wrapper's
      # SYSTEM_PROMPT placeholder carries the file-handshake instructions.
      # Codex 0.5+ supports --output-last-message to a file — we direct
      # it at OUTFILE so the wrapper's harvest just works.
      printf 'codex exec --input-file {INFILE} --model {MODEL} --output-last-message {OUTFILE}'
      return 0 ;;
    gemini-cli)
      # `gemini -p` reads the prompt from stdin; with the file-based
      # contract, we cat INFILE into it. Output capture happens via the
      # wrapper's screen-poll → OUTFILE write the model performs.
      printf 'sh -c "cat {INFILE} | gemini -p --model {MODEL}"'
      return 0 ;;
    copilot-cli)
      # GitHub Copilot CLI standalone mode. Same pattern.
      printf 'sh -c "cat {INFILE} | copilot --model {MODEL}"'
      return 0 ;;
    *)
      # No known template — caller must provide IMMORTERM_P_TEMPLATE_<PROVIDER>
      # to enable immorterm-p delivery for this provider.
      return 1 ;;
  esac
}

# Run the digest via immorterm-p. Sets IMMORTERM_P_CMD_TEMPLATE if a non-empty
# template exists; otherwise lets immorterm-p use its default Claude path.
# Reads transcript from stdin, prints the historic envelope JSON shape on
# stdout. Returns 0 on success.
_digest_llm_via_immorterm_p() {
  local provider="$1"
  local model="$2"
  local system_prompt="$3"
  local impp="${IMMORTERM_P_BIN:-$HOME/.immorterm/bin/immorterm-p}"

  if [ ! -x "$impp" ] && ! _digest_llm_have immorterm-p; then
    _digest_llm_die "immorterm-p: not installed (need ~/.immorterm/bin/immorterm-p or on PATH)"
    return 1
  fi
  [ -x "$impp" ] || impp="immorterm-p"

  local template
  template=$(_digest_llm_immorterm_p_template "$provider") || {
    _digest_llm_die "immorterm-p: no template for provider '$provider' (set IMMORTERM_P_TEMPLATE_$(printf '%s' "$provider" | tr 'a-z-' 'A-Z_')=...)"
    return 1
  }

  # Substitute {MODEL} in the template (immorterm-p.sh handles {INFILE} etc).
  if [ -n "$template" ]; then
    template=${template//\{MODEL\}/$model}
  fi

  local stdin_input
  stdin_input=$(cat)
  local combined
  combined=$(printf '<transcript_to_analyze>\n%s\n</transcript_to_analyze>\n\nAnalyze and return JSON per the system prompt.' "$stdin_input")

  local err_tmp out_tmp usage_file
  err_tmp=$(mktemp -t immorterm-via-p-err.XXXXXX)
  out_tmp=$(mktemp -t immorterm-via-p-out.XXXXXX)
  usage_file=$(mktemp -t immorterm-p-usage.XXXXXX.json)

  # Warm-session pooling applies ONLY to the default Claude path (empty
  # template). Custom-CLI templates (codex/gemini/etc.) can't be reset with
  # /clear between calls, so they stay one-shot with slash-commands disabled.
  # For the pooled Claude path we MUST drop --disable-slash-commands (pool
  # reset needs /clear) — immorterm-p also drops it defensively in pool mode.
  local pool_args="" slash_args="--disable-slash-commands"
  if [ -z "$template" ]; then
    pool_args="--pool digest"
    slash_args=""
  fi

  # Build immorterm-p invocation. Pass the combined transcript on stdin —
  # immorterm-p writes it to its INFILE for us.
  IMMORTERM_P_USAGE_FILE="$usage_file" \
  IMMORTERM_P_CMD_TEMPLATE="$template" \
  timeout 300 "$impp" \
    $pool_args \
    --permission-mode bypassPermissions \
    --model "$model" \
    --allowed-tools "Read,Write" \
    $slash_args \
    --append-system-prompt "$system_prompt" \
    <<< "$combined" \
    > "$out_tmp" 2>"$err_tmp"
  local rc=$?

  if [ $rc -ne 0 ] && [ -s "$err_tmp" ]; then
    sed 's/^/[immorterm-p] /' "$err_tmp" >&2
  fi

  if [ $rc -eq 0 ]; then
    # Wrap content + usage into the historic envelope. Same shape as the
    # direct anthropic-cli path so downstream parsing is unchanged.
    python3 - "$out_tmp" "$usage_file" <<'PYEOF'
import json, sys
with open(sys.argv[1]) as f:
    content = f.read()
try:
    usage = json.load(open(sys.argv[2]))
except Exception:
    usage = {}
out = {
    "result": content.strip(),
    "usage": {
        "input_tokens": int(usage.get("input_tokens") or 0),
        "output_tokens": int(usage.get("output_tokens") or 0),
        "cache_read_input_tokens": int(usage.get("cache_read_input_tokens") or 0),
        "cache_creation_input_tokens": int(usage.get("cache_creation_input_tokens") or 0),
    },
    "total_cost_usd": float(usage.get("cost_usd") or 0.0),
    "model": usage.get("model") or "",
}
print(json.dumps(out))
PYEOF
  fi
  rm -f "$err_tmp" "$out_tmp" "$usage_file"
  return $rc
}

# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------

# digest_llm_invoke <system_prompt>
# Reads transcript from stdin; writes envelope JSON to stdout.
# Returns 0 on success, non-zero on dispatch error.
digest_llm_invoke() {
  local system_prompt="$1"
  local provider="${IMMORTERM_DIGEST_PROVIDER:-anthropic-cli}"
  local model="${IMMORTERM_DIGEST_MODEL:-sonnet}"
  local delivery="${IMMORTERM_DIGEST_DELIVERY:-auto}"

  # ── Delivery: direct vs immorterm-p ──────────────────────────────
  # `direct`        — call the vendor CLI from this process (legacy path)
  # `immorterm-p`   — wrap the vendor CLI in a headless immorterm session
  #                   (subscription-safe; survives `claude -p` deprecation
  #                   and any equivalent vendor lockdowns)
  # `auto`          — use immorterm-p when ~/.immorterm/bin/immorterm-p
  #                   exists AND the chosen provider has a known wrap
  #                   template; otherwise fall back to direct.
  local impp="${IMMORTERM_P_BIN:-$HOME/.immorterm/bin/immorterm-p}"
  if [ "$delivery" = "auto" ]; then
    if [ -x "$impp" ] && _digest_llm_immorterm_p_template "$provider" >/dev/null 2>&1; then
      delivery="immorterm-p"
    else
      delivery="direct"
    fi
  fi
  if [ "$delivery" = "immorterm-p" ]; then
    if _digest_llm_via_immorterm_p "$provider" "$model" "$system_prompt"; then
      return 0
    fi
    # Wrapper unavailable or fell through — drop to direct.
    delivery="direct"
  fi

  case "$provider" in
    # Subscription-backed CLI providers (preferred — no separate billing)
    anthropic-cli)
      _digest_llm_anthropic_cli "$system_prompt" "$model"
      ;;
    codex-cli)
      _digest_llm_codex_cli "$system_prompt" "$model"
      ;;
    cursor-cli)
      _digest_llm_cursor_cli "$system_prompt" "$model"
      ;;
    gemini-cli)
      _digest_llm_gemini_cli "$system_prompt" "$model"
      ;;
    copilot-cli)
      _digest_llm_copilot_cli "$system_prompt" "$model"
      ;;
    opencode-cli)
      _digest_llm_opencode_cli "$system_prompt" "$model"
      ;;
    llm-cli)
      _digest_llm_llm_cli "$system_prompt" "$model"
      ;;
    # Local
    ollama)
      _digest_llm_ollama "$system_prompt" "$model"
      ;;
    # Pay-per-token API providers (last resort)
    anthropic-api)
      _digest_llm_anthropic_api "$system_prompt" "$model"
      ;;
    openai-api)
      _digest_llm_openai_api "$system_prompt" "$model"
      ;;
    gemini-api)
      _digest_llm_gemini_api "$system_prompt" "$model"
      ;;
    *)
      _digest_llm_die "unknown provider: $provider (expected one of: anthropic-cli, codex-cli, cursor-cli, gemini-cli, copilot-cli, opencode-cli, llm-cli, ollama, anthropic-api, openai-api, gemini-api)"
      return 1
      ;;
  esac
}

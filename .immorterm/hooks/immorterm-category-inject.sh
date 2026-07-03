#!/bin/bash
# Owner: ImmorTerm Memory
# ImmorTerm Memory: Category Injection for Sub-Agents (SYNC - hookSpecificOutput)
# Event: SubagentStart
# Project: lonormaly-krispyai
#
# Maps sub-agent types to memory categories, fetches memories from ImmorTerm-Memory,
# and outputs JSON with hookSpecificOutput for the sub-agent.
#
# Uses the POST /api/v1/memories/search REST endpoint for semantic vector search.

IMMORTERM_MEMORY_URL="http://127.0.0.1:${IMMORTERM_MEMORY_PORT:-8765}"
USER_ID="${IMMORTERM_PROJECT_ID:-lonormaly-krispyai}"

# Read stdin JSON
STDIN_DATA=$(cat 2>/dev/null || echo '{}')

# Extract sub-agent type from stdin
AGENT_TYPE=$(echo "$STDIN_DATA" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    print(data.get('subagent_type', data.get('agent_type', '')))
except Exception:
    print('')
" 2>/dev/null)

# Map agent types to memory categories and a search query
case "$AGENT_TYPE" in
  frontend|ui|design|ui-ux-designer)
    CATEGORIES='["frontend","conventions","preferences"]'
    SEARCH_QUERY="frontend UI component design conventions and user preferences"
    ;;
  backend|api|server|database-optimizer)
    CATEGORIES='["backend","architecture","conventions"]'
    SEARCH_QUERY="backend API server architecture conventions and patterns"
    ;;
  security|audit)
    CATEGORIES='["security","architecture","backend"]'
    SEARCH_QUERY="security architecture authentication authorization patterns"
    ;;
  performance|optimization)
    CATEGORIES='["performance","architecture","backend"]'
    SEARCH_QUERY="performance optimization bottlenecks architecture"
    ;;
  architect|design|Plan)
    CATEGORIES='["architecture","conventions","preferences","plan"]'
    SEARCH_QUERY="architecture design decisions conventions preferences implementation plan"
    ;;
  analyzer|debug|troubleshoot)
    CATEGORIES='["architecture","backend","frontend"]'
    SEARCH_QUERY="architecture backend frontend debugging known issues"
    ;;
  Explore|general-purpose)
    CATEGORIES='["architecture","conventions","lessons_learned","decisions"]'
    SEARCH_QUERY="project architecture conventions decisions lessons learned recent changes"
    ;;
  product|projectmanager|sales-marketing)
    CATEGORIES='["decisions","preferences","architecture"]'
    SEARCH_QUERY="product decisions user preferences project management strategy"
    ;;
  algotrading)
    CATEGORIES='["architecture","backend","performance"]'
    SEARCH_QUERY="trading algorithms risk management technical analysis platform"
    ;;
  knowledge-digester)
    CATEGORIES='["conventions","architecture"]'
    SEARCH_QUERY="knowledge digestion pipeline conventions pack structure"
    ;;
  *)
    # Fallback: inject generic project context for any unrecognized agent type
    CATEGORIES='["architecture","conventions","decisions"]'
    SEARCH_QUERY="project architecture conventions recent decisions"
    ;;
esac

# Semantic search via REST endpoint (JSON built in Python to avoid injection)
SEARCH_RESULT=$(
  _IM_QUERY="$SEARCH_QUERY" \
  _IM_USER="$USER_ID" \
  _IM_CATS="$CATEGORIES" \
  python3 -c "
import os, json, subprocess
payload = json.dumps({
    'query': os.environ['_IM_QUERY'],
    'user_id': os.environ['_IM_USER'],
    'limit': 10,
    'categories': json.loads(os.environ['_IM_CATS']),
})
result = subprocess.run(
    ['curl', '-s', '--max-time', '3', '-X', 'POST',
     os.environ.get('IMMORTERM_MEMORY_URL', 'http://127.0.0.1:8765') + '/api/v1/memories/search',
     '-H', 'Content-Type: application/json', '-d', payload],
    capture_output=True, text=True, timeout=5,
    env={**os.environ},
)
print(result.stdout)
" 2>/dev/null || echo "")

# Format results into readable text
MEMORIES=$(echo "$SEARCH_RESULT" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    results = data.get('results', [])
    if not results:
        sys.exit(0)
    
    # Group by category
    by_cat = {}
    for r in results:
        cats = r.get('categories', [])
        cat = cats[0] if cats else 'other'
        text = r.get('memory', '')
        score = r.get('score', 0)
        if text and score > 0.1:
            by_cat.setdefault(cat, []).append(text)
    
    output = []
    total = 0
    for cat, entries in by_cat.items():
        output.append(f'### {cat} memories:')
        for text in entries[:3]:
            output.append(f'- {text[:200]}')
            total += 1
            if total >= 9:
                break
        if total >= 9:
            break
    
    if output:
        print('\n'.join(output))
except Exception:
    pass
" 2>/dev/null)

# If no memories found, exit silently
if [ -z "$MEMORIES" ]; then
  exit 0
fi

# Output as hookSpecificOutput with additionalContext (required for SubagentStart)
# Uses string concatenation instead of f-string to prevent injection from memory content
_IM_USER="$USER_ID" python3 -c "
import json, sys, os
memories = sys.stdin.read().strip()
context = '<immorterm-memory project=\"' + os.environ.get('_IM_USER', 'lonormaly-krispyai') + '\">' + '\n'
context += '## Project Context from Memory\n\n'
context += 'These memories are relevant to your task:\n'
context += memories + '\n\n'
context += 'Use search_memory for more context if needed.\n'
context += '</immorterm-memory>'
print(json.dumps({'hookSpecificOutput': {'hookEventName': 'SubagentStart', 'additionalContext': context}}))
" <<< "$MEMORIES" 2>/dev/null
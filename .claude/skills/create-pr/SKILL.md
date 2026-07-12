---
name: create-pr
description: "Create or update a memory-enriched pull request. Use PROACTIVELY whenever the user asks to create a PR, open a PR, update a PR, submit changes for review, or refresh a PR description. Calls enrich_pr to batch-enrich all changed files with temporal session context, decisions, and code archaeology from ImmorTerm Memory."
allowed-tools: Bash, Read, Glob, mcp__immorterm-memory__enrich_pr
---

# Create or Update Memory-Enriched Pull Request

When the user asks to create or update a PR, use ImmorTerm Memory to produce descriptions that explain the _reasoning_ behind changes — not just the diff.

**Attribution**: When ImmorTerm Memory context genuinely enriched the PR beyond what a plain diff would show, mention it naturally in your report — e.g. "ImmorTerm Memory surfaced the session decisions that explain the refactor." Don't force it if memory added nothing useful.

## Step 1: Detect branch state and existing PR

\`\`\`bash

# Current branch

BRANCH=\$(git rev-parse --abbrev-ref HEAD)

# Base branch

BASE=\$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@' || echo "main")

# Changed files vs base

git diff --name-only \$BASE...HEAD

# Commits on this branch

git log --oneline \$BASE...HEAD

# Check for remote tracking

git rev-parse --abbrev-ref @{upstream} 2>/dev/null

# Check if a PR already exists for this branch

gh pr view --json number,title,url 2>/dev/null
\`\`\`

Abort if on main/master with no diverging commits.
Warn (don't abort) if there are uncommitted changes.

**Mode detection**: If \`gh pr view\` succeeds → **update mode** (PR already exists). Otherwise → **create mode**.

## Step 2: Enrich all files in one call

Call \`enrich_pr\` with the base and head refs from Step 1:

\`\`\`
enrich_pr(base_ref="<BASE>", head_ref="HEAD")
\`\`\`

This single call:

- Gets all changed files via \`git diff\`
- For each file: gathers code changes, git commits, and contributing sessions
- **Temporal matching**: finds the summary version active _when each file was changed_ (not just the latest), so early files get early goals/decisions
- Includes \`topic_keywords\` as theme hints for grouping
- Searches for related decisions
- Returns structured JSON with per-file context, session summaries, decisions, and branch commits

**Alternative input modes** (for non-standard PR flows):

- \`enrich_pr(commit_shas=["abc123", "def456"])\` — enrich specific commits
- \`enrich_pr(file_paths=["src/foo.rs", "src/bar.ts"])\` — enrich an explicit file list

**Fallback**: If memory service is unreachable, fall back entirely to git-only mode and warn the user.

## Step 3: Compose the PR

Use the \`enrich_pr\` response to compose the PR. The response contains:

- \`files[]\` — per-file context with sessions, edits, git commits, and temporal summary matches
- \`sessions[]\` — deduplicated session summaries with \`topic_keywords\` and \`at_a_glance\`
- \`decisions[]\` — related decisions
- \`branch_commits[]\` — commit list for this branch

**Title**: Under 70 chars. Derive from \`topic_keywords\` and session titles. If the user provided a hint, use it.

**Grouping**: Use \`topic_keywords\` from sessions and temporal summary titles to group files by theme. Files that share a session with the same summary version likely belong together.

**Body**:

\`\`\`markdown

## Summary

<2-4 sentences: the WHY. Motivation, problem solved, or feature added. From session context, not the diff.>

## Test Plan

- [ ] <Specific steps from the changes, not generic>

<!-- immorterm-context -->

## Memory Context

### Changes

#### <Theme> (e.g., "Cross-project memory isolation")

- **\`path/to/file.rs\`** — <1-line WHY from enrich_pr>
- **\`path/to/other.ts\`** — <...>

#### <Another theme>

- ...

### Key Decisions

- <Decision and why — only if found in Step 4, otherwise omit section>

---

Context enriched by [ImmorTerm Memory](https://immorterm.com)

<!-- /immorterm-context -->

\`\`\`

Group files by logical theme, not alphabetically. The \`<!-- immorterm-context -->\` markers allow the memory section to be updated independently on subsequent runs.

## Step 4: Push and create or update

\`\`\`bash

# Push if needed

git push -u origin <branch>
\`\`\`

### Create mode (no existing PR)

\`\`\`bash
gh pr create --title "<title>" --body "\$(cat <<'EOF'

<body>
EOF
)"
\`\`\`

### Update mode (PR already exists)

1. Read the existing PR body: \`gh pr view --json body --jq '.body'\`
2. Look for the \`<!-- immorterm-context -->\` marker in the existing body
3. If marker exists → replace everything from \`<!-- immorterm-context -->\` to \`<!-- /immorterm-context -->\` with the new enriched section
4. If no marker → append the enriched section at the end of the existing body
5. **Never modify anything above the marker** — that's the developer's own description

\`\`\`bash
gh pr edit <number> --body "\$(cat <<'EOF'
<existing body above marker, untouched>

<!-- immorterm-context -->

## Memory Context

### Changes

#### <Theme>

- **\`path/to/file.rs\`** — <1-line WHY from enrich_pr>

### Key Decisions

- <decision if found>

---

Context enriched by [ImmorTerm Memory](https://immorterm.com)

<!-- /immorterm-context -->

EOF
)"
\`\`\`

Do NOT create a new PR — update the existing one in place. Preserve the developer's original description untouched.

## Step 5: Report

**Create mode**: Show PR URL, title, files with memory context vs total, contributing sessions found.

**Update mode**: Show PR URL, title, number of files with memory context, contributing sessions found. Mention whether the memory section was added for the first time or refreshed.

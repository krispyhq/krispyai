#!/usr/bin/env bash
# Headless deploy for the krispy public core. Shared by the Tilt deploy:* resources
# (DRY — Tilt calls this, it isn't a second copy) and by a human on the command line.
#
#   ./deploy.sh <edge|docs|widget> <preview|production>
#
# Every deploy: preflight (creds present) → build (if any) → wrangler deploy → smoke.
# Cloudflare creds come from the Infisical-fed .env.local (docs/secrets.md) — never
# hardcoded, never in GitHub. Deploy is Tilt + wrangler, NOT GitHub Actions.
set -euo pipefail
cd "$(dirname "$0")"

TARGET="${1:-}"
ENV="${2:-}"
MODE="${3:-}"
case "$TARGET" in edge | docs | widget) ;; *) echo "usage: ./deploy.sh <edge|docs|widget> <preview|production>" >&2; exit 2 ;; esac
case "$ENV" in preview | production) ;; *) echo "usage: ./deploy.sh <edge|docs|widget> <preview|production>" >&2; exit 2 ;; esac
if [ "$#" -gt 3 ] || { [ -n "$MODE" ] && { [ "$MODE" != --preserve-secrets ] || [ "$TARGET" != edge ]; }; }; then
  echo "Only Edge accepts the optional --preserve-secrets flag." >&2
  exit 2
fi

# Production ships TAGGED RELEASES only. `git describe --exact-match` succeeds
# only when HEAD is a `v*` tag, so a prod deploy is always a cut, changelog'd,
# released version — never a bare commit. Cut one first:
#   node scripts/release.mjs <x.y.z>        (see RELEASING.md)
# Break-glass for a genuine hotfix: ALLOW_UNTAGGED_DEPLOY=1 ./deploy.sh … production
if [ "$ENV" = production ]; then
  if [ "$TARGET" = edge ] && [ -n "$(git status --porcelain)" ]; then
    echo "✘ Edge production deploy requires a clean checkout, including untracked source." >&2
    exit 1
  fi
  TAG_ARGS=(--match 'v*')
  [ "$TARGET" = edge ] && TAG_ARGS+=(--match 'edge-v*')
  if REL_TAG="$(git describe --exact-match --tags "${TAG_ARGS[@]}" HEAD 2>/dev/null)"; then
    echo "→ releasing $REL_TAG to production"
  elif [ "$MODE" != --preserve-secrets ] && [ "${ALLOW_UNTAGGED_DEPLOY:-}" = 1 ]; then
    echo "⚠ ALLOW_UNTAGGED_DEPLOY=1 — shipping an UNTAGGED commit to production (break-glass)." >&2
  else
    echo "✘ production deploys ship a tagged release only — HEAD ($(git rev-parse --short HEAD)) is not a v* tag." >&2
    echo "  Cut one first: node scripts/release.mjs <x.y.z> [--target=edge] (see RELEASING.md)" >&2
    echo "  Emergency hotfix:  ALLOW_UNTAGGED_DEPLOY=1 ./deploy.sh $TARGET production" >&2
    exit 1
  fi
fi

# Source Infisical-fed creds. `set -a` exports every var so wrangler + child scripts see them.
set -a
if [ "$MODE" != --preserve-secrets ] && [ -f .env.local ]; then . .env.local; fi
set +a

BUN="${BUN:-bun}"

# 1) Preflight — assert CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID (blocks on missing).
if [ "$MODE" = --preserve-secrets ]; then
  node scripts/cf-deploy-preflight.mjs "$ENV" --env-only
  if [ "$ENV" = production ] && [ -z "${PUSH_TOKENS_SECRET:-}" ]; then
    echo "✘ PUSH_TOKENS_SECRET is required in the environment for the existing read-only push check." >&2
    exit 1
  fi
else
  node scripts/cf-deploy-preflight.mjs "$ENV"
fi

# The deployed base URL to smoke. Prod defaults to the krispyai.com custom domains
# (attached in the CF dashboard after first deploy — see AGENTS.md §11). Override any
# via .env.local: EDGE_PRODUCTION_URL / DOCS_PRODUCTION_URL / WIDGET_*_URL, etc.
# Preview has no default (workers.dev/pages.dev URL differs per account) — set it to smoke.
url_for() {
  local t="$1" e="$2" var
  var="$(echo "${t}_${e}_URL" | tr '[:lower:]' '[:upper:]')"
  if [ -n "${!var:-}" ]; then echo "${!var}"; return; fi
  [ "$e" = production ] && case "$t" in
    edge) echo "https://edge.krispyai.com" ;;
    docs) echo "https://docs.krispyai.com" ;;
    widget) echo "https://widget.krispyai.com" ;;
  esac
}

case "$TARGET" in
  edge)
    echo "→ deploy edge ($ENV)"
    if [ "$MODE" = --preserve-secrets ]; then
      # Existing Infisical-managed secrets stay in Cloudflare. Only deployment
      # credentials and the existing read-only push-check credential are supplied
      # by the caller; runtime values are never reasserted by this mode.
      ( cd services/edge && "$BUN" x wrangler deploy --env "$ENV" --keep-vars )
    else
      ( cd services/edge && "$BUN" x wrangler deploy --env "$ENV" )
    fi
    # Re-assert the Worker's secrets from the Infisical-fed .env.local on every deploy
    # (after deploy — the Worker must exist; before smoke — smoke tests WITH secrets).
    # A new bundle reading a secret the Worker never received fails closed silently;
    # syncing here means code + secrets can't drift apart.
    if [ "$MODE" != --preserve-secrets ]; then node scripts/sync-edge-secrets.mjs "$ENV"; fi
    if [ "$ENV" = production ]; then
      node scripts/check-hosted-push.mjs
    fi
    SMOKE_KIND=edge
    ;;
  docs)
    echo "→ deploy docs ($ENV)"
    if [ ! -f apps/docs/package.json ]; then
      echo "✘ apps/docs not present on this ref — cannot deploy docs." >&2; exit 1
    fi
    # apps/docs is a Fumadocs app that fully static-exports (`output: 'export'` →
    # `out/`). All routes are SSG and search is a build-time Orama index (static
    # client), so there's NO Node/edge runtime and NO next-on-pages — we just
    # `next build` and upload `out/` to CF Pages, exactly like the widget target.
    ( cd apps/docs && "$BUN" install --frozen-lockfile \
        && "$BUN" run build \
        && "$BUN" x wrangler pages deploy out \
             --project-name "krispy-docs-${ENV}" \
             --branch "$([ "$ENV" = production ] && echo master || echo preview)" )
    SMOKE_KIND=pages
    ;;
  widget)
    echo "→ deploy widget ($ENV)"
    # The widget is a static bundle (no build step) — deploy the dir as-is.
    # Preview always carries the pinned LiveKit browser UMD; an installed package
    # path is optional. Without one, the staging script fetches the exact public
    # npm release and verifies its bundle checksum before upload.
    if [ "$ENV" = preview ] || [ -n "${LIVEKIT_CLIENT_PACKAGE_DIR:-}${LIVEKIT_CLIENT_URL:-}" ]; then
      if [ -n "${LIVEKIT_CLIENT_PACKAGE_DIR:-}" ]; then
        node scripts/stage-livekit-client.mjs "$LIVEKIT_CLIENT_PACKAGE_DIR"
      else
        node scripts/stage-livekit-client.mjs
      fi
    fi
    "$BUN" x wrangler pages deploy packages/widget \
      --project-name "krispy-widget-${ENV}" --branch "$([ "$ENV" = production ] && echo master || echo preview)"
    SMOKE_KIND=pages
    ;;
esac

# 3) Smoke — curl the live URL if we know it. Skipped (with a warning) when unset,
# so a first deploy before you've recorded the URL doesn't hard-fail.
SMOKE_URL="$(url_for "$TARGET" "$ENV")"
if [ -n "$SMOKE_URL" ]; then
  node scripts/cf-deploy-smoke.mjs "$SMOKE_KIND" "$SMOKE_URL"
else
  echo "⚠ smoke skipped — set $(echo "${TARGET}_${ENV}_URL" | tr '[:lower:]' '[:upper:]') in .env.local to enable the post-deploy check."
fi

echo "✔ deploy done: $TARGET ($ENV)"

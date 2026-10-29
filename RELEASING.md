# Releasing

Krispy's public core is **versioned** (semver, pre-1.0: features → minor, fixes →
patch) and **released as git tags + GitHub Releases**. Production deploys ship
tagged releases only — the discipline is enforced, not a convention.

## Cut a release

From a clean `master`:

```bash
node scripts/release.mjs <x.y.z>        # e.g. 0.2.0
node scripts/release.mjs <x.y.z> --dry-run   # preview, writes nothing
```

The script, in one step:

1. Guards: on `master`, no uncommitted **tracked** changes, tag doesn't exist, and
   `CHANGELOG.md [Unreleased]` is non-empty (there's something to release).
2. Promotes `## [Unreleased]` → `## [x.y.z] — <date>` and leaves a fresh empty
   `[Unreleased]` on top (Keep a Changelog).
3. Bumps `version` in `package.json` + `packages/cli/package.json` (the widget is a
   bare dependency-free `widget.js` — its version is the repo tag).
4. Commits `chore(release): vx.y.z`, tags `vx.y.z`, pushes both.
5. Opens the GitHub Release with the changelog section as its notes.

## Edge-only release

To release the Edge Worker without publishing the CLI, use:

```sh
node scripts/release.mjs <x.y.z> --target=edge --dry-run
node scripts/release.mjs <x.y.z> --target=edge
./deploy.sh edge production --preserve-secrets
```

This creates an annotated `edge-v<x.y.z>` tag on the exact clean, published
`master` commit after its complete push CI workflow succeeds, then creates a
GitHub Release with the source SHA and a snapshot of the `[Unreleased]` notes.
It does not change manifests, create a metadata commit, consume `[Unreleased]`,
or publish npm packages. The existing CLI publisher only matches `v*`; its
permissions and checks are unchanged. Existing full releases retain their flow.
Edge tags are accepted only for Edge deployment, never docs or widget deployment.

`--preserve-secrets` requires a clean checkout and an exact release tag; it cannot
use the untagged emergency override. It reads no `.env.local` and does not run the
secret-sync writer. Supply existing Infisical production deployment credentials
and `PUSH_TOKENS_SECRET` in memory for the unchanged read-only push check.
Wrangler uses `--keep-vars`; secrets are retained from the previous Worker.
This flag is not a proof that all config/bindings match: before upload, compare
Wrangler's named environment with a fresh live binding/settings receipt, including
KV, DO classes/namespaces, R2, vars, compatibility flags and routes/exposure. Stop
on drift. Record the active version for rollback, then verify deployed code and
all preserved settings before tenant-policy activation or bounded live tests.
Never print secret values, change Infisical sync ownership, or substitute another
credential when access is denied.

## Ship it

```bash
./deploy.sh <edge|widget|docs> production
```

Production **refuses to deploy a commit that isn't a `v*` tag**:

```
✘ production deploys ship a tagged release only — HEAD (abc1234) is not a v* tag.
  Cut one first:  node scripts/release.mjs <x.y.z>
```

Break-glass for a genuine hotfix (documented, not the norm):

```bash
ALLOW_UNTAGGED_DEPLOY=1 ./deploy.sh edge production
```

## The rule

- **Every behavior/API/config/CLI change** adds a `[Unreleased]` CHANGELOG entry in
  its own PR (AGENTS.md §7 — Documentation sync). The release just promotes them.
- **`master` is always releasable.** Tag when you're ready to ship; deploy the tag.
- Preview deploys are unrestricted — the gate is production-only.

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

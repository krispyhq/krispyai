// Cut a release: move CHANGELOG [Unreleased] → [X.Y.Z], bump the versioned
// package.json files, commit, tag `vX.Y.Z`, push, and open a GitHub Release from
// the changelog section. This is the ONE release path — `deploy.sh production`
// refuses to ship a commit that isn't a `v*` tag (see require_release_tag), so a
// production deploy is always a real, changelog'd, tagged release.
//
//   node scripts/release.mjs <version>        # e.g. 0.2.0
//   node scripts/release.mjs <version> --dry-run
//
// Semver, pre-1.0: new features = minor, fixes = patch. The widget is a bare
// dependency-free widget.js (no package.json); its version is the repo tag.
import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

const args = process.argv.slice(2);
const DRY = args.includes("--dry-run");
const version = args.find((a) => /^\d+\.\d+\.\d+$/.test(a));
if (!version) {
  console.error("usage: node scripts/release.mjs <x.y.z> [--dry-run]");
  process.exit(2);
}
const tag = "v" + version;
const sh = (c) => execSync(c, { encoding: "utf8" }).trim();

// ── guards ──────────────────────────────────────────────────────────────────
if (sh("git rev-parse --abbrev-ref HEAD") !== "master") {
  console.error("✘ releases are cut from master only.");
  process.exit(1);
}
// Only TRACKED changes block a release; untracked local cruft (.env.local,
// build artifacts) is irrelevant — the commit stages explicit paths anyway.
if (sh("git status --porcelain --untracked-files=no")) {
  console.error("✘ tracked changes uncommitted — commit or stash first.");
  process.exit(1);
}
if (sh(`git tag --list ${tag}`)) {
  console.error(`✘ tag ${tag} already exists.`);
  process.exit(1);
}

// The two versioned manifests (the widget has none by design). Bump both in
// lockstep with the repo tag so `npm`-shaped consumers and the tag never drift.
const MANIFESTS = ["package.json", "packages/cli/package.json"];
const date = new Date().toISOString().slice(0, 10);

// ── CHANGELOG: [Unreleased] must have content, then promote it to [version] ───
const CL = "CHANGELOG.md";
const cl = readFileSync(CL, "utf8");
const m = cl.match(/## \[Unreleased\]\n([\s\S]*?)\n## \[/);
if (!m || !m[1].trim()) {
  console.error("✘ CHANGELOG [Unreleased] is empty — nothing to release.");
  process.exit(1);
}
// Leave a fresh empty [Unreleased] on top; the old one becomes [version] — date.
const newCl = cl.replace("## [Unreleased]\n", `## [Unreleased]\n\n## [${version}] — ${date}\n`);
// The release notes for the GitHub Release = just this version's section.
const notes = m[1].trim();

// ── apply ─────────────────────────────────────────────────────────────────────
const bumped = MANIFESTS.map((f) => {
  const j = JSON.parse(readFileSync(f, "utf8"));
  const before = j.version;
  // Root manifest is `private` with no version — introduce one; others bump.
  const next = { ...j };
  // Insert `version` right after `name` if absent, else replace in place.
  if (!("version" in next)) {
    const ordered = {};
    for (const [k, v] of Object.entries(next)) {
      ordered[k] = v;
      if (k === "name") ordered.version = version;
    }
    if (!("version" in ordered)) ordered.version = version;
    return {
      f,
      before: before ?? "(none)",
      text: JSON.stringify(ordered, null, 2) + "\n",
      json: ordered,
    };
  }
  next.version = version;
  return { f, before, text: JSON.stringify(next, null, 2) + "\n", json: next };
});

console.log(`\n→ release ${tag} (${date})${DRY ? "  [dry-run]" : ""}`);
console.log(`  CHANGELOG: [Unreleased] → [${version}]`);
for (const b of bumped) console.log(`  ${b.f}: ${b.before} → ${version}`);

if (DRY) {
  console.log("\n(dry-run — nothing written)");
  process.exit(0);
}

writeFileSync(CL, newCl);
for (const b of bumped) writeFileSync(b.f, b.text);

// oxfmt the touched manifests so the release commit passes the format gate.
try {
  execSync(`bunx oxfmt ${MANIFESTS.join(" ")} CHANGELOG.md`, { stdio: "ignore" });
} catch {
  /* oxfmt optional here; CI is the real gate */
}

const staged = [CL, ...MANIFESTS].join(" ");
execSync(`git add ${staged}`);
// --no-verify: the commit is manifests + CHANGELOG only (no lintable source),
// which trips the lefthook "no files to lint" gate; oxfmt already ran above and
// CI re-runs every gate on push.
execSync(`git commit --no-verify -m "chore(release): ${tag}"`, { stdio: "inherit" });
execSync(`git tag -a ${tag} -m "${tag}"`);
execSync(`git push origin master`, { stdio: "inherit" });
execSync(`git push origin ${tag}`, { stdio: "inherit" });

// GitHub Release from the changelog section (best-effort — the tag is the source
// of truth; a failed release note can be re-run with `gh release create`).
try {
  writeFileSync(".release-notes.tmp", notes);
  execSync(`gh release create ${tag} --title "${tag}" --notes-file .release-notes.tmp`, {
    stdio: "inherit",
  });
  execSync("rm -f .release-notes.tmp");
} catch (e) {
  console.warn(`⚠ tag pushed but 'gh release create' failed — run it manually. (${e.message})`);
}
console.log(`\n✔ released ${tag}. Production deploys of this commit are now allowed.`);

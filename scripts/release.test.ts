import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const roots: string[] = [];
const source = resolve(import.meta.dir, "..");
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "krispy-release-test-"));
  roots.push(dir);
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    ALLOW_UNTAGGED_DEPLOY: "",
    CLOUDFLARE_API_TOKEN: "",
    CLOUDFLARE_ACCOUNT_ID: "",
    PUSH_TOKENS_SECRET: "",
  };
  function run(args: string[], extra: Record<string, string> = {}) {
    return spawnSync(args[0], args.slice(1), {
      cwd: dir,
      env: { ...env, ...extra },
      encoding: "utf8",
    });
  }
  function git(...args: string[]) {
    const r = run(["git", ...args]);
    if (r.status !== 0) throw Error(r.stderr);
    return r.stdout.trim();
  }
  mkdirSync(join(dir, "scripts"));
  for (const f of ["scripts/release.mjs", "scripts/cf-deploy-preflight.mjs", "deploy.sh"])
    copyFileSync(join(source, f), join(dir, f));
  writeFileSync(
    join(dir, "CHANGELOG.md"),
    "## [Unreleased]\n\n### Fixed\n\n- Tested fix.\n\n## [0.0.0]\n",
  );
  writeFileSync(join(dir, ".gitignore"), ".env.local\n");
  git("init", "-b", "master");
  git("config", "user.name", "Release test");
  git("config", "user.email", "test@example.invalid");
  git(
    "add",
    "scripts/release.mjs",
    "scripts/cf-deploy-preflight.mjs",
    "deploy.sh",
    "CHANGELOG.md",
    ".gitignore",
  );
  git("commit", "-m", "test fixture");
  return { dir, run, git };
}
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("Edge release dry run creates no tag, commit or manifest changes", () => {
  const f = fixture(),
    before = f.git("rev-parse", "HEAD"),
    text = readFileSync(join(f.dir, "CHANGELOG.md"), "utf8");
  const r = f.run(["node", "scripts/release.mjs", "0.5.0", "--target=edge", "--dry-run"]);
  expect(r.status).toBe(0);
  expect(r.stdout).toContain("edge-v0.5.0");
  expect(f.git("tag", "--list")).toBe("");
  expect(f.git("rev-parse", "HEAD")).toBe(before);
  expect(readFileSync(join(f.dir, "CHANGELOG.md"), "utf8")).toBe(text);
  expect(f.git("status", "--porcelain")).toBe("");
});
test("unknown release target cannot fall through to CLI publication", () => {
  const f = fixture();
  expect(f.run(["node", "scripts/release.mjs", "0.5.0", "--target=edeg"]).status).toBe(2);
  expect(f.git("tag", "--list")).toBe("");
});
test("Edge release rejects dirty source and non-master branches", () => {
  const f = fixture();
  writeFileSync(join(f.dir, "new-source.ts"), "export {};\n");
  expect(
    f.run(["node", "scripts/release.mjs", "0.5.0", "--target=edge", "--dry-run"]).status,
  ).not.toBe(0);
  rmSync(join(f.dir, "new-source.ts"));
  f.git("switch", "-c", "feature");
  expect(
    f.run(["node", "scripts/release.mjs", "0.5.0", "--target=edge", "--dry-run"]).status,
  ).not.toBe(0);
});
test("Edge-only tag reaches credential preflight only for Edge", () => {
  const f = fixture();
  f.git("tag", "-a", "edge-v0.5.0", "-m", "test");
  const edge = f.run(["bash", "deploy.sh", "edge", "production", "--preserve-secrets"]);
  expect(edge.status).toBe(1);
  expect(edge.stderr).toContain("PREFLIGHT FAILED");
  for (const target of ["docs", "widget"]) {
    const r = f.run(["bash", "deploy.sh", target, "production"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("not a v* tag");
  }
});
test("preserve mode cannot use the untagged escape or an older tag", () => {
  const f = fixture();
  f.git("tag", "edge-v0.5.0");
  writeFileSync(join(f.dir, "CHANGELOG.md"), "changed\n");
  f.git("commit", "-am", "later");
  const r = f.run(["bash", "deploy.sh", "edge", "production", "--preserve-secrets"], {
    ALLOW_UNTAGGED_DEPLOY: "1",
  });
  expect(r.status).toBe(1);
  expect(r.stderr).toContain("not a v* tag");
  expect(r.stderr).not.toContain("PREFLIGHT FAILED");
});
test("tag does not authorize dirty or untracked production code", () => {
  const f = fixture();
  f.git("tag", "edge-v0.5.0");
  writeFileSync(join(f.dir, "new-source.ts"), "export {};\n");
  const r = f.run(["bash", "deploy.sh", "edge", "production", "--preserve-secrets"]);
  expect(r.status).toBe(1);
  expect(r.stderr).toContain("clean checkout");
});
test("preserve mode does not source local secrets and requires push check before upload", () => {
  const f = fixture();
  f.git("tag", "edge-v0.5.0");
  writeFileSync(
    join(f.dir, ".env.local"),
    "echo UNEXPECTED_ENV_READ; exit 77\nCLOUDFLARE_API_TOKEN=fixture\nCLOUDFLARE_ACCOUNT_ID=fixture\n",
  );
  const absent = f.run(["bash", "deploy.sh", "edge", "production", "--preserve-secrets"]);
  expect(absent.status).toBe(1);
  expect(absent.stderr).toContain("PREFLIGHT FAILED");
  expect(absent.stdout).not.toContain("UNEXPECTED_ENV_READ");
  const r = f.run(["bash", "deploy.sh", "edge", "production", "--preserve-secrets"], {
    CLOUDFLARE_API_TOKEN: "fixture",
    CLOUDFLARE_ACCOUNT_ID: "fixture",
  });
  expect(r.status).toBe(1);
  expect(r.stderr).toContain("PUSH_TOKENS_SECRET is required");
  expect(r.stdout).not.toContain("deploy edge");
});
test("unknown deploy option and preserve mode for other targets fail closed", () => {
  const f = fixture();
  for (const args of [
    ["edge", "production", "--skip-secrets"],
    ["docs", "production", "--preserve-secrets"],
  ])
    expect(f.run(["bash", "deploy.sh", ...args]).status).toBe(2);
});
test("CLI workflow trigger does not match the Edge tag namespace", () => {
  const text = readFileSync(join(source, ".github/workflows/publish.yml"), "utf8");
  expect(text).toContain('- "v*"');
  expect(text).not.toContain("edge-v");
  expect("edge-v0.5.0".startsWith("v")).toBe(false);
});

for (const success of [false, true]) {
  test(`Edge publication requires exact successful CI: ${success}`, () => {
    const f = fixture();
    const remote = mkdtempSync(join(tmpdir(), "krispy-release-remote-"));
    roots.push(remote);
    const tools = mkdtempSync(join(tmpdir(), "krispy-release-tools-"));
    roots.push(tools);
    f.git("init", "--bare", remote);
    f.git("remote", "add", "origin", remote);
    f.git("push", "origin", "master");
    const head = f.git("rev-parse", "HEAD"),
      log = join(tools, "calls.jsonl");
    writeFileSync(
      join(tools, "gh"),
      `#!/usr/bin/env node
const fs=require("node:fs"); const a=process.argv.slice(2);
if(a[0]==="run")console.log(JSON.stringify([{headSha:process.env.TEST_RELEASE_HEAD,status:"completed",conclusion:process.env.TEST_RELEASE_CONCLUSION}]));
else if(a[0]==="release")fs.appendFileSync(process.env.TEST_RELEASE_LOG,JSON.stringify(a)+"\\n");
else process.exit(2);
`,
      { mode: 0o755 },
    );
    if (success) f.git("switch", "--detach", head);
    const r = f.run(["node", "scripts/release.mjs", "0.5.0", "--target=edge"], {
      PATH: tools + ":" + process.env.PATH,
      TEST_RELEASE_HEAD: head,
      TEST_RELEASE_CONCLUSION: success ? "success" : "failure",
      TEST_RELEASE_LOG: log,
    });
    if (!success) {
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain("complete CI workflow");
      expect(f.git("tag", "--list")).toBe("");
    } else {
      expect(r.status).toBe(0);
      expect(f.git("rev-parse", "edge-v0.5.0^{}")).toBe(head);
      expect(f.git("ls-remote", "origin", "refs/tags/edge-v0.5.0")).toContain(
        "refs/tags/edge-v0.5.0",
      );
      expect(readFileSync(log, "utf8")).toContain("--verify-tag");
      expect(f.git("status", "--porcelain")).toBe("");
    }
  });
}

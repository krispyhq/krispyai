#!/usr/bin/env node
// The project entry point for new agent worktrees. WT0 owns the checkout and
// dependency preparation; this script refuses an incomplete runtime on 0.1.19,
// before `wt0 run --require-ready` is available in a released version.
import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptCheckout = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const common = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
  cwd: scriptCheckout,
  encoding: "utf8",
});
const commonPath = resolve(scriptCheckout, common.stdout.trim());
if (common.status !== 0 || basename(commonPath) !== ".git")
  throw new Error("Agent workflow requires a linked checkout of a non-bare Git repository");
const repo = dirname(realpathSync(commonPath));
const branchBase = "origin/master";

function command(program, args, cwd = repo, timeout = 120_000) {
  const result = spawnSync(program, args, {
    cwd,
    encoding: "utf8",
    timeout,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`${program} ${args[0] ?? ""} failed (exit ${result.status ?? "unknown"})`);
  }
  return result.stdout;
}

function wt0Json(args, timeout) {
  return JSON.parse(command("wt0", [...args, "--json"], repo, timeout));
}

export function readinessDecision(report) {
  if (!report || typeof report !== "object") return { ready: false, source: "invalid" };
  if (typeof report.automation_ready === "boolean") {
    return { ready: report.automation_ready, source: "automation_ready" };
  }
  const ready =
    report.ready === true &&
    report.dependency_ready === true &&
    report.promise?.verdict === "holds" &&
    Array.isArray(report.promise.shortfalls) &&
    report.promise.shortfalls.length === 0;
  return { ready, source: "0.1.19 doctor fallback" };
}

export function safeDestination(root, destination) {
  if (!isAbsolute(destination)) return false;
  const path = resolve(destination);
  const inside = relative(root, path);
  if (!inside || !inside.startsWith(`..${sep}`)) return false;
  return !path.split(sep).includes("node_modules");
}

export function assertReusableDestination(fleet, destination, branch, owner) {
  const item = fleet?.runtimes?.find((runtime) => runtime.worktree === destination);
  if (!item?.managed || item.is_main || item.branch !== branch || item.owner !== owner)
    throw new Error("Existing path is not this task's WT0-managed checkout; refusing to touch it");
}

export function cleanupAssessment(report, worktree) {
  if (report?.mode !== "dry-run" || !Array.isArray(report.reaped) || !Array.isArray(report.skipped))
    throw new Error("WT0 did not return a dry-run assessment");
  if (report.adopted_for_removal?.length) throw new Error("Unmanaged checkout entered assessment");
  const eligible = report.reaped.includes(worktree);
  const skipped = report.skipped.find((item) => item.worktree === worktree);
  if (!eligible && !skipped) throw new Error("WT0 did not assess the selected checkout");
  return { cleanupEligible: eligible, reason: skipped?.reason ?? null };
}

function destinationFor(branch) {
  const root = process.env.WT0_WORKTREES_DIR
    ? resolve(process.env.WT0_WORKTREES_DIR)
    : join(dirname(repo), `${basename(repo)}-worktrees`);
  const slug = branch.replace(/[^A-Za-z0-9._-]+/g, "-");
  const hash = createHash("sha256").update(branch).digest("hex").slice(0, 8);
  return join(root, `${slug}-${hash}`);
}

function start(taskId, branch, owner) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{1,127}$/.test(taskId))
    throw new Error("Pass a stable task ID for idempotent creation");
  if (!owner || !/^[A-Za-z0-9][A-Za-z0-9._:-]{1,127}$/.test(owner))
    throw new Error("Set WT0_OWNER to the agent or session ID");
  command("git", ["check-ref-format", "--branch", branch]);
  if (process.env.WT0_WORKTREE_PATH && !isAbsolute(process.env.WT0_WORKTREE_PATH))
    throw new Error("WT0_WORKTREE_PATH must be absolute");
  const destination = process.env.WT0_WORKTREE_PATH
    ? resolve(process.env.WT0_WORKTREE_PATH)
    : destinationFor(branch);
  if (!safeDestination(repo, destination))
    throw new Error("Agent worktree must be outside the repo and node_modules");
  // A retry keeps the exact checkout, even when the network is unavailable.
  if (existsSync(destination)) {
    assertReusableDestination(wt0Json(["fleet"]), destination, branch, owner);
  } else {
    command("git", ["fetch", "--quiet", "origin", "master"], repo, 60_000);
  }
  let receipt;
  try {
    receipt = wt0Json([
      "create",
      branch,
      "--path",
      destination,
      "--base",
      branchBase,
      "--require-cow",
      "--ephemeral",
      "--require-free",
      process.env.WT0_REQUIRE_FREE || "20G",
      "--owner",
      owner,
      "--idempotency-key",
      taskId,
    ]);
    if (
      receipt.worktree !== destination ||
      receipt.branch !== branch ||
      receipt.owner !== owner ||
      receipt.mode !== "cow-clone"
    )
      throw new Error("WT0 returned a different worktree identity");
    // A retried create may return a dirty but already prepared checkout. Do not
    // run prepare over the agent's edits; doctor first, prepare only if needed.
    const inspect = () => {
      const result = spawnSync("wt0", ["doctor", destination, "--json"], {
        cwd: repo,
        encoding: "utf8",
        timeout: 120_000,
        maxBuffer: 4 * 1024 * 1024,
      });
      return { status: result.status, report: JSON.parse(result.stdout || "null") };
    };
    let doctor = inspect();
    if (doctor.report?.dependency_ready !== true) {
      wt0Json(["prepare", destination, "--apply"], 300_000);
      doctor = inspect();
    }
    // Doctor can exit nonzero while still returning actionable JSON. Keep the
    // checkout either way; never launch an agent from a refused runtime.
    const report = doctor.report;
    const decision = readinessDecision(report);
    const result = {
      ready: decision.ready,
      source: decision.source,
      worktree: destination,
      branch,
      owner,
      runtimeId: receipt.runtime_id,
      mode: receipt.mode,
      shortfalls: report?.promise?.shortfalls ?? [],
      steps: decision.ready ? [] : (report?.steps ?? []),
    };
    console.log(JSON.stringify(result));
    if (!decision.ready || doctor.status !== 0) process.exitCode = 2;
  } catch (error) {
    // A failed source checkout is deliberately retained for repair/retry.
    console.log(
      JSON.stringify({
        ready: false,
        worktree: receipt?.worktree ?? (existsSync(destination) ? destination : null),
        blocker: error instanceof Error ? error.message : "Unknown WT0 failure",
      }),
    );
    process.exitCode = 2;
  }
}

function assess(inputPath) {
  if (!inputPath || !isAbsolute(inputPath) || !existsSync(inputPath))
    throw new Error("Pass the existing absolute WT0 worktree path");
  const worktree = realpathSync(inputPath);
  // Otherwise WT0 correctly reports this wrapper's own cwd as a live blocker.
  process.chdir(repo);
  const fleet = wt0Json(["fleet"]);
  const item = fleet.runtimes?.find((runtime) => runtime.worktree === worktree);
  if (!item?.managed || item.is_main || !item.owner || !item.branch)
    throw new Error("Refusing to assess an unmanaged or main checkout");
  const report = wt0Json(
    ["gc", "--branch", item.branch, "--owner", item.owner, "--idle", "0s"],
    120_000,
  );
  console.log(
    JSON.stringify({
      worktree,
      branch: item.branch,
      owner: item.owner,
      mode: report.mode,
      ...cleanupAssessment(report, worktree),
      taskAccepted: "verify PR, tests, and user acceptance separately",
    }),
  );
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [action, ...args] = process.argv.slice(2);
    if (action === "start" && args.length === 2) start(args[0], args[1], process.env.WT0_OWNER);
    else if (action === "assess" && args.length === 1) assess(args[0]);
    else
      throw new Error(
        "usage: agent-worktree.mjs start <task-id> <branch> | assess <absolute-worktree-path>",
      );
  } catch (error) {
    console.error(error instanceof Error ? error.message : "WT0 workflow failed");
    process.exitCode = 2;
  }
}

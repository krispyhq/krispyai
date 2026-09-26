import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertReusableDestination,
  cleanupAssessment,
  readinessDecision,
  safeDestination,
} from "./agent-worktree.mjs";

const complete = {
  ready: true,
  dependency_ready: true,
  promise: { verdict: "holds", shortfalls: [] },
};

void test("released WT0 automation verdict takes precedence over old doctor fields", () => {
  assert.deepEqual(readinessDecision({ ...complete, automation_ready: false }), {
    ready: false,
    source: "automation_ready",
  });
  assert.deepEqual(readinessDecision({ ...complete, automation_ready: true }), {
    ready: true,
    source: "automation_ready",
  });
});

void test("0.1.19 fallback requires dependencies and the complete thin-runtime promise", () => {
  assert.deepEqual(readinessDecision(complete), {
    ready: true,
    source: "0.1.19 doctor fallback",
  });
  assert.equal(readinessDecision({ ...complete, dependency_ready: false }).ready, false);
  assert.equal(
    readinessDecision({ ...complete, promise: { verdict: "partial", shortfalls: ["policy"] } })
      .ready,
    false,
  );
  assert.equal(readinessDecision({ ready: true, dependency_ready: true }).ready, false);
});

void test("agent destinations must be outside the repo and every node_modules tree", () => {
  const root = "/tmp/krispyai";
  assert.equal(safeDestination(root, "/tmp/krispyai-worktrees/task-a"), true);
  assert.equal(safeDestination(root, "/tmp/krispyai/.claude/worktrees/task-a"), false);
  assert.equal(safeDestination(root, "/tmp/krispyai/node_modules/task-a"), false);
  assert.equal(safeDestination(root, "/tmp/node_modules/task-a"), false);
  assert.equal(safeDestination(root, "/tmp"), false);
  assert.equal(safeDestination(root, "relative/task-a"), false);
});

void test("an existing path is reusable only for the exact WT0-managed task owner", () => {
  const path = "/tmp/krispyai-worktrees/task-a";
  const item = {
    worktree: path,
    managed: true,
    is_main: false,
    branch: "agent/task-a",
    owner: "session-a",
  };
  assert.doesNotThrow(() =>
    assertReusableDestination({ runtimes: [item] }, path, "agent/task-a", "session-a"),
  );
  assert.throws(
    () =>
      assertReusableDestination(
        { runtimes: [{ ...item, managed: false }] },
        path,
        "agent/task-a",
        "session-a",
      ),
    /refusing/,
  );
  assert.throws(
    () => assertReusableDestination({ runtimes: [item] }, path, "agent/task-a", "session-b"),
    /refusing/,
  );
  assert.throws(
    () => assertReusableDestination({ runtimes: [item] }, path, "agent/task-b", "session-a"),
    /refusing/,
  );
});

void test("completion only interprets a scoped WT0 dry run", () => {
  const path = "/tmp/krispyai-worktrees/task-a";
  assert.deepEqual(
    cleanupAssessment(
      { mode: "dry-run", reaped: [], skipped: [{ worktree: path, reason: "dirty" }] },
      path,
    ),
    { cleanupEligible: false, reason: "dirty" },
  );
  assert.deepEqual(cleanupAssessment({ mode: "dry-run", reaped: [path], skipped: [] }, path), {
    cleanupEligible: true,
    reason: null,
  });
  assert.throws(
    () => cleanupAssessment({ mode: "apply", reaped: [path], skipped: [] }, path),
    /dry-run/,
  );
  assert.throws(
    () =>
      cleanupAssessment(
        { mode: "dry-run", reaped: [], skipped: [], adopted_for_removal: [path] },
        path,
      ),
    /Unmanaged/,
  );
});

import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";

import { batch } from "solid-js";

import type { Commit } from "@/git/log";
import { state } from "@/state";

import { createFixtureRepo, loadModel, loadWorktrees, runGit, seedState } from "./helpers";

const commit = (n: number, subject: string): Commit => ({
  author: "Jimmy",
  authorTime: 1_700_000_000 - n,
  parent: `p${n}`,
  sha: `sha${n}`,
  shortSha: `sha${n}`,
  subject,
});

// Newest-first: index 0 is the newest, higher index is older.
const three = [commit(0, "newest"), commit(1, "middle"), commit(2, "oldest")];

afterEach(() => {
  batch(() => {
    state.setCommits([]);
    state.setScope({ kind: "all", ref: "HEAD" });
  });
});

test("selectCommit pins a range scope of the commit's parent against its sha", () => {
  state.setCommits(three);
  state.selectCommit(1);

  expect(state.scope()).toEqual({ headRef: "sha1", kind: "commit", ref: "p1" });
});

test("commitScopeLabel is the active commit's subject", () => {
  state.setCommits(three);
  state.selectCommit(0);
  expect(state.commitScopeLabel()).toBe("newest");
});

test("commitScopeLabel follows the pinned commit even after it ages out of the list", () => {
  state.setCommits(three);
  state.selectCommit(1); // Pin the "middle" commit (sha1).

  // Enough new commits land that the reloaded window no longer contains the pinned
  // Commit at all (it fell past LOG_LIMIT). The label must still name it, not degrade.
  state.setCommits([{ ...commit(0, "brand new"), sha: "shaNEW" }]);

  expect(state.commitScopeLabel()).toBe("middle");
});

test("selecting out of range is a no-op", () => {
  state.setCommits(three);
  state.selectCommit(9);
  expect(state.scope()).toEqual({ kind: "all", ref: "HEAD" });
});

// The rebaselineScope commit branch is reached only through switchWorktree (the
// Helper isn't exported and shouldn't be exposed just to test it). A .txt-only
// Fixture keeps runChecks from spawning an LSP server into the shared runtime.
test("switching worktrees while viewing a commit resets the scope to all", async () => {
  const repoRoot = createFixtureRepo("sideye-commit-rebaseline-", { "notes.txt": "one\n" });
  const linkedRoot = join(repoRoot, ".wt");
  runGit(repoRoot, ["worktree", "add", "-b", "side-branch", linkedRoot]);

  const model = await loadModel(repoRoot, { kind: "all", ref: "HEAD" });
  seedState(model, { kind: "all", ref: "HEAD" });

  // Pin a commit scope, as selecting a commit does. Its SHA has no meaning in the
  // Target worktree, so the switch must fall back to the all scope.
  state.setScope({ headRef: "deadbeef", kind: "commit", ref: "cafebabe" });

  const worktrees = await loadWorktrees(repoRoot);
  const linked = worktrees.find((worktree) => worktree.branch === "side-branch");
  if (linked === undefined) {
    throw new Error("linked worktree missing");
  }

  await state.switchWorktree(linked);

  // Without the commit branch, rebaselineScope would fall through and leave the
  // Scope as `commit`; resetting to `all` proves the branch ran.
  expect(state.scope()).toEqual({ kind: "all", ref: "HEAD" });
});

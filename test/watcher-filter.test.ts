import { expect, test } from "bun:test";
import { sep } from "node:path";

import { shouldRefresh } from "@/watcher/filter";

const WORKTREE = `.git${sep}`;
const GIT_DIR = "";

const g = (...parts: string[]) => parts.join(sep);

test("worktree root drops high-churn git internals", () => {
  expect(shouldRefresh(WORKTREE, g(".git", "objects", "ab", "cdef"))).toBe(false);
  expect(shouldRefresh(WORKTREE, g(".git", "logs", "HEAD"))).toBe(false);
  expect(shouldRefresh(WORKTREE, g(".git", "rebase-merge", "done"))).toBe(false);
  expect(shouldRefresh(WORKTREE, g(".git", "index.lock"))).toBe(false);
  expect(shouldRefresh(WORKTREE, g(".git", "HEAD.lock"))).toBe(false);
  expect(shouldRefresh(WORKTREE, g(".git", "packed-refs.lock"))).toBe(false);
  expect(shouldRefresh(WORKTREE, g(".git", "COMMIT_EDITMSG"))).toBe(false);
  expect(shouldRefresh(WORKTREE, g(".git", "FETCH_HEAD"))).toBe(false);
});

test("worktree root keeps meaningful git state changes", () => {
  expect(shouldRefresh(WORKTREE, g(".git", "HEAD"))).toBe(true);
  expect(shouldRefresh(WORKTREE, g(".git", "index"))).toBe(true);
  expect(shouldRefresh(WORKTREE, g(".git", "refs", "heads", "main"))).toBe(true);
  expect(shouldRefresh(WORKTREE, g(".git", "packed-refs"))).toBe(true);
  expect(shouldRefresh(WORKTREE, g(".git", "ORIG_HEAD"))).toBe(true);
  expect(shouldRefresh(WORKTREE, g(".git", "MERGE_HEAD"))).toBe(true);
});

test("worktree root keeps working-tree edits, incl. lookalikes outside .git/", () => {
  expect(shouldRefresh(WORKTREE, g("src", "foo.ts"))).toBe(true);
  expect(shouldRefresh(WORKTREE, ".gitignore")).toBe(true);
  expect(shouldRefresh(WORKTREE, g(".github", "workflows", "ci.yml"))).toBe(true);
});

test("a missing filename ticks (unclassifiable fails open)", () => {
  expect(shouldRefresh(WORKTREE, null)).toBe(true);
  expect(shouldRefresh(GIT_DIR, null)).toBe(true);
  // Linux inotify passes undefined, not null, for nameless events.
  expect(shouldRefresh(WORKTREE, undefined)).toBe(true);
  expect(shouldRefresh(GIT_DIR, undefined)).toBe(true);
});

test("linked-worktree git dir root treats the whole root as internal", () => {
  expect(shouldRefresh(GIT_DIR, g("objects", "ab", "cd"))).toBe(false);
  expect(shouldRefresh(GIT_DIR, g("logs", "HEAD"))).toBe(false);
  expect(shouldRefresh(GIT_DIR, "index.lock")).toBe(false);
  expect(shouldRefresh(GIT_DIR, "HEAD")).toBe(true);
  expect(shouldRefresh(GIT_DIR, "index")).toBe(true);
  expect(shouldRefresh(GIT_DIR, g("refs", "bisect", "bad"))).toBe(true);
});

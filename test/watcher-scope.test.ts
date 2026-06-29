import { expect, test } from "bun:test";
import { sep } from "node:path";

import { watchRoots } from "@/watcher/scope";

test("watchRoots drops a git dir that lives inside the worktree", () => {
  const root = `${sep}repo`;
  expect(watchRoots(root, `${root}${sep}.git`)).toEqual([
    { gitInternalPrefix: `.git${sep}`, path: root },
  ]);
});

test("watchRoots keeps a linked-worktree git dir that lives outside the worktree", () => {
  const root = `${sep}repo${sep}wt`;
  const gitDir = `${sep}repo${sep}.git${sep}worktrees${sep}wt`;
  expect(watchRoots(root, gitDir)).toEqual([
    { gitInternalPrefix: `.git${sep}`, path: root },
    { gitInternalPrefix: "", path: gitDir },
  ]);
});

test("watchRoots drops a git dir equal to the worktree root", () => {
  const root = `${sep}repo`;
  expect(watchRoots(root, root)).toEqual([{ gitInternalPrefix: `.git${sep}`, path: root }]);
});

test("watchRoots watches only the worktree when the git dir is unknown", () => {
  const root = `${sep}repo`;
  expect(watchRoots(root, undefined)).toEqual([{ gitInternalPrefix: `.git${sep}`, path: root }]);
});

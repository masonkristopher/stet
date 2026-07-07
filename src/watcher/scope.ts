import { sep } from "node:path";

/**
 * The filesystem roots to watch for a worktree, each paired with the path prefix under which every
 * event is git-internal (so the watcher can drop high-churn internals; see `classify`). The
 * worktree tree catches file edits; the resolved git dir catches staging/commit/checkout. In a
 * normal repo the git dir lives at `<root>/.git`, already inside the recursively-watched tree, so
 * it is dropped as redundant and only its `.git/` subtree is internal. In a linked worktree the git
 * dir resolves outside the tree and is watched as a second root, where the entire root is
 * internal.
 */
export function watchRoots(repoRoot: string, gitDir: string | undefined) {
  const worktree = { gitInternalPrefix: `.git${sep}`, path: repoRoot };
  if (gitDir === undefined || gitDir === repoRoot || gitDir.startsWith(repoRoot + sep)) {
    return [worktree];
  }
  return [worktree, { gitInternalPrefix: "", path: gitDir }];
}

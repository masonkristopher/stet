import { sep } from "node:path";

// High-churn git internals that never change the working-tree, staged, or branch
// State stet renders. An agent writing to the repo churns these continuously
// (a loose object per blob/tree/commit, a reflog append per ref update, a lock
// File per write), and watching them re-runs a full `git status` and repaint per
// Event. A denylist, not a whitelist: a forgotten entry costs one redundant
// Refresh, never a dropped HEAD/index/refs signal shown stale until the poll.
const DENY_FIRST_SEGMENT = new Set(["objects", "logs", "rebase-merge", "rebase-apply"]);
const DENY_EXACT = new Set(["COMMIT_EDITMSG", "FETCH_HEAD"]);

/**
 * Whether a raw `fs.watch` event should produce a refresh tick. `gitInternalPrefix` is the per-root
 * prefix under which every path is git-internal: `.git${sep}` for the worktree root (only its
 * `.git/` subtree), or `""` for a linked worktree's git dir (the whole watched root). Drops the
 * high-churn internals git writes while an agent works; keeps HEAD/index/refs and every
 * working-tree edit. Fails open (ticks) when it cannot classify, so a filtered event is never
 * traded for stale state.
 */
export function shouldRefresh(gitInternalPrefix: string, filename: string | null | undefined) {
  // `fs.watch` omits the name on some events (`null` on macOS, `undefined` on
  // Linux inotify); an unclassifiable event must tick rather than throw or stale.
  if (typeof filename !== "string") {
    return true;
  }

  // The trailing separator in the prefix is load-bearing: `.gitignore` and
  // `.github/...` do not start with `.git${sep}`, so they read as edits and tick.
  if (gitInternalPrefix !== "" && !filename.startsWith(gitInternalPrefix)) {
    return true;
  }

  const internalPath = filename.slice(gitInternalPrefix.length);
  if (internalPath.endsWith(".lock") || DENY_EXACT.has(internalPath)) {
    return false;
  }
  return !DENY_FIRST_SEGMENT.has(internalPath.split(sep)[0] ?? "");
}

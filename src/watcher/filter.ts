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
 * How a raw `fs.watch` event should be treated. `"worktree"` is a tracked working-tree file edit
 * (tick the git refresh and invalidate the intel cache, which keys off working-tree content);
 * `"internal"` is a meaningful git-state change (HEAD/index/refs, or any event on a linked
 * worktree's git-dir root) that ticks the refresh but is not a content change; `"ignored"` is a
 * high-churn internal git drops on every write and produces no tick.
 */
export type WatchEventClass = "worktree" | "internal" | "ignored";

/**
 * Classify a raw `fs.watch` event. `gitInternalPrefix` is the per-root prefix under which every
 * path is git-internal: `.git${sep}` for the worktree root (only its `.git/` subtree), or `""` for
 * a linked worktree's git dir (the whole watched root). Drops the high-churn internals git writes
 * while an agent works; keeps HEAD/index/refs and every working-tree edit. Fails toward correctness
 * when it cannot classify (a nameless event on the worktree root might be a content change, so
 * `"worktree"`; on the git-dir root it is always `"internal"`): either way it ticks, and it errs
 * toward invalidating rather than stranding stale intel.
 */
export function classify(
  gitInternalPrefix: string,
  filename: string | null | undefined,
): WatchEventClass {
  // `fs.watch` omits the name on some events (`null` on macOS, `undefined` on Linux inotify).
  if (typeof filename !== "string") {
    return gitInternalPrefix === "" ? "internal" : "worktree";
  }

  // The trailing separator in the prefix is load-bearing: `.gitignore` and `.github/...` do not
  // Start with `.git${sep}`, so they read as edits, not internals.
  if (gitInternalPrefix !== "" && !filename.startsWith(gitInternalPrefix)) {
    return "worktree";
  }

  const internalPath = filename.slice(gitInternalPrefix.length);
  if (
    internalPath.endsWith(".lock") ||
    DENY_EXACT.has(internalPath) ||
    DENY_FIRST_SEGMENT.has(internalPath.split(sep)[0] ?? "")
  ) {
    return "ignored";
  }
  return "internal";
}

import { expect, test } from "bun:test";
import { sep } from "node:path";

import { classify } from "@/watcher/filter";

const WORKTREE = `.git${sep}`;
const GIT_DIR = "";

const g = (...parts: string[]) => parts.join(sep);

test("worktree root drops high-churn git internals", () => {
  expect(classify(WORKTREE, g(".git", "objects", "ab", "cdef"))).toBe("ignored");
  expect(classify(WORKTREE, g(".git", "logs", "HEAD"))).toBe("ignored");
  expect(classify(WORKTREE, g(".git", "rebase-merge", "done"))).toBe("ignored");
  expect(classify(WORKTREE, g(".git", "index.lock"))).toBe("ignored");
  expect(classify(WORKTREE, g(".git", "HEAD.lock"))).toBe("ignored");
  expect(classify(WORKTREE, g(".git", "packed-refs.lock"))).toBe("ignored");
  expect(classify(WORKTREE, g(".git", "COMMIT_EDITMSG"))).toBe("ignored");
  expect(classify(WORKTREE, g(".git", "FETCH_HEAD"))).toBe("ignored");
});

test("worktree root keeps meaningful git state changes as internal (tick, no content change)", () => {
  expect(classify(WORKTREE, g(".git", "HEAD"))).toBe("internal");
  expect(classify(WORKTREE, g(".git", "index"))).toBe("internal");
  expect(classify(WORKTREE, g(".git", "refs", "heads", "main"))).toBe("internal");
  expect(classify(WORKTREE, g(".git", "packed-refs"))).toBe("internal");
  expect(classify(WORKTREE, g(".git", "ORIG_HEAD"))).toBe("internal");
  expect(classify(WORKTREE, g(".git", "MERGE_HEAD"))).toBe("internal");
});

test("worktree root marks working-tree edits, incl. lookalikes outside .git/", () => {
  expect(classify(WORKTREE, g("src", "foo.ts"))).toBe("worktree");
  expect(classify(WORKTREE, ".gitignore")).toBe("worktree");
  expect(classify(WORKTREE, g(".github", "workflows", "ci.yml"))).toBe("worktree");
});

test("a nameless event fails toward correctness (worktree root: content; git dir: internal)", () => {
  // `fs.watch` omits the name on some events (`null` on macOS, `undefined` on Linux inotify).
  expect(classify(WORKTREE, null)).toBe("worktree");
  expect(classify(WORKTREE, undefined)).toBe("worktree");
  expect(classify(GIT_DIR, null)).toBe("internal");
  expect(classify(GIT_DIR, undefined)).toBe("internal");
});

test("linked-worktree git dir root is never a working-tree write", () => {
  expect(classify(GIT_DIR, g("objects", "ab", "cd"))).toBe("ignored");
  expect(classify(GIT_DIR, g("logs", "HEAD"))).toBe("ignored");
  expect(classify(GIT_DIR, "index.lock")).toBe("ignored");
  expect(classify(GIT_DIR, "HEAD")).toBe("internal");
  expect(classify(GIT_DIR, "index")).toBe("internal");
  expect(classify(GIT_DIR, g("refs", "bisect", "bad"))).toBe("internal");
});

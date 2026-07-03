import { describe, expect, test } from "bun:test";

import { structureDiff } from "@/diff/engine";
import { buildFilePatch, classifySideBytes, fileDiffSides } from "@/git/file-patch";
import type { SideContent } from "@/git/file-patch";
import type { ChangedFile } from "@/git/model";

function file(path: string, overrides: Partial<ChangedFile> = {}): ChangedFile {
  return {
    additions: 1,
    binary: false,
    deletions: 1,
    kind: "modified",
    mtimeMs: 0,
    path,
    stage: "unstaged",
    warnings: [],
    ...overrides,
  };
}

function text(value: string): SideContent {
  return { kind: "text", text: value };
}

function rows(patch: string) {
  return structureDiff({ full: true, maxLines: 1600, patch }).navigable;
}

describe("fileDiffSides", () => {
  test("all and session compare the ref blob against the worktree", () => {
    expect(fileDiffSides({ kind: "all", ref: "main" }, file("src/a.ts"))).toEqual({
      newSide: { kind: "worktree" },
      oldSide: { kind: "git", spec: "main:src/a.ts" },
    });
    expect(fileDiffSides({ kind: "session", ref: "abc123" }, file("src/a.ts"))).toEqual({
      newSide: { kind: "worktree" },
      oldSide: { kind: "git", spec: "abc123:src/a.ts" },
    });
  });

  test("unstaged compares the index blob against the worktree and ignores the ref", () => {
    expect(fileDiffSides({ kind: "unstaged", ref: "main" }, file("src/a.ts"))).toEqual({
      newSide: { kind: "worktree" },
      oldSide: { kind: "git", spec: ":src/a.ts" },
    });
  });

  test("staged compares the ref blob against the index blob, never the worktree", () => {
    expect(fileDiffSides({ kind: "staged", ref: "HEAD" }, file("src/a.ts"))).toEqual({
      newSide: { kind: "git", spec: ":src/a.ts" },
      oldSide: { kind: "git", spec: "HEAD:src/a.ts" },
    });
  });

  test("last-commit compares the two committed trees, defaulting the right side to HEAD", () => {
    expect(
      fileDiffSides({ headRef: "HEAD", kind: "last-commit", ref: "parentsha" }, file("src/a.ts")),
    ).toEqual({
      newSide: { kind: "git", spec: "HEAD:src/a.ts" },
      oldSide: { kind: "git", spec: "parentsha:src/a.ts" },
    });
    expect(fileDiffSides({ kind: "last-commit", ref: "parentsha" }, file("src/a.ts"))).toEqual({
      newSide: { kind: "git", spec: "HEAD:src/a.ts" },
      oldSide: { kind: "git", spec: "parentsha:src/a.ts" },
    });
  });

  test("a stepped commit compares the commit's parent tree against the commit sha", () => {
    expect(
      fileDiffSides({ headRef: "abcsha", kind: "commit", ref: "parentsha" }, file("src/a.ts")),
    ).toEqual({
      newSide: { kind: "git", spec: "abcsha:src/a.ts" },
      oldSide: { kind: "git", spec: "parentsha:src/a.ts" },
    });
  });

  test("added and untracked files have no old side", () => {
    expect(
      fileDiffSides({ kind: "all", ref: "HEAD" }, file("src/a.ts", { kind: "added" })),
    ).toEqual({
      newSide: { kind: "worktree" },
      oldSide: { kind: "empty" },
    });
    expect(
      fileDiffSides({ kind: "all", ref: "HEAD" }, file("src/a.ts", { kind: "untracked" })),
    ).toEqual({
      newSide: { kind: "worktree" },
      oldSide: { kind: "empty" },
    });
  });

  test("deleted files have no new side", () => {
    expect(
      fileDiffSides({ kind: "all", ref: "HEAD" }, file("src/a.ts", { kind: "deleted" })),
    ).toEqual({
      newSide: { kind: "empty" },
      oldSide: { kind: "git", spec: "HEAD:src/a.ts" },
    });
    expect(
      fileDiffSides({ kind: "staged", ref: "HEAD" }, file("src/a.ts", { kind: "deleted" })),
    ).toEqual({
      newSide: { kind: "empty" },
      oldSide: { kind: "git", spec: "HEAD:src/a.ts" },
    });
  });

  test("renamed files read the old side at the pre-rename path", () => {
    expect(
      fileDiffSides(
        { kind: "all", ref: "HEAD" },
        file("src/new.ts", { kind: "renamed", oldPath: "src/old.ts" }),
      ),
    ).toEqual({
      newSide: { kind: "worktree" },
      oldSide: { kind: "git", spec: "HEAD:src/old.ts" },
    });
    expect(
      fileDiffSides(
        { kind: "staged", ref: "HEAD" },
        file("src/new.ts", { kind: "renamed", oldPath: "src/old.ts" }),
      ),
    ).toEqual({
      newSide: { kind: "git", spec: ":src/new.ts" },
      oldSide: { kind: "git", spec: "HEAD:src/old.ts" },
    });
  });
});

describe("classifySideBytes", () => {
  test("decodes text preserving the trailing newline", () => {
    expect(classifySideBytes(new TextEncoder().encode("a\nb\n"))).toEqual({
      kind: "text",
      text: "a\nb\n",
    });
    expect(classifySideBytes(new TextEncoder().encode("no newline"))).toEqual({
      kind: "text",
      text: "no newline",
    });
  });

  test("classifies a NUL byte in the first 8KB as binary", () => {
    expect(classifySideBytes(new Uint8Array([104, 105, 0, 33]))).toEqual({ kind: "binary" });
  });

  test("classifies an oversized side as too-large without decoding", () => {
    expect(classifySideBytes(new Uint8Array(10_000_001))).toEqual({ kind: "too-large" });
  });
});

describe("buildFilePatch", () => {
  test("a modified file produces a git-shaped patch with three context lines", () => {
    const oldText = "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\n";
    const newText = "one\ntwo\nthree\nfour\nCHANGED\nsix\nseven\neight\nnine\n";
    const built = buildFilePatch(file("src/a.ts"), text(oldText), text(newText));

    if (built.kind !== "patch") {
      throw new Error("expected a patch");
    }
    expect(built.patch).toStartWith("diff --git a/src/a.ts b/src/a.ts\n");
    expect(built.patch).toContain("--- a/src/a.ts\n");
    expect(built.patch).toContain("+++ b/src/a.ts\n");

    expect(rows(built.patch)).toEqual([
      { content: "two", newLine: 2, oldLine: 2, type: "context" },
      { content: "three", newLine: 3, oldLine: 3, type: "context" },
      { content: "four", newLine: 4, oldLine: 4, type: "context" },
      { content: "five", newLine: undefined, oldLine: 5, type: "remove" },
      { content: "CHANGED", newLine: 5, oldLine: undefined, type: "add" },
      { content: "six", newLine: 6, oldLine: 6, type: "context" },
      { content: "seven", newLine: 7, oldLine: 7, type: "context" },
      { content: "eight", newLine: 8, oldLine: 8, type: "context" },
    ]);
  });

  test("an added file carries new-file headers and renders all-added", () => {
    const built = buildFilePatch(
      file("src/a.ts", { deletions: 0, kind: "added" }),
      text(""),
      text("hello\nworld\n"),
    );

    if (built.kind !== "patch") {
      throw new Error("expected a patch");
    }
    expect(built.patch).toStartWith("diff --git a/src/a.ts b/src/a.ts\n");
    expect(built.patch).toContain("new file mode 100644\n");
    expect(built.patch).toContain("--- /dev/null\n");
    expect(built.patch).toContain("+++ b/src/a.ts\n");
    expect(rows(built.patch)).toEqual([
      { content: "hello", newLine: 1, oldLine: undefined, type: "add" },
      { content: "world", newLine: 2, oldLine: undefined, type: "add" },
    ]);
  });

  test("a deleted file carries deleted-file headers and renders all-removed", () => {
    const built = buildFilePatch(
      file("src/a.ts", { additions: 0, kind: "deleted" }),
      text("hello\nworld\n"),
      text(""),
    );

    if (built.kind !== "patch") {
      throw new Error("expected a patch");
    }
    expect(built.patch).toContain("deleted file mode 100644\n");
    expect(built.patch).toContain("--- a/src/a.ts\n");
    expect(built.patch).toContain("+++ /dev/null\n");
    expect(rows(built.patch)).toEqual([
      { content: "hello", newLine: undefined, oldLine: 1, type: "remove" },
      { content: "world", newLine: undefined, oldLine: 2, type: "remove" },
    ]);
  });

  test("a rename with an edit carries rename headers and both names", () => {
    const built = buildFilePatch(
      file("src/new.ts", { kind: "renamed", oldPath: "src/old.ts" }),
      text("keep\nbefore\n"),
      text("keep\nafter\n"),
    );

    if (built.kind !== "patch") {
      throw new Error("expected a patch");
    }
    expect(built.patch).toStartWith("diff --git a/src/old.ts b/src/new.ts\n");
    expect(built.patch).toContain("rename from src/old.ts\n");
    expect(built.patch).toContain("rename to src/new.ts\n");
    expect(rows(built.patch)).toEqual([
      { content: "keep", newLine: 1, oldLine: 1, type: "context" },
      { content: "before", newLine: undefined, oldLine: 2, type: "remove" },
      { content: "after", newLine: 2, oldLine: undefined, type: "add" },
    ]);
  });

  test("a pure rename produces a header-only patch with no rows, like git", () => {
    const built = buildFilePatch(
      file("src/new.ts", { additions: 0, deletions: 0, kind: "renamed", oldPath: "src/old.ts" }),
      text("same\n"),
      text("same\n"),
    );

    if (built.kind !== "patch") {
      throw new Error("expected a patch");
    }
    expect(built.patch).toContain("rename from src/old.ts\n");
    expect(built.patch).not.toContain("@@");
    expect(rows(built.patch)).toEqual([]);
  });

  test("a missing trailing newline emits the no-newline marker on the right side", () => {
    const removed = buildFilePatch(file("a.txt"), text("end\n"), text("end"));
    if (removed.kind !== "patch") {
      throw new Error("expected a patch");
    }
    expect(removed.patch).toContain("+end\n\\ No newline at end of file\n");

    const added = buildFilePatch(file("a.txt"), text("end"), text("end\n"));
    if (added.kind !== "patch") {
      throw new Error("expected a patch");
    }
    expect(added.patch).toContain("-end\n\\ No newline at end of file\n");
  });

  test("a binary side yields an empty patch, matching the model-driven placeholder", () => {
    expect(buildFilePatch(file("a.bin"), { kind: "binary" }, text("x\n"))).toEqual({
      kind: "patch",
      patch: "",
    });
    expect(buildFilePatch(file("a.bin"), text("x\n"), { kind: "binary" })).toEqual({
      kind: "patch",
      patch: "",
    });
  });

  test("a missing or oversized side falls back to the git invocation", () => {
    expect(buildFilePatch(file("a.txt"), { kind: "missing" }, text("x\n"))).toEqual({
      kind: "fallback",
    });
    expect(buildFilePatch(file("a.txt"), text("x\n"), { kind: "too-large" })).toEqual({
      kind: "fallback",
    });
  });

  test("CRLF on exactly one side falls back; CRLF on both sides diffs in-process", () => {
    expect(buildFilePatch(file("a.txt"), text("a\r\nb\r\n"), text("a\nb\nc\n"))).toEqual({
      kind: "fallback",
    });

    const both = buildFilePatch(file("a.txt"), text("a\r\nb\r\n"), text("a\r\nc\r\n"));
    expect(both.kind).toBe("patch");
  });

  test("zero hunks against non-zero numstat counts falls back instead of rendering empty", () => {
    expect(
      buildFilePatch(file("a.txt", { additions: 2, deletions: 1 }), text("same\n"), text("same\n")),
    ).toEqual({ kind: "fallback" });
  });

  test("identical text with zero numstat counts renders empty, like a mode-only change", () => {
    const built = buildFilePatch(
      file("a.txt", { additions: 0, deletions: 0 }),
      text("same\n"),
      text("same\n"),
    );

    if (built.kind !== "patch") {
      throw new Error("expected a patch");
    }
    expect(rows(built.patch)).toEqual([]);
  });

  test("adding an empty file produces the header-only new-file patch", () => {
    const built = buildFilePatch(
      file("empty.txt", { additions: 0, deletions: 0, kind: "added" }),
      text(""),
      text(""),
    );

    if (built.kind !== "patch") {
      throw new Error("expected a patch");
    }
    expect(built.patch).toContain("new file mode 100644\n");
    expect(rows(built.patch)).toEqual([]);
  });
});

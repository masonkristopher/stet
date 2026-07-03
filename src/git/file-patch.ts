import { lstat, readFile, readlink } from "node:fs/promises";

import { formatPatch, structuredPatch } from "diff";

import type { DiffScope } from "@/cli";

import type { ChangedFile } from "./model";

/**
 * One endpoint of a per-file comparison: a git object (`ref:path` / `:path`), the worktree file, or
 * nothing (the fabricated side of an add or delete).
 */
export type PatchSide = { kind: "git"; spec: string } | { kind: "worktree" } | { kind: "empty" };

export type SideContent =
  | { kind: "text"; text: string }
  | { kind: "binary" }
  | { kind: "too-large" }
  | { kind: "missing" };

export type FilePatch = { kind: "patch"; patch: string } | { kind: "fallback" };

// Sides above this size are not decoded or diffed in-process; the git fallback
// Handles them as it always has. 10x the viewer's own file cap: generous enough
// That real source files never fall back, small enough to never diff a giant
// Artifact on the render path.
const MAX_SIDE_BYTES = 10_000_000;

// Give jsdiff a bounded budget: a pathological pair (huge, fully rewritten
// Generated files) aborts to the git fallback instead of stalling the load.
const DIFF_TIMEOUT_MS = 1000;

/**
 * Which two endpoints the scope's `git diff` invocation would compare for this file. `file.stage`
 * is deliberately not consulted: membership in the scope's changed set (built from the same `git
 * diff` arguments) already encodes it, exactly as the pathspec invocation relied on.
 */
export function fileDiffSides(
  scope: DiffScope,
  file: ChangedFile,
): { oldSide: PatchSide; newSide: PatchSide } {
  const base = (path: string): PatchSide =>
    scope.kind === "unstaged"
      ? { kind: "git", spec: `:${path}` }
      : { kind: "git", spec: `${scope.ref}:${path}` };

  const target = (): PatchSide => {
    if (scope.kind === "staged") {
      return { kind: "git", spec: `:${file.path}` };
    }
    if (scope.kind === "last-commit" || scope.kind === "commit") {
      return { kind: "git", spec: `${scope.headRef ?? "HEAD"}:${file.path}` };
    }
    return { kind: "worktree" };
  };

  return {
    newSide: file.kind === "deleted" ? { kind: "empty" } : target(),
    oldSide:
      file.kind === "added" || file.kind === "untracked"
        ? { kind: "empty" }
        : base(file.oldPath ?? file.path),
  };
}

const decoder = new TextDecoder();

/**
 * Byte classification for a diff side. Deliberately not `classifyFileBytes`: that path truncates
 * oversized/long files and strips the trailing newline, either of which would fabricate diff
 * content (a truncated side reads as deletions, a stripped newline breaks the `\ No newline at end
 * of file` marker).
 */
export function classifySideBytes(bytes: Uint8Array): SideContent {
  if (bytes.byteLength > MAX_SIDE_BYTES) {
    return { kind: "too-large" };
  }

  if (bytes.subarray(0, 8000).includes(0)) {
    return { kind: "binary" };
  }

  return { kind: "text", text: decoder.decode(bytes) };
}

/**
 * The worktree endpoint, read raw. A symlink reads as its target path text (git's blob form for a
 * link); a directory or vanished path is `missing`, which sends the caller to the git fallback.
 */
export async function readWorktreeSide(repoRoot: string, path: string): Promise<SideContent> {
  const absolutePath = `${repoRoot}/${path}`;
  try {
    const stat = await lstat(absolutePath);
    if (stat.isSymbolicLink()) {
      return { kind: "text", text: await readlink(absolutePath) };
    }
    if (!stat.isFile()) {
      return { kind: "missing" };
    }
    if (stat.size > MAX_SIDE_BYTES) {
      return { kind: "too-large" };
    }
    return classifySideBytes(await readFile(absolutePath));
  } catch {
    return { kind: "missing" };
  }
}

/**
 * Build the git-shaped unified patch for one changed file from its two sides' contents, or signal
 * `fallback` when an in-process diff could not be faithful to what `git diff` would print: a side
 * that is missing or oversized, a jsdiff timeout, CRLF on exactly one side (git may be
 * eol-converting the worktree before diffing, so raw bytes would paint a whole-file rewrite), or
 * zero hunks against non-zero numstat counts (an unmodeled content filter). Binary sides yield an
 * empty patch: the render is a model-driven placeholder either way, same as git's `Binary files
 * differ` line.
 */
export function buildFilePatch(
  file: ChangedFile,
  oldContent: SideContent,
  newContent: SideContent,
): FilePatch {
  if (oldContent.kind === "binary" || newContent.kind === "binary") {
    return { kind: "patch", patch: "" };
  }

  if (oldContent.kind !== "text" || newContent.kind !== "text") {
    return { kind: "fallback" };
  }

  const created = file.kind === "added" || file.kind === "untracked";
  if (
    !created &&
    file.kind !== "deleted" &&
    oldContent.text.includes("\r\n") !== newContent.text.includes("\r\n")
  ) {
    return { kind: "fallback" };
  }

  const patch = structuredPatch(
    created ? "/dev/null" : `a/${file.oldPath ?? file.path}`,
    file.kind === "deleted" ? "/dev/null" : `b/${file.path}`,
    oldContent.text,
    newContent.text,
    undefined,
    undefined,
    { context: 3, timeout: DIFF_TIMEOUT_MS },
  );

  if (patch === undefined) {
    return { kind: "fallback" };
  }

  if (patch.hunks.length === 0 && file.additions + file.deletions > 0) {
    return { kind: "fallback" };
  }

  return {
    kind: "patch",
    patch: formatPatch({
      ...patch,
      isCreate: created,
      isDelete: file.kind === "deleted",
      isGit: true,
      isRename: file.oldPath !== undefined,
    }),
  };
}

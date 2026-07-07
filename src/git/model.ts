import { lstatSync } from "node:fs";

import type { DiffScope } from "@/cli";
import { loadFileContent } from "@/file/content";

export type ChangeKind = "modified" | "added" | "deleted" | "renamed" | "untracked";

export type StageState = "staged" | "unstaged" | "mixed" | "untracked";

export interface ChangedFile {
  path: string;
  oldPath?: string;
  kind: ChangeKind;
  stage: StageState;
  additions: number;
  deletions: number;
  binary: boolean;
  warnings: string[];
  // Worktree mtime so edits that keep the churn counts identical still register
  mtimeMs: number;
}

export interface RepoFile {
  path: string;
  tracked: boolean;
  symlink: boolean;
}

export interface GitModel {
  repoRoot: string;
  scopeKey: string;
  changed: ChangedFile[];
  changedByPath: Map<string, ChangedFile>;
  repoFiles: RepoFile[];
  repoFilesKey: string;
}

interface StatusEntry {
  path: string;
  oldPath?: string;
  kind: ChangeKind;
}

export interface Worktree {
  path: string;
  head: string;
  branch?: string;
  detached: boolean;
  bare: boolean;
  locked: boolean;
  prunable: boolean;
}

export function parseWorktreeList(output: string): Worktree[] {
  const worktrees: Worktree[] = [];

  // With -z every attribute line ends in NUL and each record ends in an extra NUL
  for (const record of output.split("\0\0")) {
    const attributes = record.split("\0").filter((line) => line !== "");
    const first = attributes[0];
    if (first === undefined || !first.startsWith("worktree ")) {
      continue;
    }

    const worktree: Worktree = {
      bare: false,
      detached: false,
      head: "",
      locked: false,
      path: first.slice("worktree ".length),
      prunable: false,
    };

    for (const attribute of attributes.slice(1)) {
      if (attribute.startsWith("HEAD ")) {
        worktree.head = attribute.slice("HEAD ".length);
      } else if (attribute.startsWith("branch ")) {
        const ref = attribute.slice("branch ".length);
        worktree.branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
      } else if (attribute === "bare") {
        worktree.bare = true;
      } else if (attribute === "detached") {
        worktree.detached = true;
      } else if (attribute === "locked" || attribute.startsWith("locked ")) {
        worktree.locked = true;
      } else if (attribute === "prunable" || attribute.startsWith("prunable ")) {
        worktree.prunable = true;
      }
    }

    worktrees.push(worktree);
  }

  return worktrees;
}

// Pure assembly of the changed set from raw git output, shared by the loaders and the Git service.
export function assembleChanged(
  repoRoot: string,
  scope: DiffScope,
  untrackedOutput: string,
  nameStatusOutput: string,
  numstatOutput: string,
  porcelainOutput: string,
): Pick<GitModel, "changed" | "changedByPath" | "scopeKey"> {
  // The committed-tree-to-committed-tree ranges (last-commit, a stepped commit)
  // Have no place for working-tree untracked files (same reasoning as staged).
  const untracked =
    scope.kind === "staged" || scope.kind === "last-commit" || scope.kind === "commit"
      ? []
      : parseUntrackedFiles(untrackedOutput);
  const nameStatus = parseNameStatus(nameStatusOutput);
  const statusByPath = new Map([...nameStatus, ...untracked].map((entry) => [entry.path, entry]));
  const numstat = parseNumstat(numstatOutput);
  const numstatByPath = new Map(numstat.map((entry) => [entry.path, entry]));
  const stageByPath = parsePorcelainStatus(porcelainOutput);
  const paths = new Set([...numstatByPath.keys(), ...statusByPath.keys()]);

  const changed = [...paths]
    .map((path) => {
      const stat = numstatByPath.get(path);
      const statusEntry = statusByPath.get(path);
      const kind = statusEntry?.kind ?? inferKind(path, stat?.deletions ?? 0, stat?.additions ?? 0);
      const untrackedStat =
        kind === "untracked" && stat === undefined ? statUntrackedFile(repoRoot, path) : undefined;
      const file: ChangedFile = {
        additions: stat?.additions ?? untrackedStat?.additions ?? 0,
        binary: stat?.binary ?? untrackedStat?.binary ?? false,
        deletions: stat?.deletions ?? 0,
        kind,
        mtimeMs: kind === "deleted" ? 0 : fileMtime(repoRoot, path),
        oldPath: statusEntry?.oldPath,
        path,
        stage: stageByPath.get(path) ?? (kind === "untracked" ? "untracked" : "unstaged"),
        warnings: warningsFor(
          path,
          kind,
          stat?.additions ?? untrackedStat?.additions ?? 0,
          stat?.deletions ?? 0,
        ),
      };
      return file;
    })
    .toSorted((a, b) => a.path.localeCompare(b.path));

  return {
    changed,
    changedByPath: new Map(changed.map((file) => [file.path, file])),
    scopeKey: `${scope.kind}:${scope.ref}:${scope.headRef ?? ""}`,
  };
}

// Pure assembly of the full model (changed set + repo file list) from raw output.
export function assembleModel(
  repoRoot: string,
  scope: DiffScope,
  trackedOutput: string,
  untrackedOutput: string,
  nameStatusOutput: string,
  numstatOutput: string,
  porcelainOutput: string,
): GitModel {
  return {
    ...assembleChanged(
      repoRoot,
      scope,
      untrackedOutput,
      nameStatusOutput,
      numstatOutput,
      porcelainOutput,
    ),
    ...parseRepoFiles(repoRoot, trackedOutput, untrackedOutput),
    repoRoot,
  };
}

export function mergeChanged(
  prev: GitModel,
  next: Pick<GitModel, "changed" | "changedByPath" | "scopeKey">,
): GitModel {
  if (prev.scopeKey === next.scopeKey && sameChangedSet(prev.changed, next.changed)) {
    return prev;
  }

  const changed = next.changed.map((file) => {
    const before = prev.changedByPath.get(file.path);
    return before !== undefined && sameChangedFile(before, file) ? before : file;
  });

  // If every entry in changed is the same reference as next.changed[index], no
  // File was reused from prev — skip building a new Map and return next's
  // References directly.
  if (
    prev.scopeKey === next.scopeKey &&
    changed.every((file, index) => file === next.changed[index])
  ) {
    return {
      ...prev,
      changed: next.changed,
      changedByPath: next.changedByPath,
      scopeKey: next.scopeKey,
    };
  }

  return {
    ...prev,
    changed,
    changedByPath: new Map(changed.map((file) => [file.path, file])),
    scopeKey: next.scopeKey,
  };
}

export function numstatArgs(scope: DiffScope) {
  // -z keeps non-ASCII paths literal instead of core.quotePath's C-quoting
  return [...diffArgs(scope), "--numstat", "-z"];
}

export function nameStatusArgs(scope: DiffScope) {
  return [...diffArgs(scope), "--name-status", "-z"];
}

// Pin canonical a//b/ prefixes and disable external/textconv diff drivers so a
// User's gitconfig (diff.noprefix, diff.mnemonicPrefix, diff.external) can't
// Corrupt the patch text the viewer parses. These are command-line options, not
// `-c diff.srcPrefix` overrides: the config form loses to diff.mnemonicPrefix,
// The command-line form wins.
const diffFlags = ["--no-ext-diff", "--src-prefix=a/", "--dst-prefix=b/"];

// The empty tree object, used as last-commit's parent on a root commit (which
// Has no HEAD~1) so the whole first commit still renders as all-added.
export const EMPTY_TREE_SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

export function diffArgs(scope: DiffScope) {
  const base = ["git", "diff", ...diffFlags];

  if (scope.kind === "staged") {
    return [...base, "--cached", scope.ref];
  }

  if (scope.kind === "unstaged") {
    return base;
  }

  // The range scopes: last-commit (HEAD~1..HEAD) and a stepped commit (parent..sha).
  if (scope.kind === "last-commit" || scope.kind === "commit") {
    return [...base, scope.ref, scope.headRef ?? "HEAD"];
  }

  // All and session: worktree vs a single base ref (HEAD / session SHA).
  return [...base, scope.ref];
}

export function untrackedDiffArgs(path: string) {
  return ["git", "diff", ...diffFlags, "--no-index", "--", "/dev/null", path];
}

export function parsePorcelainStatus(output: string): Map<string, StageState> {
  const stageByPath = new Map<string, StageState>();
  const tokens = output.split("\0");

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined || token.length < 4) {
      continue;
    }

    const stage = stageFromCodes(token[0] ?? " ", token[1] ?? " ");
    stageByPath.set(token.slice(3), stage);

    if (token.startsWith("R") || token.startsWith("C") || token[1] === "R" || token[1] === "C") {
      const original = tokens[index + 1];
      if (original !== undefined && original !== "") {
        stageByPath.set(original, stage);
      }
      index += 1;
    }
  }

  return stageByPath;
}

export function mergeModel(prev: GitModel, next: GitModel): GitModel {
  if (
    prev.repoRoot === next.repoRoot &&
    prev.scopeKey === next.scopeKey &&
    prev.repoFilesKey === next.repoFilesKey &&
    sameChangedSet(prev.changed, next.changed)
  ) {
    return prev;
  }

  // Keep identity for untouched files so per-file memos (e.g. the selected diff) hold
  const changed = next.changed.map((file) => {
    const before = prev.changedByPath.get(file.path);
    return before !== undefined && sameChangedFile(before, file) ? before : file;
  });

  if (changed.every((file, index) => file === next.changed[index])) {
    return next;
  }

  return { ...next, changed, changedByPath: new Map(changed.map((file) => [file.path, file])) };
}

function sameChangedSet(a: ChangedFile[], b: ChangedFile[]) {
  return a.length === b.length && a.every((file, i) => sameChangedFile(file, b[i]));
}

function sameChangedFile(a: ChangedFile, b: ChangedFile) {
  return (
    a.path === b.path &&
    a.oldPath === b.oldPath &&
    a.kind === b.kind &&
    a.stage === b.stage &&
    a.additions === b.additions &&
    a.deletions === b.deletions &&
    a.binary === b.binary &&
    a.mtimeMs === b.mtimeMs
  );
}

function stageFromCodes(index: string, worktree: string): StageState {
  if (index === "?" && worktree === "?") {
    return "untracked";
  }

  const staged = index !== " " && index !== "?";
  const unstaged = worktree !== " " && worktree !== "?";
  if (staged && unstaged) {
    return "mixed";
  }

  return staged ? "staged" : "unstaged";
}

// Whether the *set* of changed paths shifted (a file appeared or disappeared),
// Ignoring churn in additions/deletions/mtime. Both arrays are path-sorted
// (assembleChanged sorts, mergeChanged preserves order), so a positional compare
// Suffices. Drives the repoFiles refresh: the full file tree only needs re-listing
// When the file set changes, never on a content-only edit.
export function changedPathsDiffer(previous: ChangedFile[], next: ChangedFile[]) {
  if (previous.length !== next.length) {
    return true;
  }
  return previous.some((file, index) => file.path !== next[index]?.path);
}

// Whether the working tree gained a content edit whose mtime advanced, detected as the newest
// `mtimeMs` across the changed set advancing. This is a lossy signal (it misses a revert to
// Baseline, a deletion, and a write that preserves an older mtime), so it is only the poll
// Fallback for intel invalidation, never the primary: the filesystem watcher catches every write
// Precisely. A commit, scope re-resolve, or staging shifts changed-set membership without moving
// Any mtime, so this stays false on a baseline move and so never over-invalidates the cache.
export function changedContentAdvanced(previous: GitModel, next: GitModel) {
  const newest = (model: GitModel) =>
    model.changed.reduce((max, file) => Math.max(max, file.mtimeMs), 0);
  return newest(next) > newest(previous);
}
let repoFilesCache: { key: string; repoFiles: RepoFile[] } | undefined;

const SYMLINK_MODE = "120000";

// `git ls-files --stage -z` emits "<mode> <sha> <stage>\t<path>" per entry; the
// Mode is the git source of truth for symlink-ness (120000), free in the listing call.
function parseTrackedStage(output: string) {
  return output
    .split("\0")
    .filter((entry) => entry !== "")
    .map((entry) => {
      const tab = entry.indexOf("\t");
      const mode = entry.slice(0, entry.indexOf(" "));
      return { path: entry.slice(tab + 1), symlink: mode === SYMLINK_MODE };
    });
}

export function parseRepoFiles(
  repoRoot: string,
  trackedStageOutput: string,
  untrackedOutput: string,
): Pick<GitModel, "repoFiles" | "repoFilesKey"> {
  const tracked = parseTrackedStage(trackedStageOutput);
  const untracked = untrackedOutput
    .split("\0")
    .filter((path) => path !== "")
    .map((path) => ({ path, symlink: isSymlink(repoRoot, path) }));

  // Key off symlink-ness + path, never the blob sha: a content edit must not churn
  // The repo-file list (and force a full tree rebuild), only a changed file set or a
  // Type flip does. The NUL between flag and path keeps a file named like the flag
  // Unambiguous, and the repoRoot prevents two worktrees from sharing a cache slot.
  const repoFilesKey = [
    repoRoot,
    ...tracked.map((entry) => `t${entry.symlink ? "1" : "0"}\0${entry.path}`),
    ...untracked.map((entry) => `u${entry.symlink ? "1" : "0"}\0${entry.path}`),
  ].join("\x01");

  if (repoFilesCache?.key === repoFilesKey) {
    return { repoFiles: repoFilesCache.repoFiles, repoFilesKey };
  }

  const seen = new Set<string>();
  const repoFiles: RepoFile[] = [];

  for (const { path, symlink } of tracked) {
    if (!seen.has(path)) {
      seen.add(path);
      repoFiles.push({ path, symlink, tracked: true });
    }
  }

  for (const { path, symlink } of untracked) {
    if (!seen.has(path)) {
      seen.add(path);
      repoFiles.push({ path, symlink, tracked: false });
    }
  }

  repoFilesCache = { key: repoFilesKey, repoFiles };
  return { repoFiles, repoFilesKey };
}

// Untracked files carry no git mode, so the worktree is the only source; the set is
// Bounded by --exclude-standard, and this module already stats per file (fileMtime).
function isSymlink(repoRoot: string, path: string) {
  try {
    return lstatSync(`${repoRoot}/${path}`).isSymbolicLink();
  } catch {
    return false;
  }
}

export function parseUntrackedFiles(output: string): StatusEntry[] {
  return output
    .split("\0")
    .filter((path) => path !== "")
    .map((path) => ({ kind: "untracked", path }));
}

export function parseNumstat(output: string) {
  const tokens = output.split("\0");
  const entries: { path: string; additions: number; deletions: number; binary: boolean }[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined || token === "") {
      continue;
    }

    const [addedRaw = "0", deletedRaw = "0", ...pathParts] = token.split("\t");
    let path = pathParts.join("\t");
    // A rename record carries no inline path at all ("added\tdeleted\t" NUL old
    // NUL new), unlike a path that merely ends with a tab
    if (pathParts.length === 1 && pathParts[0] === "") {
      path = tokens[index + 2] ?? "";
      index += 2;
    }

    const binary = addedRaw === "-" || deletedRaw === "-";
    entries.push({
      additions: binary ? 0 : Number.parseInt(addedRaw, 10),
      binary,
      deletions: binary ? 0 : Number.parseInt(deletedRaw, 10),
      path,
    });
  }

  return entries;
}

export function parseNameStatus(output: string): StatusEntry[] {
  const tokens = output.split("\0");
  const entries: StatusEntry[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const status = tokens[index];
    if (status === undefined || status.trim() === "") {
      continue;
    }

    const code = status[0];

    if (code === "R" || code === "C") {
      const oldPath = tokens[index + 1] ?? "";
      const path = tokens[index + 2] ?? oldPath;
      index += 2;
      // A copy leaves the source untouched, so only the destination is a change
      entries.push(code === "R" ? { kind: "renamed", oldPath, path } : { kind: "added", path });
      continue;
    }

    const path = tokens[index + 1] ?? "";
    index += 1;

    if (code === "A") {
      entries.push({ kind: "added", path });
    } else if (code === "D") {
      entries.push({ kind: "deleted", path });
    } else {
      entries.push({ kind: "modified", path });
    }
  }

  return entries;
}

function inferKind(path: string, deletions: number, additions: number): ChangeKind {
  if (deletions > 0 && additions === 0) {
    return "deleted";
  }

  if (additions > 0 && deletions === 0 && path !== "") {
    return "added";
  }

  return "modified";
}

function fileMtime(repoRoot: string, path: string) {
  try {
    // Lstat, not stat: a symlink's own mtime drives change detection, and a dangling
    // Link reports a real mtime instead of throwing into the 0 fallback.
    return lstatSync(`${repoRoot}/${path}`).mtimeMs;
  } catch {
    return 0;
  }
}

function warningsFor(path: string, kind: ChangeKind, additions: number, deletions: number) {
  const warnings: string[] = [];
  const filename = path.split("/").at(-1) ?? path;

  if (kind === "deleted" || deletions > additions * 2) {
    warnings.push("deletions");
  }

  if (
    filename === "package.json" ||
    filename.endsWith(".lock") ||
    filename === "bun.lockb" ||
    filename === "bun.lock"
  ) {
    warnings.push("deps");
  }

  if (additions + deletions > 500) {
    warnings.push("large");
  }

  if (kind === "untracked") {
    warnings.push("new");
  }

  return warnings;
}

function statUntrackedFile(repoRoot: string, path: string) {
  // LoadFileContent absorbs dangling symlinks and files deleted mid-scan as "missing"
  const content = loadFileContent(repoRoot, path, { full: false });
  if (content.kind === "text") {
    return { additions: content.lineCount, binary: false };
  }

  return { additions: 0, binary: content.kind !== "missing" };
}

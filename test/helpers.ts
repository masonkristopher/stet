import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { Effect, Layer } from "effect";
import { batch } from "solid-js";

import type { DiffScope } from "@/cli";
import { initialCheckerState } from "@/diagnostics/checker";
import { File, FileLive } from "@/file/service";
import type { ChangedFile, GitModel } from "@/git/model";
import { Git, GitLive } from "@/git/service";
import { defaultExpandedDirectories, expandAncestorsForPath } from "@/git/tree";
import type { FileTreeRow } from "@/git/tree";
import { ProcessLive } from "@/process";
import { state } from "@/state";

const GitTestLive = GitLive.pipe(Layer.provide(ProcessLive));
const FileTestLive = FileLive.pipe(Layer.provide(ProcessLive));

// Run the File service against a fixture repo's git-show path, the same path the
// App uses for deleted files, so tests exercise the production classification.
export function loadGitShowContent(repoRoot: string, path: string) {
  return Effect.runPromise(
    File.pipe(
      Effect.flatMap((file) =>
        file.content(repoRoot, path, { full: false, gitSpec: `HEAD:${path}` }),
      ),
      Effect.provide(FileTestLive),
    ),
  );
}

// Run the Git service against a fixture repo, the same path the app uses, so
// Tests exercise the production load instead of a mock.
export function loadModel(repoRoot: string, scope: DiffScope) {
  return Effect.runPromise(
    Git.pipe(
      Effect.flatMap((git) => git.loadModel(repoRoot, scope)),
      Effect.provide(GitTestLive),
    ),
  );
}

export function loadWorktrees(repoRoot: string) {
  return Effect.runPromise(
    Git.pipe(
      Effect.flatMap((git) => git.worktrees(repoRoot)),
      Effect.provide(GitTestLive),
    ),
  );
}

export function loadFileDiff(repoRoot: string, scope: DiffScope, changed: ChangedFile) {
  return Effect.runPromise(
    Git.pipe(
      Effect.flatMap((git) => git.fileDiff(repoRoot, scope, changed)),
      Effect.provide(GitTestLive),
    ),
  );
}

// State is a global singleton, so render tests seed it fresh (and reset the UI
// Signals that might bleed from a prior test) before rendering App. Mirrors the
// Startup seeding in main.tsx.
export function seedState(model: GitModel, scope: DiffScope) {
  const selected = model.changed[0]?.path ?? model.repoFiles[0]?.path;
  const baseExpanded = defaultExpandedDirectories(model.changed.map((file) => file.path));
  const expanded =
    selected === undefined ? baseExpanded : expandAncestorsForPath(baseExpanded, selected);
  batch(() => {
    state.setScope(scope);
    state.setCliBaseRef(scope.ref);
    state.setSessionBase("HEAD");
    state.setScopeMenuOpen(false);
    state.setScopeMenuIndex(0);
    state.setIconsEnabled(true);
    state.setChangesOnly(false);
    state.setNotice(undefined);
    state.setGitModel(model);
    state.setRepoRoot(model.repoRoot);
    state.setLastChange(Date.now());
    state.seedNav(selected);
    state.setFocusedNodeId(selected === undefined ? "" : `file:${selected}`);
    state.setExpandedDirectories(expanded);
    state.setCheckerState(initialCheckerState(model.changed));
    state.setFileView(false);
    state.setFullContentPaths(new Set<string>());
    state.setFocusedPane("tree");
    state.setProblemsOpen(false);
    state.setProblemIndex(0);
    state.setFileComboboxOpen(false);
    state.setFileComboboxQuery("");
    state.setFileComboboxIndex(0);
    state.setWorktreeComboboxOpen(false);
    state.setWorktreeComboboxIndex(0);
    state.setWorktreeComboboxQuery("");
    state.setWorktrees(undefined);
    state.setHelpDialogOpen(false);
    state.setCursorIndex(0);
    state.setJumpTarget(undefined);
    state.setSearchComboboxOpen(false);
    state.setSearchComboboxQuery("");
    state.setSearchComboboxIndex(0);
    state.setSearchComboboxScope("changed");
    state.setThemeComboboxQuery("");
    state.setThemeComboboxIndex(0);
  });
}

export function focusedRow(): FileTreeRow | undefined {
  return state.treeRows()[state.focusedRowIndex()];
}

export function runGit(repoRoot: string, args: string[]) {
  execFileSync(
    "git",
    ["-c", "user.name=Sideye Test", "-c", "user.email=sideye-test@example.com", ...args],
    {
      cwd: repoRoot,
      stdio: "ignore",
    },
  );
}

export function createFixtureRepo(prefix: string, files: Record<string, string>) {
  const repoRoot = mkdtempSync(join(tmpdir(), prefix));

  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(repoRoot, path)), { recursive: true });
    writeFileSync(join(repoRoot, path), content);
  }

  runGit(repoRoot, ["init"]);
  runGit(repoRoot, ["add", "."]);
  runGit(repoRoot, ["commit", "-m", "fixture"]);

  return repoRoot;
}

interface FrameSource {
  renderOnce: () => Promise<void>;
  captureCharFrame: () => string;
}

export function makeSettleUntil({ renderOnce, captureCharFrame }: FrameSource) {
  return async (
    label: string,
    predicate: (frame: string) => boolean,
    minAttempts = 1,
    maxAttempts = 100,
  ) => {
    let frame = "";
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      // oxlint-disable-next-line no-await-in-loop -- polling retry: each tick must complete before the next check
      await new Promise((resolve) => setTimeout(resolve, 10));
      // oxlint-disable-next-line no-await-in-loop -- polling retry: each tick must complete before the next check
      await renderOnce();
      frame = captureCharFrame();
      if (attempt + 1 >= minAttempts && predicate(frame)) {
        return frame;
      }
    }

    throw new Error(`timed out waiting for ${label}\n\n${frame}`);
  };
}

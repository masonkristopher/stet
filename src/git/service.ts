import { Context, Effect, Layer, Schedule } from "effect";

import type { DiffScope } from "@/cli";
import { Process } from "@/process";
import type { CommandError } from "@/process";

import { GitError } from "./errors";
import { buildFilePatch, classifySideBytes, fileDiffSides, readWorktreeSide } from "./file-patch";
import type { FilePatch, PatchSide, SideContent } from "./file-patch";
import { logArgs, parseLog } from "./log";
import type { Commit } from "./log";
import {
  assembleChanged,
  assembleModel,
  diffArgs,
  EMPTY_TREE_SHA,
  nameStatusArgs,
  numstatArgs,
  parseRepoFiles,
  parseWorktreeList,
  untrackedDiffArgs,
} from "./model";
import type { ChangedFile, GitModel, Worktree } from "./model";
import { parseSearchOutput, searchArgs } from "./search";
import type { SearchMatch, SearchOptions } from "./search";

function toGitError(error: CommandError) {
  return new GitError({ message: error.message });
}

function isTransientGit(error: CommandError) {
  // An index.lock (an agent mid-commit) clears on a quick retry
  return /index\.lock|unable to create/i.test(error.stderr);
}

function retryTransient<A>(effect: Effect.Effect<A, CommandError>) {
  return effect.pipe(
    Effect.retry({ schedule: Schedule.spaced("50 millis"), times: 2, while: isTransientGit }),
  );
}

export class Git extends Context.Service<
  Git,
  {
    readonly changedFiles: (
      repoRoot: string,
      scope: DiffScope,
    ) => Effect.Effect<Pick<GitModel, "changed" | "changedByPath" | "scopeKey">, GitError>;
    readonly fileDiff: (
      repoRoot: string,
      scope: DiffScope,
      file: ChangedFile,
    ) => Effect.Effect<string, GitError>;
    /**
     * The full text of the side an expanded gap reveals (the new side, or the old side for a
     * deletion). Loaded lazily on the first gap expansion in a file, never on the diff hot path.
     */
    readonly fileSource: (
      repoRoot: string,
      scope: DiffScope,
      file: ChangedFile,
    ) => Effect.Effect<SideContent, GitError>;
    readonly gitDir: (repoRoot: string) => Effect.Effect<string, GitError>;
    /** The SHA HEAD points at, or the empty tree on a commitless repo. */
    readonly headRef: (repoRoot: string) => Effect.Effect<string, GitError>;
    readonly loadModel: (repoRoot: string, scope: DiffScope) => Effect.Effect<GitModel, GitError>;
    /** HEAD's parent SHA, or the empty tree on a root commit. */
    readonly parentRef: (repoRoot: string) => Effect.Effect<string, GitError>;
    /** The most recent commits (newest first), capped at `limit`. */
    readonly recentCommits: (repoRoot: string, limit: number) => Effect.Effect<Commit[], GitError>;
    readonly repoFiles: (
      repoRoot: string,
    ) => Effect.Effect<Pick<GitModel, "repoFiles" | "repoFilesKey">, GitError>;
    readonly search: (
      repoRoot: string,
      query: string,
      paths: readonly string[] | undefined,
      options: SearchOptions,
    ) => Effect.Effect<SearchMatch[], GitError>;
    readonly worktrees: (repoRoot: string) => Effect.Effect<Worktree[], GitError>;
  }
>()("sideye/Git") {}

export const GitLive = Layer.effect(
  Git,
  Effect.gen(function* gitLive() {
    const process = yield* Process;

    // No retryTransient on `git show`: a bad spec (submodule gitlink, ref gone
    // Mid-flight) should fail fast into the fallback, not retry.
    const fetchSide = (
      repoRoot: string,
      side: PatchSide,
      worktreePath: string,
    ): Effect.Effect<SideContent, CommandError> => {
      if (side.kind === "git") {
        return process
          .run(["git", "show", side.spec], repoRoot)
          .pipe(Effect.map((result) => classifySideBytes(result.stdoutBytes)));
      }
      if (side.kind === "worktree") {
        return Effect.promise(() => readWorktreeSide(repoRoot, worktreePath));
      }
      return Effect.succeed({ kind: "text", text: "" });
    };

    return {
      changedFiles: (repoRoot, scope) =>
        Effect.all(
          [
            process.run(["git", "ls-files", "--others", "--exclude-standard", "-z"], repoRoot),
            process.run(nameStatusArgs(scope), repoRoot),
            process.run(numstatArgs(scope), repoRoot),
            process.run(["git", "status", "--porcelain=v1", "-z"], repoRoot),
          ],
          { concurrency: "unbounded" },
        ).pipe(
          retryTransient,
          Effect.map(([untracked, nameStatus, numstat, porcelain]) =>
            assembleChanged(
              repoRoot,
              scope,
              untracked.stdout,
              nameStatus.stdout,
              numstat.stdout,
              porcelain.stdout,
            ),
          ),
          Effect.mapError(toGitError),
        ),
      // The per-file patch is computed in-process from the scope's two endpoints
      // (blob/worktree reads), never via `git diff <ref> -- <path>`: in very large
      // Repos git's pathspec-limited diff-index walks the whole index (seconds per
      // Invocation, #188), while a blob read stays O(path depth). The pathspec
      // Invocation survives only as the fallback for sides an in-process diff
      // Can't reproduce faithfully (submodules, eol conversion, oversized files).
      fileDiff: (repoRoot, scope, file) => {
        if (file.kind === "untracked") {
          return process
            .run(untrackedDiffArgs(file.path), repoRoot, { allowedExitCodes: [0, 1] })
            .pipe(
              Effect.map((result) => result.stdout),
              Effect.mapError(toGitError),
            );
        }

        // Numstat already flagged it binary; the render is a model-driven
        // Placeholder, so skip both side fetches.
        if (file.binary) {
          return Effect.succeed("");
        }

        const pathspecDiff = process
          .run(
            [
              ...diffArgs(scope),
              "--",
              ...(file.oldPath === undefined ? [file.path] : [file.oldPath, file.path]),
            ],
            repoRoot,
            { allowedExitCodes: [0, 1] },
          )
          .pipe(
            Effect.map((result) => result.stdout),
            Effect.mapError(toGitError),
          );

        const { newSide, oldSide } = fileDiffSides(scope, file);

        return Effect.all(
          [fetchSide(repoRoot, oldSide, file.path), fetchSide(repoRoot, newSide, file.path)],
          { concurrency: "unbounded" },
        ).pipe(
          Effect.map(([oldContent, newContent]) => buildFilePatch(file, oldContent, newContent)),
          // A `git show` failure (submodule gitlink, ref gone mid-flight) falls
          // Back to the pathspec diff; scoped to CommandError so nothing else is
          // Swallowed into a fallback.
          Effect.catchTag("CommandError", () => Effect.succeed<FilePatch>({ kind: "fallback" })),
          Effect.flatMap((built) =>
            built.kind === "patch" ? Effect.succeed(built.patch) : pathspecDiff,
          ),
        );
      },
      fileSource: (repoRoot, scope, file) => {
        const { newSide, oldSide } = fileDiffSides(scope, file);
        return fetchSide(repoRoot, file.kind === "deleted" ? oldSide : newSide, file.path).pipe(
          Effect.mapError(toGitError),
        );
      },
      // The per-worktree git dir, absolute. In a linked worktree this resolves
      // Outside the worktree tree (to <main>/.git/worktrees/<name>), so the watcher
      // Watches it as a second root to catch staging/commit/checkout there.
      gitDir: (repoRoot) =>
        process.run(["git", "rev-parse", "--absolute-git-dir"], repoRoot).pipe(
          retryTransient,
          Effect.map((result) => result.stdout.trim()),
          Effect.mapError(toGitError),
        ),
      // Exit 128 is a commitless repo (no HEAD); fall back to the empty tree so
      // The session base is still a valid diff endpoint.
      headRef: (repoRoot) =>
        process
          .run(["git", "rev-parse", "--verify", "HEAD"], repoRoot, { allowedExitCodes: [0, 128] })
          .pipe(
            retryTransient,
            Effect.map((result) => result.stdout.trim() || EMPTY_TREE_SHA),
            Effect.mapError(toGitError),
          ),
      loadModel: (repoRoot, scope) =>
        Effect.all(
          [
            process.run(["git", "ls-files", "--stage", "-z"], repoRoot),
            process.run(["git", "ls-files", "--others", "--exclude-standard", "-z"], repoRoot),
            process.run(nameStatusArgs(scope), repoRoot),
            process.run(numstatArgs(scope), repoRoot),
            process.run(["git", "status", "--porcelain=v1", "-z"], repoRoot),
          ],
          { concurrency: "unbounded" },
        ).pipe(
          retryTransient,
          Effect.map(([tracked, untracked, nameStatus, numstat, porcelain]) =>
            assembleModel(
              repoRoot,
              scope,
              tracked.stdout,
              untracked.stdout,
              nameStatus.stdout,
              numstat.stdout,
              porcelain.stdout,
            ),
          ),
          Effect.mapError(toGitError),
        ),
      // Exit 128 is a root commit (no HEAD~1); fall back to the empty tree so the
      // Whole first commit renders as all-added.
      parentRef: (repoRoot) =>
        process
          .run(["git", "rev-parse", "--verify", "HEAD~1"], repoRoot, { allowedExitCodes: [0, 128] })
          .pipe(
            retryTransient,
            Effect.map((result) => result.stdout.trim() || EMPTY_TREE_SHA),
            Effect.mapError(toGitError),
          ),
      // Exit 128 is a commitless repo (unborn HEAD): `git log` has no output, so
      // Allow it and parse the empty stdout to an empty list, letting the picker
      // Show its empty state instead of a failure notice (same as parentRef).
      recentCommits: (repoRoot, limit) =>
        process.run(logArgs(limit), repoRoot, { allowedExitCodes: [0, 128] }).pipe(
          retryTransient,
          Effect.map((result) => parseLog(result.stdout)),
          Effect.mapError(toGitError),
        ),
      repoFiles: (repoRoot) =>
        Effect.all(
          [
            process.run(["git", "ls-files", "--stage", "-z"], repoRoot),
            process.run(["git", "ls-files", "--others", "--exclude-standard", "-z"], repoRoot),
          ],
          { concurrency: "unbounded" },
        ).pipe(
          retryTransient,
          Effect.map(([tracked, untracked]) =>
            parseRepoFiles(repoRoot, tracked.stdout, untracked.stdout),
          ),
          Effect.mapError(toGitError),
        ),
      // Git grep exits 1 when nothing matches, which is a normal empty result.
      search: (repoRoot, query, paths, options) =>
        process.run(searchArgs(query, paths, options), repoRoot, { allowedExitCodes: [0, 1] }).pipe(
          retryTransient,
          // Bytes, not the decoded stdout: the parse converts git's byte columns
          // Against the raw line, immune to replacement-char width drift.
          Effect.map((result) => parseSearchOutput(result.stdoutBytes)),
          Effect.mapError(toGitError),
        ),
      worktrees: (repoRoot) =>
        process.run(["git", "worktree", "list", "--porcelain", "-z"], repoRoot).pipe(
          retryTransient,
          Effect.map((result) => parseWorktreeList(result.stdout)),
          Effect.mapError(toGitError),
        ),
    };
  }),
);

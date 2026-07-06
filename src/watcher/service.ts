import { watch } from "node:fs";

import { Context, Effect, Layer, Queue, Stream } from "effect";

import { Git } from "@/git/service";

import { shouldRefresh } from "./filter";
import { watchRoots } from "./scope";

const DEBOUNCE = "100 millis";

/**
 * Filesystem-change ticks for a worktree, debounced so an agent's burst of writes collapses into
 * one. Each tick means "something changed, re-derive git state"; it carries no path, since the
 * consumer always re-runs the full `changedFiles`. Watch failures (a platform without recursive
 * support, a sandbox without inotify) are swallowed: that root simply never ticks and the caller's
 * slow poll remains the correctness floor.
 */
export class Watcher extends Context.Service<
  Watcher,
  {
    readonly changes: (repoRoot: string) => Stream.Stream<void>;
  }
>()("stet/Watcher") {}

function watchStream(roots: ReturnType<typeof watchRoots>) {
  return Stream.callback<void>(
    (queue) =>
      Effect.gen(function* watch_() {
        const watchers = roots.flatMap((root) => {
          try {
            const watcher = watch(root.path, { recursive: true }, (_event, filename) => {
              if (shouldRefresh(root.gitInternalPrefix, filename)) {
                Queue.offerUnsafe(queue, undefined);
              }
            });
            // An async watcher error (e.g. the root is removed) must not crash the
            // Stream; drop it and let the slow poll cover that root.
            watcher.on("error", () => {});
            return [watcher];
          } catch {
            return [];
          }
        });
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            for (const watcher of watchers) {
              watcher.close();
            }
          }),
        );
        return yield* Effect.never;
      }),
    { bufferSize: 1, strategy: "dropping" },
  ).pipe(Stream.debounce(DEBOUNCE));
}

export const WatcherLive = Layer.effect(
  Watcher,
  Effect.gen(function* watcherLive() {
    const git = yield* Git;

    return {
      changes: (repoRoot) =>
        Stream.unwrap(
          git.gitDir(repoRoot).pipe(
            Effect.map((gitDir) => watchStream(watchRoots(repoRoot, gitDir))),
            Effect.orElseSucceed(() => watchStream(watchRoots(repoRoot, undefined))),
          ),
        ),
    };
  }),
);

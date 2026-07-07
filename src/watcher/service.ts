import { watch } from "node:fs";

import { Context, Effect, Layer, Queue, Stream } from "effect";

import { Git } from "@/git/service";

import { classify } from "./filter";
import { watchRoots } from "./scope";

const DEBOUNCE_MS = 100;

/**
 * Filesystem-change batches for a worktree, debounced so an agent's burst of writes collapses into
 * one. Each emit means "something changed, re-derive git state"; its array is the worktree-relative
 * paths written this batch (empty for a git-internal-only or nameless batch). The consumer ticks
 * the git refresh on every emit and invalidates the content-keyed intel cache only for a path it
 * knows is tracked (so gitignored churn like `node_modules/` does not wipe the cache, and a commit,
 * which touches only `.git`, carries no path). Watch failures (a platform without recursive
 * support, a sandbox without inotify) are swallowed: that root simply never ticks and the caller's
 * slow poll remains the correctness floor.
 */
export class Watcher extends Context.Service<
  Watcher,
  {
    readonly changes: (repoRoot: string) => Stream.Stream<readonly string[]>;
  }
>()("stet/Watcher") {}

function watchStream(roots: ReturnType<typeof watchRoots>) {
  return Stream.callback<readonly string[]>(
    (queue) =>
      Effect.gen(function* watch_() {
        // Debounce inside the callback so a burst collapses to one emit. `pending` accumulates the
        // Named worktree paths written in the window; a plain keep-last `Stream.debounce` would drop
        // Earlier paths whenever the window's last event was git-internal or a different file.
        const pending = new Set<string>();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const flush = () => {
          timer = undefined;
          const paths = [...pending];
          // Clear the pending set only once the emit is accepted. The callback queue is bufferSize-1
          // Dropping, so a burst could drop this offer; if it carried worktree paths (the intel
          // Signal) keep them and retry rather than losing them. A dropped empty batch is only a
          // Git-refresh tick, and the safety poll is its floor.
          if (Queue.offerUnsafe(queue, paths)) {
            pending.clear();
          } else if (pending.size > 0) {
            timer = setTimeout(flush, DEBOUNCE_MS);
          }
        };
        const watchers = roots.flatMap((root) => {
          try {
            const watcher = watch(root.path, { recursive: true }, (_event, filename) => {
              const kind = classify(root.gitInternalPrefix, filename);
              if (kind === "ignored") {
                return;
              }
              // A named worktree write is intel-relevant; a git-internal or nameless event still
              // Ticks the refresh but carries no path (nameless real edits ride the mtime poll floor).
              if (kind === "worktree" && typeof filename === "string") {
                pending.add(filename);
              }
              if (timer !== undefined) {
                clearTimeout(timer);
              }
              timer = setTimeout(flush, DEBOUNCE_MS);
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
            if (timer !== undefined) {
              clearTimeout(timer);
            }
            for (const watcher of watchers) {
              watcher.close();
            }
          }),
        );
        return yield* Effect.never;
      }),
    { bufferSize: 1, strategy: "dropping" },
  );
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

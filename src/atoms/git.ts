import { Effect, Stream } from "effect"
import { Atom, AtomRegistry } from "effect/unstable/reactivity"
import { mergeChanged, type GitModel } from "../git"
import { Git } from "../services/git"
import { runtime } from "./runtime"
import { scopeAtom } from "./ui"

// Placeholder until App seeds the real initial model (synchronously, before the
// First read), so derived atoms never have to guard an undefined model.
const emptyModel: GitModel = {
  changed: [],
  changedByPath: new Map(),
  repoFiles: [],
  repoFilesKey: "",
  repoRoot: "",
  scopeKey: "",
}

export const gitModelAtom = Atom.make(emptyModel)
// The poll keys on these (not on gitModelAtom) so writing the model never
// Restarts the poll; only a worktree switch (repoRoot) or scope switch re-keys.
export const repoRootAtom = Atom.make("")
export const lastChangeAtom = Atom.make(0)

// Adaptive git poll as an effect-backed atom. Re-keying on repoRoot/scope
// Interrupts the prior fiber, which the Process service turns into a kill of any
// In-flight git, replacing the old cancelled/in-flight flags and worktree race.
export const gitPollAtom = runtime
  .atom((get) => {
    const repoRoot = get(repoRootAtom)
    const scope = get(scopeAtom)

    const fast = Stream.fromEffect(
      Effect.gen(function* fastPoll() {
        const git = yield* Git
        const registry = yield* AtomRegistry.AtomRegistry
        yield* git.changedFiles(repoRoot, scope).pipe(
          Effect.tap((next) =>
            Effect.sync(() => {
              const prev = registry.get(gitModelAtom)
              if (prev.repoRoot === repoRoot) {
                registry.set(gitModelAtom, mergeChanged(prev, next))
              }
            }),
          ),
          Effect.ignore,
        )
        // 750ms while active, 2s after 10s of quiet (registry.get, no re-key)
        const quiet = Date.now() - registry.get(lastChangeAtom) > 10_000
        yield* Effect.sleep(quiet ? "2 seconds" : "750 millis")
      }),
    ).pipe(Stream.forever)

    const slow = Stream.fromEffect(
      Effect.gen(function* slowPoll() {
        const git = yield* Git
        const registry = yield* AtomRegistry.AtomRegistry
        yield* git.repoFiles(repoRoot).pipe(
          Effect.tap((next) =>
            Effect.sync(() => {
              const prev = registry.get(gitModelAtom)
              if (prev.repoRoot === repoRoot && prev.repoFilesKey !== next.repoFilesKey) {
                registry.set(gitModelAtom, { ...prev, repoFiles: next.repoFiles, repoFilesKey: next.repoFilesKey })
              }
            }),
          ),
          Effect.ignore,
        )
        yield* Effect.sleep("5 seconds")
      }),
    ).pipe(Stream.forever)

    return Stream.merge(fast, slow)
  })
  .pipe(Atom.keepAlive)

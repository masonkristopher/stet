import { Effect, Stream } from "effect"
import { Atom, AtomRegistry } from "effect/unstable/reactivity"
import { activityLogAtom } from "./activity"
import { gitModelAtom } from "./git"
import {
  allFindings,
  checkerNames,
  countBySeverity,
  findingsLineMap,
  initialCheckerState,
  type CheckerName,
  type CheckerState,
  type Diagnostic,
} from "../diagnostics"
import type { GitModel } from "../git"
import { Diagnostics } from "../services/diagnostics"
import { runtime } from "./runtime"
import { selectedPathAtom } from "./ui"

export type ProblemItem =
  | { kind: "failure"; id: string; checker: CheckerName; line: string; isFirst: boolean }
  | { kind: "problem"; id: string; problem: Diagnostic }

export const checkerStateAtom = Atom.make<CheckerState>(initialCheckerState([]))
export const statusAtom = Atom.make("")

// Running the checks. The latest call interrupts the prior fiber, which aborts
// In-flight checker processes and stops consuming stale stream updates, so the
// Old runGenerationRef + AbortController bookkeeping is gone.
export const runChecksAtom = runtime.fn<GitModel>()((target, get) =>
  Effect.gen(function* runChecks() {
    get.set(checkerStateAtom, initialCheckerState(target.changed))
    const failures: string[] = []
    const diagnostics = yield* Diagnostics
    yield* diagnostics.run(target.repoRoot, target.changed).pipe(
      Stream.runForEach((update) =>
        Effect.sync(() => {
          get.set(checkerStateAtom, { ...get(checkerStateAtom), [update.checker]: update.state })
          for (const fileState of update.state.values()) {
            if (fileState.status === "failed") {
              failures.push(`${update.checker} failed: ${fileState.message?.split("\n")[0] ?? ""}`)
              break
            }
          }
        }),
      ),
    )
    get.set(statusAtom, failures[0] ?? "checks finished")
  }),
)

export const problemsAtom = Atom.make((get) => allFindings(get(checkerStateAtom)))
export const countsAtom = Atom.make((get) => countBySeverity(get(problemsAtom)))

const checkerFailuresAtom = Atom.make((get) => {
  const checkerState = get(checkerStateAtom)
  return checkerNames.flatMap((checker) => {
    for (const [, fileState] of checkerState[checker]) {
      if (fileState.status === "failed" && fileState.message !== undefined) {
        return [{ checker, message: fileState.message }]
      }
    }
    return []
  })
})

export const allProblemItemsAtom = Atom.make((get) => {
  const items: ProblemItem[] = []
  get(checkerFailuresAtom).forEach(({ checker, message }, failureIndex) => {
    message
      .split("\n")
      .filter((line) => line.trim() !== "")
      .forEach((line, lineIndex) => {
        items.push({ checker, id: `failure-${failureIndex}-${lineIndex}`, isFirst: lineIndex === 0, kind: "failure", line })
      })
  })
  get(problemsAtom).forEach((problem, index) => {
    items.push({ id: `problem-${index}`, kind: "problem", problem })
  })
  return items
})

export const lineMapAtom = Atom.make((get) => {
  const selectedPath = get(selectedPathAtom)
  return selectedPath === undefined ? new Map<number, Diagnostic[]>() : findingsLineMap(selectedPath, get(checkerStateAtom))
})

// Re-run the checks once the repo has been quiet for 2s. Re-keying on each new
// Activity interrupts the prior sleep, which is the debounce the old setTimeout
// Gave us, now as fiber interruption.
export const quietRerunAtom = Atom.make((get) => {
  if (get(activityLogAtom).events.length === 0) {
    return Stream.empty
  }

  return Stream.fromEffect(
    Effect.gen(function* quietRerun() {
      const registry = yield* AtomRegistry.AtomRegistry
      yield* Effect.sleep("2 seconds")
      yield* Effect.sync(() => registry.set(runChecksAtom, registry.get(gitModelAtom)))
    }),
  )
}).pipe(Atom.keepAlive)

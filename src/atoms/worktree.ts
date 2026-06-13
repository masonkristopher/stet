import { Effect } from "effect"
import type { DiffScope } from "../cli"
import { Git } from "../services/git"
import { statusAtom } from "./diagnostics"
import { runtime } from "./runtime"
import { worktreeIndexAtom, worktreeOpenAtom, worktreesAtom } from "./ui"

// Load a worktree's model on demand for a switch; the switch handler awaits the
// Fresh model (promise mode) to re-seed the dependent atoms.
export const loadModelAtom = runtime.fn<{ repoRoot: string; scope: DiffScope }>()((input) =>
  Git.pipe(Effect.flatMap((git) => git.loadModel(input.repoRoot, input.scope))),
)

// Populate the worktree picker. Dispatching again interrupts the prior fiber
// (and its in-flight git), so a slow earlier load cannot repopulate a newer
// Picker, replacing the old request-id race guard.
export const loadWorktreesAtom = runtime.fn<string>()((repoRoot, get) =>
  Git.pipe(
    Effect.flatMap((git) => git.worktrees(repoRoot)),
    Effect.flatMap((list) =>
      Effect.sync(() => {
        // Bare entries have no files to review
        const selectable = list.filter((worktree) => !worktree.bare)
        get.set(worktreesAtom, selectable)
        get.set(
          worktreeIndexAtom,
          Math.max(
            0,
            selectable.findIndex((worktree) => worktree.path === repoRoot),
          ),
        )
      }),
    ),
    Effect.catch((error) =>
      Effect.sync(() => {
        get.set(worktreeOpenAtom, false)
        get.set(statusAtom, error.message.split("\n")[0] ?? "")
      }),
    ),
  ),
)

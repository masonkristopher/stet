import type { KeyEvent } from "@opentui/core"
import type { Atom, AtomRegistry } from "effect/unstable/reactivity"
import { latestActivity } from "./activity"
import { activityLogAtom } from "./atoms/activity"
import { copyAtom } from "./atoms/clipboard"
import { allProblemItemsAtom, problemsAtom, runChecksAtom, statusAtom } from "./atoms/diagnostics"
import { cursorIndexAtom, jumpTargetAtom } from "./atoms/diff"
import { gitModelAtom } from "./atoms/git"
import { paletteResultsAtom } from "./atoms/palette"
import { focusedRowIndexAtom, treeRowsAtom } from "./atoms/tree"
import { loadWorktreesAtom } from "./atoms/worktree"
import {
  changesOnlyAtom,
  expandedDirectoriesAtom,
  fileViewAtom,
  focusedPaneAtom,
  fullContentPathsAtom,
  helpOpenAtom,
  paletteIndexAtom,
  paletteOpenAtom,
  paletteQueryAtom,
  problemIndexAtom,
  problemsOpenAtom,
  scopeAtom,
  selectedPathAtom,
  sidebarOpenAtom,
  worktreeIndexAtom,
  worktreeOpenAtom,
  worktreesAtom,
} from "./atoms/ui"
import { navigableLinesAtom, selectedFileAtom } from "./atoms/viewer"
import { nextScope, scopeLabel } from "./cli"
import { formatCopyReference } from "./copy-reference"
import type { Worktree } from "./git"
import { lineReference } from "./patch"
import { firstFileInNode } from "./tree"
import { nextFindingPath, orderedFindingPaths } from "./ui-helpers"

interface KeyHandlerCtx {
  viewerHeight: number
  quit: () => void
  switchWorktree: (worktree: Worktree) => Promise<void> | void
  selectFile: (path: string) => void
}

// One handler routes every key through the modal-precedence chain
// (help > worktree > palette > global > pane-specific). The order of the early
// Returns is load-bearing: an open overlay must swallow keys before any later
// Branch can act on them. State is read and written through the atom registry,
// So every keypress sees the latest values, not a render-time snapshot.
export function createKeyHandler(registry: AtomRegistry.AtomRegistry, ctx: KeyHandlerCtx) {
  const { viewerHeight, quit, switchWorktree, selectFile } = ctx

  function get<A>(atom: Atom.Atom<A>) {
    return registry.get(atom)
  }

  function set<R, W>(atom: Atom.Writable<R, W>, value: W) {
    registry.set(atom, value)
  }

  return (key: KeyEvent) => {
    if (get(helpOpenAtom)) {
      if (key.name === "escape" || key.name === "?" || key.name === "q") {
        set(helpOpenAtom, false)
      }
      // Every other key belongs to the help overlay
      return
    }

    if (get(worktreeOpenAtom)) {
      const worktrees = get(worktreesAtom)
      const lastIndex = Math.max(0, (worktrees?.length ?? 1) - 1)
      if (key.name === "escape" || key.name === "w") {
        set(worktreeOpenAtom, false)
      } else if (key.name === "j" || key.name === "down") {
        set(worktreeIndexAtom, Math.min(get(worktreeIndexAtom) + 1, lastIndex))
      } else if (key.name === "k" || key.name === "up") {
        set(worktreeIndexAtom, Math.max(get(worktreeIndexAtom) - 1, 0))
      } else if (key.name === "return") {
        const worktree = worktrees?.[get(worktreeIndexAtom)]
        if (worktree !== undefined) {
          void switchWorktree(worktree)
        }
      }
      // Every other key belongs to the picker
      return
    }

    if (get(paletteOpenAtom)) {
      if (key.name === "escape") {
        set(paletteOpenAtom, false)
      } else if (key.name === "down" || (key.ctrl && key.name === "n")) {
        set(paletteIndexAtom, Math.min(get(paletteIndexAtom) + 1, Math.max(0, get(paletteResultsAtom).length - 1)))
      } else if (key.name === "up" || (key.ctrl && key.name === "p")) {
        set(paletteIndexAtom, Math.max(get(paletteIndexAtom) - 1, 0))
      }
      // Every other key belongs to the palette input
      return
    }

    if (key.ctrl && key.name === "p") {
      set(paletteOpenAtom, true)
      set(paletteQueryAtom, "")
      set(paletteIndexAtom, 0)
      return
    }

    if (key.name === "q") {
      quit()
      return
    }

    if (key.name === "escape") {
      if (get(problemsOpenAtom)) {
        set(problemsOpenAtom, false)
        if (get(focusedPaneAtom) === "problems") {
          set(focusedPaneAtom, "tree")
        }
      } else {
        quit()
      }
      return
    }

    if (key.name === "tab") {
      set(focusedPaneAtom, get(focusedPaneAtom) === "diff" ? "tree" : "diff")
      return
    }

    if (key.name === "p") {
      const open = get(problemsOpenAtom)
      set(focusedPaneAtom, open ? "tree" : "problems")
      set(problemsOpenAtom, !open)
      return
    }

    if (key.name === "b") {
      const open = get(sidebarOpenAtom)
      if (open && get(focusedPaneAtom) === "tree") {
        set(focusedPaneAtom, "diff")
      }
      set(sidebarOpenAtom, !open)
      return
    }

    if (key.name === "?") {
      set(helpOpenAtom, true)
      return
    }

    if (key.name === "w") {
      set(worktreeOpenAtom, true)
      set(worktreeIndexAtom, 0)
      set(worktreesAtom, undefined)
      set(loadWorktreesAtom, get(gitModelAtom).repoRoot)
      return
    }

    if (key.name === "s") {
      const current = get(scopeAtom)
      const next = { ...current, kind: nextScope(current.kind) }
      set(scopeAtom, next)
      set(statusAtom, `scope: ${scopeLabel(next)}`)
      return
    }

    if (key.name === "c") {
      const current = get(changesOnlyAtom)
      set(changesOnlyAtom, !current)
      set(statusAtom, current ? "showing all files" : "showing changes only")
      return
    }

    if (key.name === ".") {
      const latest = latestActivity(get(activityLogAtom))
      if (latest !== undefined) {
        selectFile(latest.path)
      }
      return
    }

    const selectedPath = get(selectedPathAtom)

    if (key.name === "v" && get(selectedFileAtom) !== undefined && selectedPath !== undefined) {
      const line = get(navigableLinesAtom)[get(cursorIndexAtom)]
      const lineNumber = line?.newLine ?? line?.oldLine
      if (lineNumber !== undefined) {
        set(jumpTargetAtom, { escalate: false, line: lineNumber, path: selectedPath })
      }
      set(fileViewAtom, !get(fileViewAtom))
      return
    }

    if (key.name === "n") {
      const next = nextFindingPath(orderedFindingPaths(get(problemsAtom)), selectedPath)
      if (next !== undefined) {
        selectFile(next)
      }
      return
    }

    if (key.name === "r") {
      set(runChecksAtom, get(gitModelAtom))
      return
    }

    if (key.name === "f" && selectedPath !== undefined) {
      set(fullContentPathsAtom, new Set(get(fullContentPathsAtom)).add(selectedPath))
      set(statusAtom, `loaded full content for ${selectedPath}`)
      return
    }

    if (key.name === "y" && selectedPath !== undefined) {
      const line = get(navigableLinesAtom)[get(cursorIndexAtom)]
      const reference = line === undefined ? { path: selectedPath } : lineReference(selectedPath, line)
      set(copyAtom, formatCopyReference(reference))
      return
    }

    const focusedPane = get(focusedPaneAtom)

    if (focusedPane === "problems") {
      const allProblemItems = get(allProblemItemsAtom)
      if (key.name === "j" || key.name === "down") {
        set(problemIndexAtom, Math.min(get(problemIndexAtom) + 1, Math.max(0, allProblemItems.length - 1)))
      } else if (key.name === "k" || key.name === "up") {
        set(problemIndexAtom, Math.max(get(problemIndexAtom) - 1, 0))
      } else if (key.name === "return") {
        const item = allProblemItems[get(problemIndexAtom)]
        if (item?.kind === "problem") {
          const { problem } = item
          selectFile(problem.path)
          if (problem.line !== undefined) {
            set(jumpTargetAtom, { escalate: true, line: problem.line, path: problem.path })
          }
          set(focusedPaneAtom, "diff")
        }
      }
      return
    }

    if (focusedPane === "diff") {
      const last = get(navigableLinesAtom).length - 1
      const halfPage = Math.max(1, Math.floor(viewerHeight / 2))

      if (key.name === "j" || key.name === "down") {
        set(cursorIndexAtom, Math.max(0, Math.min(get(cursorIndexAtom) + 1, last)))
      } else if (key.name === "k" || key.name === "up") {
        set(cursorIndexAtom, Math.max(get(cursorIndexAtom) - 1, 0))
      } else if (key.ctrl && key.name === "d") {
        set(cursorIndexAtom, Math.max(0, Math.min(get(cursorIndexAtom) + halfPage, last)))
      } else if (key.ctrl && key.name === "u") {
        set(cursorIndexAtom, Math.max(get(cursorIndexAtom) - halfPage, 0))
      } else if (key.name === "g" && !key.shift) {
        set(cursorIndexAtom, 0)
      } else if (key.name === "g" || key.name === "G") {
        set(cursorIndexAtom, Math.max(0, last))
      } else if (key.name === "h" || key.name === "left") {
        set(focusedPaneAtom, "tree")
      }

      return
    }

    if (key.name === "j" || key.name === "down") {
      set(focusedRowIndexAtom, 1)
      return
    }

    if (key.name === "k" || key.name === "up") {
      set(focusedRowIndexAtom, -1)
      return
    }

    const treeRows = get(treeRowsAtom)
    const focusedRowIndex = get(focusedRowIndexAtom)

    if (key.name === "l" || key.name === "right") {
      const row = treeRows[focusedRowIndex]
      if (row?.node.type === "directory") {
        set(expandedDirectoriesAtom, new Set(get(expandedDirectoriesAtom)).add(row.node.id))
      } else if (row?.node.type === "file") {
        selectFile(row.node.path)
      }
      return
    }

    if (key.name === "h" || key.name === "left") {
      const row = treeRows[focusedRowIndex]
      if (row?.node.type === "directory") {
        const next = new Set(get(expandedDirectoriesAtom))
        next.delete(row.node.id)
        set(expandedDirectoriesAtom, next)
      }
      return
    }

    if (key.name === "return") {
      const row = treeRows[focusedRowIndex]
      if (row !== undefined) {
        const file = firstFileInNode(row.node)
        if (file !== undefined) {
          selectFile(file.path)
        }
      }
    }
  }
}

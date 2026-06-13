import { Atom } from "effect/unstable/reactivity"
import type { DiffScope } from "../cli"
import type { Worktree } from "../git"

export const scopeAtom = Atom.make<DiffScope>({ kind: "all", ref: "HEAD" })
export const changesOnlyAtom = Atom.make(false)
export const selectedPathAtom = Atom.make<string | undefined>(undefined)
export const expandedDirectoriesAtom = Atom.make(new Set<string>())
export const fileViewAtom = Atom.make(false)
export const fullContentPathsAtom = Atom.make(new Set<string>())
// The id of the tree node under the cursor (a file or directory). focusedRowIndex
// Derives from this, so cursor position and selection can never desync.
export const focusedNodeIdAtom = Atom.make("")

export const focusedPaneAtom = Atom.make<"tree" | "diff" | "problems">("tree")
export const sidebarOpenAtom = Atom.make(true)
export const problemsOpenAtom = Atom.make(false)
export const problemIndexAtom = Atom.make(0)
export const paletteOpenAtom = Atom.make(false)
export const paletteQueryAtom = Atom.make("")
export const paletteIndexAtom = Atom.make(0)
export const worktreeOpenAtom = Atom.make(false)
export const worktreeIndexAtom = Atom.make(0)
export const worktreesAtom = Atom.make<Worktree[] | undefined>(undefined)
export const helpOpenAtom = Atom.make(false)

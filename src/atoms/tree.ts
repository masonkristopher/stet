import { Atom } from "effect/unstable/reactivity"
import { buildFileTree, flattenTree } from "../tree"
import { gitModelAtom } from "./git"
import { changesOnlyAtom, expandedDirectoriesAtom, fileViewAtom, focusedNodeIdAtom, selectedPathAtom } from "./ui"

const treeAtom = Atom.make((get) => {
  const model = get(gitModelAtom)
  return buildFileTree(model.repoFiles, model.changedByPath, { changesOnly: get(changesOnlyAtom) })
})

export const treeRowsAtom = Atom.make((get) => flattenTree(get(treeAtom), get(expandedDirectoriesAtom)))

// Reading derives the cursor row from the focused node id; writing a direction
// (+1/-1) advances the cursor and selects the file it lands on. The write reads
// The latest state via ctx, so rapid keypresses cannot collapse into one move.
export const focusedRowIndexAtom = Atom.writable(
  (get) => {
    const rows = get(treeRowsAtom)
    const index = rows.findIndex((row) => row.node.id === get(focusedNodeIdAtom))
    return index !== -1 ? index : 0
  },
  (ctx, direction: number) => {
    const rows = ctx.get(treeRowsAtom)
    const node = rows[Math.max(0, Math.min(ctx.get(focusedRowIndexAtom) + direction, rows.length - 1))]?.node
    if (node === undefined) {
      return
    }

    ctx.set(focusedNodeIdAtom, node.id)
    if (node.type === "file") {
      ctx.set(selectedPathAtom, node.path)
      ctx.set(fileViewAtom, false)
    }
  },
)

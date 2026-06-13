import { Atom } from "effect/unstable/reactivity"

// Escalate lets a jump switch into file view to find its exact line; without
// It a miss lands on the nearest line in the current view.
export interface JumpTarget {
  path: string
  line: number
  escalate: boolean
}

export const cursorIndexAtom = Atom.make(0)
export const jumpTargetAtom = Atom.make<JumpTarget | undefined>(undefined)

import { expect, test } from "bun:test"
import { AtomRegistry } from "effect/unstable/reactivity"
import { gitModelAtom } from "../src/atoms/git"
import { focusedRowIndexAtom } from "../src/atoms/tree"
import { focusedNodeIdAtom, selectedPathAtom } from "../src/atoms/ui"
import type { GitModel } from "../src/git"

function modelWith(paths: string[]): GitModel {
  return {
    changed: [],
    changedByPath: new Map(),
    repoFiles: paths.map((path) => ({ path, tracked: true })),
    repoFilesKey: "k",
    repoRoot: "/x",
    scopeKey: "all:HEAD",
  }
}

test("focusedRowIndex derives from the focused node and selecting a file on move", () => {
  const registry = AtomRegistry.make()
  registry.set(gitModelAtom, modelWith(["a.ts", "b.ts", "c.ts"]))
  registry.set(focusedNodeIdAtom, "file:a.ts")

  expect(registry.get(focusedRowIndexAtom)).toBe(0)

  registry.set(focusedRowIndexAtom, 1)
  expect(registry.get(focusedRowIndexAtom)).toBe(1)
  expect(registry.get(selectedPathAtom)).toBe("b.ts")
})

test("consecutive moves before a re-render advance by each step, not collapse", () => {
  const registry = AtomRegistry.make()
  registry.set(gitModelAtom, modelWith(["a.ts", "b.ts", "c.ts"]))
  registry.set(focusedNodeIdAtom, "file:a.ts")

  registry.set(focusedRowIndexAtom, 1)
  registry.set(focusedRowIndexAtom, 1)

  expect(registry.get(focusedRowIndexAtom)).toBe(2)
  expect(registry.get(selectedPathAtom)).toBe("c.ts")
})

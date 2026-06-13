import { expect, test } from "bun:test"
import { AtomRegistry } from "effect/unstable/reactivity"
import { activityLogAtom, recencyByPathAtom } from "../src/atoms/activity"

test("recencyByPathAtom maps each path to its last activity timestamp", () => {
  const registry = AtomRegistry.make()

  registry.set(activityLogAtom, {
    events: [
      { at: 1000, kind: "changed", path: "a.txt" },
      { at: 2000, kind: "changed", path: "a.txt" },
      { at: 1500, kind: "appeared", path: "b.txt" },
    ],
  })

  const recency = registry.get(recencyByPathAtom)
  expect(recency.get("a.txt")).toBe(2000)
  expect(recency.get("b.txt")).toBe(1500)
})

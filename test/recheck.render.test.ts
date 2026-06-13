import { rmSync } from "node:fs"
import { describe, expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { createRoot } from "@opentui/react"
import { createElement } from "react"
import { App } from "../src/App"
import { loadModel, createFixtureRepo, disabledSyntax, makeSettleUntil, withRegistry } from "../test/helpers"

describe("re-running checks", () => {
  test("r reports checks finished once diagnostics complete", async () => {
    const repoRoot = createFixtureRepo("sideye-recheck-", { "README.md": "# Fixture\n" })
    const model = await loadModel(repoRoot, { kind: "all", ref: "HEAD" })
    const { renderer, renderOnce, captureCharFrame, mockInput } = await createTestRenderer({ height: 34, width: 120 })
    const settleUntil = makeSettleUntil({ captureCharFrame, renderOnce })

    try {
      createRoot(renderer).render(withRegistry(createElement(App, { model, scope: { kind: "all", ref: "HEAD" }, syntax: disabledSyntax })))
      const initial = await settleUntil("app chrome", (frame) => frame.includes("sideye"), 5)
      expect(initial).toContain("sideye")

      mockInput.pressKey("r")
      const after = await settleUntil("re-run completion", (frame) => frame.includes("checks finished"))
      expect(after).toContain("checks finished")
      expect(after).not.toContain("running checks…")
    } finally {
      renderer.destroy()
      rmSync(repoRoot, { force: true, recursive: true })
    }
  }, 20_000)
})

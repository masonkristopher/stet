import { rmSync } from "node:fs"
import { describe, expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { createRoot } from "@opentui/react"
import { createElement } from "react"
import { App } from "../src/App"
import { loadModel, createFixtureRepo, disabledSyntax, makeSettleUntil, withRegistry } from "../test/helpers"

describe("help overlay", () => {
  test("opens with ?, lists every keybinding, swallows keys, and closes with escape", async () => {
    const repoRoot = createFixtureRepo("sideye-help-", { "src/a.ts": "export const a = 1\n" })
    const model = await loadModel(repoRoot, { kind: "all", ref: "HEAD" })
    const { renderer, renderOnce, captureCharFrame, mockInput } = await createTestRenderer({ height: 34, width: 120 })
    const settleUntil = makeSettleUntil({ captureCharFrame, renderOnce })

    try {
      createRoot(renderer).render(withRegistry(createElement(App, { model, scope: { kind: "all", ref: "HEAD" }, syntax: disabledSyntax })))
      const initial = await settleUntil("app chrome", (frame) => frame.includes("sideye"), 5)
      expect(initial).toContain("? keys · q quit")

      mockInput.pressKey("?")
      const help = await settleUntil("help overlay", (frame) => frame.includes("switch to another git worktree"))
      expect(help).toContain("go to file: fuzzy-search the whole repo")
      expect(help).toContain("toggle the file tree sidebar")

      // P and b must be swallowed: no problems panel, no sidebar toggle, overlay stays
      mockInput.pressKey("p")
      mockInput.pressKey("b")
      const afterSwallowed = await settleUntil("overlay still open", (frame) => frame.includes("switch to another git worktree"), 3)
      expect(afterSwallowed).not.toContain("no problems")

      mockInput.pressEscape()
      const closedByEscape = await settleUntil("help closed by escape", (frame) => !frame.includes("switch to another git worktree"))
      expect(closedByEscape).toContain("? keys · q quit")
      expect(closedByEscape).not.toContain("no problems")

      // Q must close the overlay, not quit the app
      mockInput.pressKey("?")
      await settleUntil("help overlay again", (frame) => frame.includes("switch to another git worktree"))
      mockInput.pressKey("q")
      const closed = await settleUntil("help closed by q", (frame) => !frame.includes("switch to another git worktree"))
      expect(closed).toContain("sideye")
      expect(closed).toContain("? keys · q quit")
    } finally {
      renderer.destroy()
      rmSync(repoRoot, { force: true, recursive: true })
    }
  }, 20_000)
})

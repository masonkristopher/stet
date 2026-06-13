import { rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { createRoot } from "@opentui/react"
import { createElement } from "react"
import { App } from "../src/App"
import { loadModel, createFixtureRepo, disabledSyntax, makeSettleUntil, runGit, withRegistry } from "../test/helpers"

describe("worktree picker", () => {
  test("opens with w, escape keeps the current worktree, enter switches the whole app", async () => {
    const repoRoot = createFixtureRepo("sideye-worktree-", {
      "README.md": "# Fixture\n",
      "src/main-only.ts": "export const main = true\n",
    })
    const linkedRoot = join(repoRoot, ".wt")
    runGit(repoRoot, ["worktree", "add", "-b", "side-branch", linkedRoot])
    writeFileSync(join(linkedRoot, "side-only.ts"), "export const side = true\n")
    writeFileSync(join(repoRoot, "src", "main-only.ts"), "export const main = false\n")

    const model = await loadModel(repoRoot, { kind: "all", ref: "HEAD" })
    const { renderer, renderOnce, captureCharFrame, mockInput } = await createTestRenderer({ height: 34, width: 120 })
    const settleUntil = makeSettleUntil({ captureCharFrame, renderOnce })

    try {
      createRoot(renderer).render(withRegistry(createElement(App, { model, scope: { kind: "all", ref: "HEAD" }, syntax: disabledSyntax })))
      const initial = await settleUntil("app chrome", (frame) => frame.includes("sideye") && frame.includes("main-only.ts"), 5)
      expect(initial).toContain("main-only.ts")
      expect(initial).not.toContain("side-only.ts")

      mockInput.pressKey("w")
      const picker = await settleUntil("worktree picker", (frame) => frame.includes("worktrees") && frame.includes("side-branch"))
      expect(picker).toContain("side-branch")

      mockInput.pressEscape()
      const closed = await settleUntil("picker closed", (frame) => !frame.includes("side-branch"))
      expect(closed).toContain("main-only.ts")
      expect(closed).not.toContain("side-only.ts")

      mockInput.pressKey("w")
      await settleUntil("worktree picker again", (frame) => frame.includes("side-branch"))
      mockInput.pressKey("j")
      // Let the cursor move commit before enter, as a real key cadence would
      await settleUntil("picker cursor moved", () => true, 2)
      mockInput.pressEnter()
      const switched = await settleUntil(
        "linked worktree loaded",
        (frame) => frame.includes("side-only.ts") && frame.includes(".wt · worktree vs HEAD"),
      )
      expect(switched).toContain("side-only.ts")
      expect(switched).toContain(".wt · worktree vs HEAD")
    } finally {
      renderer.destroy()
      rmSync(repoRoot, { force: true, recursive: true })
    }
  }, 20_000)
})

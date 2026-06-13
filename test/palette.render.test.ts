import { rmSync } from "node:fs"
import { describe, expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { createRoot } from "@opentui/react"
import { createElement } from "react"
import { App } from "../src/App"
import { loadModel, createFixtureRepo, disabledSyntax, makeSettleUntil, withRegistry } from "../test/helpers"

describe("go-to-file palette", () => {
  test("opens with ctrl-p, swallows global keys, fuzzy-jumps on enter", async () => {
    const repoRoot = createFixtureRepo("sideye-palette-", {
      "README.md": "# Fixture\n",
      "src/App.tsx": "export function App() { return null }\n",
      "src/tree.ts": "export const tree = true\n",
      "test/tree.test.ts": "export const testTree = true\n",
    })
    const model = await loadModel(repoRoot, { kind: "all", ref: "HEAD" })
    const { renderer, renderOnce, captureCharFrame, mockInput } = await createTestRenderer({ height: 34, width: 120 })
    const settleUntil = makeSettleUntil({ captureCharFrame, renderOnce })

    try {
      createRoot(renderer).render(withRegistry(createElement(App, { model, scope: { kind: "all", ref: "HEAD" }, syntax: disabledSyntax })))
      const initial = await settleUntil("app chrome", (frame) => frame.includes("sideye"), 5)
      expect(initial).toContain("sideye")

      mockInput.pressKey("p", { ctrl: true })
      const palette = await settleUntil("go-to-file palette", (frame) => frame.includes("go to file"))
      expect(palette).toContain("go to file")

      // Q must feed the input and show "no matches", not quit the app
      await mockInput.typeText("qqqq")
      const afterTyping = await settleUntil("empty palette results", (frame) => frame.includes("sideye") && frame.includes("no matches"))
      expect(afterTyping).toContain("sideye")
      expect(afterTyping).toContain("no matches")

      for (let index = 0; index < 4; index += 1) {
        mockInput.pressBackspace()
      }
      await mockInput.typeText("treets")
      const afterSearch = await settleUntil("tree search result", (frame) => frame.includes("src/tree.ts"))
      expect(afterSearch).toContain("src/tree.ts")

      mockInput.pressEnter()
      const after = await settleUntil("selected tree file", (frame) => frame.includes("src/tree.ts ·") && !frame.includes("go to file"))
      expect(after).toContain("src/tree.ts ·")
      expect(after).not.toContain("go to file")
    } finally {
      renderer.destroy()
      rmSync(repoRoot, { force: true, recursive: true })
    }
  }, 20_000)
})

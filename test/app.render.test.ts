import { describe, expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { createRoot } from "@opentui/react"
import { createElement } from "react"
import { App } from "../src/App"
import { loadModel, disabledSyntax, makeSettleUntil, withRegistry } from "../test/helpers"

describe("App rendering", () => {
  test("renders the repo tree, scope label, and status bar", async () => {
    const model = await loadModel(process.cwd(), { kind: "all", ref: "HEAD" })
    const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({ height: 32, width: 110 })
    const settleUntil = makeSettleUntil({ captureCharFrame, renderOnce })

    createRoot(renderer).render(withRegistry(createElement(App, { model, scope: { kind: "all", ref: "HEAD" }, syntax: disabledSyntax })))
    const frame = await settleUntil("app chrome", (current) => current.includes("sideye"))

    expect(frame).toContain("sideye")
    expect(frame).toContain("worktree vs HEAD")
    expect(frame).toContain("src/")
    expect(frame).toContain("test/")
    expect(frame).toContain("q quit")

    renderer.destroy()
  })
})

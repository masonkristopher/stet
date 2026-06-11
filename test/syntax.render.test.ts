import { DiffRenderable, type RGBA } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { afterAll, describe, expect, test } from "bun:test"
import { createSyntaxConfig, diffFiletypeFor } from "../src/syntax"

const toDiff = (path: string, lines: string[]) =>
  `--- a/${path}\n+++ b/${path}\n@@ -1,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}`).join("\n")}\n`

const hex = (color: RGBA | undefined) => {
  if (color === undefined) {
    return "none"
  }
  const scale = color.r <= 1 && color.g <= 1 && color.b <= 1 ? 255 : 1
  return `#${[color.r, color.g, color.b]
    .map((channel) =>
      Math.round(channel * scale)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`
}

const destroyers: (() => void)[] = []

afterAll(() => {
  for (const destroy of destroyers) {
    destroy()
  }
})

async function renderDiffSpans(path: string, lines: string[], sentinel: string, sentinelFg: string) {
  const syntax = await createSyntaxConfig()
  if (!syntax.enabled) {
    throw new Error(`syntax config failed: ${syntax.status}`)
  }

  const { renderer, renderOnce, captureSpans } = await createTestRenderer({ width: 100, height: 30 })
  destroyers.push(() => renderer.destroy())

  const diff = new DiffRenderable(renderer, {
    id: `syntax-render-${path}`,
    width: "100%",
    height: 28,
    diff: toDiff(path, lines),
    view: "unified",
    filetype: diffFiletypeFor(path, syntax),
    syntaxStyle: syntax.style,
    treeSitterClient: syntax.treeSitterClient,
    showLineNumbers: false,
    wrapMode: "none",
  })
  renderer.root.add(diff)

  // highlighting streams in from the parser worker, so poll with renderOnce
  // until the sentinel span reaches its highlighted color
  let spans: { text: string; fg: string }[] = []
  for (let attempt = 0; attempt < 100; attempt += 1) {
    // oxlint-disable-next-line no-await-in-loop -- polling retry: render then wait for syntax highlight to stream in
    await renderOnce()
    // oxlint-disable-next-line no-await-in-loop -- polling retry: render then wait for syntax highlight to stream in
    await new Promise((resolve) => setTimeout(resolve, 50))
    spans = captureSpans().lines.flatMap((line) => line.spans.map((span) => ({ text: span.text, fg: hex(span.fg) })))
    if (spans.some((span) => span.text.includes(sentinel) && span.fg === sentinelFg)) {
      break
    }
  }

  return (needle: string) => spans.find((span) => span.text.includes(needle))?.fg ?? "not found"
}

describe("syntax highlighting in diffs", () => {
  test("markdown diffs style headings, fenced code injections, and tables", async () => {
    const fgOf = await renderDiffSpans(
      "README.md",
      ["# Title", "", "## Section", "", "```ts", "const x: number = 1", "```", "", "| col | val |", "| --- | --- |", "| a | b |"],
      "Title",
      "#ff4fb8",
    )

    expect(fgOf("Title")).toBe("#ff4fb8")
    expect(fgOf("Section")).toBe("#ff4fb8")
    expect(fgOf("const")).toBe("#ff4fb8")
    expect(fgOf("number")).toBe("#f0abfc")
    expect(fgOf("col")).toBe("#ff4fb8")
  })

  test("typescript diffs style keywords, types, strings, and template parts", async () => {
    const fgOf = await renderDiffSpans(
      "src/example.ts",
      ['const greeting: string = "hi"', "export function shout(name: string) {", "  return `${greeting} ${name}`", "}"],
      "export",
      "#ff4fb8",
    )

    expect(fgOf("export")).toBe("#ff4fb8")
    expect(fgOf("string")).toBe("#f0abfc")
    expect(fgOf('"hi"')).toBe("#86efac")
    expect(fgOf("shout")).toBe("#67e8f9")
    expect(fgOf("${")).toBe("#f5a3d7")
  })

  test("test-file diffs style describe, test, and expect distinctly", async () => {
    const fgOf = await renderDiffSpans(
      "test/example.test.ts",
      ['describe("math", () => {', '  test("adds", () => {', "    expect(sum(1, 2)).toBe(3)", "  })", "})"],
      "describe",
      "#ff4fb8",
    )

    expect(fgOf("describe")).toBe("#ff4fb8")
    expect(fgOf("test")).toBe("#f0abfc")
    expect(fgOf("expect")).toBe("#67e8f9")
    expect(fgOf("sum")).toBe("#67e8f9")
    expect(fgOf("toBe")).toBe("#67e8f9")
  })

  test("json diffs style keys distinctly from string values", async () => {
    const fgOf = await renderDiffSpans("package.json", ["{", '  "name": "sideye",', '  "ok": true', "}"], '"ok"', "#93c5fd")

    expect(fgOf('"name"')).toBe("#93c5fd")
    expect(fgOf('"sideye"')).toBe("#86efac")
    expect(fgOf("true")).toBe("#fbbf24")
  })
})

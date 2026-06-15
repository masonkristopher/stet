import { afterAll, describe, expect, test } from "bun:test";

import { DiffRenderable, type RGBA } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";

import { createSyntaxConfig, diffFiletypeFor } from "../src/syntax/highlight";
import { darkTheme } from "../src/theme/dark";

function toDiff(path: string, lines: string[]) {
  return `--- a/${path}\n+++ b/${path}\n@@ -1,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}`).join("\n")}\n`;
}

function hex(color: RGBA | undefined) {
  if (color === undefined) {
    return "none";
  }
  const scale = color.r <= 1 && color.g <= 1 && color.b <= 1 ? 255 : 1;
  return `#${[color.r, color.g, color.b]
    .map((channel) =>
      Math.round(channel * scale)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

const destroyers: (() => void)[] = [];

afterAll(() => {
  for (const destroy of destroyers) {
    destroy();
  }
});

async function renderDiffSpans(
  path: string,
  lines: string[],
  sentinel: string,
  sentinelFg: string,
) {
  const syntax = await createSyntaxConfig(darkTheme.syntax);
  if (!syntax.enabled) {
    throw new Error(`syntax config failed: ${syntax.status}`);
  }

  const { renderer, renderOnce, captureSpans } = await createTestRenderer({
    height: 30,
    width: 100,
  });
  destroyers.push(() => renderer.destroy());

  const diff = new DiffRenderable(renderer, {
    diff: toDiff(path, lines),
    filetype: diffFiletypeFor(path, syntax),
    height: 28,
    id: `syntax-render-${path}`,
    showLineNumbers: false,
    syntaxStyle: syntax.style,
    treeSitterClient: syntax.treeSitterClient,
    view: "unified",
    width: "100%",
    wrapMode: "none",
  });
  renderer.root.add(diff);

  // Highlighting streams in from the parser worker, so poll with renderOnce
  // Until the sentinel span reaches its highlighted color
  let spans: { text: string; fg: string }[] = [];
  for (let attempt = 0; attempt < 100; attempt += 1) {
    // oxlint-disable-next-line no-await-in-loop -- polling retry: render then wait for syntax highlight to stream in
    await renderOnce();
    // oxlint-disable-next-line no-await-in-loop -- polling retry: render then wait for syntax highlight to stream in
    await new Promise((resolve) => setTimeout(resolve, 50));
    spans = captureSpans().lines.flatMap((line) =>
      line.spans.map((span) => ({ fg: hex(span.fg), text: span.text })),
    );
    if (spans.some((span) => span.text.includes(sentinel) && span.fg === sentinelFg)) {
      break;
    }
  }

  return (needle: string) => spans.find((span) => span.text.includes(needle))?.fg ?? "not found";
}

describe("syntax highlighting in diffs", () => {
  test("markdown diffs style headings, fenced code injections, and tables", async () => {
    const fgOf = await renderDiffSpans(
      "README.md",
      [
        "# Title",
        "",
        "## Section",
        "",
        "```ts",
        "const x: number = 1",
        "```",
        "",
        "| col | val |",
        "| --- | --- |",
        "| a | b |",
      ],
      "Title",
      "#ff4fb8",
    );

    expect(fgOf("Title")).toBe("#ff4fb8");
    expect(fgOf("Section")).toBe("#ff4fb8");
    expect(fgOf("const")).toBe("#ff4fb8");
    expect(fgOf("number")).toBe("#f0abfc");
    expect(fgOf("col")).toBe("#ff4fb8");
  });

  test("typescript diffs style keywords, types, strings, and template parts", async () => {
    const fgOf = await renderDiffSpans(
      "src/example.ts",
      [
        'const greeting: string = "hi"',
        "export function shout(name: string) {",
        // oxlint-disable-next-line no-template-curly-in-string
        "  return `${greeting} ${name}`",
        "}",
      ], // oxlint-disable-line no-template-curly-in-string
      "export",
      "#ff4fb8",
    );

    expect(fgOf("export")).toBe("#ff4fb8");
    expect(fgOf("string")).toBe("#f0abfc");
    expect(fgOf('"hi"')).toBe("#86efac");
    expect(fgOf("shout")).toBe("#67e8f9");
    expect(fgOf("${")).toBe("#f5a3d7");
  });

  test("test-file diffs style describe, test, and expect distinctly", async () => {
    const fgOf = await renderDiffSpans(
      "test/example.test.ts",
      [
        'describe("math", () => {',
        '  test("adds", () => {',
        "    expect(sum(1, 2)).toBe(3)",
        "  })",
        "})",
      ],
      "describe",
      "#ff4fb8",
    );

    expect(fgOf("describe")).toBe("#ff4fb8");
    expect(fgOf("test")).toBe("#f0abfc");
    expect(fgOf("expect")).toBe("#67e8f9");
    expect(fgOf("sum")).toBe("#67e8f9");
    expect(fgOf("toBe")).toBe("#67e8f9");
  });

  test("tsx diffs style JSX element and attribute names", async () => {
    const fgOf = await renderDiffSpans(
      "src/Panel.tsx",
      [
        "export function Panel() {",
        "  return (",
        '    <box flexDirection="row">',
        "      <Sidebar />",
        "      <text>{label}</text>",
        "    </box>",
        "  )",
        "}",
      ],
      "box",
      "#fda4af",
    );

    expect(fgOf("box")).toBe("#fda4af");
    expect(fgOf("text")).toBe("#fda4af");
    expect(fgOf("Sidebar")).toBe("#fda4af");
    expect(fgOf("flexDirection")).toBe("#f0abfc");
    expect(fgOf('"row"')).toBe("#86efac");
  });

  test("json diffs style keys distinctly from string values", async () => {
    const fgOf = await renderDiffSpans(
      "package.json",
      ["{", '  "name": "sideye",', '  "ok": true', "}"],
      '"ok"',
      "#93c5fd",
    );

    expect(fgOf('"name"')).toBe("#93c5fd");
    expect(fgOf('"sideye"')).toBe("#86efac");
    expect(fgOf("true")).toBe("#fbbf24");
  });
});

import { expect, test } from "bun:test";
import { rmSync } from "node:fs";

import { testRender } from "@opentui/solid";

import { App } from "@/App";
import { state } from "@/state";

import { createFixtureRepo, loadModel, makeSettleUntil, seedState } from "./helpers";

// Some graphemes (emoji with a U+FE0F variation selector) lay a `wrapMode="none"`
// Text out two terminal rows tall even though it is horizontally clipped to one.
// The windowing assumes every non-wrap row is exactly one terminal row, so each
// Such row used to under-count the content height by one, shrinking maxScrollY and
// Stranding the file's last line(s) below the fold. The fix pins every non-wrap row
// To height 1, restoring that invariant. This guards the last line staying reachable
// When earlier rows contain those graphemes.
test("last line stays reachable past emoji rows that render two terminal rows", async () => {
  // Long lines (wider than the viewer) carrying a variation-selector emoji: these
  // Are the rows OpenTUI lays out two-tall. Scatter them above the final line so any
  // Per-row under-count accumulates into a multi-row strand at the bottom.
  const lines = Array.from({ length: 40 }, (_, i) => {
    const n = i + 1;
    const emoji = "- `⚠️ marker | 🟠 wide` - ";
    return `${emoji}line_${n} ${"detail ".repeat(10)}${n}`;
  });
  const repoRoot = createFixtureRepo("stet-tallrow-", { "long.md": `${lines.join("\n")}\n` });
  const model = await loadModel(repoRoot, { kind: "all", ref: "HEAD" });
  seedState(model, { kind: "all", ref: "HEAD" });
  state.setFocusedPane("diff");
  state.setOverflow("scroll"); // Wrap off, the reported configuration

  const { renderer, renderOnce, captureCharFrame, mockInput } = await testRender(() => <App />, {
    height: 24,
    width: 90,
  });
  const settleUntil = makeSettleUntil({ captureCharFrame, renderOnce });

  try {
    await settleUntil("content", (frame) => frame.includes("line_1 "), 5);

    mockInput.pressKey("G");
    const frame = await settleUntil("last line reachable", (current) => /line_40 /.test(current));
    expect(frame).toMatch(/line_40 /);
  } finally {
    renderer.destroy();
    rmSync(repoRoot, { force: true, recursive: true });
  }
}, 20_000);

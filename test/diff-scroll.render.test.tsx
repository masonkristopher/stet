import { describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";

import { testRender } from "@opentui/solid";

import { App } from "@/App";
import { state } from "@/state";

import { createFixtureRepo, loadModel, makeSettleUntil, seedState } from "./helpers";

// A long unchanged file viewed as full content. The viewer mounts only a windowed
// Row slice, so a scroll offset that the window can't follow leaves the lower pane
// Blank. These two cases guard the two writers of that offset: the mouse wheel and
// Keyboard cursor-follow.
function longFileRepo(prefix: string) {
  const lines = Array.from({ length: 120 }, (_, i) => `const line_${i + 1} = ${i + 1}`);
  return createFixtureRepo(prefix, { "long.ts": `${lines.join("\n")}\n` });
}

function visibleLineNumbers(frame: string) {
  return (frame.match(/line_\d+ =/g) ?? []).map((match) => Number(match.replace(/\D/g, "")));
}

describe("diff viewer vertical scroll", () => {
  test("wheel-down scrolls deep and keeps the viewport full of real lines", async () => {
    const repoRoot = longFileRepo("sideye-wheel-");
    const model = await loadModel(repoRoot, { kind: "all", ref: "HEAD" });
    seedState(model, { kind: "all", ref: "HEAD" });
    const { renderer, renderOnce, captureCharFrame, mockMouse } = await testRender(() => <App />, {
      height: 34,
      useMouse: true,
      width: 120,
    });
    const settleUntil = makeSettleUntil({ captureCharFrame, renderOnce });

    try {
      await settleUntil("file content", (frame) => frame.includes("line_1 ="), 5);

      await mockMouse.moveTo(90, 20);
      for (let tick = 0; tick < 40; tick += 1) {
        // oxlint-disable-next-line no-await-in-loop -- one wheel tick per render pass
        await mockMouse.scroll(90, 20, "down");
        // oxlint-disable-next-line no-await-in-loop -- one wheel tick per render pass
        await renderOnce();
      }
      const numbers = visibleLineNumbers(captureCharFrame());

      // Scrolled well past the first screen (cursor-follow must not yank it back)...
      expect(Math.min(...numbers)).toBeGreaterThan(30);
      // ...and the viewport is packed with real lines, not an empty bottom spacer.
      expect(numbers.length).toBeGreaterThan(20);
    } finally {
      renderer.destroy();
      rmSync(repoRoot, { force: true, recursive: true });
    }
  }, 20_000);

  test("keyboard cursor-follow still drives the scroll (G to bottom, g to top)", async () => {
    const repoRoot = longFileRepo("sideye-curfollow-");
    const model = await loadModel(repoRoot, { kind: "all", ref: "HEAD" });
    seedState(model, { kind: "all", ref: "HEAD" });
    state.setFocusedPane("diff");
    const { renderer, renderOnce, captureCharFrame, mockInput } = await testRender(() => <App />, {
      height: 34,
      useMouse: true,
      width: 120,
    });
    const settleUntil = makeSettleUntil({ captureCharFrame, renderOnce });

    try {
      await settleUntil("file content", (frame) => frame.includes("line_1 ="), 5);

      mockInput.pressKey("G");
      await settleUntil("bottom", (frame) => /line_120 =/.test(frame));

      mockInput.pressKey("g");
      const top = await settleUntil(
        "top",
        (frame) => /line_1 =/.test(frame) && !/line_120 =/.test(frame),
      );
      expect(top).toContain("line_1 =");
    } finally {
      renderer.destroy();
      rmSync(repoRoot, { force: true, recursive: true });
    }
  }, 20_000);

  test("stepping down one line at a time keeps the cursor line on screen", async () => {
    const repoRoot = longFileRepo("sideye-step-");
    const model = await loadModel(repoRoot, { kind: "all", ref: "HEAD" });
    seedState(model, { kind: "all", ref: "HEAD" });
    state.setFocusedPane("diff");
    const { renderer, renderOnce, captureCharFrame, mockInput } = await testRender(() => <App />, {
      height: 34,
      useMouse: true,
      width: 120,
    });
    const settleUntil = makeSettleUntil({ captureCharFrame, renderOnce });

    try {
      await settleUntil("file content", (frame) => frame.includes("line_1 ="), 5);

      // Walk the cursor down one line per render pass; it must never leave the
      // Viewport (the reported bug: the highlight scrolls off the bottom edge).
      for (let step = 0; step < 60; step += 1) {
        mockInput.pressKey("j");
        // oxlint-disable-next-line no-await-in-loop -- one cursor step per render pass
        await renderOnce();
        const cursorLine = state.cursorLineNumber();
        expect(captureCharFrame()).toContain(`line_${cursorLine} =`);
      }
    } finally {
      renderer.destroy();
      rmSync(repoRoot, { force: true, recursive: true });
    }
  }, 20_000);
});

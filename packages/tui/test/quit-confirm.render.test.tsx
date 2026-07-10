import { describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";

import { testRender } from "@opentui/solid";

import { App } from "@/App";
import { state } from "@/state";

import { createFixtureRepo, loadModel, makeSettleUntil, seedState } from "./helpers";

const luminance = (bg: { b: number; g: number; r: number }) =>
  0.299 * bg.r + 0.587 * bg.g + 0.114 * bg.b;

// First cell of a background row, well below the dialog, that exists before and after.
const backgroundCell = (frame: {
  lines: { spans: { bg: { b: number; g: number; r: number } }[] }[];
}) => frame.lines[10]?.spans[0]?.bg;

describe("quit confirm", () => {
  test("q opens the alert dialog, dims the app behind it, and esc cancels without quitting", async () => {
    const repoRoot = createFixtureRepo("stet-quit-", { "src/a.ts": "export const a = 1\n" });
    const model = await loadModel(repoRoot, { kind: "all", ref: "HEAD" });
    seedState(model, { kind: "all", ref: "HEAD" });
    const { renderer, renderOnce, captureCharFrame, captureSpans, mockInput } = await testRender(
      () => <App />,
      { height: 24, width: 120 },
    );
    const settleUntil = makeSettleUntil({ captureCharFrame, renderOnce });

    try {
      await settleUntil("app chrome", (frame) => frame.includes("q quit"), 5);
      const litBackground = backgroundCell(captureSpans());

      // Q must not quit outright: it raises the confirm prompt (y quit · esc cancel).
      mockInput.pressKey("q");
      const prompt = await settleUntil("quit confirm", (frame) => frame.includes("Quit stet?"));
      expect(prompt).toContain("y quit · esc cancel");

      // The scrim dims the background (lower luminance) without blanking it: the tree
      // And header text stay legible behind the modal.
      const dimmedBackground = backgroundCell(captureSpans());
      expect(luminance(dimmedBackground)).toBeLessThan(luminance(litBackground) * 0.8);
      expect(prompt).toContain("a.ts");

      // Esc cancels and returns to the app instead of quitting.
      mockInput.pressEscape();
      const dismissed = await settleUntil(
        "confirm dismissed",
        (frame) => !frame.includes("Quit stet?"),
      );
      expect(dismissed).toContain("? keys · q quit");
    } finally {
      renderer.destroy();
      rmSync(repoRoot, { force: true, recursive: true });
    }
  });

  test("the barrier makes the app inert: a background click is blocked while open, lands once closed", async () => {
    const repoRoot = createFixtureRepo("stet-barrier-", {
      "src/a.ts": "export const a = 1\n",
      "src/b.ts": "export const b = 2\n",
    });
    const model = await loadModel(repoRoot, { kind: "all", ref: "HEAD" });
    seedState(model, { kind: "all", ref: "HEAD" });
    const { renderer, renderOnce, captureCharFrame, mockInput, mockMouse } = await testRender(
      () => <App />,
      { height: 24, width: 120 },
    );
    const settleUntil = makeSettleUntil({ captureCharFrame, renderOnce });

    try {
      const chrome = await settleUntil("app chrome", (frame) => frame.includes("b.ts"), 5);
      // Start with b.ts selected, so a click that reaches a.ts's tree row is observable.
      state.selectFile("src/b.ts");
      // Locate a.ts in the sidebar tree (low column, not the viewer's filename header).
      const lines = chrome.split("\n");
      const row = lines.findIndex((line) => /a\.ts/.test(line) && line.indexOf("a.ts") < 24);
      const col = lines[row].indexOf("a.ts");
      expect(row).toBeGreaterThan(0);

      // With the confirm open, clicking a.ts's row must not reach the tree.
      mockInput.pressKey("q");
      await settleUntil("quit confirm", (frame) => frame.includes("Quit stet?"));
      await mockMouse.click(col, row);
      await renderOnce();
      expect(state.selectedPath()).toBe("src/b.ts");
      expect(state.quitConfirmOpen()).toBe(true);

      // Positive control: once cancelled, the same click lands and selects a.ts.
      mockInput.pressEscape();
      await settleUntil("confirm dismissed", (frame) => !frame.includes("Quit stet?"));
      await mockMouse.click(col, row);
      await renderOnce();
      expect(state.selectedPath()).toBe("src/a.ts");
    } finally {
      renderer.destroy();
      rmSync(repoRoot, { force: true, recursive: true });
    }
  });
});

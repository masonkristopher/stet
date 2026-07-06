import { describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createMockMouse } from "@opentui/core/testing";
import { testRender } from "@opentui/solid";

import { App } from "@/App";
import { state } from "@/state";

import { createFixtureRepo, loadModel, makeSettleUntil, seedState } from "./helpers";

describe("word caret", () => {
  test("h/l hop the caret word to word and wrap across lines, shown as ln L:C", async () => {
    // Two changed lines so the line number distinguishes a wrap; "const a = 1"
    // Has words at columns 1 (const), 7 (a), 11 (1).
    const repoRoot = createFixtureRepo("stet-caret-", {
      "package.json": `${JSON.stringify({ scripts: { lint: "exit 0", typecheck: "exit 0" } })}\n`,
      "src/a.ts": "const a = 1\nconst b = 1\n",
    });
    writeFileSync(join(repoRoot, "src", "a.ts"), "const a = 2\nconst b = 2\n");

    const model = await loadModel(repoRoot, { kind: "all", ref: "HEAD" });
    seedState(model, { kind: "all", ref: "HEAD" });
    const { renderer, renderOnce, captureCharFrame, mockInput } = await testRender(() => <App />, {
      height: 30,
      width: 110,
    });
    const settleUntil = makeSettleUntil({ captureCharFrame, renderOnce });

    try {
      // The caret homes to the first line's first word: ln 1, column 1.
      await settleUntil("caret at first word", (frame) => /ln 1:1\b/.test(frame));

      mockInput.pressTab();
      mockInput.pressKey("l");
      await settleUntil("caret on the second word", (frame) => /ln 1:7\b/.test(frame));

      mockInput.pressKey("l");
      await settleUntil("caret on the third word", (frame) => /ln 1:11\b/.test(frame));

      // Past the last word, l wraps to the next line's first word.
      mockInput.pressKey("l");
      await settleUntil("caret wraps to the next line", (frame) => /ln 2:1\b/.test(frame));

      // H past the first word wraps back to the previous line's last word.
      mockInput.pressKey("h");
      const back = await settleUntil("caret wraps back", (frame) => /ln 1:11\b/.test(frame));
      expect(back).toMatch(/ln 1:11\b/);
    } finally {
      renderer.destroy();
      rmSync(repoRoot, { force: true, recursive: true });
    }
  }, 20_000);

  test("clicking the line number selects the line (no symbol), so y copies path:line", async () => {
    const repoRoot = createFixtureRepo("stet-caret-gutter-", {
      "package.json": `${JSON.stringify({ scripts: { lint: "exit 0", typecheck: "exit 0" } })}\n`,
      "src/a.ts": "const a = 1\n",
    });
    writeFileSync(join(repoRoot, "src", "a.ts"), "const alpha = 2\n");

    const model = await loadModel(repoRoot, { kind: "all", ref: "HEAD" });
    seedState(model, { kind: "all", ref: "HEAD" });
    const { renderer, renderOnce, captureCharFrame, mockInput } = await testRender(() => <App />, {
      height: 30,
      width: 110,
    });
    const settleUntil = makeSettleUntil({ captureCharFrame, renderOnce });
    const mouse = createMockMouse(renderer);

    // Capture what `y` copies. The clipboard itself is a subprocess (pbcopy/xclip)
    // Absent on Linux CI, so stub only that sink and assert the formatted reference
    // The real mouse -> keymap -> formatCopyReference path produces.
    const copied: string[] = [];
    const realCopy = state.copy;
    state.copy = (text: string) => {
      copied.push(text);
    };

    try {
      // The caret homes to a symbol, so the stats line carries a column.
      const frame = await settleUntil("caret on a symbol", (current) => /ln \d+:\d+/.test(current));
      const rows = frame.split("\n");
      const rowIndex = rows.findIndex((row) => row.includes("alpha"));
      expect(rowIndex).toBeGreaterThan(-1);

      // Click the gutter (just past the sidebar, before the content): line-level,
      // So the stats line drops the column and `y` copies path:line.
      await mouse.click(state.sidebarWidth() + 2, rowIndex);
      const onLine = await settleUntil(
        "line-level selection",
        (current) => /ln \d+(?!:)/.test(current) && !/ln \d+:\d/.test(current),
      );
      expect(onLine).not.toMatch(/ln \d+:\d/);
      mockInput.pressKey("y");
      expect(copied.at(-1)).toBe("src/a.ts:1");

      // Clicking the content word re-selects a symbol, so `y` copies path:line:col.
      const wordColumn = rows[rowIndex].indexOf("alpha");
      await mouse.click(wordColumn + 1, rowIndex);
      await settleUntil("symbol re-selected", (current) => /ln \d+:\d+/.test(current));
      mockInput.pressKey("y");
      expect(copied.at(-1)).toMatch(/^src\/a\.ts:1:\d+$/);
    } finally {
      state.copy = realCopy;
      renderer.destroy();
      rmSync(repoRoot, { force: true, recursive: true });
    }
  }, 20_000);

  test("back restores the caret column captured on leave", async () => {
    const repoRoot = createFixtureRepo("stet-caret-nav-", {
      "package.json": `${JSON.stringify({ scripts: { lint: "exit 0", typecheck: "exit 0" } })}\n`,
      "src/a.ts": "const a = 1\n",
      "src/b.ts": "const b = 1\n",
    });
    // Distinctive content per file (`alpha` vs `beta`) so the rendered diff proves
    // Which file is active, not just the line:col shape.
    writeFileSync(join(repoRoot, "src", "a.ts"), "const alpha = 2\n");
    writeFileSync(join(repoRoot, "src", "b.ts"), "const beta = 2\n");

    const model = await loadModel(repoRoot, { kind: "all", ref: "HEAD" });
    seedState(model, { kind: "all", ref: "HEAD" });
    const { renderer, renderOnce, captureCharFrame, mockInput } = await testRender(() => <App />, {
      height: 30,
      width: 110,
    });
    const settleUntil = makeSettleUntil({ captureCharFrame, renderOnce });

    try {
      state.selectFile("src/a.ts");
      await settleUntil(
        "file a caret home",
        (current) => /ln \d+:1\b/.test(current) && current.includes("alpha"),
      );

      // Move the caret off the first word so the column is non-default, then leave.
      mockInput.pressTab();
      mockInput.pressKey("l");
      await settleUntil("caret moved on a", (current) => /ln \d+:7\b/.test(current));

      state.selectFile("src/b.ts");
      await settleUntil("file b active", (current) => current.includes("beta"));

      // Back must switch the view to a *and* restore its captured caret column, not
      // Stay on b or re-home to a's first word.
      mockInput.pressKey("<");
      const restored = await settleUntil(
        "a active and caret restored",
        (current) => current.includes("alpha") && /ln \d+:7\b/.test(current),
      );
      expect(restored).toContain("alpha");
      expect(restored).not.toContain("beta");
      expect(restored).toMatch(/ln \d+:7\b/);
      expect(state.selectedPath()).toBe("src/a.ts");
    } finally {
      renderer.destroy();
      rmSync(repoRoot, { force: true, recursive: true });
    }
  }, 20_000);
});

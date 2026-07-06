import { describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createMockMouse } from "@opentui/core/testing";
import { testRender } from "@opentui/solid";

import { App } from "@/App";
import { state } from "@/state";

import { createFixtureRepo, loadModel, makeSettleUntil, seedState } from "./helpers";

// One committed line plus two appended lines, so the whole small file shows in the
// Diff (one context row + two adds) with clean per-line content and stable navIndices
// 0/1/2 — no remove rows to interleave.
function snippetRepo(prefix: string) {
  const repoRoot = createFixtureRepo(prefix, {
    "package.json": `${JSON.stringify({ scripts: { lint: "exit 0", typecheck: "exit 0" } })}\n`,
    "src/snippet.ts": "alpha\n",
  });
  writeFileSync(join(repoRoot, "src", "snippet.ts"), "alpha\nbeta\ngamma\n");
  return repoRoot;
}

describe("line selection copy", () => {
  test("Shift+arrow builds a selection, C copies its lines, a plain move clears it", async () => {
    const repoRoot = snippetRepo("stet-copy-sel-");
    const model = await loadModel(repoRoot, { kind: "all", ref: "HEAD" });
    seedState(model, { kind: "all", ref: "HEAD" });
    const { renderer, renderOnce, captureCharFrame, mockInput } = await testRender(() => <App />, {
      height: 30,
      width: 110,
    });
    const settleUntil = makeSettleUntil({ captureCharFrame, renderOnce });

    // Verify the C key reaches copySelection without depending on the clipboard
    // Subprocess (pbcopy/xclip, absent on CI); the copied *text* is asserted through
    // The observable selectionText/cursorLineContent instead.
    let copyCalls = 0;
    const realCopySelection = state.copySelection;
    state.copySelection = () => {
      copyCalls += 1;
    };

    try {
      await settleUntil("diff shown", (frame) => frame.includes("beta") && frame.includes("gamma"));
      mockInput.pressTab();
      mockInput.pressKey("g");
      await settleUntil("caret at the top line", () => state.cursorIndex() === 0);

      // No selection yet: the caret line is what `C` would copy.
      expect(state.selectionRange()).toBeUndefined();
      expect(state.cursorLineContent()).toBe("alpha");
      mockInput.pressKey("C");
      expect(copyCalls).toBe(1);

      // Shift+Down twice spans all three lines, and selectionText joins them.
      mockInput.pressArrow("down", { shift: true });
      mockInput.pressArrow("down", { shift: true });
      await settleUntil("selection spans three lines", () => {
        const range = state.selectionRange();
        return range !== undefined && range[0] === 0 && range[1] === 2;
      });
      expect(state.selectionText()).toBe("alpha\nbeta\ngamma");
      mockInput.pressKey("C");
      expect(copyCalls).toBe(2);

      // A plain vertical move drops the selection.
      mockInput.pressKey("k");
      await settleUntil("selection cleared", () => state.selectionRange() === undefined);
      expect(state.selectionAnchor()).toBeUndefined();
    } finally {
      state.copySelection = realCopySelection;
      renderer.destroy();
      rmSync(repoRoot, { force: true, recursive: true });
    }
  }, 20_000);

  test("shift-click extends a whole-line selection; a plain click clears it", async () => {
    const repoRoot = snippetRepo("stet-copy-sel-mouse-");
    const model = await loadModel(repoRoot, { kind: "all", ref: "HEAD" });
    seedState(model, { kind: "all", ref: "HEAD" });
    const { renderer, renderOnce, captureCharFrame } = await testRender(() => <App />, {
      height: 30,
      width: 110,
    });
    const settleUntil = makeSettleUntil({ captureCharFrame, renderOnce });
    const mouse = createMockMouse(renderer);

    try {
      const frame = await settleUntil(
        "diff shown",
        (current) => current.includes("alpha") && current.includes("gamma"),
      );
      const rows = frame.split("\n");
      const alphaRow = rows.findIndex((row) => row.includes("alpha"));
      const gammaRow = rows.findIndex((row) => row.includes("gamma"));
      expect(alphaRow).toBeGreaterThan(-1);
      expect(gammaRow).toBeGreaterThan(alphaRow);

      const contentX = state.sidebarWidth() + 5;
      await mouse.click(contentX, alphaRow);
      await settleUntil("caret on the first line", () => state.cursorIndex() === 0);
      expect(state.selectionRange()).toBeUndefined();

      // Shift-click the last line: the band spans both, regardless of the click x.
      await mouse.click(contentX, gammaRow, 0, { modifiers: { shift: true } });
      await settleUntil("selection spans the clicked range", () => {
        const range = state.selectionRange();
        return range !== undefined && range[0] === 0 && range[1] === 2;
      });

      // A plain click collapses back to a caret.
      await mouse.click(contentX, gammaRow);
      await settleUntil("selection cleared", () => state.selectionRange() === undefined);

      // Dragging from the first line down to the last follows the pointer (derived
      // From the drag event's y, not OpenTUI's captured row).
      await mouse.drag(contentX, alphaRow, contentX, gammaRow);
      await settleUntil("drag selects the range", () => {
        const range = state.selectionRange();
        return range !== undefined && range[0] === 0 && range[1] === 2;
      });
    } finally {
      renderer.destroy();
      rmSync(repoRoot, { force: true, recursive: true });
    }
  }, 20_000);

  test("a selection survives a fold toggle (anchor remaps like the caret)", async () => {
    const source = [
      "export const before = 0",
      "export function foo() {",
      "  const a = 1",
      "  const b = 2",
      "}",
      "export const after = 5",
    ].join("\n");
    const repoRoot = createFixtureRepo("stet-sel-fold-", {
      "package.json": `${JSON.stringify({ scripts: { lint: "exit 0", typecheck: "exit 0" } })}\n`,
      "src/mod.ts": `${source}\n`,
    });
    // A trivial edit makes it a changed file so it auto-opens in the viewer.
    writeFileSync(
      join(repoRoot, "src", "mod.ts"),
      `${source.replace("const a = 1", "const a = 9")}\n`,
    );

    const model = await loadModel(repoRoot, { kind: "all", ref: "HEAD" });
    seedState(model, { kind: "all", ref: "HEAD" });
    const { renderer, renderOnce, captureCharFrame, mockInput } = await testRender(() => <App />, {
      height: 30,
      width: 110,
    });
    const settleUntil = makeSettleUntil({ captureCharFrame, renderOnce });

    try {
      await settleUntil(
        "diff shown",
        (f) => f.includes("const a = 9") && f.includes("const b = 2"),
      );
      mockInput.pressTab();
      // Full-file view so each line is a single navigable row (a diff would split the
      // Edited line into a remove + add row and shift the indices under test).
      mockInput.pressKey("v");
      await settleUntil(
        "file view",
        (f) => f.includes("const a = 9") && !f.includes("const a = 1"),
      );

      // Anchor below the block (on "after"), then extend up so the caret lands inside
      // Foo's body. Folding then hides the caret line, which re-homes to the fold
      // Header, and shifts the anchor up, so both endpoints must remap, not just one.
      mockInput.pressKey("G");
      await settleUntil("caret on the last line", () =>
        state.cursorLineContent().includes("after"),
      );
      mockInput.pressArrow("up", { shift: true });
      mockInput.pressArrow("up", { shift: true });
      mockInput.pressArrow("up", { shift: true });
      await settleUntil("caret inside foo, anchor on after", () => {
        const range = state.selectionRange();
        return state.cursorLineContent().includes("const a = 9") && range?.[1] === 5;
      });
      expect(state.selectionRange()).toEqual([2, 5]);

      // Fold the block at the caret: its body collapses (proving the fold ran). The
      // Caret re-homes to the fold header (index 1) and the anchor shifts up (5 -> 3),
      // So the full tuple must be [1, 3]; without the anchor remap it would clear.
      mockInput.pressKey("z");
      const folded = await settleUntil("block folded and both endpoints remapped", (frame) => {
        const range = state.selectionRange();
        return (
          !frame.includes("const b = 2") && range !== undefined && range[0] === 1 && range[1] === 3
        );
      });
      expect(folded).not.toContain("const b = 2");
      expect(state.selectionRange()).toEqual([1, 3]);
    } finally {
      renderer.destroy();
      rmSync(repoRoot, { force: true, recursive: true });
    }
  }, 20_000);

  test("a scope change clears the selection (content identity drifts)", async () => {
    const repoRoot = snippetRepo("stet-sel-scope-");
    const model = await loadModel(repoRoot, { kind: "all", ref: "HEAD" });
    seedState(model, { kind: "all", ref: "HEAD" });
    const { renderer, renderOnce, captureCharFrame, mockInput } = await testRender(() => <App />, {
      height: 30,
      width: 110,
    });
    const settleUntil = makeSettleUntil({ captureCharFrame, renderOnce });

    try {
      await settleUntil("diff shown", (f) => f.includes("beta") && f.includes("gamma"));
      mockInput.pressTab();
      mockInput.pressKey("g");
      mockInput.pressArrow("down", { shift: true });
      mockInput.pressArrow("down", { shift: true });
      await settleUntil("selection built", () => state.selectionRange() !== undefined);

      // Switching scope reloads the diff against a different line list, so a navIndex
      // Anchor is meaningless; the identity-drift effect must drop it even though this
      // Path never routes through the caret/goToLocation clears.
      state.selectScope("session");
      await settleUntil(
        "selection cleared on scope change",
        () => state.selectionRange() === undefined && state.selectionAnchor() === undefined,
      );
      expect(state.selectionRange()).toBeUndefined();
    } finally {
      renderer.destroy();
      rmSync(repoRoot, { force: true, recursive: true });
    }
  }, 20_000);

  test("esc closes the find bar before it clears the selection", async () => {
    const repoRoot = snippetRepo("stet-sel-find-esc-");
    const model = await loadModel(repoRoot, { kind: "all", ref: "HEAD" });
    seedState(model, { kind: "all", ref: "HEAD" });
    const { renderer, renderOnce, captureCharFrame, mockInput } = await testRender(() => <App />, {
      height: 30,
      width: 110,
    });
    const settleUntil = makeSettleUntil({ captureCharFrame, renderOnce });

    try {
      await settleUntil("diff shown", (f) => f.includes("beta") && f.includes("gamma"));
      mockInput.pressTab();
      mockInput.pressKey("g");
      mockInput.pressArrow("down", { shift: true });
      mockInput.pressArrow("down", { shift: true });
      await settleUntil("selection built", () => state.selectionRange() !== undefined);

      // Opening the find bar moves no caret, so the selection persists alongside it.
      mockInput.pressKey("/");
      await settleUntil("find bar open", () => state.findOpen());
      expect(state.selectionRange()).not.toBeUndefined();

      // First esc dismisses the find bar (the more recent modal), not the selection.
      mockInput.pressEscape();
      await settleUntil("find closed, selection kept", () => !state.findOpen());
      expect(state.selectionRange()).not.toBeUndefined();

      // A second esc then clears the selection.
      mockInput.pressEscape();
      await settleUntil("selection cleared", () => state.selectionRange() === undefined);
    } finally {
      renderer.destroy();
      rmSync(repoRoot, { force: true, recursive: true });
    }
  }, 20_000);
});

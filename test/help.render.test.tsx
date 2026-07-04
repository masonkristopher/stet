import { describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";

import { testRender } from "@opentui/solid";

import { App } from "@/App";

import { createFixtureRepo, loadModel, makeSettleUntil, seedState } from "./helpers";

describe("help overlay", () => {
  test("opens with ?, lists every keybinding, swallows keys, and closes with escape", async () => {
    const repoRoot = createFixtureRepo("sideye-help-", { "src/a.ts": "export const a = 1\n" });
    const model = await loadModel(repoRoot, { kind: "all", ref: "HEAD" });
    seedState(model, { kind: "all", ref: "HEAD" });
    const { renderer, renderOnce, captureCharFrame, mockInput } = await testRender(() => <App />, {
      // Tall enough to fit the whole grouped keybindings list (its section headers
      // And spacers included), so the last-row assertions below verify it sizes to
      // Show every shortcut (no clip) when there's room.
      height: 64,
      width: 120,
    });
    const settleUntil = makeSettleUntil({ captureCharFrame, renderOnce });

    try {
      const initial = await settleUntil("app chrome", (frame) => frame.includes("sideye"), 5);
      expect(initial).toContain("? keys · q quit");

      mockInput.pressKey("?");
      const help = await settleUntil("help overlay", (frame) =>
        frame.includes("switch to another git worktree"),
      );
      // Section headings group the list; assert ones no description text contains, so a
      // Regression to a flat list (no headings) fails. Spread top/middle/bottom.
      expect(help).toContain("navigation");
      expect(help).toContain("workspace");
      expect(help).toContain("layout");
      expect(help).toContain("go to file: fuzzy-search the whole repo");
      // The hover shortcut must be listed, or the height bump alone would pass with it gone.
      expect(help).toContain("hover: type and docs for the symbol under the caret");
      expect(help).toContain("copy the entire contents of the viewed file");
      // Folding took over `z`; wrap moved to `x`. Both must be listed under their keys.
      expect(help).toContain("fold / unfold the region at the caret");
      expect(help).toContain("toggle long-line wrap in the viewer");
      expect(help).toContain("toggle the file tree sidebar");
      expect(help).toContain("open in terminal editor");
      expect(help).toContain("open in GUI / IDE");
      // The list sizes to fit (wrapped descriptions included), so even the last
      // Row is visible without scrolling — guards the clip regression.
      expect(help).toContain("pin / unpin the current file as a tab");
      expect(help).toContain("quit (esc closes panels first)");

      // P and ctrl-b must be swallowed: no problems panel, no sidebar toggle, overlay stays
      mockInput.pressKey("p");
      mockInput.pressKey("b", { ctrl: true });
      const afterSwallowed = await settleUntil(
        "overlay still open",
        (frame) => frame.includes("switch to another git worktree"),
        3,
      );
      expect(afterSwallowed).not.toContain("no problems");

      mockInput.pressEscape();
      const closedByEscape = await settleUntil(
        "help closed by escape",
        (frame) => !frame.includes("switch to another git worktree"),
      );
      expect(closedByEscape).toContain("? keys · q quit");
      expect(closedByEscape).not.toContain("no problems");

      // Q must close the overlay, not quit the app
      mockInput.pressKey("?");
      await settleUntil("help overlay again", (frame) =>
        frame.includes("switch to another git worktree"),
      );
      mockInput.pressKey("q");
      const closed = await settleUntil(
        "help closed by q",
        (frame) => !frame.includes("switch to another git worktree"),
      );
      expect(closed).toContain("sideye");
      expect(closed).toContain("? keys · q quit");
    } finally {
      renderer.destroy();
      rmSync(repoRoot, { force: true, recursive: true });
    }
  }, 20_000);
});

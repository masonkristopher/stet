import { describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { testRender } from "@opentui/solid";

import { App } from "@/App";
import { state } from "@/state";

import { createFixtureRepo, loadModel, makeSettleUntil, seedState } from "./helpers";

describe("project content search", () => {
  test("ctrl-f searches changed files, ctrl-a widens, enter jumps, reopening restores", async () => {
    const repoRoot = createFixtureRepo("stet-search-", {
      "src/a.ts": "const x = 1\n",
      // Lib.ts stays unchanged (only under whole-repo scope); needle is on line 3.
      "src/lib.ts": "// one\n// two\nexport const needle = 0\n",
    });
    writeFileSync(join(repoRoot, "src", "a.ts"), "const x = 1\nconst needle = 2\n");

    const model = await loadModel(repoRoot, { kind: "all", ref: "HEAD" });
    seedState(model, { kind: "all", ref: "HEAD" });
    const { renderer, renderOnce, captureCharFrame, mockInput } = await testRender(() => <App />, {
      height: 34,
      width: 120,
    });
    const settleUntil = makeSettleUntil({ captureCharFrame, renderOnce });

    try {
      // The seeded file is a.ts, so selecting lib.ts below is a cross-file jump.
      await settleUntil("app chrome", (frame) => frame.includes("stet"), 5);

      mockInput.pressKey("f", { ctrl: true });
      await settleUntil("search pane", (frame) => frame.includes("search…"));

      // Changed scope sees only the modified a.ts, not the unchanged lib.ts.
      await mockInput.typeText("needle");
      const changed = await settleUntil("changed-scope results", (frame) =>
        frame.includes("1 match in 1 file"),
      );
      expect(changed).toContain("src/a.ts");
      expect(changed).not.toContain("src/lib.ts");

      // Widening to the whole repo with ctrl-g adds the unchanged lib.ts, with
      // Context lines around each match.
      mockInput.pressKey("g", { ctrl: true });
      const repo = await settleUntil("repo-scope results", (frame) =>
        frame.includes("2 matches in 2 files"),
      );
      expect(repo).toContain("src/lib.ts");
      expect(repo).toContain("// two");

      // Enter the results, jump the selection to the last navigable row with G
      // (lib.ts's match, the file after a.ts), then open it: the caret must land
      // On the matched line 3 at the match column, not the top of the file.
      mockInput.pressKey("n", { ctrl: true });
      mockInput.pressKey("G");
      mockInput.pressEnter();
      const jumped = await settleUntil(
        "jumped to lib.ts line 3",
        (frame) => frame.includes("ln 3:14") && !frame.includes("g/G ends"),
      );
      expect(jumped).toContain("ln 3:14");

      // Reopening restores the query and the result set without retyping.
      mockInput.pressKey("f", { ctrl: true });
      const restored = await settleUntil("restored results", (frame) =>
        frame.includes("2 matches in 2 files"),
      );
      expect(restored).toContain("needle");
      expect(restored).toContain("src/lib.ts");

      // The glob field narrows by pathspec: only lib.ts matches src/l*, and a
      // ! token excludes it again (excludes subtract from includes).
      mockInput.pressTab();
      await mockInput.typeText("src/l*");
      const globbed = await settleUntil(
        "glob-narrowed results",
        (frame) => frame.includes("1 match in 1 file"),
        1,
        300,
      );
      expect(globbed).toContain("src/lib.ts");

      await mockInput.typeText(" !src/lib*");
      await settleUntil("exclude wins", (frame) => frame.includes("no matches"), 1, 300);

      // Readline stays the input's: shift-tab back to the query, ctrl-a moves
      // The caret home (no scope flip), and typing lands at the line start.
      mockInput.pressTab({ shift: true });
      mockInput.pressKey("a", { ctrl: true });
      await mockInput.typeText("x");
      const homed = await settleUntil("caret homed", (frame) => frame.includes("xneedle"));
      expect(homed).toContain("[repo]");

      // Ctrl-p falls through from the query to the go-to-file palette.
      mockInput.pressKey("p", { ctrl: true });
      await settleUntil("palette over pane", (frame) => frame.includes("go to file…"));
      mockInput.pressEscape();
      await settleUntil("palette closed", (frame) => !frame.includes("go to file…"));
    } finally {
      renderer.destroy();
      rmSync(repoRoot, { force: true, recursive: true });
    }
  }, 20_000);

  test("jumps to a match outside the diff hunk by escalating to full file", async () => {
    // A 60-line zzz.ts with needle on line 50; editing line 1 puts the only diff
    // Hunk far from the match, so the jump must escalate to full-file view.
    const lines = Array.from({ length: 60 }, (_, index) =>
      index === 49 ? "const needle = 1" : `const x${index} = ${index}`,
    );
    const repoRoot = createFixtureRepo("stet-search-escalate-", {
      "src/aaa.ts": "const a = 1\n",
      "src/zzz.ts": `${lines.join("\n")}\n`,
    });
    writeFileSync(join(repoRoot, "src", "aaa.ts"), "const a = 2\n");
    writeFileSync(
      join(repoRoot, "src", "zzz.ts"),
      `const x0 = 999\n${lines.slice(1).join("\n")}\n`,
    );

    const model = await loadModel(repoRoot, { kind: "all", ref: "HEAD" });
    seedState(model, { kind: "all", ref: "HEAD" });
    const { renderer, renderOnce, captureCharFrame, mockInput } = await testRender(() => <App />, {
      height: 34,
      width: 120,
    });
    const settleUntil = makeSettleUntil({ captureCharFrame, renderOnce });

    try {
      // Seeded on aaa.ts; the only needle match is line 50 of the changed zzz.ts.
      await settleUntil("app chrome", (frame) => frame.includes("stet"), 5);
      mockInput.pressKey("f", { ctrl: true });
      await settleUntil("search pane", (frame) => frame.includes("search…"));
      await mockInput.typeText("needle");
      await settleUntil("result", (frame) => frame.includes("1 match in 1 file"));

      // Enter from the query submits the highlighted (first) match directly.
      mockInput.pressEnter();
      const jumped = await settleUntil("jumped to zzz.ts line 50", (frame) =>
        frame.includes("ln 50"),
      );
      expect(jumped).toContain("ln 50");
    } finally {
      renderer.destroy();
      rmSync(repoRoot, { force: true, recursive: true });
    }
  }, 20_000);

  test("collapses a file group, reports no matches, and keeps results on a bad regex", async () => {
    const repoRoot = createFixtureRepo("stet-search-states-", {
      "src/a.ts": "const x = 1\n",
    });
    writeFileSync(join(repoRoot, "src", "a.ts"), "const x = 1\nconst needle = 2\n");

    const model = await loadModel(repoRoot, { kind: "all", ref: "HEAD" });
    seedState(model, { kind: "all", ref: "HEAD" });
    const { renderer, renderOnce, captureCharFrame, mockInput, mockMouse } = await testRender(
      () => <App />,
      {
        height: 34,
        width: 120,
      },
    );
    const settleUntil = makeSettleUntil({ captureCharFrame, renderOnce });

    try {
      await settleUntil("app chrome", (frame) => frame.includes("stet"), 5);
      mockInput.pressKey("f", { ctrl: true });
      await settleUntil("search pane", (frame) => frame.includes("search…"));
      await mockInput.typeText("needle");
      const results = await settleUntil("results", (frame) => frame.includes("1 match in 1 file"));
      expect(results).toContain("needle = 2");

      // Ctrl-s opens the scope picker without leaving the pane; esc returns.
      mockInput.pressKey("s", { ctrl: true });
      await settleUntil("scope picker over pane", (frame) => frame.includes("switch scope"));
      mockInput.pressEscape();
      await settleUntil("picker closed, pane intact", (frame) => !frame.includes("switch scope"));

      // A single click on the match row selects it (the pane must not navigate
      // Away on a focus-intent click): the footer flips to the results variant
      // And the results stay on screen. Rows: header y=5, context y=6, match y=7.
      const matchRowY = 7;
      await mockMouse.click(state.sidebarWidth() + 10, matchRowY);
      const clicked = await settleUntil("click selects", (frame) => frame.includes("g/G ends"));
      expect(clicked).toContain("1 match in 1 file");

      // Past the double-click window, two rapid clicks read as a double: open.
      await settleUntil("double-click window elapsed", () => true, 45);
      await mockMouse.click(state.sidebarWidth() + 10, matchRowY);
      await mockMouse.click(state.sidebarWidth() + 10, matchRowY);
      await settleUntil("double click opens", (frame) => frame.includes("ln 2:7"));

      // Back into the pane for the states below.
      mockInput.pressKey("f", { ctrl: true });
      await settleUntil("pane restored", (frame) => frame.includes("1 match in 1 file"));

      // A bad extended regex fails the grep but keeps the prior results on
      // Screen under an error notice.
      mockInput.pressKey("r", { ctrl: true });
      await mockInput.typeText("(");
      const errored = await settleUntil("error keeps results", (frame) =>
        frame.includes("search failed · check the pattern"),
      );
      expect(errored).toContain("src/a.ts");

      // A valid pattern that matches nothing: a designed empty screen.
      mockInput.pressBackspace();
      await mockInput.typeText("zzz");
      await settleUntil("no matches", (frame) => frame.includes("no matches"), 1, 300);

      // Restore the match, then enter on the file header collapses the group:
      // The match row hides, the header (with its count) stays.
      mockInput.pressBackspace();
      mockInput.pressBackspace();
      mockInput.pressBackspace();
      await settleUntil("results again", (frame) => frame.includes("1 match in 1 file"), 1, 300);
      mockInput.pressKey("n", { ctrl: true });
      mockInput.pressEnter();
      // The header carries a file-type icon between the collapse glyph and the
      // Path, so match the parts rather than the literal run.
      const collapsed = await settleUntil(
        "collapsed group",
        (frame) =>
          frame.includes("▸") && frame.includes("src/a.ts") && !frame.includes("needle = 2"),
      );
      expect(collapsed).toContain("1 match in 1 file");

      // Results focus has no text input, so global keys still work: ? opens
      // The help overlay over the pane.
      mockInput.pressKey("?");
      await settleUntil("help over search", (frame) => frame.includes("keyboard shortcuts"));
      mockInput.pressEscape();
      await settleUntil(
        "help closed, pane intact",
        (frame) => !frame.includes("keyboard shortcuts") && frame.includes("▸"),
      );
    } finally {
      renderer.destroy();
      rmSync(repoRoot, { force: true, recursive: true });
    }
  }, 20_000);

  test("a wheel scroll moves the results window without moving the selection", async () => {
    const lines = Array.from({ length: 60 }, (_, index) => `const needle${index} = ${index}`);
    const repoRoot = createFixtureRepo("stet-search-wheel-", {
      "src/many.ts": "const x = 1\n",
    });
    writeFileSync(join(repoRoot, "src", "many.ts"), `${lines.join("\n")}\n`);

    const model = await loadModel(repoRoot, { kind: "all", ref: "HEAD" });
    seedState(model, { kind: "all", ref: "HEAD" });
    const { renderer, renderOnce, captureCharFrame, mockInput, mockMouse } = await testRender(
      () => <App />,
      { height: 34, width: 120 },
    );
    const settleUntil = makeSettleUntil({ captureCharFrame, renderOnce });

    try {
      await settleUntil("app chrome", (frame) => frame.includes("stet"), 5);
      mockInput.pressKey("f", { ctrl: true });
      await settleUntil("search pane", (frame) => frame.includes("search…"));
      await mockInput.typeText("needle");
      await settleUntil("results", (frame) => frame.includes("60 matches in 1 file"));
      expect(captureCharFrame()).toContain("needle1 ");

      const selectionBefore = state.searchIndex();
      for (let i = 0; i < 5; i += 1) {
        // oxlint-disable-next-line no-await-in-loop -- sequential wheel steps
        await mockMouse.scroll(state.sidebarWidth() + 10, 12, "down");
        // oxlint-disable-next-line no-await-in-loop -- sequential wheel steps
        await renderOnce();
      }
      await renderOnce();
      expect(captureCharFrame()).not.toContain("needle1 ");
      expect(state.searchIndex()).toBe(selectionBefore);
    } finally {
      renderer.destroy();
      rmSync(repoRoot, { force: true, recursive: true });
    }
  }, 20_000);
});

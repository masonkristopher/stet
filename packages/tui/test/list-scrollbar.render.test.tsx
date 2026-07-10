import { describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { testRender } from "@opentui/solid";

import { App } from "@/App";
import { stateForResolvedChecker } from "@/diagnostics/checker";
import type { Diagnostic } from "@/diagnostics/checker";
import { state } from "@/state";

import { createFixtureRepo, loadModel, makeSettleUntil, seedState } from "./helpers";

// The windowed lists mount only their visible slice, so the scroll indicator is
// Hand-drawn: a width-1 thumb column derived from (rowCount, viewport, scrollTop).
// These pin the behavior it must have: a thumb appears only when the list
// Overflows, and it tracks the scroll position downward. Each fixture keeps the
// Sidebar small (one file) so the only thumb in the frame belongs to the list
// Under test, which is what proves that list wired its own scroll signal in.
describe("list scrollbar", () => {
  const thumbRow = (frame: string) =>
    frame
      .split("\n")
      .map((line) => line.split("││")[0])
      .findIndex((line) => line.includes("▐"));
  const thumbRowAnywhere = (frame: string) =>
    frame.split("\n").findIndex((line) => line.includes("▐"));

  test("shows a thumb only when the tree overflows, and it tracks scroll", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 300; i += 1) {
      files[`big/f${String(i).padStart(3, "0")}.txt`] = `content ${i}\n`;
    }
    const repoRoot = createFixtureRepo("stet-scrollbar-", files);
    const scope = { kind: "all", ref: "HEAD" } as const;
    const model = await loadModel(repoRoot, scope);
    seedState(model, scope);

    const { renderer, mockInput, renderOnce, captureCharFrame } = await testRender(() => <App />, {
      height: 16,
      width: 90,
    });
    const settleUntil = makeSettleUntil({ captureCharFrame, renderOnce });
    await settleUntil("first render", (current) => current.includes("f000.txt"));

    // The 300-file directory far exceeds the ~10-row sidebar viewport, so the
    // Thumb paints near the top.
    const topRow = thumbRow(captureCharFrame());
    expect(topRow).toBeGreaterThanOrEqual(0);

    // Scrolling deep into the directory moves the thumb strictly downward.
    for (let i = 0; i < 80; i += 1) {
      mockInput.pressKey("j");
      // oxlint-disable-next-line no-await-in-loop -- sequential nav steps
      await renderOnce();
    }
    await renderOnce();
    expect(thumbRow(captureCharFrame())).toBeGreaterThan(topRow);

    // Collapsing the directory leaves fewer rows than the viewport: the column
    // Stays reserved but paints no thumb.
    for (let i = 0; i < 90; i += 1) {
      mockInput.pressKey("k");
      // oxlint-disable-next-line no-await-in-loop -- sequential nav steps
      await renderOnce();
    }
    mockInput.pressKey("h");
    await renderOnce();
    await renderOnce();
    expect(thumbRow(captureCharFrame())).toBe(-1);

    renderer.destroy();
  });

  test("shows a thumb in the problems panel and tracks scroll", async () => {
    const repoRoot = createFixtureRepo("stet-scrollbar-problems-", {
      "src/a.ts": "export const a = 1;\n",
    });
    const scope = { kind: "all", ref: "HEAD" } as const;
    const model = await loadModel(repoRoot, scope);
    seedState(model, scope);

    state.setCheckerState({
      diagnostics: stateForResolvedChecker(
        "diagnostics",
        model.changed,
        Array.from(
          { length: 60 },
          (_, index): Diagnostic => ({
            checker: "diagnostics",
            column: 1,
            line: 1 + index,
            message: `synthetic finding ${String(index).padStart(2, "0")}`,
            path: `${repoRoot}/src/file${index % 10}.ts`,
            severity: "warning",
            source: "probe",
          }),
        ),
        repoRoot,
      ),
    });

    const { renderer, mockInput, renderOnce, captureCharFrame } = await testRender(() => <App />, {
      height: 30,
      width: 100,
    });
    const settleUntil = makeSettleUntil({ captureCharFrame, renderOnce });
    await settleUntil("first render", (current) => current.includes("a.ts"));

    try {
      mockInput.pressKey("p");
      await renderOnce();
      await settleUntil("panel open", (current) => current.includes("synthetic finding 00"));

      // 60 findings overflow the panel viewport, so its reserved column paints a
      // Thumb; the sidebar has one file, so this thumb is the panel's.
      const topRow = thumbRowAnywhere(captureCharFrame());
      expect(topRow).toBeGreaterThanOrEqual(0);

      for (let i = 0; i < 30; i += 1) {
        mockInput.pressKey("j");
        // oxlint-disable-next-line no-await-in-loop -- sequential nav steps
        await renderOnce();
      }
      await renderOnce();
      expect(thumbRowAnywhere(captureCharFrame())).toBeGreaterThan(topRow);
    } finally {
      renderer.destroy();
      rmSync(repoRoot, { force: true, recursive: true });
    }
  });

  test("shows a thumb in the search results and tracks scroll", async () => {
    const repoRoot = createFixtureRepo("stet-scrollbar-search-", { "src/many.ts": "seed\n" });
    const lines = Array.from({ length: 60 }, (_, index) => `const needle${index} = ${index}`);
    writeFileSync(join(repoRoot, "src", "many.ts"), `${lines.join("\n")}\n`);
    const scope = { kind: "all", ref: "HEAD" } as const;
    const model = await loadModel(repoRoot, scope);
    seedState(model, scope);

    const { renderer, mockInput, mockMouse, renderOnce, captureCharFrame } = await testRender(
      () => <App />,
      { height: 34, width: 120 },
    );
    const settleUntil = makeSettleUntil({ captureCharFrame, renderOnce });

    try {
      await settleUntil("app chrome", (frame) => frame.includes("q quit"), 5);
      mockInput.pressKey("f", { ctrl: true });
      await settleUntil("search pane", (frame) => frame.includes("search…"));
      await mockInput.typeText("needle");
      await settleUntil("results", (frame) => frame.includes("60 matches in 1 file"));

      // 60 matches overflow the results band; the sidebar has one file, so the
      // Only thumb in the frame is the search pane's.
      const topRow = thumbRowAnywhere(captureCharFrame());
      expect(topRow).toBeGreaterThanOrEqual(0);

      for (let i = 0; i < 10; i += 1) {
        // oxlint-disable-next-line no-await-in-loop -- sequential wheel steps
        await mockMouse.scroll(state.sidebarWidth() + 10, 12, "down");
        // oxlint-disable-next-line no-await-in-loop -- sequential wheel steps
        await renderOnce();
      }
      await renderOnce();
      expect(thumbRowAnywhere(captureCharFrame())).toBeGreaterThan(topRow);
    } finally {
      renderer.destroy();
      rmSync(repoRoot, { force: true, recursive: true });
    }
  }, 20_000);
});

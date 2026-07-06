import { describe, expect, test } from "bun:test";

import { testRender } from "@opentui/solid";

import { App } from "@/App";
import { state } from "@/state";

import { createFixtureRepo, loadModel, makeSettleUntil, seedState } from "./helpers";

// The sidebar windows the tree to the viewport (only ~paneHeight rows are ever
// Mounted), so these tests pin the behaviors that windowing must preserve: the
// Cursor stays framed while navigating deep into a directory far larger than
// The viewport, a wheel scroll moves the window away without the cursor
// Snapping it back, the next keypress re-frames the cursor, and collapsing the
// Big directory clamps the window instead of leaving a blank pane.
describe("sidebar windowing", () => {
  test("frames the cursor deep in a large directory, frees the wheel, and clamps on collapse", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 300; i += 1) {
      files[`big/f${String(i).padStart(3, "0")}.txt`] = `content ${i}\n`;
    }
    const repoRoot = createFixtureRepo("stet-window-", files);
    const scope = { kind: "all", ref: "HEAD" } as const;
    const model = await loadModel(repoRoot, scope);
    seedState(model, scope);

    const { renderer, mockMouse, mockInput, renderOnce, captureCharFrame } = await testRender(
      () => <App />,
      { height: 16, width: 90 },
    );
    const settleUntil = makeSettleUntil({ captureCharFrame, renderOnce });
    await settleUntil("first render", (current) => current.includes("f000.txt"));

    const sidebarFrame = () =>
      captureCharFrame()
        .split("\n")
        .map((line) => line.split("││")[0])
        .join("\n");
    const focusedName = () => state.treeRows()[state.focusedRowIndex()].node.name;

    // Navigate far past the first window; the focused row must stay visible and
    // The window must have moved off the top of the directory.
    for (let i = 0; i < 50; i += 1) {
      mockInput.pressKey("j");
      // oxlint-disable-next-line no-await-in-loop -- sequential nav steps
      await renderOnce();
    }
    await renderOnce();
    expect(sidebarFrame()).toContain(focusedName());
    expect(sidebarFrame()).not.toContain("f000.txt");

    // A wheel scroll moves the window away from the cursor and stays there: the
    // Follow effect must not snap it back until the cursor itself moves.
    for (let i = 0; i < 5; i += 1) {
      // oxlint-disable-next-line no-await-in-loop -- sequential wheel steps
      await mockMouse.scroll(5, 6, "up");
      // oxlint-disable-next-line no-await-in-loop -- sequential wheel steps
      await renderOnce();
    }
    await renderOnce();
    expect(sidebarFrame()).not.toContain(focusedName());

    // The next keypress re-frames the cursor.
    mockInput.pressKey("j");
    await renderOnce();
    await renderOnce();
    expect(sidebarFrame()).toContain(focusedName());

    // Collapsing the big directory shrinks the rows under the window; the
    // Clamp must land the pane on the collapsed directory, not a blank page.
    // `h` collapses only from the directory row itself, so walk the cursor back
    // Up to it first (it clamps at the top row).
    for (let i = 0; i < 60; i += 1) {
      mockInput.pressKey("k");
      // oxlint-disable-next-line no-await-in-loop -- sequential nav steps
      await renderOnce();
    }
    mockInput.pressKey("h");
    await renderOnce();
    await renderOnce();
    expect(state.treeRows().length).toBeLessThan(5);
    expect(sidebarFrame()).toContain("big");
    expect(sidebarFrame()).not.toContain(".txt");

    renderer.destroy();
  });
});

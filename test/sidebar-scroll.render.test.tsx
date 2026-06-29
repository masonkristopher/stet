import { describe, expect, test } from "bun:test";

import { testRender } from "@opentui/solid";

import { App } from "@/App";
import { state } from "@/state";

import { createFixtureRepo, loadModel, makeSettleUntil, seedState } from "./helpers";

// The sidebar's scrollbox must not capture keyboard focus: OpenTUI's scrollbox
// Scrolls itself by a fraction of a viewport on arrow/j/k once focused (e.g. via
// A mouse click), which fights the tree's own cursor-follow and strands the
// Highlight offscreen. Sideye owns navigation through its keymap, so a click in
// The sidebar followed by arrow keys must still keep the focused file on screen.
describe("sidebar scroll follow", () => {
  test("keeps the focused file visible after a mouse click then keyboard nav", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 40; i += 1) {
      files[`f${String(i).padStart(2, "0")}.txt`] = `content ${i}\n`;
    }
    const repoRoot = createFixtureRepo("sideye-scroll-", files);
    const scope = { kind: "all", ref: "HEAD" } as const;
    const model = await loadModel(repoRoot, scope);
    seedState(model, scope);

    const { renderer, mockMouse, mockInput, renderOnce, captureCharFrame } = await testRender(
      () => <App />,
      { height: 16, width: 90 },
    );
    const settleUntil = makeSettleUntil({ captureCharFrame, renderOnce });
    await settleUntil("first render", (current) => current.includes("f00.txt"));

    // Click inside the sidebar, which hands keyboard focus to the scrollbox.
    await mockMouse.click(5, 6);
    await renderOnce();

    // Now navigate with the keyboard, exactly as a user would.
    for (let i = 0; i < 12; i += 1) {
      mockInput.pressArrow("down");
      // oxlint-disable-next-line no-await-in-loop -- sequential nav steps
      await renderOnce();
    }
    await renderOnce();

    // The viewer pane echoes the selected file name, so scope to the sidebar.
    const sidebar = captureCharFrame()
      .split("\n")
      .map((line) => line.split("││")[0])
      .join("\n");
    const focusedPath = state.treeRows()[state.focusedRowIndex()].node.path;

    expect(sidebar).toContain(focusedPath);

    renderer.destroy();
  });
});

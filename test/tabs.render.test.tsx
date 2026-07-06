import { describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createTextAttributes } from "@opentui/core";
import { createMockMouse } from "@opentui/core/testing";
import { testRender } from "@opentui/solid";

import { App } from "@/App";
import { state } from "@/state";

import { createFixtureRepo, loadModel, makeSettleUntil, seedState } from "./helpers";

describe("tabs strip", () => {
  test("appears with a second tab, swaps content, and collapses on close", async () => {
    const body = Array.from({ length: 20 }, (_, index) => `const line${index + 1} = ${index + 1}`);
    const repoRoot = createFixtureRepo("stet-tabs-", {
      "package.json": `${JSON.stringify({ scripts: { lint: "exit 0", typecheck: "exit 0" } })}\n`,
      "src/a.ts": `${body.join("\n")}\n`,
      "src/b.ts": `${body.join("\n")}\n`,
    });
    writeFileSync(
      join(repoRoot, "src", "a.ts"),
      `${["const line1 = 1", "const aChanged = true", ...body.slice(2)].join("\n")}\n`,
    );
    writeFileSync(
      join(repoRoot, "src", "b.ts"),
      `${["const line1 = 1", "const bChanged = true", ...body.slice(2)].join("\n")}\n`,
    );

    const model = await loadModel(repoRoot, { kind: "all", ref: "HEAD" });
    seedState(model, { kind: "all", ref: "HEAD" });
    const { renderer, renderOnce, captureCharFrame, mockInput } = await testRender(() => <App />, {
      height: 30,
      width: 120,
    });
    const settleUntil = makeSettleUntil({ captureCharFrame, renderOnce });

    try {
      await settleUntil("diff view", (frame) => /ln \d/.test(frame), 5);

      // One preview tab: no strip, just the path on the left.
      state.selectFile("src/a.ts");
      await settleUntil(
        "a.ts preview",
        (frame) => frame.includes("src/a.ts") && frame.includes("aChanged"),
      );
      expect(state.tabItems().length).toBe(1);
      expect(state.tabItems()[0].preview).toBe(true);

      // Ctrl-t pins a.ts; navigating to b.ts then opens a fresh preview, so the
      // Strip appears with the pinned a.ts (basename) and the active preview b.ts.
      mockInput.pressKey("t", { ctrl: true });
      state.selectFile("src/b.ts");
      const twoTabs = await settleUntil("b.ts active", (frame) => frame.includes("bChanged"));
      expect(state.tabItems().length).toBe(2);
      expect(twoTabs).toContain("src/b.ts"); // Active tab shows its path
      expect(twoTabs).toContain("a.ts"); // Pinned tab shows its basename
      expect(twoTabs).not.toContain("src/a.ts"); // ...not its full path
      // Stats stay on the right, and the diff/file word is gone.
      expect(twoTabs).toMatch(/\+\d+ -\d+ · ln \d+/);
      expect(twoTabs).not.toContain("· diff");

      // Cycle to the pinned tab: the viewer swaps to a.ts.
      state.cycleTab(-1);
      const back = await settleUntil("a.ts active again", (frame) => frame.includes("aChanged"));
      expect(back).toContain("src/a.ts");
      expect(back).not.toContain("src/b.ts");

      // Closing the pinned tab leaves only the preview, so the strip disappears.
      mockInput.pressKey("w", { ctrl: true });
      const collapsed = await settleUntil(
        "back to one tab",
        (frame) => frame.includes("src/b.ts") && frame.includes("bChanged"),
      );
      expect(state.tabItems().length).toBe(1);
      expect(collapsed).toMatch(/\+\d+ -\d+ · ln \d+/);
    } finally {
      renderer.destroy();
      rmSync(repoRoot, { force: true, recursive: true });
    }
  }, 20_000);

  test("clicking a tab switches it; double-clicking starts no text selection", async () => {
    const body = Array.from({ length: 20 }, (_, index) => `const line${index + 1} = ${index + 1}`);
    const repoRoot = createFixtureRepo("stet-tabcursor-", {
      "package.json": `${JSON.stringify({ scripts: { lint: "exit 0", typecheck: "exit 0" } })}\n`,
      "src/a.ts": `${body.join("\n")}\n`,
      "src/b.ts": `${body.join("\n")}\n`,
    });
    writeFileSync(
      join(repoRoot, "src", "a.ts"),
      `const aChanged = true\n${body.slice(1).join("\n")}\n`,
    );
    writeFileSync(
      join(repoRoot, "src", "b.ts"),
      `const bChanged = true\n${body.slice(1).join("\n")}\n`,
    );

    const model = await loadModel(repoRoot, { kind: "all", ref: "HEAD" });
    seedState(model, { kind: "all", ref: "HEAD" });
    const { renderer, renderOnce, captureCharFrame, mockInput } = await testRender(() => <App />, {
      height: 30,
      width: 120,
    });
    const settleUntil = makeSettleUntil({ captureCharFrame, renderOnce });
    const mouse = createMockMouse(renderer);

    try {
      await settleUntil("diff view", (frame) => /ln \d/.test(frame), 5);
      // Pin a.ts, then preview b.ts -> strip shows [a.ts][src/b.ts].
      state.selectFile("src/a.ts");
      mockInput.pressKey("t", { ctrl: true });
      state.selectFile("src/b.ts");
      const frame = await settleUntil("two tabs", (f) => f.includes("src/b.ts"));

      // Locate the pinned "a.ts" tab in the strip (right of the sidebar columns).
      const lines = frame.split("\n");
      const rowIndex = lines.findIndex((line) => line.includes("src/b.ts"));
      const column = lines[rowIndex].indexOf("a.ts", state.sidebarWidth());
      expect(column).toBeGreaterThan(0);

      // A single click switches to a.ts; no terminal cursor lingers.
      await mouse.click(column + 1, rowIndex);
      const onA = await settleUntil("a.ts diff", (f) => f.includes("aChanged"));
      expect(state.selectedPath()).toBe("src/a.ts");
      expect(renderer.getCursorState().visible).toBe(false);

      // A double-click on a tab must not start a text selection (the stray
      // Highlight): the tab strip is non-selectable chrome.
      await mouse.doubleClick(column + 1, rowIndex);
      await renderOnce();
      expect(renderer.getSelection()).toBeNull();

      // The viewer content is non-selectable chrome too: stet owns line selection
      // And disables OpenTUI's native text selection on the diff's text leaves, so a
      // Double-click on a diff line starts no stray highlight either.
      const diffLines = onA.split("\n");
      const diffRow = diffLines.findIndex((line) => line.includes("aChanged"));
      const diffCol = diffLines[diffRow].indexOf("aChanged");
      await mouse.doubleClick(diffCol + 1, diffRow);
      await renderOnce();
      expect(renderer.getSelection()).toBeNull();
    } finally {
      renderer.destroy();
      rmSync(repoRoot, { force: true, recursive: true });
    }
  }, 20_000);

  test("double-clicking a preview tab pins it", async () => {
    const body = Array.from({ length: 20 }, (_, index) => `const line${index + 1} = ${index + 1}`);
    const repoRoot = createFixtureRepo("stet-tabpin-", {
      "package.json": `${JSON.stringify({ scripts: { lint: "exit 0", typecheck: "exit 0" } })}\n`,
      "src/a.ts": `${body.join("\n")}\n`,
      "src/b.ts": `${body.join("\n")}\n`,
    });
    writeFileSync(
      join(repoRoot, "src", "a.ts"),
      `const aChanged = true\n${body.slice(1).join("\n")}\n`,
    );
    writeFileSync(
      join(repoRoot, "src", "b.ts"),
      `const bChanged = true\n${body.slice(1).join("\n")}\n`,
    );

    const model = await loadModel(repoRoot, { kind: "all", ref: "HEAD" });
    seedState(model, { kind: "all", ref: "HEAD" });
    const { renderer, renderOnce, captureCharFrame, mockInput, mockMouse } = await testRender(
      () => <App />,
      { height: 30, width: 120 },
    );
    const settleUntil = makeSettleUntil({ captureCharFrame, renderOnce });

    try {
      await settleUntil("diff view", (frame) => /ln \d/.test(frame), 5);
      // Pin a.ts, then preview b.ts so the strip shows [a.ts][src/b.ts].
      state.selectFile("src/a.ts");
      mockInput.pressKey("t", { ctrl: true });
      state.selectFile("src/b.ts");
      const frame = await settleUntil("two tabs", (f) => f.includes("src/b.ts"));

      const bTab = () => state.tabItems().find((tab) => tab.path === "src/b.ts");
      expect(bTab()?.preview).toBe(true);

      // Double-click the active preview tab's label to pin it.
      const lines = frame.split("\n");
      const rowIndex = lines.findIndex((line) => line.includes("src/b.ts"));
      const column = lines[rowIndex].indexOf("src/b.ts");
      await mockMouse.doubleClick(column + 1, rowIndex);
      await renderOnce();

      expect(bTab()?.preview).toBe(false);
    } finally {
      renderer.destroy();
      rmSync(repoRoot, { force: true, recursive: true });
    }
  }, 20_000);

  test("double-clicking a file in the tree pins it as a tab", async () => {
    const repoRoot = createFixtureRepo("stet-treepin-", {
      "package.json": `${JSON.stringify({ scripts: { lint: "exit 0", typecheck: "exit 0" } })}\n`,
      "src/a.ts": "const a = 1\n",
      "src/b.ts": "const b = 1\n",
    });
    writeFileSync(join(repoRoot, "src", "b.ts"), "const bChanged = 1\n");

    const model = await loadModel(repoRoot, { kind: "all", ref: "HEAD" });
    seedState(model, { kind: "all", ref: "HEAD" });
    const { renderer, renderOnce, captureCharFrame, mockMouse } = await testRender(() => <App />, {
      height: 24,
      width: 100,
    });
    const settleUntil = makeSettleUntil({ captureCharFrame, renderOnce });

    try {
      const frame = await settleUntil("tree", (f) => f.includes("b.ts"));

      // Locate the b.ts row in the sidebar (left of the pane border).
      const sidebar = frame.split("\n").map((line) => line.split("││")[0]);
      const rowIndex = sidebar.findIndex((line) => line.includes("b.ts"));
      const column = sidebar[rowIndex].indexOf("b.ts");
      expect(column).toBeGreaterThan(0);

      await mockMouse.doubleClick(column + 1, rowIndex);
      await settleUntil("b.ts pinned", () => {
        const tab = state.tabItems().find((item) => item.path === "src/b.ts");
        return tab !== undefined && !tab.preview;
      });

      const tab = state.tabItems().find((item) => item.path === "src/b.ts");
      expect(tab?.preview).toBe(false);
    } finally {
      renderer.destroy();
      rmSync(repoRoot, { force: true, recursive: true });
    }
  }, 20_000);

  test("the preview tab renders italic, pinned tabs upright", async () => {
    const repoRoot = createFixtureRepo("stet-tabitalic-", {
      "package.json": `${JSON.stringify({ scripts: { lint: "exit 0", typecheck: "exit 0" } })}\n`,
      "src/a.ts": "const a = 1\n",
      "src/b.ts": "const b = 1\n",
    });
    writeFileSync(join(repoRoot, "src", "a.ts"), "const aChanged = 1\n");
    writeFileSync(join(repoRoot, "src", "b.ts"), "const bChanged = 1\n");

    const model = await loadModel(repoRoot, { kind: "all", ref: "HEAD" });
    seedState(model, { kind: "all", ref: "HEAD" });
    const { renderer, renderOnce, captureCharFrame, mockInput } = await testRender(() => <App />, {
      height: 24,
      width: 100,
    });
    const settleUntil = makeSettleUntil({ captureCharFrame, renderOnce });

    try {
      await settleUntil("diff view", (frame) => /ln \d/.test(frame), 5);
      // Pin a.ts, preview b.ts -> strip shows the pinned a.ts and the preview b.ts.
      state.selectFile("src/a.ts");
      mockInput.pressKey("t", { ctrl: true });
      state.selectFile("src/b.ts");
      const frame = await settleUntil("two tabs", (f) => f.includes("src/b.ts"));
      await renderOnce();

      // Read the actual rendered cell attributes (what the terminal paints).
      const italic = createTextAttributes({ italic: true });
      const buffer = renderer.currentRenderBuffer;
      const attributeAt = (x: number, y: number) => buffer.buffers.attributes[y * buffer.width + x];

      const lines = frame.split("\n");
      const row = lines.findIndex((line) => line.includes("src/b.ts"));
      const previewCol = lines[row].indexOf("b.ts");
      const pinnedCol = lines[row].indexOf("a.ts");

      expect(attributeAt(previewCol, row) & italic).toBe(italic);
      expect(attributeAt(pinnedCol, row) & italic).toBe(0);
    } finally {
      renderer.destroy();
      rmSync(repoRoot, { force: true, recursive: true });
    }
  }, 20_000);
});

import { describe, expect, test } from "bun:test";

import { testRender } from "@opentui/solid";

import { App } from "../src/App";
import { state } from "../src/state";
import { createFixtureRepo, loadModel, makeSettleUntil, seedState } from "./helpers";

const FOLDER = "\u{f07b}";
const FOLDER_OPEN = "\u{f07c}";
const CHEVRONS = /[▸▾]/u;

describe("file-type icons", () => {
  test("renders folder glyphs and no chevrons by default", async () => {
    const model = await loadModel(process.cwd(), { kind: "all", ref: "HEAD" });
    seedState(model, { kind: "all", ref: "HEAD" });
    const { renderer, renderOnce, captureCharFrame } = await testRender(() => <App />, {
      height: 32,
      width: 110,
    });
    const settleUntil = makeSettleUntil({ captureCharFrame, renderOnce });

    const frame = await settleUntil("tree", (current) => current.includes("src/"));

    expect(frame.includes(FOLDER) || frame.includes(FOLDER_OPEN)).toBe(true);
    expect(CHEVRONS.test(frame)).toBe(false);

    renderer.destroy();
  });

  test("--no-icons restores chevrons and drops the folder glyphs", async () => {
    const model = await loadModel(process.cwd(), { kind: "all", ref: "HEAD" });
    seedState(model, { kind: "all", ref: "HEAD" });
    state.setIconsEnabled(false);
    const { renderer, renderOnce, captureCharFrame } = await testRender(() => <App />, {
      height: 32,
      width: 110,
    });
    const settleUntil = makeSettleUntil({ captureCharFrame, renderOnce });

    const frame = await settleUntil("tree", (current) => current.includes("src/"));

    expect(CHEVRONS.test(frame)).toBe(true);
    expect(frame.includes(FOLDER) || frame.includes(FOLDER_OPEN)).toBe(false);

    renderer.destroy();
  });

  test("a truncated row stays one line and keeps the icon column stable", async () => {
    /*
     * Two root files at the same depth: one short, one long enough that the
     * narrow sidebar must cut it. Guards two regressions: each row stays one
     * line tall (a wide glyph used to wrap the name onto a blank second line),
     * and the fixed icon column keeps both names starting at the same column.
     */
    const repo = createFixtureRepo("icon-col-", {
      "aaa.ts": "export const a = 1;\n",
      "this-is-a-very-long-filename-that-truncates.ts": "export const z = 1;\n",
    });
    const model = await loadModel(repo, { kind: "all", ref: "HEAD" });
    seedState(model, { kind: "all", ref: "HEAD" });
    const { renderer, renderOnce, captureCharFrame } = await testRender(() => <App />, {
      height: 16,
      width: 44,
    });
    const settleUntil = makeSettleUntil({ captureCharFrame, renderOnce });

    const frame = await settleUntil("tree", (current) => current.includes("aaa.ts"));
    const lines = frame.split("\n");
    const shortIndex = lines.findIndex((line) => line.includes("aaa.ts"));
    const longIndex = lines.findIndex((line) => line.includes("this-is"));

    expect(shortIndex).toBeGreaterThanOrEqual(0);
    // Sorted order is aaa.ts then this-is...; adjacency proves no blank row crept between them.
    expect(longIndex).toBe(shortIndex + 1);
    // The long name is cut, not rendered in full.
    expect(lines[longIndex]).not.toContain("truncates.ts");
    // Both names begin at the same column: the icon column is a stable width.
    expect(lines[shortIndex].indexOf("aaa.ts")).toBe(lines[longIndex].indexOf("this-is"));

    renderer.destroy();
  });
});

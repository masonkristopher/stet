import { describe, expect, test } from "bun:test";

import { testRender } from "@opentui/solid";

import { App } from "@/App";

import { loadModel, makeSettleUntil, seedState } from "./helpers";

describe("App rendering", () => {
  test("renders the repo tree, scope label, and status bar", async () => {
    const model = await loadModel(process.cwd(), { kind: "all", ref: "HEAD" });
    seedState(model, { kind: "all", ref: "HEAD" });
    const { renderer, renderOnce, captureCharFrame } = await testRender(() => <App />, {
      height: 32,
      width: 110,
    });
    const settleUntil = makeSettleUntil({ captureCharFrame, renderOnce });

    const frame = await settleUntil("app chrome", (current) => current.includes("sideye"));

    expect(frame).toContain("sideye");
    expect(frame).toContain("worktree vs HEAD");
    expect(frame).toContain("src/");
    expect(frame).toContain("q quit");

    renderer.destroy();
  });
});

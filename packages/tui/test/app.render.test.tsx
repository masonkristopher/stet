import { describe, expect, test } from "bun:test";

import { testRender } from "@opentui/solid";

import { App } from "@/App";

import { createFixtureRepo, loadModel, makeSettleUntil, seedState } from "./helpers";

describe("App rendering", () => {
  test("renders the repo tree, scope label, and status bar", async () => {
    const repoRoot = createFixtureRepo("app-render-", {
      "src/index.ts": "export const main = true;\n",
    });
    const model = await loadModel(repoRoot, { kind: "all", ref: "HEAD" });
    seedState(model, { kind: "all", ref: "HEAD" });
    const { renderer, renderOnce, captureCharFrame } = await testRender(() => <App />, {
      height: 32,
      width: 110,
    });
    const settleUntil = makeSettleUntil({ captureCharFrame, renderOnce });

    const frame = await settleUntil("app chrome", (current) => current.includes("q quit"));

    expect(frame).toContain("q quit");
    expect(frame).toContain("uncommitted vs HEAD");
    expect(frame).toContain("src");
    expect(frame).toContain("q quit");

    renderer.destroy();
  });
});

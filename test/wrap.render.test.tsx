import { describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";

import { testRender } from "@opentui/solid";

import { App } from "@/App";

import { createFixtureRepo, loadModel, makeSettleUntil, seedState } from "./helpers";

describe("word wrap toggle", () => {
  test("x toggles long-line handling between scroll and wrap", async () => {
    const repoRoot = createFixtureRepo("stet-wrap-", { "src/a.ts": "export const a = 1\n" });
    const model = await loadModel(repoRoot, { kind: "all", ref: "HEAD" });
    seedState(model, { kind: "all", ref: "HEAD" });
    const { renderer, renderOnce, captureCharFrame, mockInput } = await testRender(() => <App />, {
      height: 34,
      width: 120,
    });
    const settleUntil = makeSettleUntil({ captureCharFrame, renderOnce });

    try {
      await settleUntil("app chrome", (frame) => frame.includes("stet"), 5);

      mockInput.pressKey("x");
      const wrapped = await settleUntil("wrap on", (frame) => frame.includes("wrap on"));
      expect(wrapped).toContain("wrap on");

      mockInput.pressKey("x");
      const scrolled = await settleUntil("wrap off", (frame) => frame.includes("wrap off"));
      expect(scrolled).toContain("wrap off");
    } finally {
      renderer.destroy();
      rmSync(repoRoot, { force: true, recursive: true });
    }
  }, 20_000);
});

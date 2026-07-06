import { describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";

import { testRender } from "@opentui/solid";

import { App } from "@/App";

import { createFixtureRepo, loadModel, makeSettleUntil, seedState } from "./helpers";

describe("re-running checks", () => {
  test("r reports checks passed once diagnostics complete", async () => {
    const repoRoot = createFixtureRepo("stet-recheck-", { "README.md": "# Fixture\n" });
    const model = await loadModel(repoRoot, { kind: "all", ref: "HEAD" });
    seedState(model, { kind: "all", ref: "HEAD" });
    const { renderer, renderOnce, captureCharFrame, mockInput } = await testRender(() => <App />, {
      height: 34,
      width: 120,
    });
    const settleUntil = makeSettleUntil({ captureCharFrame, renderOnce });

    try {
      const initial = await settleUntil("app chrome", (frame) => frame.includes("stet"), 5);
      expect(initial).toContain("stet");

      mockInput.pressKey("r");
      const after = await settleUntil("re-run completion", (frame) =>
        frame.includes("checks passed"),
      );
      expect(after).toContain("checks passed");
      expect(after).not.toContain("checking…");
    } finally {
      renderer.destroy();
      rmSync(repoRoot, { force: true, recursive: true });
    }
  }, 20_000);
});

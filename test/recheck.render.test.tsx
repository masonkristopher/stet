import { describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";

import { testRender } from "@opentui/solid";

import { App } from "@/App";

import { createFixtureRepo, loadModel, makeSettleUntil, seedState } from "./helpers";

describe("re-running checks", () => {
  test("r reports checks finished once diagnostics complete", async () => {
    const repoRoot = createFixtureRepo("sideye-recheck-", { "README.md": "# Fixture\n" });
    const model = await loadModel(repoRoot, { kind: "all", ref: "HEAD" });
    seedState(model, { kind: "all", ref: "HEAD" });
    const { renderer, renderOnce, captureCharFrame, mockInput } = await testRender(() => <App />, {
      height: 34,
      width: 120,
    });
    const settleUntil = makeSettleUntil({ captureCharFrame, renderOnce });

    try {
      const initial = await settleUntil("app chrome", (frame) => frame.includes("sideye"), 5);
      expect(initial).toContain("sideye");

      mockInput.pressKey("r");
      const after = await settleUntil("re-run completion", (frame) =>
        frame.includes("checks finished"),
      );
      expect(after).toContain("checks finished");
      expect(after).not.toContain("running checks…");
    } finally {
      renderer.destroy();
      rmSync(repoRoot, { force: true, recursive: true });
    }
  }, 20_000);
});

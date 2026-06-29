import { describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";

import { testRender } from "@opentui/solid";

import { App } from "@/App";

import { createFixtureRepo, loadModel, makeSettleUntil, seedState } from "./helpers";

describe("word wrap toggle", () => {
  test("z toggles long-line handling between scroll and wrap", async () => {
    const repoRoot = createFixtureRepo("sideye-wrap-", { "src/a.ts": "export const a = 1\n" });
    const model = await loadModel(repoRoot, { kind: "all", ref: "HEAD" });
    seedState(model, { kind: "all", ref: "HEAD" });
    const { renderer, renderOnce, captureCharFrame, mockInput } = await testRender(() => <App />, {
      height: 34,
      width: 120,
    });
    const settleUntil = makeSettleUntil({ captureCharFrame, renderOnce });

    try {
      await settleUntil("app chrome", (frame) => frame.includes("sideye"), 5);

      mockInput.pressKey("z");
      const wrapped = await settleUntil("wrap on", (frame) => frame.includes("long lines: wrap"));
      expect(wrapped).toContain("long lines: wrap");

      mockInput.pressKey("z");
      const scrolled = await settleUntil("wrap off", (frame) =>
        frame.includes("long lines: scroll"),
      );
      expect(scrolled).toContain("long lines: scroll");
    } finally {
      renderer.destroy();
      rmSync(repoRoot, { force: true, recursive: true });
    }
  }, 20_000);
});

import { describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";

import { testRender } from "@opentui/solid";

import { App } from "@/App";
import { state } from "@/state";

import { createFixtureRepo, loadModel, makeSettleUntil, seedState } from "./helpers";

// A file longer than the render cap loads partially; the viewer surfaces that in a
// Reserved footer at the content (not the transient status bar), and `f` loads the
// Rest. The hidden-line count is asserted against the model the footer renders from
// So the arithmetic stays honest without hardcoding the caps.
describe("truncation footer", () => {
  test("shows the hidden-line count and clears it when f loads the full file", async () => {
    const big = `${Array.from({ length: 6000 }, (_, index) => `line ${index}`).join("\n")}\n`;
    const repoRoot = createFixtureRepo("stet-trunc-", {
      "big.txt": big,
      "package.json": `${JSON.stringify({ name: "trunc-fixture" })}\n`,
    });

    const model = await loadModel(repoRoot, { kind: "all", ref: "HEAD" });
    seedState(model, { kind: "all", ref: "HEAD" });
    state.selectFile("big.txt");

    const { renderer, renderOnce, captureCharFrame, mockInput } = await testRender(() => <App />, {
      height: 30,
      width: 110,
    });
    const settleUntil = makeSettleUntil({ captureCharFrame, renderOnce });

    try {
      const shown = await settleUntil("truncation footer", (frame) =>
        frame.includes("more lines · f to load"),
      );
      expect(state.truncatedHidden()).toBeGreaterThan(0);
      expect(shown).toContain(`⋯ ${state.truncatedHidden()} more lines · f to load`);

      mockInput.pressKey("f");
      const loaded = await settleUntil(
        "footer clears after loading full content",
        (frame) => !frame.includes("f to load"),
      );
      expect(loaded).not.toContain("f to load");
    } finally {
      renderer.destroy();
      rmSync(repoRoot, { force: true, recursive: true });
    }
  }, 20_000);
});

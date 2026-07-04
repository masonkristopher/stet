import { describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { testRender } from "@opentui/solid";

import { App } from "@/App";

import { createFixtureRepo, loadModel, makeSettleUntil, seedState } from "./helpers";

// Count the terminal rows the long line occupies: scroll mode keeps it on one
// Truncated row (the trailing marker is off-screen); wrap mode flows it across
// Several rows and the marker reappears on a continuation row. A `1 -> auto`
// Box-height transition used to leave an `x` toggle stuck at one row.
describe("long-line wrap toggle", () => {
  test("x wraps a long changed line and back un-wraps it", async () => {
    // Distinct tokens so a continuation row is unambiguous, and a trailing marker
    // Far past any plausible content width so it only renders once wrapped.
    const words = Array.from({ length: 16 }, (_, index) => `tok${index}`).join(" ");
    const long = `const x = "${words} ENDMARKER"`;
    const repoRoot = createFixtureRepo("sideye-wrap-toggle-", {
      "package.json": `${JSON.stringify({ scripts: { lint: "exit 0", typecheck: "exit 0" } })}\n`,
      "src/a.ts": `first line\n${long}\n`,
    });
    writeFileSync(join(repoRoot, "src", "a.ts"), `first CHANGED\n${long} CHANGED\n`);

    const model = await loadModel(repoRoot, { kind: "all", ref: "HEAD" });
    seedState(model, { kind: "all", ref: "HEAD" });
    const { renderer, renderOnce, captureCharFrame, mockInput } = await testRender(() => <App />, {
      height: 30,
      width: 80,
    });
    const settleUntil = makeSettleUntil({ captureCharFrame, renderOnce });

    try {
      // Scroll mode (default): the line is truncated, so the trailing marker that
      // Sits past the viewport width never renders.
      const scrolled = await settleUntil("diff loaded", (frame) => frame.includes("tok0"));
      expect(scrolled).not.toContain("ENDMARKER");

      // Toggle to wrap: the line now flows across rows and the marker appears.
      mockInput.pressKey("x");
      const wrapped = await settleUntil("long line wrapped", (frame) =>
        frame.includes("ENDMARKER"),
      );
      expect(wrapped).toContain("ENDMARKER");

      // Toggle back to scroll: the marker is truncated away again.
      mockInput.pressKey("x");
      const reScrolled = await settleUntil(
        "long line truncated again",
        (frame) => frame.includes("tok0") && !frame.includes("ENDMARKER"),
      );
      expect(reScrolled).not.toContain("ENDMARKER");
    } finally {
      renderer.destroy();
      rmSync(repoRoot, { force: true, recursive: true });
    }
  }, 20_000);
});

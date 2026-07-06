import { describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { testRender } from "@opentui/solid";

import { App } from "@/App";

import { createFixtureRepo, loadModel, makeSettleUntil, seedState } from "./helpers";

describe("in-buffer find", () => {
  test("opens with /, highlights matches, cycles with n, clears on esc", async () => {
    const repoRoot = createFixtureRepo("stet-find-", {
      "README.md": "# Fixture\n",
      "src/sample.ts": "const base = 0\n",
    });
    // Two added lines containing "needle" become two matches in the diff.
    writeFileSync(
      join(repoRoot, "src", "sample.ts"),
      "const base = 0\nconst needle = 1\nreturn needle\n",
    );

    const model = await loadModel(repoRoot, { kind: "all", ref: "HEAD" });
    seedState(model, { kind: "all", ref: "HEAD" });
    const { renderer, renderOnce, captureCharFrame, mockInput } = await testRender(() => <App />, {
      height: 34,
      width: 120,
    });
    const settleUntil = makeSettleUntil({ captureCharFrame, renderOnce });

    try {
      // Wait for the diff to load so the find bar has content to search.
      await settleUntil("diff content", (frame) => frame.includes("needle"), 5);

      // The viewer title row shows the line indicator before searching.
      const before = captureCharFrame();
      expect(before).toContain("· ln");

      // `/` opens the find bar; typing must feed the input, not run global commands.
      mockInput.pressKey("/");
      await mockInput.typeText("needle");
      const matching = await settleUntil("find counter", (frame) => frame.includes("1/2"));
      expect(matching).toContain("1/2");
      // The find bar replaces the title row, so the line indicator is gone while open.
      expect(matching).not.toContain("· ln");

      // Enter commits; n cycles to the second match, then wraps back to the first.
      mockInput.pressEnter();
      mockInput.pressKey("n");
      const cycled = await settleUntil("second match", (frame) => frame.includes("2/2"));
      expect(cycled).toContain("2/2");

      mockInput.pressKey("n");
      await settleUntil("wrapped to first match", (frame) => frame.includes("1/2"));

      // Esc clears the find: the counter disappears and the default hint returns.
      mockInput.pressEscape();
      const cleared = await settleUntil(
        "find cleared",
        (frame) => frame.includes("? keys") && !frame.includes("1/2") && !frame.includes("2/2"),
      );
      expect(cleared).not.toContain("1/2");
      // The title row (line indicator) returns once the find clears.
      expect(cleared).toContain("· ln");
    } finally {
      renderer.destroy();
      rmSync(repoRoot, { force: true, recursive: true });
    }
  }, 20_000);
});

import { describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { testRender } from "@opentui/solid";

import { App } from "@/App";

import { createFixtureRepo, loadModel, makeSettleUntil, seedState } from "./helpers";

describe("markdown folding", () => {
  test("z folds the heading section enclosing the caret, not by indentation", async () => {
    const source = [
      "# Guide",
      "",
      "intro paragraph",
      "",
      "## Install",
      "",
      "step one",
      "step two",
      "step three",
      "",
      "## Usage",
      "",
      "run the command",
      "",
    ].join("\n");
    const repoRoot = createFixtureRepo("sideye-fold-md-", {
      "docs.md": source,
      "package.json": `${JSON.stringify({ scripts: { lint: "exit 0", typecheck: "exit 0" } })}\n`,
    });
    // Edit a line inside the Install section so the file changes and the caret homes there.
    writeFileSync(join(repoRoot, "docs.md"), source.replace("step two", "step 2"));

    const model = await loadModel(repoRoot, { kind: "all", ref: "HEAD" });
    seedState(model, { kind: "all", ref: "HEAD" });
    const { renderer, renderOnce, captureCharFrame, mockInput } = await testRender(() => <App />, {
      height: 30,
      width: 110,
    });
    const settleUntil = makeSettleUntil({ captureCharFrame, renderOnce });

    try {
      await settleUntil("diff shown", (frame) => frame.includes("step three"));
      mockInput.pressTab();

      // Fold the Install section: its body collapses, but sibling headings stay. An
      // Indent-based fold would find nothing here (every line is at column 0).
      mockInput.pressKey("z");
      const folded = await settleUntil("section folded", (frame) => /\d+ lines folded/.test(frame));
      expect(folded).not.toContain("step three");
      expect(folded).toContain("## Install");
      expect(folded).toContain("## Usage");

      mockInput.pressKey("z");
      const unfolded = await settleUntil("section unfolded", (frame) =>
        frame.includes("step three"),
      );
      expect(unfolded).not.toContain("lines folded");
    } finally {
      renderer.destroy();
      rmSync(repoRoot, { force: true, recursive: true });
    }
  }, 20_000);
});

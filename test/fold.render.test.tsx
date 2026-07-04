import { describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { testRender } from "@opentui/solid";

import { App } from "@/App";

import { createFixtureRepo, loadModel, makeSettleUntil, seedState } from "./helpers";

describe("code folding", () => {
  test("z folds the indented block enclosing the caret and unfolds it again", async () => {
    const source = [
      "export function foo() {",
      "  const a = 1",
      "  const b = 2",
      "}",
      "export const top = 1",
      "",
    ].join("\n");
    const repoRoot = createFixtureRepo("sideye-fold-", {
      "package.json": `${JSON.stringify({ scripts: { lint: "exit 0", typecheck: "exit 0" } })}\n`,
      "src/mod.ts": source,
    });
    // A trivial edit makes it a changed file so it auto-selects in the viewer.
    writeFileSync(join(repoRoot, "src", "mod.ts"), source.replace("const a = 1", "const a = 3"));

    const model = await loadModel(repoRoot, { kind: "all", ref: "HEAD" });
    seedState(model, { kind: "all", ref: "HEAD" });
    const { renderer, renderOnce, captureCharFrame, mockInput } = await testRender(() => <App />, {
      height: 30,
      width: 110,
    });
    const settleUntil = makeSettleUntil({ captureCharFrame, renderOnce });

    try {
      // The whole small file shows at once (no elision); the caret homes inside foo.
      await settleUntil("diff shown", (frame) => frame.includes("const b = 2"));
      mockInput.pressTab();

      // Fold: the block collapses behind a marker and its body lines disappear.
      mockInput.pressKey("z");
      const folded = await settleUntil("block folded", (frame) => /\d+ lines folded/.test(frame));
      expect(folded).toContain("export function foo()");
      expect(folded).not.toContain("const b = 2");

      // Unfold (the caret re-homed onto the fold header): the body returns.
      mockInput.pressKey("z");
      const unfolded = await settleUntil("block unfolded", (frame) =>
        frame.includes("const b = 2"),
      );
      expect(unfolded).not.toContain("lines folded");
    } finally {
      renderer.destroy();
      rmSync(repoRoot, { force: true, recursive: true });
    }
  }, 20_000);
});

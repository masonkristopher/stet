import { describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { testRender } from "@opentui/solid";

import { App } from "@/App";

import { createFixtureRepo, loadModel, makeSettleUntil, seedState } from "./helpers";

describe("gap expansion", () => {
  test("z reveals the git-elided unmodified lines nearest the caret", async () => {
    // Twenty flat lines (no indentation, so nothing folds); changing only the first
    // And last leaves a wide unchanged middle that git elides into one gap.
    const lines = Array.from({ length: 20 }, (_, index) => `const l${index + 1} = ${index + 1}`);
    const source = `${lines.join("\n")}\n`;
    const repoRoot = createFixtureRepo("sideye-gap-", {
      "package.json": `${JSON.stringify({ scripts: { lint: "exit 0", typecheck: "exit 0" } })}\n`,
      "src/mod.ts": source,
    });
    const edited = source
      .replace("const l1 = 1", "const l1 = 100")
      .replace("const l20 = 20", "const l20 = 200");
    writeFileSync(join(repoRoot, "src", "mod.ts"), edited);

    const model = await loadModel(repoRoot, { kind: "all", ref: "HEAD" });
    seedState(model, { kind: "all", ref: "HEAD" });
    const { renderer, renderOnce, captureCharFrame, mockInput } = await testRender(() => <App />, {
      height: 30,
      width: 110,
    });
    const settleUntil = makeSettleUntil({ captureCharFrame, renderOnce });

    try {
      // The middle is collapsed into a gap marker; a mid-file line is not shown yet.
      const collapsed = await settleUntil("gap marker shown", (frame) =>
        /unmodified lines/.test(frame),
      );
      expect(collapsed).not.toContain("const l10 = 10");

      // Put the caret on the last line (below the gap), then expand the gap above it.
      // The revealed lines are inserted above the caret; it must stay on line 20, not
      // Shift up by the number of revealed lines once the async source load lands.
      mockInput.pressTab();
      mockInput.pressKey("G");
      await settleUntil("caret on last line", (frame) => /ln 20:\d/.test(frame));
      mockInput.pressKey("z");
      const expanded = await settleUntil("gap expanded", (frame) =>
        frame.includes("const l10 = 10"),
      );
      expect(expanded).toContain("const l10 = 10");
      expect(expanded).toMatch(/ln 20:\d/);
    } finally {
      renderer.destroy();
      rmSync(repoRoot, { force: true, recursive: true });
    }
  }, 20_000);
});

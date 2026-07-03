import { describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { testRender } from "@opentui/solid";

import { App } from "@/App";

import { createFixtureRepo, loadModel, makeSettleUntil, runGit, seedState } from "./helpers";

// Long, gitmoji-bearing subjects that overflow the overlay at this width: they must
// Clip to one line, never wrap a row two cells tall (the emoji variation-selector trap).
function commitFixture(prefix: string) {
  const repoRoot = createFixtureRepo(prefix, {
    "package.json": `${JSON.stringify({ name: "commits-fixture" })}\n`,
    "src/a.ts": "const a = 1\n",
  });
  writeFileSync(join(repoRoot, "src", "a.ts"), "const a = 2\n");
  runGit(repoRoot, [
    "commit",
    "-am",
    "ZEBRA ✨ a deliberately long subject that overflows the row",
  ]);
  writeFileSync(join(repoRoot, "src", "a.ts"), "const a = 3\n");
  runGit(repoRoot, ["commit", "-am", "YACHT 🐛 another long subject wider than the overlay box"]);
  writeFileSync(join(repoRoot, "src", "a.ts"), "const a = 4\n");
  runGit(repoRoot, ["commit", "-am", "XENON 🔄 the newest commit with a long trailing subject"]);
  return repoRoot;
}

describe("commit drill-down", () => {
  test("lists recent commits, each on its own line, and picking one relabels the header", async () => {
    const repoRoot = commitFixture("sideye-commits-");
    const model = await loadModel(repoRoot, { kind: "all", ref: "HEAD" });
    seedState(model, { kind: "all", ref: "HEAD" });
    const { renderer, renderOnce, captureCharFrame, mockInput } = await testRender(() => <App />, {
      height: 30,
      width: 90,
    });
    const settleUntil = makeSettleUntil({ captureCharFrame, renderOnce });

    try {
      // From `all` (index 2) step down to the commits drill-down row (index 5), then enter.
      mockInput.pressKey("s");
      await settleUntil("scope picker opens", (frame) => frame.includes("switch scope"));
      mockInput.pressKey("j");
      mockInput.pressKey("j");
      mockInput.pressKey("j");
      await settleUntil("cursor on the commits row", () => true, 2);
      mockInput.pressEnter();

      const list = await settleUntil(
        "the commit list shows newest-first",
        (frame) => frame.includes("commits") && frame.includes("XENON") && frame.includes("ZEBRA"),
      );

      // No-wrap: the three commit rows land on consecutive lines. A wrapped subject
      // Would push the next sha down an extra row and break this adjacency.
      const lines = list.split("\n");
      const xenon = lines.findIndex((line) => line.includes("XENON"));
      const yacht = lines.findIndex((line) => line.includes("YACHT"));
      const zebra = lines.findIndex((line) => line.includes("ZEBRA"));
      expect(xenon).toBeGreaterThanOrEqual(0);
      expect(yacht).toBe(xenon + 1);
      expect(zebra).toBe(yacht + 1);

      // Pick the second commit (YACHT); the picker closes and the header names the
      // Commit by sha + subject (no position counter).
      mockInput.pressKey("j");
      await settleUntil("cursor moved to the second commit", () => true, 2);
      mockInput.pressEnter();
      const after = await settleUntil(
        "header names the commit by subject",
        (frame) => !frame.includes("switch scope") && frame.includes("YACHT"),
      );
      expect(after).toContain("YACHT");
    } finally {
      renderer.destroy();
      rmSync(repoRoot, { force: true, recursive: true });
    }
  }, 20_000);
});

import { describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { testRender } from "@opentui/solid";

import { App } from "@/App";

import { createFixtureRepo, loadModel, makeSettleUntil, runGit, seedState } from "./helpers";

describe("worktree picker", () => {
  test("opens with w, escape keeps the current worktree, enter switches the whole app", async () => {
    const repoRoot = createFixtureRepo("stet-worktree-", {
      "README.md": "# Fixture\n",
      "src/main-only.ts": "export const main = true\n",
    });
    const linkedRoot = join(repoRoot, ".wt");
    runGit(repoRoot, ["worktree", "add", "-b", "side-branch", linkedRoot]);
    writeFileSync(join(linkedRoot, "side-only.ts"), "export const side = true\n");
    writeFileSync(join(repoRoot, "src", "main-only.ts"), "export const main = false\n");

    const model = await loadModel(repoRoot, { kind: "all", ref: "HEAD" });
    seedState(model, { kind: "all", ref: "HEAD" });
    const { renderer, renderOnce, captureCharFrame, mockInput } = await testRender(() => <App />, {
      height: 34,
      width: 120,
    });
    const settleUntil = makeSettleUntil({ captureCharFrame, renderOnce });

    try {
      const initial = await settleUntil(
        "app chrome",
        (frame) => frame.includes("q quit") && frame.includes("main-only.ts"),
        5,
      );
      expect(initial).toContain("main-only.ts");
      expect(initial).not.toContain("side-only.ts");

      mockInput.pressKey("w");
      const picker = await settleUntil(
        "worktree picker",
        (frame) => frame.includes("switch worktree") && frame.includes("side-branch"),
      );
      expect(picker).toContain("side-branch");

      mockInput.pressEscape();
      const closed = await settleUntil("picker closed", (frame) => !frame.includes("side-branch"));
      expect(closed).toContain("main-only.ts");
      expect(closed).not.toContain("side-only.ts");

      mockInput.pressKey("w");
      await settleUntil("worktree picker again", (frame) => frame.includes("side-branch"));
      mockInput.pressArrow("down");
      // Let the cursor move commit before enter, as a real key cadence would
      await settleUntil("picker cursor moved", () => true, 2);
      mockInput.pressEnter();
      const switched = await settleUntil(
        "linked worktree loaded",
        (frame) =>
          frame.includes("side-only.ts") &&
          frame.includes("side-branch") &&
          frame.includes("uncommitted vs HEAD"),
      );
      expect(switched).toContain("side-only.ts");
      expect(switched).toContain("side-branch");
      expect(switched).toContain("uncommitted vs HEAD");
    } finally {
      renderer.destroy();
      rmSync(repoRoot, { force: true, recursive: true });
    }
  }, 20_000);

  test("typing filters the worktree list", async () => {
    const repoRoot = createFixtureRepo("stet-worktree-filter-", {
      "README.md": "# Fixture\n",
    });
    const linkedRoot = join(repoRoot, ".wt");
    runGit(repoRoot, ["worktree", "add", "-b", "side-branch", linkedRoot]);

    const model = await loadModel(repoRoot, { kind: "all", ref: "HEAD" });
    seedState(model, { kind: "all", ref: "HEAD" });
    const { renderer, renderOnce, captureCharFrame, mockInput } = await testRender(() => <App />, {
      height: 34,
      width: 120,
    });
    const settleUntil = makeSettleUntil({ captureCharFrame, renderOnce });

    try {
      await settleUntil("app chrome", (frame) => frame.includes("q quit"), 5);

      mockInput.pressKey("w");
      await settleUntil("worktree picker", (frame) => frame.includes("side-branch"));

      await mockInput.typeText("branch");
      const filtered = await settleUntil("filtered to side-branch", (frame) =>
        frame.includes("side-branch"),
      );
      expect(filtered).toContain("side-branch");

      await mockInput.typeText("zzz");
      const empty = await settleUntil(
        "no matches",
        (frame) => frame.includes("no matches") && !frame.includes("side-branch"),
      );
      expect(empty).toContain("no matches");
    } finally {
      renderer.destroy();
      rmSync(repoRoot, { force: true, recursive: true });
    }
  }, 20_000);
});

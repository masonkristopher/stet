import { describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

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

  test("each row says how much work sits in that worktree and how recently it moved", async () => {
    const repoRoot = createFixtureRepo("stet-worktree-activity-", { "README.md": "# Fixture\n" });
    // Outside the repo, so the main worktree reads as genuinely clean: a nested worktree is an
    // Untracked entry in its parent (real setups gitignore theirs, as this repo does).
    const linkedRoot = `${repoRoot}-linked`;
    runGit(repoRoot, ["worktree", "add", "-b", "busy-branch", linkedRoot]);
    writeFileSync(join(linkedRoot, "one.ts"), "export const one = 1\n");
    writeFileSync(join(linkedRoot, "two.ts"), "export const two = 2\n");

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
      const picker = await settleUntil(
        "worktree summaries",
        (frame) => frame.includes("busy-branch") && frame.includes("now"),
      );

      // Every worktree carries an age, and the one just written in sorts to the top. `relativeTime`
      // Calls anything under a minute "now", and the fixture just committed, so both read "now".
      const rows = picker
        .split("\n")
        .filter((line) => /busy-branch|● (?<default>main|master)/.test(line));
      expect(rows).toHaveLength(2);
      expect(rows[0]).toContain("busy-branch");
      for (const row of rows) {
        expect(row).toContain("now");
      }
    } finally {
      renderer.destroy();
      rmSync(repoRoot, { force: true, recursive: true });
      rmSync(linkedRoot, { force: true, recursive: true });
    }
  }, 20_000);

  test("the footer carries the highlighted worktree's whole path, and follows the cursor", async () => {
    const repoRoot = createFixtureRepo("stet-wt-path-", { "README.md": "# Fixture\n" });
    const linkedRoot = `${repoRoot}-linked`;
    runGit(repoRoot, ["worktree", "add", "-b", "other-branch", linkedRoot]);

    const model = await loadModel(repoRoot, { kind: "all", ref: "HEAD" });
    seedState(model, { kind: "all", ref: "HEAD" });
    const { renderer, renderOnce, captureCharFrame, mockInput } = await testRender(() => <App />, {
      height: 30,
      width: 160,
    });
    const settleUntil = makeSettleUntil({ captureCharFrame, renderOnce });

    try {
      await settleUntil("app chrome", (frame) => frame.includes("q quit"), 5);
      mockInput.pressKey("w");
      await settleUntil("worktree rows", (frame) => frame.includes("other-branch"));

      // The path arrives *whole*. The old per-row column clipped its last characters against the
      // Overlay's border (`…trees/lsp-watched-file`, no `s`), so the complete directory name is the
      // Witness: the footer left-truncates only a head that does not fit, never a tail.
      const mainName = basename(repoRoot);
      const linkedName = basename(linkedRoot);

      // The picker opens on the worktree being inspected, so the footer starts on the main one.
      const onMain = await settleUntil("main's path", (frame) => frame.includes(mainName));
      expect(onMain).toContain(mainName);
      expect(onMain).not.toContain(linkedName);

      // Moving the cursor swaps the footer to the newly highlighted worktree.
      mockInput.pressArrow("up");
      const onLinked = await settleUntil("the linked worktree's path", (frame) =>
        frame.includes(linkedName),
      );
      expect(onLinked).toContain(linkedName);
    } finally {
      renderer.destroy();
      rmSync(repoRoot, { force: true, recursive: true });
      rmSync(linkedRoot, { force: true, recursive: true });
    }
  }, 20_000);

  test("the age holds its column whatever the marker, label, or badges", async () => {
    const repoRoot = createFixtureRepo("stet-worktree-align-", { "README.md": "# Fixture\n" });
    const busyRoot = `${repoRoot}-busy`;
    const lockedRoot = `${repoRoot}-locked`;
    const quietRoot = `${repoRoot}-quiet`;
    runGit(repoRoot, ["worktree", "add", "-b", "feat/busy-branch", busyRoot]);
    runGit(repoRoot, ["worktree", "add", "-b", "chore/a-very-long-branch-name", lockedRoot]);
    runGit(repoRoot, ["worktree", "add", "-b", "docs/quiet", quietRoot]);
    runGit(repoRoot, ["worktree", "lock", lockedRoot]);
    writeFileSync(join(busyRoot, "a.ts"), "export const a = 1\n");
    writeFileSync(join(busyRoot, "b.ts"), "export const b = 2\n");

    const model = await loadModel(repoRoot, { kind: "all", ref: "HEAD" });
    seedState(model, { kind: "all", ref: "HEAD" });
    const { renderer, renderOnce, captureCharFrame, mockInput } = await testRender(() => <App />, {
      height: 30,
      width: 120,
    });
    const settleUntil = makeSettleUntil({ captureCharFrame, renderOnce });

    try {
      await settleUntil("app chrome", (frame) => frame.includes("q quit"), 5);
      mockInput.pressKey("w");
      const frame = await settleUntil(
        "worktree rows",
        (candidate) => candidate.includes("busy-branch") && candidate.includes("locked"),
      );

      // Cells that render nothing (the marker box on every row but the current one) used to be
      // Whitespace-only `<text>`s, which measure zero cells in a flex row and slid everything right
      // Of them out of line. The age is the witness: an absent marker, a long label, and a `locked`
      // Badge must all leave it exactly where it was.
      const ageStarts = new Set(
        frame
          .split("\n")
          .filter((line) => /feat\/|chore\/|docs\/|● (?<default>main|master)/.test(line))
          .map((line) => {
            const match = /\bnow\b/.exec(line);
            return match === null ? -1 : match.index;
          }),
      );

      expect(ageStarts.size).toBeGreaterThan(0);
      expect(ageStarts.has(-1)).toBe(false);
      expect(ageStarts.size).toBe(1);
    } finally {
      renderer.destroy();
      rmSync(repoRoot, { force: true, recursive: true });
      for (const root of [busyRoot, lockedRoot, quietRoot]) {
        rmSync(root, { force: true, recursive: true });
      }
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

import { describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { testRender } from "@opentui/solid";

import { App } from "@/App";
import { state } from "@/state";

import { createFixtureRepo, loadModel, makeSettleUntil, runGit, seedState } from "./helpers";

describe("scope switching", () => {
  test("re-runs checks for the new scope's changed set", async () => {
    const repoRoot = createFixtureRepo("sideye-scope-", {
      "package.json": `${JSON.stringify({ name: "scope-fixture" })}\n`,
      "src/a.ts": "const a = 1\n",
    });
    // An unstaged edit: the default `all` scope sees it, the `staged` scope does not.
    writeFileSync(join(repoRoot, "src", "a.ts"), "const a = 2\n");

    const model = await loadModel(repoRoot, { kind: "all", ref: "HEAD" });
    seedState(model, { kind: "all", ref: "HEAD" });
    const { renderer, renderOnce, captureCharFrame, mockInput } = await testRender(() => <App />, {
      height: 34,
      width: 120,
    });
    const settleUntil = makeSettleUntil({ captureCharFrame, renderOnce });

    try {
      // Main runs the initial checks at startup; mirror that here. The `all` scope sees the unstaged
      // Edit, so a.ts shows a "+1 -1" change indicator.
      void state.runChecks(model);
      await settleUntil(
        "all scope shows the unstaged change",
        (frame) => frame.includes("+1 -1") && frame.includes("checks finished"),
        5,
        400,
      );

      // `s` opens the picker on the active scope (all, index 2); `k` moves up to
      // Staged (index 1); `return` selects it. Nothing is staged, so the new
      // Changed set is empty and the recheck runs against it: the change indicator
      // Must disappear, which a stale all-scope frame cannot satisfy.
      mockInput.pressKey("s");
      await settleUntil("scope picker opens", (frame) => frame.includes("all changes"));
      mockInput.pressKey("k");
      // Let the cursor move commit before enter, as a real key cadence would.
      await settleUntil("picker cursor moved", () => true, 2);
      mockInput.pressEnter();
      const after = await settleUntil(
        "staged scope drops the unstaged change",
        (frame) =>
          frame.includes("staged vs HEAD") &&
          !frame.includes("+1 -1") &&
          frame.includes("checks finished"),
        1,
        400,
      );
      expect(after).toContain("staged vs HEAD");
      expect(after).not.toContain("+1 -1");
    } finally {
      renderer.destroy();
      rmSync(repoRoot, { force: true, recursive: true });
    }
  }, 20_000);

  test("the picker lists every scope and marks the active one, and escape closes it", async () => {
    const repoRoot = createFixtureRepo("sideye-scope-picker-", {
      "package.json": `${JSON.stringify({ name: "scope-picker-fixture" })}\n`,
    });

    const model = await loadModel(repoRoot, { kind: "all", ref: "HEAD" });
    seedState(model, { kind: "all", ref: "HEAD" });
    const { renderer, renderOnce, captureCharFrame, mockInput } = await testRender(() => <App />, {
      height: 34,
      width: 120,
    });
    const settleUntil = makeSettleUntil({ captureCharFrame, renderOnce });

    try {
      mockInput.pressKey("s");
      const open = await settleUntil(
        "picker lists all scopes",
        (frame) =>
          frame.includes("unstaged") &&
          // Word-bounded so the "unstaged" row can't satisfy the staged check.
          /\bstaged\b/.test(frame) &&
          frame.includes("all changes") &&
          frame.includes("since session start") &&
          frame.includes("last commit"),
      );
      // The active scope (all) carries the ● marker.
      expect(open).toContain("● all changes");

      mockInput.pressEscape();
      const closed = await settleUntil(
        "escape closes the picker",
        (frame) => !frame.includes("● all changes"),
      );
      expect(closed).not.toContain("since session start");
    } finally {
      renderer.destroy();
      rmSync(repoRoot, { force: true, recursive: true });
    }
  }, 20_000);

  test("selecting session relabels the header without restarting", async () => {
    const repoRoot = createFixtureRepo("sideye-scope-session-", {
      "package.json": `${JSON.stringify({ name: "scope-session-fixture" })}\n`,
      "src/a.ts": "const a = 1\n",
    });
    writeFileSync(join(repoRoot, "src", "a.ts"), "const a = 2\n");

    const model = await loadModel(repoRoot, { kind: "all", ref: "HEAD" });
    seedState(model, { kind: "all", ref: "HEAD" });
    const { renderer, renderOnce, captureCharFrame, mockInput } = await testRender(() => <App />, {
      height: 34,
      width: 120,
    });
    const settleUntil = makeSettleUntil({ captureCharFrame, renderOnce });

    try {
      await settleUntil("all scope is active", (frame) => frame.includes("worktree vs HEAD"));

      // From all (index 2), `j` moves down to session (index 3); `return` selects.
      mockInput.pressKey("s");
      await settleUntil("scope picker opens", (frame) => frame.includes("since session start"));
      mockInput.pressKey("j");
      // Let the cursor move commit before enter, as a real key cadence would.
      await settleUntil("picker cursor moved", () => true, 2);
      mockInput.pressEnter();
      const after = await settleUntil(
        "header shows the session scope",
        (frame) => frame.includes("since session start") && !frame.includes("worktree vs HEAD"),
      );
      // Session base defaults to HEAD here, so the unstaged change is still in view.
      expect(after).toContain("since session start");
      expect(after).toContain("+1 -1");
    } finally {
      renderer.destroy();
      rmSync(repoRoot, { force: true, recursive: true });
    }
  }, 20_000);

  test("last-commit shows the newest commit's own diff", async () => {
    const repoRoot = createFixtureRepo("sideye-scope-lastcommit-", {
      "package.json": `${JSON.stringify({ name: "scope-lastcommit-fixture" })}\n`,
      "src/a.ts": "const a = 1\n",
    });
    // A second commit: last-commit must diff it against its parent (the root commit),
    // Not fold in any working-tree state. The tree is otherwise clean.
    writeFileSync(join(repoRoot, "src", "a.ts"), "const a = 2\n");
    runGit(repoRoot, ["commit", "-am", "second"]);

    const model = await loadModel(repoRoot, { kind: "all", ref: "HEAD" });
    seedState(model, { kind: "all", ref: "HEAD" });
    const { renderer, renderOnce, captureCharFrame, mockInput } = await testRender(() => <App />, {
      height: 34,
      width: 120,
    });
    const settleUntil = makeSettleUntil({ captureCharFrame, renderOnce });

    try {
      // The working tree is clean, so all shows nothing changed.
      await settleUntil("all scope is active", (frame) => frame.includes("worktree vs HEAD"));

      // From all (index 2), `j` twice reaches last-commit (index 4); `return` selects.
      mockInput.pressKey("s");
      await settleUntil("scope picker opens", (frame) => frame.includes("last commit"));
      mockInput.pressKey("j");
      mockInput.pressKey("j");
      await settleUntil("picker cursor moved", () => true, 2);
      mockInput.pressEnter();
      const after = await settleUntil(
        "last-commit reveals the second commit's change",
        (frame) => frame.includes("last commit") && frame.includes("+1 -1"),
      );
      expect(after).toContain("last commit");
      expect(after).toContain("+1 -1");
    } finally {
      renderer.destroy();
      rmSync(repoRoot, { force: true, recursive: true });
    }
  }, 20_000);
});

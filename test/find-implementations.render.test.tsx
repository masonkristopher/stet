import { describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { testRender } from "@opentui/solid";

import { App } from "@/App";
import { state } from "@/state";

import { createFixtureRepo, loadModel, makeSettleUntil, seedState } from "./helpers";

// A `.txt` fixture has no language server advertising `implementation`, so the pull resolves
// Empty without spawning one: this stays off a real server (env-dependent, slow, and it would
// Pollute the shared runtime), the way intel-service.test.ts covers the pull's result branches
// Against a fake peer. Here the point is the state action's own surface: the in-flight indicator
// It shares with go-to-definition, and the `implementations` overlay it opens.
describe("find-implementations", () => {
  test("acknowledges Shift+I instantly, then the status bar settles to the result", async () => {
    const repoRoot = createFixtureRepo("sideye-impl-", {
      "notes.txt": "alpha\n",
      "package.json": `${JSON.stringify({ name: "impl-fixture" })}\n`,
    });
    writeFileSync(join(repoRoot, "notes.txt"), "alpha\nbravo charlie\n");

    const model = await loadModel(repoRoot, { kind: "all", ref: "HEAD" });
    seedState(model, { kind: "all", ref: "HEAD" });
    const { renderer, renderOnce, captureCharFrame } = await testRender(() => <App />, {
      height: 30,
      width: 110,
    });
    const settleUntil = makeSettleUntil({ captureCharFrame, renderOnce });

    try {
      // Caret lands on `bravo` (a symbol) on the added line, so the guards pass.
      await settleUntil("caret on the added line", (frame) => /ln 2:1\b/.test(frame));

      // Mirrors go-to-definition: the indicator is set synchronously, before the pull is awaited.
      const pending = state.findImplementations();
      expect(state.statusRight()).toContain("resolving implementations…");
      expect(state.statusRightLevel()).toBe("info");

      await pending;

      // No capable server for a `.txt`, so the pull resolves empty and the status bar drops the
      // In-flight indicator for the resolved notice with its info glyph.
      const settled = await settleUntil("status bar settles to the result", (frame) =>
        frame.includes("ℹ no implementations"),
      );
      expect(settled).not.toContain("resolving implementations…");
    } finally {
      renderer.destroy();
      rmSync(repoRoot, { force: true, recursive: true });
    }
  }, 20_000);

  test("opens the implementations overlay without the call-hierarchy direction hint", async () => {
    const repoRoot = createFixtureRepo("sideye-impl-", {
      "notes.txt": "alpha\n",
      "package.json": `${JSON.stringify({ name: "impl-fixture" })}\n`,
    });
    writeFileSync(join(repoRoot, "notes.txt"), "alpha\nbravo charlie\n");

    const model = await loadModel(repoRoot, { kind: "all", ref: "HEAD" });
    seedState(model, { kind: "all", ref: "HEAD" });
    const { renderer, renderOnce, captureCharFrame } = await testRender(() => <App />, {
      height: 30,
      width: 110,
    });
    const settleUntil = makeSettleUntil({ captureCharFrame, renderOnce });

    try {
      await settleUntil("caret on the added line", (frame) => /ln 2:1\b/.test(frame));

      // Seed the multi-result overlay directly (like the references viewport test), so the label
      // And footer render without a real server: two concrete bodies of one interface member.
      state.openReferences("implementations", [
        { column: 1, line: 1, path: "src/a.ts", text: "export class A {}" },
        { column: 1, line: 1, path: "src/b.ts", text: "export class B {}" },
      ]);

      const open = await settleUntil("overlay open with the implementations summary", (frame) =>
        frame.includes("2 implementations in 2 files"),
      );
      // The overlay carries the shared footer, but implementations aren't directional, so the
      // `⇥ direction` toggle (call hierarchy's) must not appear.
      expect(open).toContain("⏎ open");
      expect(open).not.toContain("⇥ direction");
    } finally {
      renderer.destroy();
      rmSync(repoRoot, { force: true, recursive: true });
    }
  }, 20_000);
});

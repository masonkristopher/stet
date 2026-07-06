import { describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { testRender } from "@opentui/solid";

import { App } from "@/App";
import { state } from "@/state";

import { createFixtureRepo, loadModel, makeSettleUntil, seedState } from "./helpers";

// A non-code fixture (.txt) has no language server that provides definition, so
// `goToDefinition` resolves to "no definition" at once, without acquiring or
// Spawning a server. That keeps the test hermetic: it never leaves a real LSP
// Process in the shared runtime (a .ts fixture would spawn typescript-language-server
// And block on project load). The pull is covered against a fake peer in
// Intel-service.test.ts.
describe("go-to-definition in-flight indicator", () => {
  test("acknowledges F12 instantly, then the status bar settles to the result", async () => {
    const repoRoot = createFixtureRepo("stet-def-", {
      "notes.txt": "alpha\n",
      "package.json": `${JSON.stringify({ name: "def-fixture" })}\n`,
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

      // `goToDefinition` sets the indicator synchronously, before the pull is awaited.
      // The loading state is sub-frame here (no server, so the pull settles at once),
      // So its exact value is asserted on the model the status bar renders from; the
      // Rendered info glyph and the clearing are covered by the settled frame below.
      const pending = state.goToDefinition();
      expect(state.statusRight()).toContain("resolving definition…");
      expect(state.statusRightLevel()).toBe("info");

      await pending;

      // End to end: the rendered status bar drops the in-flight indicator and shows
      // The resolved notice with its info glyph, never a stale "resolving" line.
      const settled = await settleUntil("status bar settles to the result", (frame) =>
        frame.includes("ℹ no definition"),
      );
      expect(settled).not.toContain("resolving definition…");
    } finally {
      renderer.destroy();
      rmSync(repoRoot, { force: true, recursive: true });
    }
  }, 20_000);
});

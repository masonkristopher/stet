import { describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { testRender } from "@opentui/solid";

import { App } from "@/App";
import { SymbolKind } from "@/intel/protocol";
import { state } from "@/state";

import { createFixtureRepo, loadModel, makeSettleUntil, seedState } from "./helpers";

// A `.txt` fixture has no server advertising `documentSymbol`, so `findSymbols` resolves to the
// Unsupported state without a request or a spawned server (the same reasoning as the references
// Render test). These tests exercise the overlay surface: it opens on the request, renders each
// State with the shared footer, follows the cursor when the list overflows, and closes on escape
// Or repo/file/content drift.
describe("symbols overlay", () => {
  test("opens on find-symbols, renders the unsupported screen, and closes on escape", async () => {
    const repoRoot = createFixtureRepo("stet-symbols-", {
      "notes.txt": "alpha beta\n",
      "package.json": `${JSON.stringify({ scripts: { lint: "exit 0", typecheck: "exit 0" } })}\n`,
    });
    writeFileSync(join(repoRoot, "notes.txt"), "alpha beta\ngamma delta\n");

    const model = await loadModel(repoRoot, { kind: "all", ref: "HEAD" });
    seedState(model, { kind: "all", ref: "HEAD" });
    const { renderer, renderOnce, captureCharFrame, mockInput } = await testRender(() => <App />, {
      height: 30,
      width: 110,
    });
    const settleUntil = makeSettleUntil({ captureCharFrame, renderOnce });

    try {
      await settleUntil("caret on the added line", (frame) => /ln 2:1\b/.test(frame));

      void state.findSymbols();
      const unsupported = await settleUntil("unsupported screen", (frame) =>
        frame.includes("no symbol support"),
      );
      expect(unsupported).toContain("↑↓ navigate");

      mockInput.pressEscape();
      const closed = await settleUntil(
        "overlay closed",
        (frame) => !frame.includes("no symbol support"),
      );
      expect(closed).not.toContain("↑↓ navigate");
    } finally {
      renderer.destroy();
      rmSync(repoRoot, { force: true, recursive: true });
    }
  }, 20_000);

  test("closes when the repoRoot changes under it (a worktree switch)", async () => {
    const repoRoot = createFixtureRepo("stet-symbols-", {
      "notes.txt": "alpha beta\n",
      "package.json": `${JSON.stringify({ scripts: { lint: "exit 0", typecheck: "exit 0" } })}\n`,
    });
    writeFileSync(join(repoRoot, "notes.txt"), "alpha beta\ngamma delta\n");
    const otherRoot = createFixtureRepo("stet-symbols-other-", { "readme.md": "other\n" });

    const model = await loadModel(repoRoot, { kind: "all", ref: "HEAD" });
    seedState(model, { kind: "all", ref: "HEAD" });
    const { renderer, renderOnce, captureCharFrame } = await testRender(() => <App />, {
      height: 30,
      width: 110,
    });
    const settleUntil = makeSettleUntil({ captureCharFrame, renderOnce });

    try {
      await settleUntil("caret on the added line", (frame) => /ln 2:1\b/.test(frame));

      void state.findSymbols();
      await settleUntil("overlay open", (frame) => frame.includes("no symbol support"));

      state.setRepoRoot(otherRoot);
      const closed = await settleUntil(
        "overlay closed by the repo change",
        (frame) => !frame.includes("no symbol support"),
      );
      expect(closed).not.toContain("↑↓ navigate");
    } finally {
      renderer.destroy();
      rmSync(repoRoot, { force: true, recursive: true });
      rmSync(otherRoot, { force: true, recursive: true });
    }
  }, 20_000);

  test("closes when the open file's content reloads under it", async () => {
    const repoRoot = createFixtureRepo("stet-symbols-", {
      "notes.txt": "alpha beta\n",
      "package.json": `${JSON.stringify({ scripts: { lint: "exit 0", typecheck: "exit 0" } })}\n`,
    });
    writeFileSync(join(repoRoot, "notes.txt"), "alpha beta\ngamma delta\n");

    const model = await loadModel(repoRoot, { kind: "all", ref: "HEAD" });
    seedState(model, { kind: "all", ref: "HEAD" });
    const { renderer, renderOnce, captureCharFrame } = await testRender(() => <App />, {
      height: 30,
      width: 110,
    });
    const settleUntil = makeSettleUntil({ captureCharFrame, renderOnce });

    try {
      await settleUntil("caret on the added line", (frame) => /ln 2:1\b/.test(frame));

      void state.findSymbols();
      await settleUntil("overlay open", (frame) => frame.includes("no symbol support"));

      // The open file's content reloads (an edit the watcher picks up), minting a new ChangedFile
      // Identity for the same path, so the outline's captured positions are stale and it must close.
      writeFileSync(join(repoRoot, "notes.txt"), "alpha beta\ngamma delta\nepsilon zeta\n");
      const refreshed = await loadModel(repoRoot, { kind: "all", ref: "HEAD" });
      state.setGitModel(refreshed);

      const closed = await settleUntil(
        "overlay closed by the content reload",
        (frame) => !frame.includes("no symbol support"),
      );
      expect(closed).not.toContain("↑↓ navigate");
    } finally {
      renderer.destroy();
      rmSync(repoRoot, { force: true, recursive: true });
    }
  }, 20_000);

  test("scrolls the viewport to follow the cursor past the visible window", async () => {
    const repoRoot = createFixtureRepo("stet-symbols-", {
      "notes.txt": "alpha beta\n",
      "package.json": `${JSON.stringify({ scripts: { lint: "exit 0", typecheck: "exit 0" } })}\n`,
    });
    writeFileSync(join(repoRoot, "notes.txt"), "alpha beta\ngamma delta\n");

    const model = await loadModel(repoRoot, { kind: "all", ref: "HEAD" });
    seedState(model, { kind: "all", ref: "HEAD" });
    const { renderer, renderOnce, captureCharFrame, mockInput } = await testRender(() => <App />, {
      height: 30,
      width: 110,
    });
    const settleUntil = makeSettleUntil({ captureCharFrame, renderOnce });

    try {
      await settleUntil("caret on the added line", (frame) => /ln 2:1\b/.test(frame));

      // Seed enough symbols to overflow the 14-row viewport, each with a unique marker name so
      // Scroll position reads straight off the captured char frame.
      const results = Array.from({ length: 30 }, (_symbol, index) => ({
        column: 1,
        depth: 0,
        kind: SymbolKind.Function,
        line: index + 1,
        name: `marker_${String(index).padStart(3, "0")}`,
      }));
      state.openSymbols(results);

      const top = await settleUntil("overlay open at the top", (frame) =>
        frame.includes("marker_000"),
      );
      expect(top).not.toContain("marker_029");

      // Ctrl-n is down in the symbols keymap; drive the cursor to the last symbol.
      for (let i = 0; i < 29; i += 1) {
        mockInput.pressKey("n", { ctrl: true });
      }

      const scrolled = await settleUntil("viewport followed the cursor", (frame) =>
        frame.includes("marker_029"),
      );
      expect(scrolled).not.toContain("marker_000");
    } finally {
      renderer.destroy();
      rmSync(repoRoot, { force: true, recursive: true });
    }
  }, 20_000);

  test("indents a nested child under its parent", async () => {
    const repoRoot = createFixtureRepo("stet-symbols-", {
      "notes.txt": "alpha beta\n",
      "package.json": `${JSON.stringify({ scripts: { lint: "exit 0", typecheck: "exit 0" } })}\n`,
    });
    writeFileSync(join(repoRoot, "notes.txt"), "alpha beta\ngamma delta\n");

    const model = await loadModel(repoRoot, { kind: "all", ref: "HEAD" });
    seedState(model, { kind: "all", ref: "HEAD" });
    const { renderer, renderOnce, captureCharFrame } = await testRender(() => <App />, {
      height: 30,
      width: 110,
    });
    const settleUntil = makeSettleUntil({ captureCharFrame, renderOnce });

    try {
      await settleUntil("caret on the added line", (frame) => /ln 2:1\b/.test(frame));

      state.openSymbols([
        { column: 1, depth: 0, kind: SymbolKind.Class, line: 1, name: "parentsym" },
        { column: 3, depth: 1, kind: SymbolKind.Method, line: 2, name: "childsym" },
      ]);

      const frame = await settleUntil(
        "both rows rendered",
        (f) => f.includes("parentsym") && f.includes("childsym"),
      );
      // The child sits one level deeper, so its name paints further right than the parent's.
      const rows = frame.split("\n");
      const parentRow = rows.find((row) => row.includes("parentsym")) ?? "";
      const childRow = rows.find((row) => row.includes("childsym")) ?? "";
      expect(childRow.indexOf("childsym")).toBeGreaterThan(parentRow.indexOf("parentsym"));
    } finally {
      renderer.destroy();
      rmSync(repoRoot, { force: true, recursive: true });
    }
  }, 20_000);
});

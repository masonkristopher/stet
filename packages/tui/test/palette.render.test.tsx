import { describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";

import { testRender } from "@opentui/solid";

import { App } from "@/App";

import { createFixtureRepo, loadModel, makeSettleUntil, seedState } from "./helpers";

describe("go-to-file palette", () => {
  test("opens with ctrl-p, swallows global keys, fuzzy-jumps on enter", async () => {
    const repoRoot = createFixtureRepo("stet-palette-", {
      "README.md": "# Fixture\n",
      "src/App.tsx": "export function App() { return null }\n",
      "src/tree.ts": "export const tree = true\n",
      "test/tree.test.ts": "export const testTree = true\n",
    });
    const model = await loadModel(repoRoot, { kind: "all", ref: "HEAD" });
    seedState(model, { kind: "all", ref: "HEAD" });
    const { renderer, renderOnce, captureCharFrame, mockInput } = await testRender(() => <App />, {
      height: 34,
      width: 120,
    });
    const settleUntil = makeSettleUntil({ captureCharFrame, renderOnce });

    try {
      const initial = await settleUntil("app chrome", (frame) => frame.includes("q quit"), 5);
      expect(initial).toContain("q quit");

      mockInput.pressKey("p", { ctrl: true });
      const palette = await settleUntil("go-to-file palette", (frame) =>
        frame.includes("go to file"),
      );
      expect(palette).toContain("go to file");

      // Q must feed the input and show "no matches", not quit the app
      await mockInput.typeText("qqqq");
      const afterTyping = await settleUntil(
        "empty palette results",
        (frame) => frame.includes("q quit") && frame.includes("no matches"),
      );
      expect(afterTyping).toContain("q quit");
      expect(afterTyping).toContain("no matches");

      for (let index = 0; index < 4; index += 1) {
        mockInput.pressBackspace();
      }
      await mockInput.typeText("treets");
      const afterSearch = await settleUntil("tree search result", (frame) =>
        frame.includes("src/tree.ts"),
      );
      expect(afterSearch).toContain("src/tree.ts");

      mockInput.pressEnter();
      const after = await settleUntil(
        "selected tree file",
        (frame) => frame.includes("src/tree.ts") && !frame.includes("go to file"),
      );
      expect(after).toContain("src/tree.ts");
      expect(after).not.toContain("go to file");
    } finally {
      renderer.destroy();
      rmSync(repoRoot, { force: true, recursive: true });
    }
  }, 20_000);

  test("keeps a match visible when it falls in a long path's middle directory", async () => {
    // Every result matches "references" only in a mid-path directory; a plain
    // Keep-the-tail truncation would hide exactly what was typed.
    const repoRoot = createFixtureRepo("stet-palette-mid-", {
      ".agents/skills/effect-best-practices/references/error-patterns.md": "a\n",
      ".agents/skills/effect-best-practices/references/language-server.md": "b\n",
      "README.md": "# Fixture\n",
    });
    const model = await loadModel(repoRoot, { kind: "all", ref: "HEAD" });
    seedState(model, { kind: "all", ref: "HEAD" });
    const { renderer, renderOnce, captureCharFrame, mockInput } = await testRender(() => <App />, {
      height: 34,
      width: 100,
    });
    const settleUntil = makeSettleUntil({ captureCharFrame, renderOnce });

    try {
      await settleUntil("app chrome", (frame) => frame.includes("q quit"), 5);
      mockInput.pressKey("p", { ctrl: true });
      await settleUntil("go-to-file palette", (frame) => frame.includes("go to file"));

      await mockInput.typeText("references");
      const results = await settleUntil("mid-dir match visible", (frame) =>
        frame.includes("references"),
      );
      // The matched directory is on screen (the leading dirs were truncated, not it).
      expect(results).toContain("references");
      expect(results).toContain("…");
    } finally {
      renderer.destroy();
      rmSync(repoRoot, { force: true, recursive: true });
    }
  }, 20_000);
});

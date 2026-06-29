import { describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { testRender } from "@opentui/solid";

import { App } from "@/App";

import { createFixtureRepo, loadModel, makeSettleUntil, seedState } from "./helpers";

describe("project content search", () => {
  test("ctrl-f searches changed files, ctrl-a widens, enter jumps to the file and line", async () => {
    const repoRoot = createFixtureRepo("sideye-search-", {
      "src/a.ts": "const x = 1\n",
      // Lib.ts stays unchanged (only under whole-repo scope); needle is on line 3.
      "src/lib.ts": "// one\n// two\nexport const needle = 0\n",
    });
    writeFileSync(join(repoRoot, "src", "a.ts"), "const x = 1\nconst needle = 2\n");

    const model = await loadModel(repoRoot, { kind: "all", ref: "HEAD" });
    seedState(model, { kind: "all", ref: "HEAD" });
    const { renderer, renderOnce, captureCharFrame, mockInput } = await testRender(() => <App />, {
      height: 34,
      width: 120,
    });
    const settleUntil = makeSettleUntil({ captureCharFrame, renderOnce });

    try {
      // The seeded file is a.ts, so selecting lib.ts below is a cross-file jump.
      await settleUntil("app chrome", (frame) => frame.includes("sideye"), 5);

      mockInput.pressKey("f", { ctrl: true });
      await settleUntil("search panel", (frame) => frame.includes("search in changes…"));

      // Changed scope sees only the modified a.ts, not the unchanged lib.ts.
      await mockInput.typeText("needle");
      const changed = await settleUntil("changed-scope results", (frame) =>
        frame.includes("1 match in 1 file"),
      );
      expect(changed).toContain("src/a.ts");
      expect(changed).not.toContain("src/lib.ts");

      // Widening to the whole repo with ctrl-a adds the unchanged lib.ts.
      mockInput.pressKey("a", { ctrl: true });
      const repo = await settleUntil("repo-scope results", (frame) =>
        frame.includes("2 matches in 2 files"),
      );
      expect(repo).toContain("src/lib.ts");

      // Select the second result (lib.ts) and jump: the cursor must land on the
      // Matched line 3, not the top of the file (the cross-file jump race).
      mockInput.pressKey("n", { ctrl: true });
      mockInput.pressEnter();
      const jumped = await settleUntil(
        "jumped to lib.ts line 3",
        (frame) => frame.includes("ln 3") && !frame.includes("ctrl-a scope"),
      );
      expect(jumped).toContain("ln 3");
      expect(jumped).not.toContain("ctrl-a scope");
    } finally {
      renderer.destroy();
      rmSync(repoRoot, { force: true, recursive: true });
    }
  }, 20_000);

  test("jumps to a match outside the diff hunk by escalating to full file", async () => {
    // A 60-line zzz.ts with needle on line 50; editing line 1 puts the only diff
    // Hunk far from the match, so the jump must escalate to full-file view.
    const lines = Array.from({ length: 60 }, (_, index) =>
      index === 49 ? "const needle = 1" : `const x${index} = ${index}`,
    );
    const repoRoot = createFixtureRepo("sideye-search-escalate-", {
      "src/aaa.ts": "const a = 1\n",
      "src/zzz.ts": `${lines.join("\n")}\n`,
    });
    writeFileSync(join(repoRoot, "src", "aaa.ts"), "const a = 2\n");
    writeFileSync(
      join(repoRoot, "src", "zzz.ts"),
      `const x0 = 999\n${lines.slice(1).join("\n")}\n`,
    );

    const model = await loadModel(repoRoot, { kind: "all", ref: "HEAD" });
    seedState(model, { kind: "all", ref: "HEAD" });
    const { renderer, renderOnce, captureCharFrame, mockInput } = await testRender(() => <App />, {
      height: 34,
      width: 120,
    });
    const settleUntil = makeSettleUntil({ captureCharFrame, renderOnce });

    try {
      // Seeded on aaa.ts; the only needle match is line 50 of the changed zzz.ts.
      await settleUntil("app chrome", (frame) => frame.includes("sideye"), 5);
      mockInput.pressKey("f", { ctrl: true });
      await settleUntil("search panel", (frame) => frame.includes("search in changes…"));
      await mockInput.typeText("needle");
      await settleUntil("result", (frame) => frame.includes("1 match in 1 file"));

      mockInput.pressEnter();
      const jumped = await settleUntil("jumped to zzz.ts line 50", (frame) =>
        frame.includes("ln 50"),
      );
      expect(jumped).toContain("ln 50");
    } finally {
      renderer.destroy();
      rmSync(repoRoot, { force: true, recursive: true });
    }
  }, 20_000);
});

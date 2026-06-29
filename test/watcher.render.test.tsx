import { expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { testRender } from "@opentui/solid";

import { App } from "@/App";

import { createFixtureRepo, loadModel, makeSettleUntil, seedState } from "./helpers";

const allScope = { kind: "all", ref: "HEAD" } as const;

// End-to-end live refresh: editing the file on disk makes the tree show its
// Churn with no keypress. The fast path is the fs watcher; the 2s safety poll is
// The deterministic backstop, so the assertion window outlasts it rather than
// Racing the watcher's arming (the unit test proves the watcher fires).
test("the tree reflects an on-disk edit", async () => {
  const repo = createFixtureRepo("watcher-render-", { "watched.txt": "one\n" });
  try {
    seedState(await loadModel(repo, allScope), allScope);
    const { renderer, renderOnce, captureCharFrame } = await testRender(() => <App />, {
      height: 24,
      width: 100,
    });
    const settleUntil = makeSettleUntil({ captureCharFrame, renderOnce });

    const before = await settleUntil("clean tree", (frame) => frame.includes("watched.txt"));
    expect(before).not.toContain("+1 -0");

    // Let the fs.watch subscription arm so the watcher catches the edit on the
    // Fast path; if it still misses, the safety poll backstops within the window.
    await new Promise((resolve) => setTimeout(resolve, 200));
    writeFileSync(join(repo, "watched.txt"), "one\ntwo\n");

    const after = await settleUntil(
      "churn badge after edit",
      (frame) => frame.includes("+1 -0"),
      1,
      400,
    );
    expect(after).toContain("watched.txt");

    renderer.destroy();
  } finally {
    rmSync(repo, { force: true, recursive: true });
  }
});

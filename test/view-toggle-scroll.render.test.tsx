import { describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { ScrollBoxRenderable, type Renderable } from "@opentui/core";
import { testRender } from "@opentui/solid";

import { App } from "../src/App";
import { createFixtureRepo, loadModel, makeSettleUntil, seedState } from "./helpers";

// Toggling a diff to whole-file view used to leave the viewport blank until the user
// Scrolled: the cursor jumps deep into the now-taller content, but the scrollbox
// Clamps the physical scroll to its content height as last laid out, and OpenTUI's
// Layout pass transiently overwrites that height and re-clamps the scroll toward 0,
// Stranding the viewport in the empty top spacer. The viewer now reconciles the
// Physical scroll to the scrollTop signal every rendered frame, so it always recovers.
function visibleLineNumbers(frame: string) {
  return (frame.match(/line_\d+ =/g) ?? []).map((match) => Number(match.replace(/\D/g, "")));
}

// The diff viewer's scrollbox is the deepest-scrolling box in the tree (the file tree
// Is short); find it so the test can read and perturb physical scroll metrics.
function diffScrollBox(node: Renderable) {
  const candidates: ScrollBoxRenderable[] = [];
  const walk = (current: Renderable) => {
    if (current instanceof ScrollBoxRenderable) {
      candidates.push(current);
    }
    for (const child of current.getChildren()) {
      walk(child);
    }
  };
  walk(node);
  return candidates.toSorted((a, b) => b.scrollHeight - a.scrollHeight)[0];
}

function longFileToggleFixture(prefix: string) {
  const lines = Array.from({ length: 120 }, (_, index) => `const line_${index + 1} = ${index + 1}`);
  // Pin the checkers so binaries on the runner's PATH cannot lint the fixture.
  const repoRoot = createFixtureRepo(prefix, {
    "long.ts": `${lines.join("\n")}\n`,
    "package.json": `${JSON.stringify({ scripts: { lint: "exit 0", typecheck: "exit 0" } })}\n`,
  });
  // Edit a single line near the bottom: the diff is a small hunk low in the file, so
  // The whole-file view is far taller than the diff content it replaces.
  writeFileSync(
    join(repoRoot, "long.ts"),
    `${lines.with(109, "const line_110 = 9999").join("\n")}\n`,
  );
  return repoRoot;
}

describe("view toggle scroll", () => {
  test("toggling to file view shows a low change immediately, no navigation", async () => {
    const repoRoot = longFileToggleFixture("sideye-toggle-scroll-");
    const model = await loadModel(repoRoot, { kind: "all", ref: "HEAD" });
    seedState(model, { kind: "all", ref: "HEAD" });
    const { renderer, renderOnce, captureCharFrame, mockInput } = await testRender(() => <App />, {
      height: 34,
      width: 120,
    });
    const settleUntil = makeSettleUntil({ captureCharFrame, renderOnce });

    try {
      // The diff lands with the cursor on the low change.
      await settleUntil("diff view", (frame) => frame.includes("diff · ln 110"), 5);

      // Focus the viewer and toggle to whole-file view.
      mockInput.pressTab();
      mockInput.pressKey("v");

      // The cursor stays on line 110, now deep in the full file. Without the fix the
      // Viewport stays blank here (the settle would time out); with it, the content
      // Around line 110 paints with no intervening navigation.
      const frame = await settleUntil("low change visible in file view", (current) => {
        if (!current.includes("file · ln 110")) {
          return false;
        }
        const numbers = visibleLineNumbers(current);
        return numbers.includes(110) && numbers.length > 20;
      });
      expect(visibleLineNumbers(frame)).toContain(110);

      const box = diffScrollBox(renderer.root);
      expect(box).toBeDefined();
      expect(box.scrollHeight).toBeGreaterThanOrEqual(115);
      expect(box.scrollTop).toBeGreaterThan(50);
    } finally {
      renderer.destroy();
      rmSync(repoRoot, { force: true, recursive: true });
    }
  }, 20_000);
});

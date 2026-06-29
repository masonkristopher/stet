import { expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { ScrollBoxRenderable } from "@opentui/core";
import type { Renderable } from "@opentui/core";
import { testRender } from "@opentui/solid";

import { App } from "@/App";

import { createFixtureRepo, loadModel, makeSettleUntil, seedState } from "./helpers";

// Solo file: render tests share the global state singleton, so a second toggle test
// In the same file pollutes this one. See view-toggle-scroll.render.test.tsx for the
// First-frame visibility case; this one guards the recovery mechanism behind it.
function visibleLineNumbers(frame: string) {
  return (frame.match(/line_\d+ =/g) ?? []).map((match) => Number(match.replace(/\D/g, "")));
}

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

// The toggle-blank bug is a layout race: after the diff→file swap grows the content,
// OpenTUI's layout transiently overwrites the scrollbar's content height and re-clamps
// The physical scroll off the deep cursor position, while the windowed slice still
// Points deep — stranding the viewport in the empty top spacer. Nothing reactive
// Changes, so a one-shot scrollTo can't recover; the viewer reconciles the physical
// Scroll to the scrollTop signal every rendered frame, which always recovers.
test("recovers when a layout pass strands the physical scroll", async () => {
  const lines = Array.from({ length: 120 }, (_, index) => `const line_${index + 1} = ${index + 1}`);
  const repoRoot = createFixtureRepo("sideye-toggle-strand-", {
    "long.ts": `${lines.join("\n")}\n`,
    "package.json": `${JSON.stringify({ scripts: { lint: "exit 0", typecheck: "exit 0" } })}\n`,
  });
  writeFileSync(
    join(repoRoot, "long.ts"),
    `${lines.with(109, "const line_110 = 9999").join("\n")}\n`,
  );

  const model = await loadModel(repoRoot, { kind: "all", ref: "HEAD" });
  seedState(model, { kind: "all", ref: "HEAD" });
  const { renderer, renderOnce, captureCharFrame, mockInput } = await testRender(() => <App />, {
    height: 34,
    width: 120,
  });
  const settleUntil = makeSettleUntil({ captureCharFrame, renderOnce });

  try {
    await settleUntil("diff view", (frame) => /-\d+ · ln 110/.test(frame), 5);
    mockInput.pressTab();
    mockInput.pressKey("v");
    await settleUntil(
      "file view scrolled to the change",
      (current) => /lines · ln 110/.test(current) && visibleLineNumbers(current).includes(110),
    );

    const box = diffScrollBox(renderer.root);
    expect(box).toBeDefined();

    // Reproduce the layout race: shrink the scrollbar's known content height, which
    // Re-clamps the physical scroll off the deep position. No reactive signal changed.
    box.verticalScrollBar.scrollSize = 5;
    expect(box.scrollTop).toBeLessThan(50);

    // No navigation — just let frames render. The per-frame reconcile must re-assert
    // The scrollbar metrics and restore the deep scroll on its own.
    const recovered = await settleUntil(
      "scroll recovers without navigation",
      (current) => visibleLineNumbers(current).includes(110) && box.scrollTop > 50,
    );
    expect(visibleLineNumbers(recovered)).toContain(110);
    expect(box.scrollHeight).toBeGreaterThanOrEqual(115);
  } finally {
    renderer.destroy();
    rmSync(repoRoot, { force: true, recursive: true });
  }
}, 20_000);

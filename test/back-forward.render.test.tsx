import { describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { testRender } from "@opentui/solid";

import { App } from "@/App";
import { state } from "@/state";

import { createFixtureRepo, loadModel, makeSettleUntil, seedState } from "./helpers";

const lnOf = (frame: string) => {
  const match = /ln (?<line>\d+)/.exec(frame);
  return match?.groups?.line === undefined ? undefined : Number(match.groups.line);
};

describe("back / forward navigation", () => {
  test("restores the file and the cursor line you left", async () => {
    const body = Array.from({ length: 30 }, (_, index) => `const line${index + 1} = ${index + 1}`);
    const repoRoot = createFixtureRepo("sideye-backfwd-", {
      "package.json": `${JSON.stringify({ scripts: { lint: "exit 0", typecheck: "exit 0" } })}\n`,
      "src/a.ts": `${body.join("\n")}\n`,
      "src/b.ts": `${body.join("\n")}\n`,
    });
    // Edit both so each renders a hunk away from line 1.
    writeFileSync(
      join(repoRoot, "src", "a.ts"),
      `${["const line1 = 1", "const aChanged = true", ...body.slice(2)].join("\n")}\n`,
    );
    writeFileSync(
      join(repoRoot, "src", "b.ts"),
      `${["const line1 = 1", "const bChanged = true", ...body.slice(2)].join("\n")}\n`,
    );

    const model = await loadModel(repoRoot, { kind: "all", ref: "HEAD" });
    seedState(model, { kind: "all", ref: "HEAD" });
    const { renderer, renderOnce, captureCharFrame, mockInput } = await testRender(() => <App />, {
      height: 34,
      width: 120,
    });
    const settleUntil = makeSettleUntil({ captureCharFrame, renderOnce });

    try {
      await settleUntil("diff view", (frame) => lnOf(frame) !== undefined, 5);

      // Open a.ts and move the cursor down inside it, away from the first change.
      state.selectFile("src/a.ts");
      const onA = await settleUntil(
        "a.ts open",
        (frame) => frame.includes("src/a.ts") && lnOf(frame) !== undefined,
      );
      const startLn = lnOf(onA);
      state.setFocusedPane("diff");
      mockInput.pressKey("j");
      await renderOnce();
      mockInput.pressKey("j");
      const moved = await settleUntil(
        "cursor moved",
        (frame) =>
          frame.includes("src/a.ts") && lnOf(frame) !== undefined && lnOf(frame) !== startLn,
      );
      const movedLn = lnOf(moved);
      expect(movedLn).not.toBe(startLn);

      // Jump away to b.ts (records a.ts's cursor on leave).
      state.selectFile("src/b.ts");
      await settleUntil(
        "b.ts open",
        (frame) => frame.includes("src/b.ts") && lnOf(frame) !== undefined,
      );

      // Back returns to a.ts at the exact line we left.
      state.goBack();
      const back = await settleUntil(
        "back on a.ts",
        (frame) => frame.includes("src/a.ts") && lnOf(frame) === movedLn,
      );
      expect(lnOf(back)).toBe(movedLn);

      // Forward returns to b.ts.
      state.goForward();
      await settleUntil(
        "forward on b.ts",
        (frame) => frame.includes("src/b.ts") && lnOf(frame) !== undefined,
      );
    } finally {
      renderer.destroy();
      rmSync(repoRoot, { force: true, recursive: true });
    }
  }, 20_000);
});

import { describe, expect, test } from "bun:test";

import { testRender } from "@opentui/solid";

import { App } from "@/App";
import { stateForResolvedChecker } from "@/diagnostics/checker";
import type { Diagnostic } from "@/diagnostics/checker";
import { state } from "@/state";

import { createFixtureRepo, loadModel, makeSettleUntil, seedState } from "./helpers";

// The problems panel windows its rows to the fixed panel viewport, so a large
// Findings list must stay navigable: the cursor stays framed while walking far
// Past the first window, and a diagnostics update landing while the panel is
// Open re-renders in place instead of rebuilding a renderable per finding.
describe("problems panel windowing", () => {
  test("frames the cursor deep in a large findings list and survives an update while open", async () => {
    const repoRoot = createFixtureRepo("sideye-problems-", { "src/a.ts": "export const a = 1;\n" });
    const scope = { kind: "all", ref: "HEAD" } as const;
    const model = await loadModel(repoRoot, scope);
    seedState(model, scope);

    const makeDiagnostics = (count: number): Diagnostic[] =>
      Array.from({ length: count }, (_, index) => ({
        checker: "diagnostics",
        column: 1,
        line: 1 + index,
        message: `synthetic finding ${String(index).padStart(2, "0")}`,
        path: `${repoRoot}/src/file${index % 10}.ts`,
        severity: "warning",
        source: "probe",
      }));
    state.setCheckerState({
      diagnostics: stateForResolvedChecker(
        "diagnostics",
        model.changed,
        makeDiagnostics(60),
        repoRoot,
      ),
    });

    const { renderer, mockInput, mockMouse, renderOnce, captureCharFrame } = await testRender(
      () => <App />,
      { height: 30, width: 100 },
    );
    const settleUntil = makeSettleUntil({ captureCharFrame, renderOnce });
    await settleUntil("first render", (current) => current.includes("a.ts"));

    mockInput.pressKey("p");
    await renderOnce();
    await settleUntil("panel open", (current) => current.includes("synthetic finding 00"));

    for (let i = 0; i < 30; i += 1) {
      mockInput.pressKey("j");
      // oxlint-disable-next-line no-await-in-loop -- sequential nav steps
      await renderOnce();
    }
    await renderOnce();
    const focused = state.allProblemItems()[state.problemIndex()];
    const summary = focused?.kind === "problem" ? focused.summary : "";
    expect(summary).not.toBe("");
    expect(captureCharFrame()).toContain(summary);
    expect(captureCharFrame()).not.toContain("synthetic finding 00");

    // A wheel scroll moves the window away from the cursor; a checker update
    // Landing while it is away must not snap it back until the cursor moves.
    for (let i = 0; i < 5; i += 1) {
      // oxlint-disable-next-line no-await-in-loop -- sequential wheel steps
      await mockMouse.scroll(50, 24, "up");
      // oxlint-disable-next-line no-await-in-loop -- sequential wheel steps
      await renderOnce();
    }
    await renderOnce();
    expect(captureCharFrame()).not.toContain(summary);
    state.setCheckerState({
      diagnostics: stateForResolvedChecker(
        "diagnostics",
        model.changed,
        makeDiagnostics(60),
        repoRoot,
      ),
    });
    await renderOnce();
    await renderOnce();
    expect(captureCharFrame()).not.toContain(summary);

    // The next keypress re-frames the cursor.
    mockInput.pressKey("j");
    await renderOnce();
    await renderOnce();
    const refocused = state.allProblemItems()[state.problemIndex()];
    expect(refocused?.kind === "problem" && captureCharFrame().includes(refocused.summary)).toBe(
      true,
    );

    // A diagnostics update while the panel is open must keep rendering rows.
    state.setCheckerState({
      diagnostics: stateForResolvedChecker(
        "diagnostics",
        model.changed,
        makeDiagnostics(40),
        repoRoot,
      ),
    });
    await renderOnce();
    await renderOnce();
    expect(captureCharFrame()).toContain("synthetic finding");

    renderer.destroy();
  });
});

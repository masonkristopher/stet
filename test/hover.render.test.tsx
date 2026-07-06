import { describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { testRender } from "@opentui/solid";

import { App } from "@/App";
import { state } from "@/state";

import { createFixtureRepo, loadModel, makeSettleUntil, seedState } from "./helpers";

// The card renders over the live diff through the decoration seam (the same seam
// `showHover` drives). Driving the seam directly keeps this test off a real
// Language server (env-dependent, slow); the LSP pull itself is covered against a
// Fake peer in intel-service.test.ts, and the K -> showHover wiring in keymap.test.ts.
describe("caret-anchored decoration card", () => {
  test("renders at the caret, clears on a caret move, and clears on escape", async () => {
    const repoRoot = createFixtureRepo("stet-card-", {
      "package.json": `${JSON.stringify({ scripts: { lint: "exit 0", typecheck: "exit 0" } })}\n`,
      "src/a.ts": "const alpha = 1\n",
    });
    writeFileSync(join(repoRoot, "src", "a.ts"), "const alpha = 1\nconst added = 2\n");

    const model = await loadModel(repoRoot, { kind: "all", ref: "HEAD" });
    seedState(model, { kind: "all", ref: "HEAD" });
    const { renderer, renderOnce, captureCharFrame, mockInput } = await testRender(() => <App />, {
      height: 30,
      width: 110,
    });
    const settleUntil = makeSettleUntil({ captureCharFrame, renderOnce });

    try {
      await settleUntil("caret on the added line", (frame) => /ln 2:1\b/.test(frame));
      mockInput.pressTab();

      // A highlighted code line (its text comes through a StyledText) plus a prose
      // Doc line, the shape a real hover resolves to.
      state.openViewerDecoration({
        lines: [
          { kind: "code", spans: [{ fg: "#79b8ff", text: "const added: number" }] },
          { kind: "prose", text: "A constant." },
        ],
        status: "ready",
      });
      const card = await settleUntil("card visible at the caret", (frame) =>
        frame.includes("const added: number"),
      );
      // Both the styled code line and the prose line render their text in the card.
      expect(card).toContain("A constant.");

      // A caret move closes the card (it described one exact spot).
      mockInput.pressKey("l");
      const afterMove = await settleUntil(
        "card cleared by a caret move",
        (frame) => !frame.includes("const added: number"),
      );
      expect(afterMove).not.toContain("const added: number");

      // Escape dismisses it, before the find/global esc handlers.
      state.openViewerDecoration({
        lines: [{ kind: "prose", text: "const added: number" }],
        status: "ready",
      });
      await settleUntil("card reopened", (frame) => frame.includes("const added: number"));
      mockInput.pressEscape();
      const afterEscape = await settleUntil(
        "card cleared by escape",
        (frame) => !frame.includes("const added: number"),
      );
      expect(afterEscape).not.toContain("const added: number");

      // A scope switch can leave the path, caret, and scroll untouched yet show a
      // Different diff, so it must still close the card. Set scope alone so only the
      // Scope-drift trigger fires (the card would linger without it).
      state.openViewerDecoration({
        lines: [{ kind: "prose", text: "const added: number" }],
        status: "ready",
      });
      await settleUntil("card reopened", (frame) => frame.includes("const added: number"));
      state.setScope({ kind: "unstaged", ref: "HEAD" });
      const afterScope = await settleUntil(
        "card cleared by a scope switch",
        (frame) => !frame.includes("const added: number"),
      );
      expect(afterScope).not.toContain("const added: number");
    } finally {
      renderer.destroy();
      rmSync(repoRoot, { force: true, recursive: true });
    }
  }, 20_000);
});

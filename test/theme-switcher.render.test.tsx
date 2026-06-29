import { afterEach, describe, expect, test } from "bun:test";

import { RGBA } from "@opentui/core";
import { testRender } from "@opentui/solid";

import { App } from "@/App";
import { state } from "@/state";
import { setAppearance, setSelection } from "@/theme/active";
import { darkTheme } from "@/theme/dark";
import { registerThemes, resolveThemes, restoreRegistry, snapshotRegistry } from "@/theme/registry";

import { loadModel, makeSettleUntil, seedState } from "./helpers";

// Unique, easy-to-spot surface backgrounds: the App root paints `surface.base`, so
// A preview/commit shows up as that color filling the screen.
const KB_BG = "#061709";
const ONE_BG = "#021304";
const TWO_BG = "#041507";

const surface = (base: string) => ({ ...darkTheme.surface, base });

const hasBackground = (frame: { lines: { spans: { bg: RGBA }[] }[] }, hex: string) => {
  const want = RGBA.fromHex(hex);
  const near = (a: number, b: number) => Math.abs(a - b) < 0.01;
  return frame.lines.some((line) =>
    line.spans.some(
      (span) => near(span.bg.r, want.r) && near(span.bg.g, want.g) && near(span.bg.b, want.b),
    ),
  );
};

const locate = (frame: string, needle: string) => {
  const lines = frame.split("\n");
  const y = lines.findIndex((line) => line.includes(needle));
  return { x: y === -1 ? 0 : lines[y].indexOf(needle), y };
};

// Captured before any test registers, so afterEach can drop this file's themes from
// The process-global registry and keep later tests isolated.
const registryBaseline = snapshotRegistry();

afterEach(() => {
  // Reset the global theme + picker state so other render tests see the default.
  state.closeThemePicker(false);
  setSelection(undefined);
  setAppearance("dark");
  restoreRegistry(registryBaseline);
});

describe("theme switcher", () => {
  // Guards a staleness trap: themes register at startup, after `state`'s root is
  // Created, so the unfiltered list must read the registry lazily, not snapshot it
  // At creation time. Without typing (which would force a recompute), a stale list
  // Would omit every user theme.
  test("the unfiltered list includes themes registered after startup", () => {
    registerThemes(resolveThemes({ "post-startup-probe": { base: "dark" } }).themes);

    expect(state.themeComboboxResults().some((item) => item.name === "post-startup-probe")).toBe(
      true,
    );
  });

  test("t opens it; navigating previews live, esc reverts, enter commits", async () => {
    registerThemes(resolveThemes({ zzonly: { base: "dark", surface: surface(KB_BG) } }).themes);
    setSelection(undefined);
    setAppearance("dark");

    const model = await loadModel(process.cwd(), { kind: "all", ref: "HEAD" });
    seedState(model, { kind: "all", ref: "HEAD" });
    const { renderer, renderOnce, captureCharFrame, captureSpans, mockInput } = await testRender(
      () => <App />,
      { height: 32, width: 120 },
    );
    const settleUntil = makeSettleUntil({ captureCharFrame, renderOnce });

    try {
      await settleUntil("app chrome", (frame) => frame.includes("sideye"), 5);
      expect(hasBackground(captureSpans(), KB_BG)).toBe(false);

      mockInput.pressKey("t");
      await settleUntil("theme picker", (frame) => frame.includes("hover preview"));

      // Filtering to the one theme highlights it (index 0), which previews live.
      await mockInput.typeText("zzonly");
      await settleUntil("filtered to zzonly", (frame) => frame.includes("zzonly"));
      await settleUntil("zzonly previewed", () => hasBackground(captureSpans(), KB_BG));

      // Esc restores the selection captured on open (the default).
      mockInput.pressEscape();
      await settleUntil("picker closed", (frame) => !frame.includes("hover preview"));
      expect(hasBackground(captureSpans(), KB_BG)).toBe(false);

      // Reopen, filter, and commit with enter: the theme sticks after closing.
      mockInput.pressKey("t");
      await settleUntil("theme picker again", (frame) => frame.includes("hover preview"));
      await mockInput.typeText("zzonly");
      await settleUntil("filtered again", (frame) => frame.includes("zzonly"));
      mockInput.pressEnter();
      await settleUntil("committed and closed", (frame) => !frame.includes("hover preview"));
      await settleUntil("zzonly still applied", () => hasBackground(captureSpans(), KB_BG));
    } finally {
      renderer.destroy();
    }
  }, 20_000);

  test("hovering a row previews it, clicking commits it", async () => {
    registerThemes(
      resolveThemes({
        zztwoa: { base: "dark", surface: surface(ONE_BG) },
        zztwob: { base: "dark", surface: surface(TWO_BG) },
      }).themes,
    );
    setSelection(undefined);
    setAppearance("dark");

    const model = await loadModel(process.cwd(), { kind: "all", ref: "HEAD" });
    seedState(model, { kind: "all", ref: "HEAD" });
    const { renderer, renderOnce, captureCharFrame, captureSpans, mockInput, mockMouse } =
      await testRender(() => <App />, { height: 32, width: 120 });
    const settleUntil = makeSettleUntil({ captureCharFrame, renderOnce });

    try {
      await settleUntil("app chrome", (frame) => frame.includes("sideye"), 5);

      mockInput.pressKey("t");
      await settleUntil("theme picker", (frame) => frame.includes("hover preview"));
      await mockInput.typeText("zztwo");
      // Both themes match; the first (zztwoa) is highlighted and previewed.
      const filtered = await settleUntil(
        "both rows visible",
        (frame) => frame.includes("zztwoa") && frame.includes("zztwob"),
      );
      // Preview is a Solid effect that flushes on a microtask, so settle (re-render)
      // Until the background reflects it rather than asserting on a fixed frame.
      await settleUntil("zztwoa previewed", () => hasBackground(captureSpans(), ONE_BG));
      expect(hasBackground(captureSpans(), TWO_BG)).toBe(false);

      // Hover the second row: the preview follows the pointer.
      const two = locate(filtered, "zztwob");
      await mockMouse.moveTo(two.x, two.y);
      await settleUntil("zztwob previewed on hover", () => hasBackground(captureSpans(), TWO_BG));
      expect(hasBackground(captureSpans(), ONE_BG)).toBe(false);

      // Click it: commit and close, the theme persists.
      await mockMouse.click(two.x, two.y);
      await settleUntil("committed and closed", (frame) => !frame.includes("hover preview"));
      await settleUntil("zztwob still applied", () => hasBackground(captureSpans(), TWO_BG));
    } finally {
      renderer.destroy();
    }
  }, 20_000);
});

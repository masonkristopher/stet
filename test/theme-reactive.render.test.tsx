import { afterEach, describe, expect, test } from "bun:test";

import { RGBA } from "@opentui/core";
import { testRender } from "@opentui/solid";

import { App } from "@/App";
import { setAppearance, setSelection } from "@/theme/active";
import { darkTheme } from "@/theme/dark";
import { registerThemes, resolveThemes } from "@/theme/registry";

import { loadModel, makeSettleUntil, seedState } from "./helpers";

// Two themes with unique, easy-to-spot surface backgrounds, one per appearance.
const DARK_BG = "#010203";
const LIGHT_BG = "#fdfdfd";

const hasBackground = (frame: { lines: { spans: { bg: RGBA }[] }[] }, hex: string) => {
  const want = RGBA.fromHex(hex);
  const near = (a: number, b: number) => Math.abs(a - b) < 0.01;
  return frame.lines.some((line) =>
    line.spans.some(
      (span) => near(span.bg.r, want.r) && near(span.bg.g, want.g) && near(span.bg.b, want.b),
    ),
  );
};

afterEach(() => {
  // Reset the global theme signals so other render tests see the default.
  setSelection(undefined);
  setAppearance("dark");
});

describe("runtime appearance follow (#101)", () => {
  test("flipping the terminal appearance re-themes the UI live", async () => {
    registerThemes(
      resolveThemes({
        "t-dark": { base: "dark", surface: { ...darkTheme.surface, base: DARK_BG } },
        "t-light": { base: "dark", surface: { ...darkTheme.surface, base: LIGHT_BG } },
      }).themes,
    );
    setSelection({ dark: "t-dark", light: "t-light" });
    setAppearance("dark");

    const model = await loadModel(process.cwd(), { kind: "all", ref: "HEAD" });
    seedState(model, { kind: "all", ref: "HEAD" });

    const { renderer, renderOnce, captureCharFrame, captureSpans } = await testRender(
      () => <App />,
      {
        height: 32,
        width: 110,
      },
    );
    const settleUntil = makeSettleUntil({ captureCharFrame, renderOnce });
    await settleUntil("app chrome", (frame) => frame.includes("sideye"));

    expect(hasBackground(captureSpans(), DARK_BG)).toBe(true);
    expect(hasBackground(captureSpans(), LIGHT_BG)).toBe(false);

    // The renderer's theme_mode event would call this; drive it directly.
    setAppearance("light");
    await renderOnce();

    expect(hasBackground(captureSpans(), LIGHT_BG)).toBe(true);
    expect(hasBackground(captureSpans(), DARK_BG)).toBe(false);

    renderer.destroy();
  });
});

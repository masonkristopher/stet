import { describe, expect, test } from "bun:test";

import { RGBA } from "@opentui/core";

import { darkTheme } from "../src/theme/dark";
import { lightTheme } from "../src/theme/light";
import { resolveTheme } from "../src/theme/resolve";

const HEX = /^#[0-9a-f]{6}$/;

// Walks the theme and collects every string leaf; syntax style objects mix
// Booleans (bold/italic/…) with color strings, and only the strings matter here
function collectColors(value: unknown, path: string, out: [path: string, color: string][]) {
  if (typeof value === "string") {
    out.push([path, value]);
    return;
  }

  if (typeof value === "object" && value !== null) {
    for (const [key, child] of Object.entries(value)) {
      collectColors(child, `${path}.${key}`, out);
    }
  }
}

describe.each([
  ["darkTheme", darkTheme],
  ["lightTheme", lightTheme],
])("%s", (_name, theme) => {
  test("every color token is a lowercase 6-digit hex", () => {
    const colors: [path: string, color: string][] = [];
    collectColors(theme, "theme", colors);

    expect(colors.length).toBeGreaterThan(0);
    expect(colors.filter(([, color]) => !HEX.test(color))).toEqual([]);
  });
});

describe("theme parity", () => {
  test("light and dark expose the exact same token paths", () => {
    const paths = (theme: unknown) => {
      const out: [path: string, color: string][] = [];
      collectColors(theme, "theme", out);
      return out.map(([path]) => path).toSorted();
    };

    expect(paths(lightTheme)).toEqual(paths(darkTheme));
  });
});

describe("resolveTheme", () => {
  test("transparent is the zero RGBA singleton", () => {
    const resolved = resolveTheme(darkTheme);

    expect(resolved.colors).toBe(darkTheme);
    expect(resolved.rgba.transparent).toEqual(RGBA.fromValues(0, 0, 0, 0));
  });

  test("each active variant brightens its base token and stays clamped", () => {
    const resolved = resolveTheme(darkTheme);
    const variants = [
      [resolved.rgba.addedBgActive, darkTheme.diff.addedBg],
      [resolved.rgba.addedLineNumberBgActive, darkTheme.diff.addedLineNumberBg],
      [resolved.rgba.removedBgActive, darkTheme.diff.removedBg],
      [resolved.rgba.removedLineNumberBgActive, darkTheme.diff.removedLineNumberBg],
      [resolved.rgba.findMatchBgActive, darkTheme.find.matchBg],
    ] as const;

    for (const [active, baseHex] of variants) {
      const base = RGBA.fromHex(baseHex);
      // No channel darkens or overflows...
      for (const channel of ["r", "g", "b"] as const) {
        expect(active[channel]).toBeGreaterThanOrEqual(base[channel]);
        expect(active[channel]).toBeLessThanOrEqual(1);
      }
      // ...and the variant is genuinely brighter than its base, not a no-op.
      expect(active.r + active.g + active.b).toBeGreaterThan(base.r + base.g + base.b);
    }
  });
});

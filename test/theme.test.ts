import { describe, expect, test } from "bun:test";

import { RGBA } from "@opentui/core";

import { darkTheme } from "@/theme/dark";
import { lightTheme } from "@/theme/light";
import { resolveTheme } from "@/theme/resolve";

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

  const activeVariants = (theme: typeof darkTheme) => {
    const resolved = resolveTheme(theme);
    return [
      [resolved.rgba.addedBgActive, theme.diff.addedBg],
      [resolved.rgba.addedLineNumberBgActive, theme.diff.addedLineNumberBg],
      [resolved.rgba.removedBgActive, theme.diff.removedBg],
      [resolved.rgba.removedLineNumberBgActive, theme.diff.removedLineNumberBg],
      [resolved.rgba.findMatchBgActive, theme.find.matchBg],
    ] as const;
  };

  test("dark active variants brighten their base token and stay clamped", () => {
    for (const [active, baseHex] of activeVariants(darkTheme)) {
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

  test("light active variants darken their base token instead of washing to white", () => {
    for (const [active, baseHex] of activeVariants(lightTheme)) {
      const base = RGBA.fromHex(baseHex);
      // No channel brightens or underflows...
      for (const channel of ["r", "g", "b"] as const) {
        expect(active[channel]).toBeLessThanOrEqual(base[channel]);
        expect(active[channel]).toBeGreaterThanOrEqual(0);
      }
      // ...and the variant is genuinely darker than its base, never clamped to white.
      expect(active.r + active.g + active.b).toBeLessThan(base.r + base.g + base.b);
    }
  });
});

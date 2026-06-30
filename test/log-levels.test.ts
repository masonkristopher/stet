import { describe, expect, test } from "bun:test";

import { levelColor, levelGlyph } from "@/log/levels";
import { darkTheme } from "@/theme/dark";

describe("levelColor", () => {
  test("maps each level to its semantic theme token", () => {
    expect(levelColor(darkTheme, "error")).toBe(darkTheme.severity.error);
    expect(levelColor(darkTheme, "warning")).toBe(darkTheme.severity.warning);
    expect(levelColor(darkTheme, "success")).toBe(darkTheme.success);
    expect(levelColor(darkTheme, "info")).toBe(darkTheme.text.secondary);
  });
});

describe("levelGlyph", () => {
  test("uses the same severity glyphs as the problems panel and tree rows", () => {
    expect(levelGlyph("error")).toBe("✖");
    expect(levelGlyph("warning")).toBe("⚠");
    expect(levelGlyph("success")).toBe("✓");
    expect(levelGlyph("info")).toBe("ℹ");
  });

  test("are single bare codepoints, never the two-row variation-selector form", () => {
    for (const level of ["error", "warning", "success", "info"] as const) {
      // Each is one BMP unit; a trailing U+FE0F would push length to 2 and force emoji height.
      expect(levelGlyph(level)).toHaveLength(1);
    }
  });
});

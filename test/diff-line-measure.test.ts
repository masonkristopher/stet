import { afterAll, describe, expect, test } from "bun:test";

import { createLineMeasurer } from "@/components/diff/line-measure";

// Drives the real OpenTUI text engine (the same call the renderable's layout
// Uses), so these assert rendered wrap behavior, not a reimplemented formula.
const measurer = createLineMeasurer("unicode");
afterAll(() => measurer.destroy());

describe("createLineMeasurer", () => {
  test("a line that fits the width is one row", () => {
    expect(measurer.measure("const a = 1", 40)).toBe(1);
  });

  test("a long multi-word line wraps to more than one row at a narrow width", () => {
    expect(measurer.measure("the quick brown fox jumps over the lazy dog", 12)).toBeGreaterThan(1);
  });

  test("wide CJK glyphs count as two columns when wrapping", () => {
    // Five wide chars = 10 columns; at width 6 that cannot fit on one row.
    expect(measurer.measure("你好世界码", 6)).toBeGreaterThan(1);
  });

  test("empty text is one row", () => {
    expect(measurer.measure("", 40)).toBe(1);
  });
});

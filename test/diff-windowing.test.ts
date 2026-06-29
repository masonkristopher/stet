import { describe, expect, test } from "bun:test";

import { visibleWindow, visibleWindowVariable } from "@/diff/windowing";

describe("visibleWindow (fixed height)", () => {
  test("mounts only the visible slice with exact spacers", () => {
    expect(visibleWindow(100, 10, 5)).toEqual({
      bottomSpacer: 85,
      end: 15,
      start: 10,
      topSpacer: 10,
    });
  });

  test("clamps the window to the row range at the top and bottom", () => {
    expect(visibleWindow(100, 0, 5)).toEqual({ bottomSpacer: 95, end: 5, start: 0, topSpacer: 0 });
    expect(visibleWindow(100, 98, 5)).toEqual({
      bottomSpacer: 0,
      end: 100,
      start: 98,
      topSpacer: 98,
    });
  });

  test("applies overscan on both edges without exceeding bounds", () => {
    expect(visibleWindow(100, 20, 5, 3)).toEqual({
      bottomSpacer: 72,
      end: 28,
      start: 17,
      topSpacer: 17,
    });
    expect(visibleWindow(100, 0, 5, 3)).toEqual({
      bottomSpacer: 92,
      end: 8,
      start: 0,
      topSpacer: 0,
    });
  });

  test("returns an empty window for no rows", () => {
    expect(visibleWindow(0, 0, 10)).toEqual({ bottomSpacer: 0, end: 0, start: 0, topSpacer: 0 });
  });
});

describe("visibleWindowVariable (wrap height)", () => {
  test("selects rows overlapping the viewport and sums spacer heights", () => {
    // Heights: row0=1 (0..1), row1=3 (1..4), row2=1 (4..5), row3=2 (5..7), row4=1 (7..8)
    const heights = [1, 3, 1, 2, 1];
    // Viewport [2,5): overlaps row1 (1..4) and row2 (4..5).
    expect(visibleWindowVariable(heights, 2, 3)).toEqual({
      bottomSpacer: 3,
      end: 3,
      start: 1,
      topSpacer: 1,
    });
  });

  test("includes a tall row that straddles the viewport top", () => {
    const heights = [5, 1, 1];
    // Viewport [3,5): only row0 (0..5) overlaps.
    expect(visibleWindowVariable(heights, 3, 2)).toEqual({
      bottomSpacer: 2,
      end: 1,
      start: 0,
      topSpacer: 0,
    });
  });

  test("returns an empty window for no rows", () => {
    expect(visibleWindowVariable([], 0, 10)).toEqual({
      bottomSpacer: 0,
      end: 0,
      start: 0,
      topSpacer: 0,
    });
  });
});

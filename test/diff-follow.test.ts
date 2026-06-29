import { describe, expect, test } from "bun:test";

import { followScrollTop, followScrollX } from "@/diff/follow";

// Viewport of 10 rows, content of 100 rows (so maxScroll = 90), 3-row margin.
const base = { height: 1, margin: 3, maxScroll: 90, viewport: 10 };

describe("followScrollTop", () => {
  test("does not scroll while the cursor sits inside the margins", () => {
    // Current=20 shows rows [20,30); a cursor at row 25 is comfortably inside.
    expect(followScrollTop({ ...base, current: 20, top: 25 })).toBe(20);
  });

  test("scrolls down before the cursor reaches the bottom edge", () => {
    // Showing [20,30): row 27 is within the 3-row bottom margin (28,29 reserved),
    // So the view scrolls so the cursor keeps 3 context rows below it.
    expect(followScrollTop({ ...base, current: 20, top: 27 })).toBe(21);
    // A cursor exactly at the last visible row pushes the scroll further.
    expect(followScrollTop({ ...base, current: 20, top: 29 })).toBe(23);
  });

  test("scrolls up before the cursor reaches the top edge", () => {
    // Showing [20,30): row 22 is within the 3-row top margin, so scroll up.
    expect(followScrollTop({ ...base, current: 20, top: 22 })).toBe(19);
  });

  test("keeps the cursor's full height visible for tall wrapped rows", () => {
    // A 4-row-tall cursor at top=27 needs its bottom (row 31) plus margin shown.
    expect(followScrollTop({ ...base, current: 20, height: 4, top: 27 })).toBe(24);
  });

  test("converges instead of oscillating when the row can't host both margins", () => {
    // Height 6 in a 10-row viewport: 6 + 2*margin(3) > 10, so the margin can't
    // Hold on both sides. The offset must reach a fixed point, not flip anchors.
    const settled = followScrollTop({ ...base, current: 0, height: 6, top: 20 });
    expect(followScrollTop({ ...base, current: settled, height: 6, top: 20 })).toBe(settled);
  });

  test("anchors a row taller than the viewport to its top, stably", () => {
    // A row taller than the viewport can't be framed; anchor its top every run.
    expect(followScrollTop({ ...base, current: 0, height: 14, top: 20 })).toBe(20);
    expect(followScrollTop({ ...base, current: 50, height: 14, top: 20 })).toBe(20);
  });

  test("clamps to the top of the content", () => {
    expect(followScrollTop({ ...base, current: 5, top: 0 })).toBe(0);
    expect(followScrollTop({ ...base, current: 5, top: 2 })).toBe(0);
  });

  test("clamps to the deepest valid scroll at the end of the content", () => {
    // Near the last row the requested offset would exceed maxScroll; it's capped,
    // So the margin can't be fully honored at the very bottom (expected).
    expect(followScrollTop({ ...base, current: 80, maxScroll: 90, top: 99 })).toBe(90);
  });

  test("caps the margin to half the viewport so small viewports don't oscillate", () => {
    // Viewport=3 -> safe margin floor((3-1)/2)=1, not the requested 3.
    expect(
      followScrollTop({ current: 10, height: 1, margin: 3, maxScroll: 90, top: 12, viewport: 3 }),
    ).toBe(11);
  });
});

// Viewport of 10 columns, content up to maxScroll 90, 3-column margin.
const xBase = { margin: 3, maxScroll: 90, viewport: 10 };

describe("followScrollX", () => {
  test("does not scroll while the caret word sits inside the margins", () => {
    // Showing cols [0,10): a word at [4,6) keeps margin on both sides.
    expect(followScrollX({ ...xBase, current: 0, from: 4, to: 6 })).toBe(0);
  });

  test("scrolls right before the word reaches the right edge", () => {
    // Showing [0,10): word [8,10) is flush right, so scroll to keep 3 cols after it.
    expect(followScrollX({ ...xBase, current: 0, from: 8, to: 10 })).toBe(3);
  });

  test("scrolls left before the word reaches the left edge", () => {
    // Showing [10,20): word [12,14) is within the left margin, so scroll left.
    expect(followScrollX({ ...xBase, current: 10, from: 12, to: 14 })).toBe(9);
  });

  test("anchors a word wider than the viewport to its start", () => {
    expect(followScrollX({ ...xBase, current: 0, from: 5, to: 20 })).toBe(5);
  });

  test("clamps to the start and the deepest valid scroll", () => {
    expect(followScrollX({ ...xBase, current: 5, from: 0, to: 2 })).toBe(0);
    expect(followScrollX({ ...xBase, current: 80, from: 95, to: 97 })).toBe(90);
  });
});

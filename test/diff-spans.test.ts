import { describe, expect, test } from "bun:test";

import { columnToIndex, markRange, sliceSpansWindow } from "@/diff/spans";

describe("sliceSpansWindow", () => {
  test("keeps spans that fit within the budget from column 0", () => {
    const spans = [{ fg: "#f00", text: "const" }, { text: " x" }];
    expect(sliceSpansWindow(spans, 0, 20)).toEqual(spans);
  });

  test("clips to the width, left-aligned, from column 0", () => {
    const spans = [
      { fg: "#f00", text: "const" },
      { fg: "#0f0", text: " value = 1" },
    ];
    expect(sliceSpansWindow(spans, 0, 8)).toEqual([
      { fg: "#f00", text: "const" },
      { fg: "#0f0", text: " va" },
    ]);
  });

  test("scrolls horizontally: skips `start` columns, then takes `width`", () => {
    const spans = [
      { fg: "#f00", text: "const" },
      { fg: "#0f0", text: " value = 1" },
    ];
    // Skip 6 cols ("const "), then take 5 → "value".
    expect(sliceSpansWindow(spans, 6, 5)).toEqual([{ fg: "#0f0", text: "value" }]);
  });

  test("drops spans entirely before or after the window", () => {
    const spans = [{ text: "abcd" }, { fg: "#0f0", text: "EFGH" }, { text: "ijkl" }];
    expect(sliceSpansWindow(spans, 4, 4)).toEqual([{ fg: "#0f0", text: "EFGH" }]);
  });

  test("counts wide CJK glyphs as two columns", () => {
    expect(sliceSpansWindow([{ text: "你好世" }], 0, 5)).toEqual([{ text: "你好" }]);
  });

  test("returns nothing for a non-positive width", () => {
    expect(sliceSpansWindow([{ text: "x" }], 0, 0)).toEqual([]);
  });
});

describe("markRange", () => {
  test("splits a span so the display range carries the highlight flag", () => {
    // "const value": highlight columns [6, 11) → "value".
    const spans = [{ fg: "#f00", text: "const value" }];
    expect(markRange(spans, 6, 11)).toEqual([
      { fg: "#f00", text: "const " },
      { fg: "#f00", highlight: true, text: "value" },
    ]);
  });

  test("highlights across a span boundary, preserving each span's color", () => {
    const spans = [
      { fg: "#f00", text: "ab" },
      { fg: "#0f0", text: "cd" },
    ];
    expect(markRange(spans, 1, 3)).toEqual([
      { fg: "#f00", text: "a" },
      { fg: "#f00", highlight: true, text: "b" },
      { fg: "#0f0", highlight: true, text: "c" },
      { fg: "#0f0", text: "d" },
    ]);
  });

  test("a non-positive range leaves the spans untouched", () => {
    const spans = [{ text: "abc" }];
    expect(markRange(spans, 2, 2)).toEqual(spans);
  });
});

describe("columnToIndex", () => {
  test("maps a display column to a UTF-16 string index", () => {
    expect(columnToIndex("const x", 0)).toBe(0);
    expect(columnToIndex("const x", 6)).toBe(6);
    expect(columnToIndex("const x", 99)).toBe(7);
  });

  test("a column inside a wide glyph returns that glyph's start", () => {
    // "你好": each glyph is two columns wide; column 3 is inside the second glyph.
    expect(columnToIndex("你好", 0)).toBe(0);
    expect(columnToIndex("你好", 2)).toBe(1);
    expect(columnToIndex("你好", 3)).toBe(1);
  });
});

import { describe, expect, test } from "bun:test";

import { toCodePoints, truncate, truncateAroundMatch, truncateLeft } from "@/utils/text";

const rangeFrom = (start: number, length: number) =>
  Array.from({ length }, (_, offset) => start + offset);

const visibleMatch = (result: { text: string; matched: number[] }) => {
  const chars = toCodePoints(result.text);
  return result.matched.map((index) => chars[index]).join("");
};

describe("truncate", () => {
  test("returns the text unchanged when it fits the budget", () => {
    expect(truncate("main", 10)).toBe("main");
  });

  test("cuts to the budget with an ellipsis, counting the ellipsis as a cell", () => {
    expect(truncate("feat/header-repo-anchor", 8)).toBe("feat/he…");
    expect(Bun.stringWidth(truncate("feat/header-repo-anchor", 8))).toBe(8);
  });

  test("measures display width, so a wide emoji counts as two cells", () => {
    // "🐛" is two cells, so only "ab" fits before the ellipsis in a 4-cell budget.
    expect(truncate("ab🐛cd", 4)).toBe("ab…");
    expect(Bun.stringWidth(truncate("ab🐛cd", 4))).toBeLessThanOrEqual(4);
  });

  test("keeps a whole wide glyph rather than splitting it across the budget edge", () => {
    // Budget 3 reserves 1 for the ellipsis, leaving 2 cells: the emoji fits exactly.
    expect(truncate("🐛xy", 3)).toBe("🐛…");
  });

  test("keeps a ZWJ sequence whole rather than cutting it into a dangling joiner", () => {
    // The family is one 2-cell cluster, so it fits the 2 cells left by the ellipsis.
    expect(truncate("👨‍👩‍👧xyz", 3)).toBe("👨‍👩‍👧…");
  });

  test("keeps a skin-tone modifier with the emoji it modifies", () => {
    expect(truncate("👍🏽xyz", 3)).toBe("👍🏽…");
  });

  test("measures a cluster as the cells it paints, not the sum of its code points", () => {
    // The family paints 2 cells; its code points sum to 6. Budget 4 leaves 3 cells after
    // The ellipsis, so the family and the following `x` both fit.
    expect(truncate("👨‍👩‍👧xyz", 4)).toBe("👨‍👩‍👧x…");
    expect(Bun.stringWidth(truncate("👨‍👩‍👧xyz", 4))).toBe(4);
  });

  test("never exceeds the budget it was given", () => {
    for (const text of ["👨‍👩‍👧xyz", "👍🏽xyz", "🇺🇸xyz", "ab🐛cd", "feat/header-repo-anchor"]) {
      for (const max of [1, 2, 3, 4, 5, 6]) {
        expect(Bun.stringWidth(truncate(text, max))).toBeLessThanOrEqual(max);
      }
    }
  });
});

describe("truncateAroundMatch", () => {
  test("returns the text unchanged when it already fits", () => {
    const matched = [0, 1, 2];
    const result = truncateAroundMatch("src/a.ts", matched, 20);
    expect(result.text).toBe("src/a.ts");
    expect(result.matched).toEqual(matched);
  });

  test("with no match it behaves like truncateLeft", () => {
    const text = "src/components/very/long/path/name.tsx";
    expect(truncateAroundMatch(text, [], 20).text).toBe(truncateLeft(text, 20));
  });

  test("keeps a basename match by anchoring to the tail", () => {
    const text = "src/very/deep/nested/path/to/error-patterns.md";
    const start = text.indexOf("patterns");
    const result = truncateAroundMatch(text, rangeFrom(start, "patterns".length), 24);

    expect(toCodePoints(result.text).length).toBeLessThanOrEqual(24);
    expect(result.text.startsWith("…")).toBe(true);
    expect(result.text.endsWith(".md")).toBe(true);
    expect(visibleMatch(result)).toBe("patterns");
  });

  test("shifts the window to a mid-path match, clipping both sides", () => {
    const text = "aaaaaaaaXXXXbbbbbbbb";
    const result = truncateAroundMatch(text, rangeFrom(8, 4), 10);

    expect(result.text).toBe("…XXXXbbbb…");
    expect(visibleMatch(result)).toBe("XXXX");
  });

  test("keeps the basename-side end of a match wider than the budget", () => {
    const result = truncateAroundMatch("abcdefghijklmnop", rangeFrom(2, 12), 6);

    expect(toCodePoints(result.text).length).toBeLessThanOrEqual(6);
    expect(result.text.startsWith("…")).toBe(true);
    // The last matched chars (nearest the basename) stay visible, not the head.
    expect(visibleMatch(result).endsWith("n")).toBe(true);
  });

  test("keeps the later run of a two-term match visible when both cannot fit", () => {
    // "…aaa/references/error-patterns" style: a leading-dir run and a basename
    // Run too far apart to both fit; the basename-side run must survive.
    const text = "leaddir/aaaaaaaaaaaaaaaaaaaaaa/error-patterns.md";
    const leadRun = rangeFrom(0, 4); // "lead"
    const tailStart = text.indexOf("patterns");
    const tailRun = rangeFrom(tailStart, "patterns".length);
    const result = truncateAroundMatch(text, [...leadRun, ...tailRun], 24);

    expect(toCodePoints(result.text).length).toBeLessThanOrEqual(24);
    expect(result.text).toContain("patterns");
    expect(visibleMatch(result)).toContain("patterns");
  });
});

import { describe, expect, test } from "bun:test";

import {
  applyCollapsedRegions,
  computeFoldRegions,
  computeMarkdownFoldRegions,
  foldKey,
  foldRegionsFor,
  remapCursorAfterToggle,
} from "@/diff/regions";
import { navigableLinesFromRows } from "@/diff/rows";
import type { DiffRow, NavigableLine } from "@/diff/rows";

const nav = (newLine: number, content: string): NavigableLine => ({
  content,
  newLine,
  oldLine: newLine,
  type: "context",
});

const line = (navIndex: number, newLine: number, content: string): DiffRow => ({
  kind: "line",
  navIndex,
  newLine,
  oldLine: newLine,
  spans: [{ text: content }],
  type: "context",
});

const empty = { expandedGaps: new Set<string>(), folded: new Set<string>() };

describe("computeFoldRegions", () => {
  test("heads a region at a line whose following lines are more indented", () => {
    const regions = computeFoldRegions([
      nav(1, "function foo() {"),
      nav(2, "  const a = 1;"),
      nav(3, "  const b = 2;"),
      nav(4, "}"),
      nav(5, "const top = 1;"),
    ]);
    expect(regions).toEqual([{ count: 2, endNavIndex: 2, headerNavIndex: 0, key: "fold:n1" }]);
  });

  test("emits nested regions, parent before child", () => {
    const regions = computeFoldRegions([
      nav(1, "class C {"),
      nav(2, "  method() {"),
      nav(3, "    return 1;"),
      nav(4, "  }"),
      nav(5, "}"),
    ]);
    expect(regions).toEqual([
      { count: 3, endNavIndex: 3, headerNavIndex: 0, key: "fold:n1" },
      { count: 1, endNavIndex: 2, headerNavIndex: 1, key: "fold:n2" },
    ]);
  });

  test("folds interior blank lines but not trailing ones", () => {
    const regions = computeFoldRegions([
      nav(1, "def f():"),
      nav(2, "    a = 1"),
      nav(3, ""),
      nav(4, "    b = 2"),
      nav(5, ""),
      nav(6, "g = 1"),
    ]);
    expect(regions).toEqual([{ count: 3, endNavIndex: 3, headerNavIndex: 0, key: "fold:n1" }]);
  });

  test("does not head a region for a line with no deeper body", () => {
    expect(computeFoldRegions([nav(1, "a = 1"), nav(2, "b = 2")])).toEqual([]);
  });
});

describe("applyCollapsedRegions folds", () => {
  const rows = [
    line(0, 1, "function foo() {"),
    line(1, 2, "  const a = 1;"),
    line(2, 3, "  const b = 2;"),
    line(3, 4, "}"),
    line(4, 5, "const top = 1;"),
  ];

  test("is identity (bar re-densified navIndex) with nothing collapsed", () => {
    const result = applyCollapsedRegions(rows, empty);
    expect(result.rows).toEqual(rows);
    expect(result.navigable).toHaveLength(5);
  });

  test("drops the folded body behind a fold marker and re-densifies navIndex", () => {
    const result = applyCollapsedRegions(rows, {
      expandedGaps: new Set(),
      folded: new Set(["fold:n1"]),
    });
    expect(result.rows).toEqual([
      line(0, 1, "function foo() {"),
      { collapsed: true, count: 2, key: "fold:n1", kind: "marker", regionKind: "fold" },
      line(1, 4, "}"),
      line(2, 5, "const top = 1;"),
    ]);
    expect(result.navigable.map((navigable) => navigable.newLine)).toEqual([1, 4, 5]);
  });

  test("hides a git gap that sits inside a folded region", () => {
    // A folded block can span an elided middle (edits at both ends), so its fold region
    // Covers a separator; folding must hide that gap marker too, not leak it in the fold.
    const spanning: DiffRow[] = [
      line(0, 1, "function foo() {"),
      line(1, 2, "  const a = 1"),
      { count: 3, kind: "separator", text: "3 unmodified lines" },
      line(2, 6, "  const b = 2"),
      line(3, 7, "}"),
    ];
    const result = applyCollapsedRegions(spanning, {
      expandedGaps: new Set(),
      folded: new Set(["fold:n1"]),
    });
    expect(result.rows).toEqual([
      line(0, 1, "function foo() {"),
      { collapsed: true, count: 2, key: "fold:n1", kind: "marker", regionKind: "fold" },
      line(1, 7, "}"),
    ]);
    expect(result.rows.some((row) => row.kind === "marker" && row.regionKind === "gap")).toBe(
      false,
    );
  });

  test("skips a nested fold marker when its parent is folded", () => {
    const nested = [
      line(0, 1, "class C {"),
      line(1, 2, "  method() {"),
      line(2, 3, "    return 1;"),
      line(3, 4, "  }"),
      line(4, 5, "}"),
    ];
    const result = applyCollapsedRegions(nested, {
      expandedGaps: new Set(),
      folded: new Set(["fold:n1", "fold:n2"]),
    });
    expect(result.rows).toEqual([
      line(0, 1, "class C {"),
      { collapsed: true, count: 3, key: "fold:n1", kind: "marker", regionKind: "fold" },
      line(1, 5, "}"),
    ]);
  });
});

describe("applyCollapsedRegions gaps", () => {
  const rows: DiffRow[] = [
    { count: 3, kind: "separator", text: "3 unmodified lines" },
    line(0, 10, "  changed();"),
  ];

  test("renders a collapsed separator as a gap marker by default", () => {
    const result = applyCollapsedRegions(rows, empty);
    expect(result.rows[0]).toEqual({
      collapsed: true,
      count: 3,
      key: "gap:0",
      kind: "marker",
      regionKind: "gap",
    });
    expect(result.navigable).toHaveLength(1);
  });

  test("reveals the elided lines from source behind a hide marker when expanded", () => {
    const result = applyCollapsedRegions(rows, {
      expandedGaps: new Set(["gap:0"]),
      folded: new Set(),
      gapSource: { lines: ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"] },
    });
    expect(result.rows[0]).toEqual({
      collapsed: false,
      count: 3,
      key: "gap:0",
      kind: "marker",
      regionKind: "gap",
    });
    // Gap of 3 before new line 10 -> reveals source lines 7, 8, 9 (indices 6..8: "g","h","i").
    expect(
      result.navigable.map((navigable) => `${navigable.newLine}:${navigable.content}`),
    ).toEqual(["7:g", "8:h", "9:i", "10:  changed();"]);
  });

  test("stays a collapsed marker when expanded but no source is loaded yet", () => {
    const result = applyCollapsedRegions(rows, {
      expandedGaps: new Set(["gap:0"]),
      folded: new Set(),
    });
    expect(result.rows[0]).toMatchObject({ collapsed: true, regionKind: "gap" });
  });
});

describe("remapCursorAfterToggle", () => {
  const before = [nav(1, "function foo() {"), nav(2, "  a"), nav(3, "  b"), nav(4, "}")];

  test("keeps the caret on the same file line when it stays visible", () => {
    const after = navigableLinesFromRows(
      applyCollapsedRegions([line(0, 1, "function foo() {"), line(1, 4, "}")], empty).rows,
    );
    expect(remapCursorAfterToggle(before, 3, after)).toBe(1);
  });

  test("falls back to the fold header when the caret line was hidden", () => {
    const after = [nav(1, "function foo() {"), nav(4, "}")];
    expect(remapCursorAfterToggle(before, 1, after)).toBe(0);
  });
});

describe("computeMarkdownFoldRegions", () => {
  test("heads a region at each ATX heading, bounded by the next same-or-higher heading", () => {
    const regions = computeMarkdownFoldRegions([
      nav(1, "# Title"),
      nav(2, "intro"),
      nav(3, "## Install"),
      nav(4, "step 1"),
      nav(5, "## Usage"),
      nav(6, "do this"),
    ]);
    expect(regions).toEqual([
      { count: 5, endNavIndex: 5, headerNavIndex: 0, key: "fold:n1" },
      { count: 1, endNavIndex: 3, headerNavIndex: 2, key: "fold:n3" },
      { count: 1, endNavIndex: 5, headerNavIndex: 4, key: "fold:n5" },
    ]);
  });

  test("ignores a `#` inside a fenced code block", () => {
    const regions = computeMarkdownFoldRegions([
      nav(1, "# Title"),
      nav(2, "```"),
      nav(3, "# fake heading"),
      nav(4, "```"),
      nav(5, "real text"),
    ]);
    expect(regions).toEqual([{ count: 4, endNavIndex: 4, headerNavIndex: 0, key: "fold:n1" }]);
  });

  test("excludes the trailing blank line before the next heading from the section", () => {
    const regions = computeMarkdownFoldRegions([
      nav(1, "# Title"),
      nav(2, "text"),
      nav(3, ""),
      nav(4, "# Next"),
    ]);
    expect(regions).toEqual([{ count: 1, endNavIndex: 1, headerNavIndex: 0, key: "fold:n1" }]);
  });

  test("does not head a region for a heading with no body", () => {
    expect(
      computeMarkdownFoldRegions([nav(1, "# Title"), nav(2, "text"), nav(3, "## End")]),
    ).toEqual([{ count: 2, endNavIndex: 2, headerNavIndex: 0, key: "fold:n1" }]);
  });

  test("foldRegionsFor dispatches markdown vs indent", () => {
    const lines = [nav(1, "# Heading"), nav(2, "body")];
    expect(foldRegionsFor(lines, "markdown")).toHaveLength(1);
    // Indent mode finds nothing here (both lines at column 0).
    expect(foldRegionsFor(lines, "indent")).toEqual([]);
  });
});

describe("foldKey", () => {
  test("qualifies by side so an add and a removal cannot collide", () => {
    expect(foldKey({ content: "x", newLine: 5, oldLine: 5, type: "context" })).toBe("fold:n5");
    expect(foldKey({ content: "x", oldLine: 5, type: "remove" })).toBe("fold:o5");
  });
});

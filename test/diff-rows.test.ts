import { describe, expect, test } from "bun:test";

import { buildDiffRows, navigableLinesFromRows } from "@/diff/rows";
import type { DiffMetaInput } from "@/diff/rows";

// Mirrors the probe: one context line, a 1/1 change, then two context lines.
// `collapsedBefore` defaults to 0 (a hunk at line 1, so no leading separator).
function sampleMeta(collapsedBefore = 0): DiffMetaInput {
  return {
    additionLines: ["const a = 1;", 'const b = "three";', "const c = 4;", "const d = 5;"],
    deletionLines: ["const a = 1;", 'const b = "two";', "const c = 4;", "const d = 5;"],
    hunks: [
      {
        additionStart: 1,
        collapsedBefore,
        deletionStart: 1,
        hunkContent: [
          { additionLineIndex: 0, deletionLineIndex: 0, lines: 1, type: "context" },
          {
            additionLineIndex: 1,
            additions: 1,
            deletionLineIndex: 1,
            deletions: 1,
            type: "change",
          },
          { additionLineIndex: 2, deletionLineIndex: 2, lines: 2, type: "context" },
        ],
      },
    ],
  };
}

describe("buildDiffRows", () => {
  test("emits unified rows with deletions before additions and tracked line numbers", () => {
    const { rows, truncated } = buildDiffRows(sampleMeta(), [], [], {
      full: false,
      maxLines: 1600,
    });
    expect(truncated).toBe(false);
    expect(
      rows.map((row) =>
        row.kind === "separator"
          ? `S:${row.text}`
          : `${row.type}:${row.oldLine ?? "-"}/${row.newLine ?? "-"}`,
      ),
    ).toEqual(["context:1/1", "remove:2/-", "add:-/2", "context:3/3", "context:4/4"]);
  });

  test("emits a 'N unmodified lines' separator for the lines collapsed before a hunk", () => {
    const { rows } = buildDiffRows(sampleMeta(6), [], [], { full: false, maxLines: 1600 });
    expect(rows[0]).toEqual({ kind: "separator", text: "6 unmodified lines" });
  });

  test("singularizes the separator label for a single collapsed line", () => {
    const { rows } = buildDiffRows(sampleMeta(1), [], [], { full: false, maxLines: 1600 });
    expect(rows[0]).toEqual({ kind: "separator", text: "1 unmodified line" });
  });

  test("emits no separator when nothing is collapsed before the hunk (e.g. full-file view)", () => {
    const { rows } = buildDiffRows(sampleMeta(0), [], [], { full: false, maxLines: 1600 });
    expect(rows.some((row) => row.kind === "separator")).toBe(false);
  });

  test("falls back to plain line text when no highlighted spans are supplied", () => {
    const { rows } = buildDiffRows(sampleMeta(), [], [], { full: false, maxLines: 1600 });
    const remove = rows.find((row) => row.kind === "line" && row.type === "remove");
    expect(remove?.kind === "line" && remove.spans).toEqual([{ text: 'const b = "two";' }]);
  });

  test("prefers supplied highlighted spans over plain text, indexed by line", () => {
    const addSpans = [[], [{ fg: "#79B8FF", text: 'const b = "three";' }], [], []];
    const { rows } = buildDiffRows(sampleMeta(), addSpans, [], { full: false, maxLines: 1600 });
    const added = rows.find((row) => row.kind === "line" && row.type === "add");
    expect(added?.kind === "line" && added.spans).toEqual([
      { fg: "#79B8FF", text: 'const b = "three";' },
    ]);
  });

  test("assigns contiguous navIndex to line rows matching navigable order", () => {
    const { rows } = buildDiffRows(sampleMeta(), [], [], { full: false, maxLines: 1600 });
    const navIndexes = rows
      .filter((row) => row.kind === "line")
      .map((row) => (row.kind === "line" ? row.navIndex : -1));
    expect(navIndexes).toEqual([0, 1, 2, 3, 4]);

    const navigable = navigableLinesFromRows(rows);
    expect(navigable).toHaveLength(5);
    expect(navigable[1]).toEqual({
      content: 'const b = "two";',
      newLine: undefined,
      oldLine: 2,
      type: "remove",
    });
  });

  test("caps body lines at maxLines and flags truncation, ignoring the cap when full", () => {
    const capped = buildDiffRows(sampleMeta(), [], [], { full: false, maxLines: 3 });
    expect(capped.truncated).toBe(true);
    expect(capped.rows.filter((row) => row.kind === "line")).toHaveLength(3);

    const full = buildDiffRows(sampleMeta(), [], [], { full: true, maxLines: 3 });
    expect(full.truncated).toBe(false);
    expect(full.rows.filter((row) => row.kind === "line")).toHaveLength(5);
  });
});

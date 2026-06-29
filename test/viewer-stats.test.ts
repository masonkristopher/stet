import { describe, expect, test } from "bun:test";

import type { ChangedFile } from "@/git/model";
import { viewerStats } from "@/ui-helpers";

function changed(over: Partial<ChangedFile> = {}): ChangedFile {
  return {
    additions: 0,
    binary: false,
    deletions: 0,
    kind: "modified",
    mtimeMs: 0,
    path: "a.ts",
    stage: "unstaged",
    warnings: [],
    ...over,
  };
}

describe("viewerStats", () => {
  test("diff view shows the add/remove counts", () => {
    expect(viewerStats(changed({ additions: 3, deletions: 1 }), false, undefined)).toBe("+3 -1");
  });

  test("diff view appends warnings", () => {
    expect(viewerStats(changed({ additions: 1, warnings: ["crlf"] }), false, undefined)).toBe(
      "+1 -0 !crlf",
    );
  });

  test("file view shows the line count", () => {
    expect(
      viewerStats(undefined, true, { content: "", kind: "text", lineCount: 42, truncated: false }),
    ).toBe("42 lines");
  });

  test("file view marks a truncated file", () => {
    expect(
      viewerStats(undefined, true, { content: "", kind: "text", lineCount: 42, truncated: true }),
    ).toBe("42 lines (truncated)");
  });

  test("a binary/placeholder file view has no stats", () => {
    expect(viewerStats(undefined, true, { kind: "binary" })).toBe("");
  });

  test("diff view labels a binary file instead of zeroed counts", () => {
    expect(viewerStats(changed({ binary: true }), false, undefined)).toBe("binary");
    expect(viewerStats(changed({ binary: true, warnings: ["lfs"] }), false, undefined)).toBe(
      "binary !lfs",
    );
  });

  test("no selected file in diff view has no stats", () => {
    expect(viewerStats(undefined, false, undefined)).toBe("");
  });
});

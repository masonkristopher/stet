import { describe, expect, test } from "bun:test";

import { lineReference, parsePatch, renderPatch } from "../src/git/patch";

const diff = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,4 @@
 const a = 1
-const b = 2
+const b = 3
+const c = 4
 const d = 5`;

describe("parsePatch", () => {
  test("parses hunks and line anchors", () => {
    const parsed = parsePatch(diff);

    expect(parsed.hunks).toHaveLength(1);
    expect(parsed.hunks[0]?.lines.map((line) => [line.type, line.oldLine, line.newLine])).toEqual([
      ["context", 1, 1],
      ["remove", 2, undefined],
      ["add", undefined, 2],
      ["add", undefined, 3],
      ["context", 3, 4],
    ]);
  });

  test("keeps removed '--' and added '++' content and does not drift line numbers", () => {
    const tricky = `--- a/q.sql
+++ b/q.sql
@@ -1,3 +1,3 @@
 select 1
--- old comment
+++ counter
 select 2`;
    const parsed = parsePatch(tricky);

    expect(parsed.header).toEqual(["--- a/q.sql", "+++ b/q.sql"]);
    expect(
      parsed.hunks[0]?.lines.map((line) => [line.type, line.oldLine, line.newLine, line.content]),
    ).toEqual([
      ["context", 1, 1, "select 1"],
      ["remove", 2, undefined, "-- old comment"],
      ["add", undefined, 2, "++ counter"],
      ["context", 3, 3, "select 2"],
    ]);
  });

  test("recognizes the next file's hunks once a hunk's counts are spent", () => {
    const multi = `--- a/a.ts
+++ b/a.ts
@@ -1,1 +1,1 @@
-old a
+new a
--- a/b.ts
+++ b/b.ts
@@ -5,1 +5,1 @@
-old b
+new b`;
    const parsed = parsePatch(multi);

    expect(parsed.hunks).toHaveLength(2);
    expect(parsed.hunks[1]?.lines.map((line) => line.content)).toEqual(["old b", "new b"]);
    expect(parsed.hunks[1]?.lines[0]?.oldLine).toBe(5);
  });

  test("ignores no-newline markers without spending hunk counts", () => {
    const noNewline = `--- a/a.ts
+++ b/a.ts
@@ -1,1 +1,1 @@
-old
\\ No newline at end of file
+new
\\ No newline at end of file`;
    const parsed = parsePatch(noNewline);

    expect(parsed.hunks[0]?.lines.map((line) => [line.type, line.content])).toEqual([
      ["remove", "old"],
      ["add", "new"],
    ]);
  });

  test("builds a copy reference for a diff line", () => {
    const lines = parsePatch(diff).hunks[0]?.lines ?? [];
    const added = lines.find((line) => line.type === "add");
    expect(added === undefined ? undefined : lineReference("src/a.ts", added)).toEqual({
      line: 2,
      path: "src/a.ts",
      snippet: "const b = 3",
    });
    const removed = lines.find((line) => line.type === "remove");
    expect(removed === undefined ? undefined : lineReference("src/a.ts", removed)).toEqual({
      line: 2,
      path: "src/a.ts",
      snippet: "const b = 2",
    });
  });

  test("renders the full patch and flags truncation", () => {
    const full = renderPatch(diff, { full: true, maxLines: 100 });
    expect(full.truncated).toBe(false);
    expect(full.diff).toContain("const c = 4");
    expect(renderPatch(diff, { full: false, maxLines: 1 }).truncated).toBe(true);
  });

  test("reports how many body lines were emitted so navigation can clamp to them", () => {
    expect(renderPatch(diff, { full: true, maxLines: 1 }).bodyLineCount).toBe(5);
    expect(renderPatch(diff, { full: false, maxLines: 2 }).bodyLineCount).toBe(2);
    expect(renderPatch("not a diff", { full: false, maxLines: 2 }).bodyLineCount).toBe(0);
  });
});

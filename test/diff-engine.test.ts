import { describe, expect, test } from "bun:test";

import { renderDiff } from "../src/diff/engine";
import { isLineRow } from "../src/diff/rows";

const patch = `diff --git a/foo.ts b/foo.ts
index 1111111..2222222 100644
--- a/foo.ts
+++ b/foo.ts
@@ -1,4 +1,4 @@
 const a = 1;
-const b = "two";
+const b = "three";
 const c = 4;
 const d = 5;
`;

describe("renderDiff", () => {
  test("parses, highlights, and builds the unified row model from a real patch", async () => {
    const render = await renderDiff({ full: false, maxLines: 1600, patch });

    expect(render.truncated).toBe(false);
    expect(render.navigable).toHaveLength(5);
    expect(render.navigable[1]).toMatchObject({
      content: 'const b = "two";',
      oldLine: 2,
      type: "remove",
    });

    const added = render.rows.filter(isLineRow).find((row) => row.type === "add");
    if (added === undefined) {
      throw new Error("expected an addition row");
    }
    // The reconstructed text is exact, and Shiki produced multiple colored tokens.
    expect(added.spans.map((span) => span.text).join("")).toBe('const b = "three";');
    expect(added.spans.length).toBeGreaterThan(1);
    expect(added.spans.some((span) => span.fg !== undefined)).toBe(true);
    expect(added.newLine).toBe(2);
  });

  test("resolves an empty render for an empty patch", async () => {
    expect(await renderDiff({ full: false, maxLines: 1600, patch: "" })).toEqual({
      navigable: [],
      rows: [],
      truncated: false,
    });
  });

  test("highlights a language not in the warm preload set by attaching its grammar on demand", async () => {
    // Rust is not preloaded; its grammar must be resolved and attached before the diff highlights.
    const rustPatch = `diff --git a/main.rs b/main.rs
index 1111111..2222222 100644
--- a/main.rs
+++ b/main.rs
@@ -1,1 +1,1 @@
-let total: u32 = 0;
+let total: u32 = sum(items);
`;
    const render = await renderDiff({ full: false, maxLines: 1600, patch: rustPatch });

    const added = render.rows.filter(isLineRow).find((row) => row.type === "add");
    if (added === undefined) {
      throw new Error("expected an addition row");
    }
    expect(added.spans.map((span) => span.text).join("")).toBe("let total: u32 = sum(items);");
    expect(added.spans.length).toBeGreaterThan(1);
    expect(added.spans.some((span) => span.fg !== undefined)).toBe(true);
  });

  test("highlights both files when two diffs of a new language render concurrently", async () => {
    // Go is not preloaded. Two different files (distinct fingerprints, so no cache/in-flight
    // De-dup) rendered together must both wait for the grammar to attach: neither may race ahead
    // And cache plain-text spans while the attachment is still in flight.
    const goPatch = (name: string, body: string) => `diff --git a/${name} b/${name}
index 1111111..2222222 100644
--- a/${name}
+++ b/${name}
@@ -1,1 +1,1 @@
-old
+${body}
`;
    const [first, second] = await Promise.all([
      renderDiff({
        full: false,
        maxLines: 1600,
        patch: goPatch("first.go", "func add(a int) int {"),
      }),
      renderDiff({
        full: false,
        maxLines: 1600,
        patch: goPatch("second.go", "func sub(b int) int {"),
      }),
    ]);

    for (const render of [first, second]) {
      const added = render.rows.filter(isLineRow).find((row) => row.type === "add");
      if (added === undefined) {
        throw new Error("expected an addition row");
      }
      expect(added.spans.length).toBeGreaterThan(1);
      expect(added.spans.some((span) => span.fg !== undefined)).toBe(true);
    }
  });

  test("renders an unknown extension as plain text without throwing", async () => {
    const unknownPatch = `diff --git a/notes.zzzz b/notes.zzzz
index 1111111..2222222 100644
--- a/notes.zzzz
+++ b/notes.zzzz
@@ -1,1 +1,1 @@
-old line
+new line here
`;
    const render = await renderDiff({ full: false, maxLines: 1600, patch: unknownPatch });

    const added = render.rows.filter(isLineRow).find((row) => row.type === "add");
    if (added === undefined) {
      throw new Error("expected an addition row");
    }
    expect(added.spans.map((span) => span.text).join("")).toBe("new line here");
  });
});

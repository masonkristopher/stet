import { describe, expect, test } from "bun:test";

import { languageForPath, renderDiff } from "@/diff/engine";
import { isLineRow } from "@/diff/rows";

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

    expect(render.hiddenLines).toBe(0);
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
      hiddenLines: 0,
      navigable: [],
      rows: [],
    });
  });

  test("serves an identical patch from the byte-capped cache by reference", async () => {
    // A second render of the same fingerprint returns the cached render object itself, not a
    // Recompute, confirming the size-tracking cache wrapper still resolves hits to `.render`.
    const first = await renderDiff({ full: false, maxLines: 1600, patch });
    const second = await renderDiff({ full: false, maxLines: 1600, patch });
    expect(second).toBe(first);
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

  test("renders a subdirectory Dockerfile with syntax highlighting", async () => {
    // An extensionless filename key resolves only against the basename; before that fix a
    // Dockerfile in any directory fell through to plain text.
    const dockerPatch = `diff --git a/docker/Dockerfile b/docker/Dockerfile
index 1111111..2222222 100644
--- a/docker/Dockerfile
+++ b/docker/Dockerfile
@@ -1,1 +1,1 @@
-FROM node:18
+FROM oven/bun:1
`;
    const render = await renderDiff({ full: false, maxLines: 1600, patch: dockerPatch });

    const added = render.rows.filter(isLineRow).find((row) => row.type === "add");
    if (added === undefined) {
      throw new Error("expected an addition row");
    }
    expect(added.spans.map((span) => span.text).join("")).toBe("FROM oven/bun:1");
    expect(added.spans.length).toBeGreaterThan(1);
    expect(added.spans.some((span) => span.fg !== undefined)).toBe(true);
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

describe("languageForPath", () => {
  test("resolves extensionless filename keys against the basename in any directory", () => {
    expect(languageForPath("Dockerfile")).toBe("dockerfile");
    expect(languageForPath("docker/Dockerfile")).toBe("dockerfile");
    expect(languageForPath("infra/backend/Makefile")).toBe("makefile");
  });

  test("resolves extension-based files, including nested paths", () => {
    expect(languageForPath("src/index.ts")).toBe("typescript");
    expect(languageForPath("nginx.conf")).toBe("nginx");
  });

  test("keeps the .gradle Groovy override on the basename", () => {
    expect(languageForPath("app/build.gradle")).toBe("groovy");
  });

  test("peels a .rb.tmpl template to Ruby, leaving other .tmpl files as text", () => {
    expect(languageForPath("script/sideye.rb.tmpl")).toBe("ruby");
    expect(languageForPath("a/b/Formula.rb")).toBe("ruby");
    expect(languageForPath("config.yaml.tmpl")).toBe("text");
  });
});

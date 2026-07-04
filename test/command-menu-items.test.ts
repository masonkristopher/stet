import { describe, expect, test } from "bun:test";

import { buildCommandMenuItems } from "@/components/command-menu/items";
import type { CommandMenuInput } from "@/components/command-menu/items";

const viewer = (overrides: Partial<CommandMenuInput> = {}): CommandMenuInput => ({
  caretColumn: 5,
  caretLine: 12,
  context: "viewer",
  hasSymbol: true,
  selectedPath: "src/foo.ts",
  treeNode: undefined,
  truncated: false,
  ...overrides,
});

const tree = (overrides: Partial<CommandMenuInput> = {}): CommandMenuInput => ({
  caretColumn: undefined,
  caretLine: undefined,
  context: "tree",
  hasSymbol: false,
  selectedPath: undefined,
  treeNode: { id: "file:src/foo.ts", kind: "file", path: "src/foo.ts" },
  truncated: false,
  ...overrides,
});

const labels = (input: CommandMenuInput) => buildCommandMenuItems(input).map((item) => item.label);

describe("buildCommandMenuItems", () => {
  test("viewer with a symbol lists the intel actions first", () => {
    expect(labels(viewer())).toEqual([
      "Go to definition",
      "Find references",
      "Find implementations",
      "Call hierarchy",
      "Quick info",
      "Find symbols",
      "Copy reference",
      "Copy file contents",
      "Open in editor",
      "Open in IDE",
    ]);
  });

  test("viewer without a symbol omits the caret-intel actions but keeps find-symbols and the rest", () => {
    expect(labels(viewer({ caretColumn: undefined, hasSymbol: false }))).toEqual([
      "Find symbols",
      "Copy reference",
      "Copy file contents",
      "Open in editor",
      "Open in IDE",
    ]);
  });

  test("viewer shows full content only when the file is truncated", () => {
    expect(labels(viewer({ truncated: false }))).not.toContain("Show full content");
    expect(labels(viewer({ truncated: true })).at(-1)).toBe("Show full content");
  });

  test("viewer copy reference carries the caret line and column", () => {
    const item = buildCommandMenuItems(viewer()).find((entry) => entry.label === "Copy reference");

    expect(item?.action).toEqual({
      column: 5,
      kind: "copyReference",
      line: 12,
      path: "src/foo.ts",
    });
  });

  test("viewer copy reference drops the column at line level", () => {
    const item = buildCommandMenuItems(
      viewer({ caretColumn: undefined, caretLine: 12, hasSymbol: false }),
    ).find((entry) => entry.label === "Copy reference");

    expect(item?.action).toEqual({
      column: undefined,
      kind: "copyReference",
      line: 12,
      path: "src/foo.ts",
    });
  });

  test("viewer editor actions target the file at the caret line", () => {
    const items = buildCommandMenuItems(viewer());

    expect(items.find((item) => item.label === "Open in editor")?.action).toEqual({
      kind: "openEditor",
      line: 12,
      mode: "terminal",
      path: "src/foo.ts",
    });
    expect(items.find((item) => item.label === "Open in IDE")?.action).toEqual({
      kind: "openEditor",
      line: 12,
      mode: "ide",
      path: "src/foo.ts",
    });
  });

  test("viewer without a selected path has no items", () => {
    expect(buildCommandMenuItems(viewer({ selectedPath: undefined }))).toEqual([]);
  });

  test("tree file node lists pin, copy path, and editor opens (opening is the row click's job)", () => {
    expect(labels(tree())).toEqual(["Pin as tab", "Copy path", "Open in editor", "Open in IDE"]);
  });

  test("tree file copy path and editor opens carry the node path with no line", () => {
    const items = buildCommandMenuItems(tree());

    expect(items.find((item) => item.label === "Copy path")?.action).toEqual({
      column: undefined,
      kind: "copyReference",
      line: undefined,
      path: "src/foo.ts",
    });
    expect(items.find((item) => item.label === "Open in editor")?.action).toEqual({
      kind: "openEditor",
      line: undefined,
      mode: "terminal",
      path: "src/foo.ts",
    });
    // Pin as tab carries the node's own path so it opens+pins that file, not the
    // Currently-viewed one.
    expect(items.find((item) => item.label === "Pin as tab")?.action).toEqual({
      kind: "pinTab",
      path: "src/foo.ts",
    });
  });

  test("tree directory node offers only its path (no expand/collapse)", () => {
    const node = { id: "dir:src", kind: "directory" as const, path: "src" };

    expect(labels(tree({ treeNode: node }))).toEqual(["Copy path"]);
    expect(buildCommandMenuItems(tree({ treeNode: node }))[0]?.action).toEqual({
      column: undefined,
      kind: "copyReference",
      line: undefined,
      path: "src",
    });
  });

  test("tree without a focused node has no items", () => {
    expect(buildCommandMenuItems(tree({ treeNode: undefined }))).toEqual([]);
  });
});

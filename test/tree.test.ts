import { describe, expect, test } from "bun:test";

import type { ChangedFile, RepoFile } from "@/git/model";
import {
  buildFileTree,
  buildTreeStructure,
  decorateTree,
  defaultExpandedDirectories,
  expandAncestorsForPath,
  findRowIndexForPath,
  firstFileInNode,
  flattenTree,
} from "@/git/tree";

function changed(path: string, overrides: Partial<ChangedFile> = {}): ChangedFile {
  return {
    additions: 1,
    binary: false,
    deletions: 0,
    kind: "modified",
    mtimeMs: 0,
    path,
    stage: "unstaged",
    warnings: [],
    ...overrides,
  };
}

const repoFiles: RepoFile[] = [
  { path: "README.md", symlink: false, tracked: true },
  { path: "src/App.tsx", symlink: false, tracked: true },
  { path: "src/git.ts", symlink: false, tracked: true },
  { path: "src/components/ui/Button.tsx", symlink: false, tracked: true },
  { path: "notes.md", symlink: false, tracked: false },
];

const changedByPath = new Map([
  [
    "src/App.tsx",
    changed("src/App.tsx", { additions: 10, kind: "added", stage: "staged", warnings: ["new"] }),
  ],
  ["src/git.ts", changed("src/git.ts", { additions: 3, deletions: 1 })],
]);

describe("buildFileTree", () => {
  test("includes unchanged files with a change overlay on changed ones", () => {
    const tree = buildFileTree(repoFiles, changedByPath, { changesOnly: false });
    const rows = flattenTree(tree, new Set(["dir:src"]));
    const appRow = rows.find((row) => row.node.path === "src/App.tsx");
    const readmeRow = rows.find((row) => row.node.path === "README.md");

    expect(appRow?.node.type === "file" && appRow.node.changed?.kind).toBe("added");
    expect(readmeRow?.node.type === "file" && readmeRow.node.changed).toBe(undefined);
  });

  test("sorts directories first, then alphabetically", () => {
    const tree = buildFileTree(repoFiles, changedByPath, { changesOnly: false });
    expect(tree.map((node) => node.name)).toEqual(["src", "notes.md", "README.md"]);
  });

  test("aggregates churn and changed counts from changed descendants only", () => {
    const tree = buildFileTree(repoFiles, changedByPath, { changesOnly: false });
    const src = tree.find((node) => node.type === "directory" && node.path === "src");

    expect(src).toMatchObject({
      additions: 13,
      changedCount: 2,
      deletions: 1,
      fileCount: 3,
      type: "directory",
    });
  });

  test("flattens single-child directory chains", () => {
    const tree = buildFileTree(repoFiles, changedByPath, { changesOnly: false });
    const src = tree.find((node) => node.type === "directory" && node.path === "src");
    const chain =
      src?.type === "directory"
        ? src.children.find((node) => node.type === "directory")
        : undefined;

    expect(chain?.name).toBe("components/ui");
    expect(chain?.path).toBe("src/components/ui");
    expect(chain?.id).toBe("dir:src/components/ui");
  });

  test("changes-only filter prunes unchanged files", () => {
    const tree = buildFileTree(repoFiles, changedByPath, { changesOnly: true });
    const rows = flattenTree(tree, new Set(["dir:src"]));

    expect(rows.map((row) => row.node.path)).toEqual(["src", "src/App.tsx", "src/git.ts"]);
  });

  test("keeps files that vanished from the index but are in the changed set", () => {
    const deleted = changed("src/gone.ts", {
      additions: 0,
      deletions: 12,
      kind: "deleted",
      stage: "staged",
    });
    const tree = buildFileTree(repoFiles, new Map([...changedByPath, ["src/gone.ts", deleted]]), {
      changesOnly: false,
    });
    const rows = flattenTree(tree, new Set(["dir:src"]));

    expect(rows.map((row) => row.node.path)).toContain("src/gone.ts");
  });

  test("assigns visual depths after flattening", () => {
    const tree = buildFileTree(repoFiles, changedByPath, { changesOnly: false });
    const rows = flattenTree(tree, new Set(["dir:src", "dir:src/components/ui"]));
    const button = rows.find((row) => row.node.path === "src/components/ui/Button.tsx");

    expect(button?.depth).toBe(2);
  });

  test("carries the symlink flag onto the file node", () => {
    const tree = buildFileTree(
      [
        { path: "link.ts", symlink: true, tracked: true },
        { path: "real.ts", symlink: false, tracked: true },
      ],
      new Map(),
      { changesOnly: false },
    );

    expect(tree.find((node) => node.path === "link.ts")).toMatchObject({ symlink: true });
    expect(tree.find((node) => node.path === "real.ts")).toMatchObject({ symlink: false });
  });
});

describe("structure and decoration split", () => {
  test("structure depends only on the path set, not on changed values", () => {
    const paths = new Set(["src/App.tsx", "src/git.ts"]);
    const lean = buildTreeStructure(repoFiles, paths, { changesOnly: false });
    const churned = buildTreeStructure(repoFiles, paths, { changesOnly: false });

    // Same file set in, structurally identical tree out (no change overlay yet).
    expect(lean).toEqual(churned);
    const appRow = flattenTree(lean, new Set(["dir:src"])).find(
      (row) => row.node.path === "src/App.tsx",
    );
    expect(appRow?.node.type === "file" && appRow.node.changed).toBe(undefined);
    const src = lean.find((node) => node.type === "directory" && node.path === "src");
    expect(src?.type === "directory" && src.changedCount).toBe(0);
  });

  test("decorateTree overlays the changed set and aggregates without mutating the structure", () => {
    const structure = buildTreeStructure(repoFiles, new Set(changedByPath.keys()), {
      changesOnly: false,
    });
    const decorated = decorateTree(structure, changedByPath);

    expect(decorated.find((node) => node.path === "src")).toMatchObject({
      additions: 13,
      changedCount: 2,
      deletions: 1,
      fileCount: 3,
      type: "directory",
    });
    // The cached structure stays pristine, so the reactive layer can reuse it.
    expect(structure.find((node) => node.path === "src")).toMatchObject({
      additions: 0,
      changedCount: 0,
    });
  });

  test("decorateTree returns stable references for nodes whose changed field did not change", () => {
    const structure = buildTreeStructure(repoFiles, new Set(changedByPath.keys()), {
      changesOnly: false,
    });
    const first = decorateTree(structure, changedByPath);
    const second = decorateTree(first, changedByPath);

    // Nothing changed between calls — the entire array and every node should be the same ref.
    expect(second).toBe(first);
    for (let i = 0; i < first.length; i++) {
      expect(second[i]).toBe(first[i]);
    }

    // An unchanged file inside a directory also keeps its reference.
    const expanded = new Set(["dir:src", "dir:src/components/ui"]);
    const rows = flattenTree(first, expanded);
    const buttonBefore = rows.find((r) => r.node.path === "src/components/ui/Button.tsx");
    expect(buttonBefore).toBeDefined();
    const rows2 = flattenTree(second, expanded);
    const buttonAfter = rows2.find((r) => r.node.path === "src/components/ui/Button.tsx");
    expect(buttonAfter).toBeDefined();
    expect(buttonAfter?.node).toBe(buttonBefore?.node);
  });

  test("buildFileTree equals structure-then-decorate", () => {
    const composed = buildFileTree(repoFiles, changedByPath, { changesOnly: false });
    const split = decorateTree(
      buildTreeStructure(repoFiles, new Set(changedByPath.keys()), { changesOnly: false }),
      changedByPath,
    );
    expect(composed).toEqual(split);
  });
});

describe("expansion", () => {
  test("default expansion covers ancestors of changed paths only", () => {
    const expanded = defaultExpandedDirectories(["src/App.tsx", "src/components/ui/Button.tsx"]);
    expect([...expanded].toSorted()).toEqual([
      "dir:src",
      "dir:src/components",
      "dir:src/components/ui",
    ]);
  });

  test("expands ancestors for a selected path", () => {
    expect([...expandAncestorsForPath(new Set(), "src/ui/App.tsx")]).toEqual([
      "dir:src",
      "dir:src/ui",
    ]);
  });
});

describe("navigation helpers", () => {
  test("finds the row index for a path", () => {
    const tree = buildFileTree(repoFiles, changedByPath, { changesOnly: false });
    const rows = flattenTree(tree, new Set(["dir:src"]));
    expect(findRowIndexForPath(rows, "src/git.ts")).toBeGreaterThan(0);
  });

  test("finds the first file in a directory", () => {
    const tree = buildFileTree(repoFiles, changedByPath, { changesOnly: false });
    const src = tree.find((node) => node.type === "directory" && node.path === "src");

    expect(src === undefined ? undefined : firstFileInNode(src)?.path).toBe(
      "src/components/ui/Button.tsx",
    );
  });
});

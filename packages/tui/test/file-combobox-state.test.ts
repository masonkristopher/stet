import { afterEach, expect, test } from "bun:test";

import { batch } from "solid-js";

import type { GitModel } from "@/git/model";
import { state } from "@/state";

function modelWith(repoFiles: GitModel["repoFiles"], key: string): GitModel {
  return {
    branch: undefined,
    changed: [],
    changedByPath: new Map(),
    repoFiles,
    repoFilesKey: key,
    repoRoot: "/x",
    scopeKey: "all:HEAD",
  };
}

// State is a global singleton shared across test files; reset what these tests mutate
afterEach(() => {
  batch(() => {
    state.setFileComboboxOpen(false);
    state.setFileComboboxQuery("");
    state.setFileComboboxIndex(0);
    state.setGitModel(modelWith([], "k"));
  });
});

test("a content-only refresh tick never re-ranks the open picker", () => {
  const repoFiles = [
    { path: "src/a.ts", symlink: false, tracked: true },
    { path: "src/b.ts", symlink: false, tracked: true },
  ];
  state.setGitModel(modelWith(repoFiles, "k1"));
  state.openFileCombobox();
  const before = state.fileComboboxResults();
  expect(before).toEqual(["src/a.ts", "src/b.ts"]);

  // A content-only refresh commits a new model object that carries the same
  // RepoFiles reference (mergeChanged preserves it) and a fresh-but-equal
  // Changed map; the open picker's results must not even recompute.
  state.setGitModel(modelWith(repoFiles, "k1"));
  expect(state.fileComboboxResults()).toBe(before);
});

test("a genuine structural shift makes a new file rankable while open", () => {
  state.setGitModel(modelWith([{ path: "src/a.ts", symlink: false, tracked: true }], "k1"));
  state.openFileCombobox();
  expect(state.fileComboboxResults()).toEqual(["src/a.ts"]);

  state.setGitModel(
    modelWith(
      [
        { path: "src/a.ts", symlink: false, tracked: true },
        { path: "src/fresh.ts", symlink: false, tracked: true },
      ],
      "k2",
    ),
  );
  state.setFileComboboxQuery("fresh");
  expect(state.fileComboboxResults()).toEqual(["src/fresh.ts"]);
});

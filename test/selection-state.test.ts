import { afterEach, expect, test } from "bun:test";

import { batch } from "solid-js";

import type { GitModel } from "../src/git/model";
import { state } from "../src/state";

function modelWith(paths: string[]): GitModel {
  return {
    changed: [],
    changedByPath: new Map(),
    repoFiles: paths.map((path) => ({ path, tracked: true })),
    repoFilesKey: "k",
    repoRoot: "/x",
    scopeKey: "all:HEAD",
  };
}

function seed(paths: string[]) {
  batch(() => {
    state.setChangesOnly(false);
    state.setExpandedDirectories(new Set<string>());
    state.setGitModel(modelWith(paths));
    state.setFocusedNodeId(`file:${paths[0]}`);
    state.setSelectedPath(undefined);
  });
}

// State is a global singleton shared across test files; reset what seed() mutates
afterEach(() => {
  batch(() => {
    state.setGitModel(modelWith([]));
    state.setExpandedDirectories(new Set<string>());
    state.setFocusedNodeId("");
    state.setSelectedPath(undefined);
  });
});

test("focusedRowIndex derives from the focused node and moving selects the file", () => {
  seed(["a.ts", "b.ts", "c.ts"]);
  expect(state.focusedRowIndex()).toBe(0);

  state.moveFocus(1);
  expect(state.focusedRowIndex()).toBe(1);
  expect(state.selectedPath()).toBe("b.ts");
});

test("consecutive moves advance by each step, not collapse", () => {
  seed(["a.ts", "b.ts", "c.ts"]);

  state.moveFocus(1);
  state.moveFocus(1);

  expect(state.focusedRowIndex()).toBe(2);
  expect(state.selectedPath()).toBe("c.ts");
});

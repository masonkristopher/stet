import { expect, test } from "bun:test";

import { testRender } from "@opentui/solid";

import { App } from "@/App";
import type { GitModel } from "@/git/model";
import { state } from "@/state";

import { createFixtureRepo, loadModel, makeSettleUntil, seedState } from "./helpers";

const allScope = { kind: "all", ref: "HEAD" } as const;

// The viewer pane echoes file names and its own empty-state copy, so scope
// Assertions to the sidebar column (left of the pane border) like the other
// Sidebar render tests do.
const sidebarOf = (frame: string) =>
  frame
    .split("\n")
    .map((line) => line.split("││")[0])
    .join("\n");

// A clean repo under the changes-only filter has zero rows. The sidebar must
// Author that empty state rather than render a blank pane, and tell the user how
// To leave it.
test("shows the changes-only empty state when nothing changed", async () => {
  const repoRoot = createFixtureRepo("stet-empty-changes-", { "a.txt": "a\n" });
  const model = await loadModel(repoRoot, allScope);
  seedState(model, allScope);
  state.setChangesOnly(true);

  const { renderer, renderOnce, captureCharFrame } = await testRender(() => <App />, {
    height: 24,
    width: 100,
  });
  try {
    const settleUntil = makeSettleUntil({ captureCharFrame, renderOnce });
    const frame = await settleUntil("empty sidebar", (current) =>
      sidebarOf(current).includes("no changes"),
    );
    const sidebar = sidebarOf(frame);
    expect(sidebar).toContain("no changes");
    expect(sidebar).toContain("press c to show all");
  } finally {
    renderer.destroy();
  }
});

// An empty repository (no files at all) is the other path to zero rows; with the
// Filter off the headline names that distinct cause. The pre-load empty model now
// Reads as still-loading (empty key), so seed a loaded-and-empty model: a non-empty
// RepoFilesKey with zero files, repoRoot signal zeroed so the poll can't race it.
const loadedEmptyModel: GitModel = {
  changed: [],
  changedByPath: new Map(),
  repoFiles: [],
  repoFilesKey: "loaded",
  repoRoot: "/loaded-empty-repo",
  scopeKey: "all:HEAD:",
};

test("shows the empty-repo state when there are no files", async () => {
  seedState(loadedEmptyModel, allScope);
  state.setRepoRoot("");

  // Wide enough that the subtitle stays on one line in the sidebar column, so the
  // Assertion proves the sidebar's own copy rather than the viewer's identical
  // Empty-repo line (which sidebarOf strips out anyway).
  const { renderer, renderOnce, captureCharFrame } = await testRender(() => <App />, {
    height: 24,
    width: 120,
  });
  try {
    const settleUntil = makeSettleUntil({ captureCharFrame, renderOnce });
    const frame = await settleUntil("empty repo sidebar", (current) =>
      sidebarOf(current).includes("no files"),
    );
    const sidebar = sidebarOf(frame);
    expect(sidebar).toContain("no files");
    expect(sidebar).toContain("this repository has no files yet");
  } finally {
    renderer.destroy();
  }
});

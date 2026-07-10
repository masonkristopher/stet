import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { testRender } from "@opentui/solid";

import { App } from "@/App";
import type { GitModel } from "@/git/model";
import { state } from "@/state";

import { createFixtureRepo, loadModel, makeSettleUntil, seedState } from "./helpers";

const allScope = { kind: "all", ref: "HEAD" } as const;

// The viewer pane echoes its own copy, so scope assertions to the sidebar column
// (left of the pane border) like the other sidebar render tests do.
const sidebarOf = (frame: string) =>
  frame
    .split("\n")
    .map((line) => line.split("││")[0])
    .join("\n");

const emptyModel: GitModel = {
  branch: undefined,
  changed: [],
  changedByPath: new Map(),
  repoFiles: [],
  repoFilesKey: "",
  repoRoot: "",
  scopeKey: "",
};

// Freeze the deferred-load window: seed a model whose repoFiles have not filled
// The tree yet (empty key), then zero the repoRoot *signal* so the background
// RepoFiles poll (gated on that signal) never runs and overwrites it.
function seedLoading(model: GitModel) {
  seedState({ ...model, repoFiles: [], repoFilesKey: "" }, allScope);
  state.setRepoRoot("");
}

// The empty model paints first (repoRoot ""), before the git load resolves. The
// Sidebar must reserve blank space for that window, not flash the centered
// Empty-state text and then jump to top-aligned rows when the tree loads.
test("reserves blank space without flashing the empty state at first paint", async () => {
  seedState(emptyModel, allScope);

  const { renderer, renderOnce, captureCharFrame } = await testRender(() => <App />, {
    height: 24,
    width: 100,
  });
  try {
    const settleUntil = makeSettleUntil({ captureCharFrame, renderOnce });
    // Settle on always-present chrome, then assert the sidebar held no flash for a
    // Stretch of frames (well past the old 150ms gate).
    await settleUntil("shell", (current) => current.includes("q quit"));
    for (let attempt = 0; attempt < 20; attempt += 1) {
      // oxlint-disable-next-line no-await-in-loop -- frame-by-frame check that nothing flashes
      await new Promise((resolve) => setTimeout(resolve, 10));
      // oxlint-disable-next-line no-await-in-loop -- frame-by-frame check that nothing flashes
      await renderOnce();
      const sidebar = sidebarOf(captureCharFrame());
      expect(sidebar).not.toContain("no files");
      expect(sidebar).not.toContain("loading…");
    }
  } finally {
    renderer.destroy();
  }
});

// When the poll commits the tree, rows render top-aligned and no empty-state text
// Ever appeared along the way.
test("fills the tree from the top once repoFiles loads", async () => {
  const repoRoot = createFixtureRepo("stet-loading-fill-", {
    "src/app.ts": "export const x = 1\n",
  });
  const model = await loadModel(repoRoot, allScope);
  seedLoading(model);

  const { renderer, renderOnce, captureCharFrame } = await testRender(() => <App />, {
    height: 24,
    width: 100,
  });
  try {
    const settleUntil = makeSettleUntil({ captureCharFrame, renderOnce });
    seedState(model, allScope); // Mirrors the repoFiles poll committing the full tree
    const frame = await settleUntil("tree", (current) => sidebarOf(current).includes("app.ts"));
    const sidebar = sidebarOf(frame);
    expect(sidebar).toContain("app.ts");
    expect(sidebar).not.toContain("no files");
  } finally {
    renderer.destroy();
  }
});

// In the default (full-tree) view the deferred window must show nothing, not a
// Changed-only preview: stagedDeletionPaths would otherwise treat every changed
// Path as a deletion while repoFiles is empty, rendering the changed files and then
// Re-rendering the full tree around them — the "changed vs unchanged" jump.
test("shows no changed-only preview during a deferred load in the default view", async () => {
  const repoRoot = createFixtureRepo("stet-loading-default-", {
    "src/app.ts": "export const x = 1\n",
  });
  writeFileSync(join(repoRoot, "src/changed.ts"), "export const y = 2\n");
  const model = await loadModel(repoRoot, allScope);
  seedLoading(model); // Default view (seedState leaves changesOnly off)

  const { renderer, renderOnce, captureCharFrame } = await testRender(() => <App />, {
    height: 24,
    width: 100,
  });
  try {
    const settleUntil = makeSettleUntil({ captureCharFrame, renderOnce });
    // The changed file must not appear during the load; assert across frames.
    for (let attempt = 0; attempt < 12; attempt += 1) {
      // oxlint-disable-next-line no-await-in-loop -- frame-by-frame check that nothing previews
      await new Promise((resolve) => setTimeout(resolve, 10));
      // oxlint-disable-next-line no-await-in-loop -- frame-by-frame check that nothing previews
      await renderOnce();
      expect(sidebarOf(captureCharFrame())).not.toContain("changed.ts");
    }

    seedState(model, allScope); // RepoFiles fills: full tree (changed + unchanged)
    const frame = await settleUntil("full tree", (current) =>
      sidebarOf(current).includes("changed.ts"),
    );
    expect(sidebarOf(frame)).toContain("app.ts");
  } finally {
    renderer.destroy();
  }
});

// The loading window must not hide rows that already exist. In changes-only mode
// The tree is built from the changed set, so it has rows even while repoFiles is
// Still loading; those rows must render instead of a blank surface.
test("keeps changed-file rows visible during a deferred load in changes-only mode", async () => {
  const repoRoot = createFixtureRepo("stet-loading-changes-", {
    "src/app.ts": "export const x = 1\n",
  });
  writeFileSync(join(repoRoot, "src/new.ts"), "export const y = 2\n");
  const model = await loadModel(repoRoot, allScope);
  seedLoading(model);
  state.setChangesOnly(true);

  const { renderer, renderOnce, captureCharFrame } = await testRender(() => <App />, {
    height: 24,
    width: 100,
  });
  try {
    const settleUntil = makeSettleUntil({ captureCharFrame, renderOnce });
    const frame = await settleUntil("changed row", (current) =>
      sidebarOf(current).includes("new.ts"),
    );
    const sidebar = sidebarOf(frame);
    expect(sidebar).toContain("new.ts");
    expect(sidebar).not.toContain("no files");
  } finally {
    renderer.destroy();
  }
});

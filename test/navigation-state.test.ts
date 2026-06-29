import { afterEach, expect, test } from "bun:test";

import { batch } from "solid-js";

import type { GitModel } from "@/git/model";
import { state } from "@/state";
import { recall } from "@/viewer/navigation";

function modelWith(paths: string[]): GitModel {
  return {
    changed: [],
    changedByPath: new Map(),
    repoFiles: paths.map((path) => ({ path, symlink: false, tracked: true })),
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
    state.seedNav(undefined);
  });
}

afterEach(() => {
  batch(() => {
    state.setGitModel(modelWith([]));
    state.setExpandedDirectories(new Set<string>());
    state.setFocusedNodeId("");
    state.seedNav(undefined);
  });
});

test("selectFile builds history that goBack and goForward walk", () => {
  seed(["a.ts", "b.ts", "c.ts"]);
  state.selectFile("a.ts");
  state.selectFile("b.ts");
  state.selectFile("c.ts");
  expect(state.selectedPath()).toBe("c.ts");
  expect(state.canGoBack()).toBe(true);
  expect(state.canGoForward()).toBe(false);

  state.goBack();
  expect(state.selectedPath()).toBe("b.ts");
  expect(state.canGoForward()).toBe(true);

  state.goBack();
  expect(state.selectedPath()).toBe("a.ts");
  expect(state.canGoBack()).toBe(false);

  state.goForward();
  expect(state.selectedPath()).toBe("b.ts");
});

test("leaving a file whose restore is still pending records the intended position, not stale live scroll", () => {
  seed(["a.ts", "b.ts", "c.ts"]);
  state.selectFile("b.ts");
  // The Viewer restore effect never runs under the bare state singleton, so b's
  // PendingRestore stays outstanding and the live scroll still holds the previous
  // File's value; capture must use the pending viewport, not this stray 99.
  state.setViewerScrollTop(99);

  state.selectFile("c.ts");

  expect(recall(state.navState(), "b.ts")?.viewport.scrollTop).toBe(0);
});

test("opening a file after going back truncates the forward history", () => {
  seed(["a.ts", "b.ts", "c.ts", "d.ts"]);
  state.selectFile("a.ts");
  state.selectFile("b.ts");
  state.selectFile("c.ts");

  state.goBack();
  expect(state.selectedPath()).toBe("b.ts");

  state.selectFile("d.ts");
  expect(state.selectedPath()).toBe("d.ts");
  expect(state.canGoForward()).toBe(false);
  state.goBack();
  expect(state.selectedPath()).toBe("b.ts");
});

test("consecutive tree browsing collapses to one history entry", () => {
  seed(["a.ts", "b.ts", "c.ts"]);
  state.selectFile("a.ts");
  state.moveFocus(1);
  state.moveFocus(1);
  expect(state.selectedPath()).toBe("c.ts");

  state.goBack();
  expect(state.selectedPath()).toBe("a.ts");
  expect(state.canGoBack()).toBe(false);
});

test("goBack enqueues a pendingRestore for the target path", () => {
  seed(["a.ts", "b.ts"]);
  state.selectFile("a.ts");
  state.selectFile("b.ts");
  expect(state.pendingRestore()?.path).toBe("b.ts");

  state.goBack();
  expect(state.pendingRestore()?.path).toBe("a.ts");
});

test("goBack and goForward are no-ops at the ends of history", () => {
  seed(["a.ts", "b.ts"]);
  state.selectFile("a.ts");
  state.goBack();
  expect(state.selectedPath()).toBe("a.ts");
  state.goForward();
  expect(state.selectedPath()).toBe("a.ts");
});

test("browsing replaces the preview tab instead of accumulating tabs", () => {
  seed(["a.ts", "b.ts", "c.ts"]);
  state.selectFile("a.ts");
  state.selectFile("b.ts");
  state.selectFile("c.ts");
  expect(state.tabItems().length).toBe(1);
  expect(state.tabItems()[0].preview).toBe(true);
  expect(state.selectedPath()).toBe("c.ts");
});

test("togglePinActiveTab pins, then the next navigation opens a fresh preview", () => {
  seed(["a.ts", "b.ts"]);
  state.selectFile("a.ts");
  state.togglePinActiveTab();
  expect(state.tabItems().length).toBe(1);
  expect(state.tabItems()[0].preview).toBe(false);

  state.selectFile("b.ts"); // Opens a new preview tab, leaving a.ts pinned
  expect(state.tabItems().length).toBe(2);
  expect(state.selectedPath()).toBe("b.ts");
  expect(state.tabItems().filter((tab) => tab.preview)).toHaveLength(1);
});

test("togglePinActiveTab unpins a pinned tab back to the calm preview", () => {
  seed(["a.ts"]);
  state.selectFile("a.ts");
  state.togglePinActiveTab(); // Pin
  expect(state.tabItems()[0].preview).toBe(false);

  state.togglePinActiveTab(); // Unpin -> back to a single preview, no file change
  expect(state.tabItems().length).toBe(1);
  expect(state.tabItems()[0].preview).toBe(true);
  expect(state.selectedPath()).toBe("a.ts");
});

test("navigating to a pinned file focuses its tab, never duplicating", () => {
  seed(["a.ts", "b.ts"]);
  state.selectFile("a.ts");
  state.togglePinActiveTab(); // Pin a.ts
  state.selectFile("b.ts"); // Preview b.ts, two tabs
  expect(state.tabItems().length).toBe(2);

  state.selectFile("a.ts"); // Already pinned -> focus it, no new tab
  expect(state.tabItems().length).toBe(2);
  expect(state.selectedPath()).toBe("a.ts");
  expect(state.tabItems().find((tab) => tab.active)?.preview).toBe(false);
});

test("each tab keeps its own history; back/forward stay within the active tab", () => {
  seed(["a.ts", "b.ts", "c.ts"]);
  state.selectFile("a.ts");
  state.selectFile("b.ts"); // Preview history: a -> b
  state.togglePinActiveTab(); // Pin b
  state.selectFile("c.ts"); // Fresh preview on c

  state.activateTab(state.tabItems().find((tab) => !tab.preview)?.id ?? "");
  expect(state.selectedPath()).toBe("b.ts");
  state.goBack(); // Within the pinned tab's own history
  expect(state.selectedPath()).toBe("a.ts");

  state.activateTab(state.tabItems().find((tab) => tab.preview)?.id ?? "");
  expect(state.selectedPath()).toBe("c.ts");
});

test("closeActiveTab returns to a neighbor; closing the sole tab reverts to preview", () => {
  seed(["a.ts", "b.ts"]);
  state.selectFile("a.ts");
  state.togglePinActiveTab();
  state.selectFile("b.ts"); // Tab 1 preview on b, tab 0 pinned a
  expect(state.tabItems().length).toBe(2);

  state.closeActiveTab(); // Closes the preview (b) -> neighbor pinned a
  expect(state.tabItems().length).toBe(1);
  expect(state.tabItems()[0].preview).toBe(false);
  expect(state.selectedPath()).toBe("a.ts");

  state.closeActiveTab(); // Sole tab -> reverts to preview (exits tab mode)
  expect(state.tabItems().length).toBe(1);
  expect(state.tabItems()[0].preview).toBe(true);
  expect(state.selectedPath()).toBe("a.ts");
});

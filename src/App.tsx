import { existsSync } from "node:fs";

import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/solid";
import { createEffect, Show } from "solid-js";

import { HeaderBar } from "./components/HeaderBar";
import { HelpOverlay } from "./components/HelpOverlay";
import { Palette } from "./components/Palette";
import { ProblemsPanel } from "./components/ProblemsPanel";
import { SearchPanel } from "./components/SearchPanel";
import { Sidebar } from "./components/Sidebar";
import { StatusBar } from "./components/StatusBar";
import { Viewer } from "./components/Viewer";
import { WorktreePicker } from "./components/WorktreePicker";
import { emptyActivityLog } from "./git/activity";
import type { Worktree } from "./git/model";
import { defaultExpandedDirectories, expandAncestorsForPath } from "./git/tree";
import { createKeyHandler } from "./keymap";
import { state } from "./state";
import { useTheme } from "./theme/context";
import { worktreeLabel } from "./ui-helpers";

export function App() {
  const theme = useTheme();
  const renderer = useRenderer();
  const dimensions = useTerminalDimensions();

  createEffect(() => {
    state.setTerminalWidth(dimensions().width);
    state.setTerminalHeight(dimensions().height);
  });

  function quit() {
    // The renderer no longer owns the background fibers (the git poll runs on the
    // Shared runtime, not the render tree), so tear down the screen and exit
    // Rather than waiting for an event loop that the poll keeps alive.
    renderer.destroy();
    process.exit(0);
  }

  async function switchWorktree(worktree: Worktree) {
    state.setWorktreeOpen(false);
    if (worktree.path === state.gitModel().repoRoot) {
      return;
    }
    if (!existsSync(worktree.path)) {
      state.setStatus(`worktree missing: ${worktree.path}`);
      return;
    }

    try {
      const fresh = await state.loadModel({ repoRoot: worktree.path, scope: state.scope() });
      const selected = fresh.changed[0]?.path ?? fresh.repoFiles[0]?.path;
      state.setLastChange(Date.now());
      state.setRepoRoot(fresh.repoRoot);
      state.setGitModel(fresh);
      state.setSelectedPath(selected);
      state.setFocusedNodeId(selected === undefined ? "" : `file:${selected}`);
      const expanded = defaultExpandedDirectories(fresh.changed.map((file) => file.path));
      const nextExpanded =
        selected === undefined ? expanded : expandAncestorsForPath(expanded, selected);
      state.setExpandedDirectories(nextExpanded);
      state.setFullContentPaths(new Set<string>());
      state.setFileView(false);
      state.setJumpTarget(undefined);
      state.setProblemIndex(0);
      state.setActivityLog(emptyActivityLog);
      state.setFocusedPane("tree");
      state.setStatus(`worktree: ${worktreeLabel(worktree)}`);
      void state.runChecks(fresh);
    } catch (error) {
      state.setStatus(
        error instanceof Error ? (error.message.split("\n")[0] ?? "") : String(error),
      );
    }
  }

  useKeyboard(createKeyHandler({ quit, switchWorktree }));

  return (
    <box
      width="100%"
      height="100%"
      flexDirection="column"
      backgroundColor={theme.colors.surface.base}
    >
      <HeaderBar />
      <box flexGrow={1} flexDirection="row">
        <Show when={state.sidebarOpen()}>
          <Sidebar />
        </Show>
        <Viewer />
      </box>
      <Show when={state.problemsOpen()}>
        <ProblemsPanel />
      </Show>
      <StatusBar />
      <Show when={state.paletteOpen()}>
        <Palette />
      </Show>
      <Show when={state.searchOpen()}>
        <SearchPanel />
      </Show>
      <Show when={state.worktreeOpen()}>
        <WorktreePicker />
      </Show>
      <Show when={state.helpOpen()}>
        <HelpOverlay />
      </Show>
    </box>
  );
}

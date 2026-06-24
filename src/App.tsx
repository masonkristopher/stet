import { existsSync } from "node:fs";
import { basename } from "node:path";

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

  createEffect(() => {
    const dir = basename(state.gitModel().repoRoot);
    if (dir === "") {
      renderer.setTerminalTitle("sideye");
      return;
    }
    const repo = basename(state.mainWorktreePath()) || dir;
    const segments = dir === repo ? [repo] : [dir, repo];
    renderer.setTerminalTitle([...segments, "sideye"].join(" · "));
  });

  function quit(message?: string) {
    // The renderer no longer owns the background fibers (the git poll runs on the
    // Shared runtime, not the render tree), so tear down the screen and exit
    // Rather than waiting for an event loop that the poll keeps alive.
    renderer.setTerminalTitle("");
    renderer.destroy();
    // Log after destroy so the message lands on the restored screen, not the alt buffer.
    if (message !== undefined) {
      console.log(message);
    }
    process.exit(0);
  }

  async function switchWorktree(worktree: Worktree, reason?: string) {
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
      state.setCurrentWorktreeDeleted(false);
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
      state.setStatus(reason ?? `worktree: ${worktreeLabel(worktree)}`);
      void state.runChecks(fresh);
    } catch (error) {
      state.setStatus(
        error instanceof Error ? (error.message.split("\n")[0] ?? "") : String(error),
      );
    }
  }

  // The heartbeat flags a deleted current worktree; recover by switching to the
  // Main worktree (the parent repo), or exit cleanly when it too is gone.
  createEffect(() => {
    if (!state.currentWorktreeDeleted()) {
      return;
    }
    const main = state.mainWorktreePath();
    const root = state.gitModel().repoRoot;
    // The flag can outlive its cause (a fresh model was seeded, or we already
    // Switched away). Act only while something is genuinely gone.
    if (existsSync(root) && (main === "" || existsSync(main))) {
      state.setCurrentWorktreeDeleted(false);
      return;
    }
    // The main worktree survives and isn't where we already are: switch to it.
    if (main !== "" && main !== root && existsSync(main)) {
      const cached = state.worktrees()?.find((worktree) => worktree.path === main);
      const label = cached === undefined ? (main.split("/").pop() ?? main) : worktreeLabel(cached);
      const target: Worktree = cached ?? {
        bare: false,
        detached: false,
        head: "",
        locked: false,
        path: main,
        prunable: false,
      };
      void switchWorktree(target, `worktree deleted, switched to ${label}`);
      return;
    }
    // Nothing recoverable: the repository itself is gone.
    quit("sideye: worktree deleted, nothing left to inspect");
  });

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

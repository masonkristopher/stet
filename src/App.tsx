import { existsSync } from "node:fs";
import { basename, join } from "node:path";

import type { ThemeMode } from "@opentui/core";
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/solid";
import { createEffect, onCleanup, Show } from "solid-js";

import { HeaderBar } from "./components/HeaderBar";
import { HelpOverlay } from "./components/HelpOverlay";
import { Palette } from "./components/Palette";
import { ProblemsPanel } from "./components/ProblemsPanel";
import { ScopePicker } from "./components/ScopePicker";
import { SearchPanel } from "./components/SearchPanel";
import { Sidebar } from "./components/Sidebar";
import { StatusBar } from "./components/StatusBar";
import { Viewer } from "./components/Viewer";
import { WorktreePicker } from "./components/WorktreePicker";
import type { Worktree } from "./git/model";
import { buildEditorCommand } from "./cli";
import { createKeyHandler } from "./keymap";
import { state } from "./state";
import { setAppearance } from "./theme/active";
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

  // Follow the terminal's appearance at runtime: when the OS flips dark/light
  // Mid-session, the renderer emits theme_mode and the reactive theme state
  // Re-themes the UI and re-renders the diff with the new palette.
  const onThemeMode = (mode: ThemeMode | null) => {
    if (mode !== null) {
      setAppearance(mode);
    }
  };
  renderer.on("theme_mode", onThemeMode);
  onCleanup(() => renderer.off("theme_mode", onThemeMode));

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
      void state.switchWorktree(target, `worktree deleted, switched to ${label}`);
      return;
    }
    // Nothing recoverable: the repository itself is gone.
    quit("sideye: worktree deleted, nothing left to inspect");
  });

  async function openInEditor(filePath: string, line: number | undefined, mode: "terminal" | "ide") {
    const template = mode === "ide" ? state.ideTemplate() : state.editorTemplate();
    if (template === undefined) {
      return;
    }
    const absolutePath = join(state.gitModel().repoRoot, filePath);
    const argv = buildEditorCommand(template, absolutePath, line);
    if (argv.length === 0) {
      return;
    }
    if (mode === "terminal") {
      renderer.suspend();
      try {
        const proc = Bun.spawn(argv, {
          cwd: state.gitModel().repoRoot,
          stderr: "inherit",
          stdin: "inherit",
          stdout: "inherit",
        });
        await proc.exited;
      } finally {
        renderer.resume();
      }
    } else {
      Bun.spawn(argv, {
        cwd: state.gitModel().repoRoot,
        stderr: "inherit",
        stdin: "inherit",
        stdout: "inherit",
      });
    }
  }

  useKeyboard(createKeyHandler({ quit, openInEditor }));

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
      <Show when={state.scopeOpen()}>
        <ScopePicker />
      </Show>
      <Show when={state.helpOpen()}>
        <HelpOverlay />
      </Show>
    </box>
  );
}

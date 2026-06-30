import { existsSync } from "node:fs";
import { basename, join } from "node:path";

import type { ThemeMode } from "@opentui/core";
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/solid";
import { Effect } from "effect";
import { createEffect, onCleanup, Show } from "solid-js";

import { FileCombobox } from "./components/FileCombobox";
import { HeaderBar } from "./components/HeaderBar";
import { HelpDialog } from "./components/HelpDialog";
import { ProblemsPanel } from "./components/ProblemsPanel";
import { ScopeMenu } from "./components/ScopeMenu";
import { SearchCombobox } from "./components/SearchCombobox";
import { Sidebar } from "./components/Sidebar";
import { StatusBar } from "./components/StatusBar";
import { ThemeCombobox } from "./components/ThemeCombobox";
import { Viewer } from "./components/Viewer";
import { WorktreeCombobox } from "./components/WorktreeCombobox";
import { buildEditorCommand } from "./editor/reference";
import { Editor } from "./editor/service";
import type { Worktree } from "./git/model";
import { createKeyHandler } from "./keymap";
import type { LogLevel } from "./log/levels";
import { log } from "./log/terminal";
import { runtime } from "./runtime";
import { state } from "./state";
import { setAppearance } from "./theme/active";
import { useTheme } from "./theme/context";
import { worktreeLabel } from "./ui-helpers";
import { formatUpdateNotice } from "./upgrade/release";

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

  // A read-only TUI should not show a stray terminal cursor outside its inputs.
  // The renderer shows one by default, so hide it whenever no input overlay is
  // Open (each input shows its own caret while focused); `autoFocus: false` on the
  // Renderer keeps a click from re-showing it by focusing the clicked renderable.
  createEffect(() => {
    const inputFocused =
      state.fileComboboxOpen() ||
      state.searchComboboxOpen() ||
      state.themeComboboxOpen() ||
      state.worktreeComboboxOpen() ||
      state.findOpen();
    if (!inputFocused) {
      renderer.setCursorPosition(0, 0, false);
    }
  });

  function quit(message?: { text: string; level: LogLevel }) {
    // The renderer no longer owns the background fibers (the git poll runs on the
    // Shared runtime, not the render tree), so tear down the screen and exit
    // Rather than waiting for an event loop that the poll keeps alive.
    renderer.setTerminalTitle("");
    renderer.destroy();
    // Log after destroy so the message lands on the restored screen, not the alt
    // Buffer, at its own severity rather than a hardcoded one.
    if (message !== undefined) {
      log(message.level, message.text);
    }
    process.exit(0);
  }

  // The user-initiated quit (keyboard) surfaces a pending update on the way out, gh-style. The
  // Worktree-recovery exit reports its degraded shutdown through the same path; the crash/signal
  // Backstops in main.tsx never route here.
  function quitWithUpdateNotice() {
    const update = state.availableUpdate();
    quit(update === undefined ? undefined : { level: "info", text: formatUpdateNotice(update) });
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
    // Nothing recoverable: the repository itself is gone. A clean exit (code 0) of a
    // Degraded condition reads as a warning, not a crash.
    quit({ level: "warning", text: "sideye: worktree deleted, nothing left to inspect" });
  });

  async function openInEditor(
    filePath: string,
    line: number | undefined,
    mode: "terminal" | "ide",
  ) {
    const template = mode === "ide" ? state.ideTemplate() : state.editorTemplate();
    if (template === undefined) {
      state.notify("no IDE configured — set 'ide' in config or use --ide");
      return;
    }
    const absolutePath = join(state.gitModel().repoRoot, filePath);
    const argv = buildEditorCommand(template, absolutePath, line);
    if (argv.length === 0) {
      return;
    }
    const cwd = state.gitModel().repoRoot;
    if (mode === "terminal") {
      renderer.suspend();
      try {
        await runtime.runPromise(Editor.use((editor) => editor.openTerminal(argv, cwd)));
      } catch (error) {
        state.notify(error instanceof Error ? error.message : "failed to open editor");
      } finally {
        renderer.resume();
      }
    } else {
      runtime.runFork(
        Editor.use((editor) => editor.openIde(argv, cwd)).pipe(
          Effect.tap((code) =>
            code !== 0
              ? Effect.sync(() => state.notify(`IDE exited with code ${String(code)}`))
              : Effect.void,
          ),
          Effect.catch((error) => Effect.sync(() => state.notify(error.message))),
        ),
      );
    }
  }

  useKeyboard(createKeyHandler({ openInEditor, quit: quitWithUpdateNotice }));

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
      <Show when={state.fileComboboxOpen()}>
        <FileCombobox />
      </Show>
      <Show when={state.searchComboboxOpen()}>
        <SearchCombobox />
      </Show>
      <Show when={state.worktreeComboboxOpen()}>
        <WorktreeCombobox />
      </Show>
      <Show when={state.scopeMenuOpen()}>
        <ScopeMenu />
      </Show>
      <Show when={state.themeComboboxOpen()}>
        <ThemeCombobox />
      </Show>
      <Show when={state.helpDialogOpen()}>
        <HelpDialog />
      </Show>
    </box>
  );
}

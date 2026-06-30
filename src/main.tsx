#!/usr/bin/env bun

import { createCliRenderer } from "@opentui/core";
import { render } from "@opentui/solid";
import { Effect, ManagedRuntime } from "effect";
import { batch } from "solid-js";

import packageJson from "../package.json";
import { App } from "./App";
import { helpText, parseCommand } from "./cli";
import { Config, ConfigLive } from "./config/service";
import { initialCheckerState } from "./diagnostics/checker";
import { resolveEditorTemplate, resolveIdeTemplate } from "./editor/reference";
import type { GitModel } from "./git/model";
import { Git } from "./git/service";
import { defaultExpandedDirectories, expandAncestorsForPath } from "./git/tree";
import { logError } from "./log/terminal";
import { Process } from "./process";
import { runtime } from "./runtime";
import { state } from "./state";
import { setAppearance, setSelection } from "./theme/active";
import { hasTheme, registerThemes, resolveThemes, selectThemeName } from "./theme/registry";
import { runUpgrade } from "./upgrade/run";

try {
  const command = parseCommand(Bun.argv.slice(2));

  if (command.kind === "upgrade") {
    process.exit(
      await runUpgrade({ currentVersion: packageJson.version, execPath: process.execPath }),
    );
  }

  const options = command.options;

  if (options.help) {
    console.log(helpText());
    process.exit(0);
  }

  if (options.version) {
    console.log(packageJson.version);
    process.exit(0);
  }

  // The provisioner reads this env var; set it before any check runs the runtime.
  if (!options.lspDownload) {
    process.env.SIDEYE_NO_LSP_DOWNLOAD = "1";
  }

  // The startup model carries only the changed set (repoFiles fill in on the
  // Slow poll once mounted), the same shape the running app uses.
  const startup = Effect.gen(function* startupModel() {
    const subprocess = yield* Process;
    const git = yield* Git;
    // One rev-parse yields both the repo root and the common dir. The common dir
    // Is <main>/.git for any worktree, so stripping /.git gives the main worktree
    // — the recovery target if this worktree is later deleted. It lives outside a
    // Linked worktree's tree, so it survives that deletion.
    const lines = (yield* subprocess.run(
      ["git", "rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"],
      process.cwd(),
    )).stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "");
    const repoRoot = lines[0] ?? "";
    const commonDir = lines[1] ?? "";
    const suffix = "/.git";
    const mainWorktreePath = commonDir.endsWith(suffix)
      ? commonDir.slice(0, -suffix.length)
      : repoRoot;
    const changed = yield* git.changedFiles(repoRoot, options.scope);
    // The SHA HEAD points at now, pinned as the base for the `session` scope so
    // It keeps meaning "since sideye launched" as the agent commits.
    const sessionBase = yield* git.headRef(repoRoot);
    return { changed, mainWorktreePath, repoRoot, sessionBase };
  });

  // Load the config on its own runtime, before the app runtime's first use warms
  // The diff highlighter: the active theme must be set before that warm-up reads
  // It. ConfigLive has no dependencies, so this builds nothing heavy.
  const configRuntime = ManagedRuntime.make(ConfigLive);
  const { config, issues: configIssues } = await configRuntime.runPromise(
    Config.pipe(Effect.flatMap((service) => service.load())),
  );
  await configRuntime.dispose();

  // Register the configured themes and seed the theme selection *before* the
  // Renderer enters the alt-screen, so a config-validation throw still lands on
  // The normal terminal rather than a torn-down one. These need neither the
  // Renderer nor the detected appearance; appearance is applied just below.
  const { themes, issues: themeIssues } = resolveThemes(config.themes ?? {});
  registerThemes(themes);
  setSelection(config.theme);

  // Create the renderer up front and detect the terminal's dark/light appearance
  // Before the first runtime use (which warms the diff highlighter), so the whole
  // App themes to match. Detection is a bounded terminal query; a terminal that
  // Does not answer within the timeout falls back to dark. The same renderer is
  // Reused for the first paint below, so detection costs no extra frame.
  // Disable OpenTUI's focus-the-element-under-the-pointer on mouse-down
  // (`autoFocus`), which would otherwise draw the terminal cursor in a clicked
  // Renderable (e.g. a tab). sideye drives focus through its own keymap, and
  // Overlay inputs focus via their explicit `focused` prop, so nothing relies on it.
  const renderer = await createCliRenderer({ autoFocus: false, exitOnCtrlC: false });
  const appearance = (await renderer.waitForThemeMode(100)) ?? "dark";

  // Restore the terminal on every exit path, not just a clean quit. In raw mode a
  // Keyboard ctrl-c is a keypress the keymap owns, so these process signals fire
  // Only on an external kill or a crash — exactly the paths that otherwise leave
  // The alt-screen buffer active and the next launch blank. destroy() is
  // Idempotent, so racing the keymap's own quit is harmless.
  const restoreTerminal = () => {
    renderer.setTerminalTitle("");
    renderer.destroy();
  };
  const crash = (error: unknown) => {
    restoreTerminal();
    logError(error instanceof Error ? error.message : String(error));
    process.exit(1);
  };
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, () => {
      restoreTerminal();
      process.exit(0);
    });
  }
  process.on("uncaughtException", crash);
  process.on("unhandledRejection", crash);

  // Apply the detected appearance and validate the active theme name. Both need
  // The renderer's appearance and are non-throwing, so running them after the
  // Alt-screen is entered leaves no window for a blank-on-error. Selection +
  // Appearance together feed the active theme before the first runtime use warms
  // The highlighter; the renderer's theme_mode event updates appearance live.
  setAppearance(appearance);
  const activeName = selectThemeName(config.theme, appearance);
  if (!hasTheme(activeName)) {
    themeIssues.push(`theme "${activeName}" not found; using the ${appearance} default`);
  }

  // The CLI-derived state needs no git, so seed it before the first paint.
  batch(() => {
    state.setScope(options.scope);
    state.setCliBaseRef(options.scope.ref);
    state.setIconsEnabled(options.icons);
    state.setOverflow(options.overflow);
    state.setEditorTemplate(resolveEditorTemplate(options.editor ?? config.editor));
    state.setIdeTemplate(resolveIdeTemplate(options.ide ?? config.ide));
  });

  // Paint the shell immediately from the empty model — every effect guards on the
  // Empty root / undefined selection — so a large repo shows the UI at once
  // Instead of a blank alt-screen for the whole git load. The model loads in the
  // Background and seeds when it resolves, the same instant-then-fill shape a
  // Worktree switch already uses. A load failure (not a repo) restores the
  // Terminal before exiting, since the alt-screen is now already entered.
  void render(() => <App />, renderer);

  // Check for a newer release in the background, independent of the git load, so it neither gates
  // Nor is gated by it. A hit surfaces on the way out via the quit notice.
  void state.checkForUpdate(packageJson.version);

  runtime
    .runPromise(startup)
    .then(({ changed, mainWorktreePath, repoRoot, sessionBase }) => {
      const model: GitModel = { repoRoot, ...changed, repoFiles: [], repoFilesKey: "" };
      const initialSelectedPath = model.changed[0]?.path ?? model.repoFiles[0]?.path;
      const baseExpanded = defaultExpandedDirectories(model.changed.map((file) => file.path));
      const initialExpanded =
        initialSelectedPath === undefined
          ? baseExpanded
          : expandAncestorsForPath(baseExpanded, initialSelectedPath);

      batch(() => {
        state.setSessionBase(sessionBase);
        state.setGitModel(model);
        state.setRepoRoot(model.repoRoot);
        state.setMainWorktreePath(mainWorktreePath);
        state.setLastChange(Date.now());
        state.seedNav(initialSelectedPath);
        state.setFocusedNodeId(
          initialSelectedPath === undefined ? "" : `file:${initialSelectedPath}`,
        );
        state.setExpandedDirectories(initialExpanded);
        state.setCheckerState(initialCheckerState(model.changed));
      });
      void state.runChecks(model);

      // A bad config never blocks startup; the first issue surfaces as a notice.
      const issues = [...configIssues, ...themeIssues];
      if (issues.length > 0) {
        state.notify(issues[0] ?? "config has issues");
      }
    })
    .catch(crash);
} catch (error) {
  logError(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

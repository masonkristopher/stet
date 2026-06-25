#!/usr/bin/env bun

import { createCliRenderer } from "@opentui/core";
import { render } from "@opentui/solid";
import { Effect, ManagedRuntime } from "effect";
import { batch } from "solid-js";

import packageJson from "../package.json";
import { App } from "./App";
import { helpText, parseArgs, resolveEditorTemplate, resolveIdeTemplate } from "./cli";
import { Config, ConfigLive } from "./config/service";
import { initialCheckerState } from "./diagnostics/checker";
import type { GitModel } from "./git/model";
import { Git } from "./git/service";
import { defaultExpandedDirectories, expandAncestorsForPath } from "./git/tree";
import { Process } from "./process";
import { runtime } from "./runtime";
import { state } from "./state";
import { setAppearance, setSelection } from "./theme/active";
import { hasTheme, registerThemes, resolveThemes, selectThemeName } from "./theme/registry";

try {
  const options = parseArgs(Bun.argv.slice(2));

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
    Effect.gen(function* loadConfig() {
      return yield* (yield* Config).load();
    }),
  );
  await configRuntime.dispose();

  // Create the renderer up front and detect the terminal's dark/light appearance
  // Before the first runtime use (which warms the diff highlighter), so the whole
  // App themes to match. Detection is a bounded terminal query; a terminal that
  // Does not answer within the timeout falls back to dark. The same renderer is
  // Reused for the first paint below, so detection costs no extra frame.
  const renderer = await createCliRenderer({ exitOnCtrlC: false });
  const appearance = (await renderer.waitForThemeMode(100)) ?? "dark";

  // Register the configured themes and seed the reactive theme state before the
  // App runtime warms the highlighter. Selection + appearance feed the active
  // Theme; a selection naming an unknown theme falls back to the built-in and is
  // Reported. The renderer's theme_mode event updates appearance live (App.tsx).
  const { themes, issues: themeIssues } = resolveThemes(config.themes ?? {});
  registerThemes(themes);
  setSelection(config.theme);
  setAppearance(appearance);
  const activeName = selectThemeName(config.theme, appearance);
  if (!hasTheme(activeName)) {
    themeIssues.push(`theme "${activeName}" not found; using the ${appearance} default`);
  }

  const { changed, mainWorktreePath, repoRoot, sessionBase } = await runtime.runPromise(startup);

  // oxlint-disable-next-line no-magic-numbers -- one-time startup model assembly
  const model: GitModel = { repoRoot, ...changed, repoFiles: [], repoFilesKey: "" };
  const initialSelectedPath = model.changed[0]?.path ?? model.repoFiles[0]?.path;
  const baseExpanded = defaultExpandedDirectories(model.changed.map((file) => file.path));
  const initialExpanded =
    initialSelectedPath === undefined
      ? baseExpanded
      : expandAncestorsForPath(baseExpanded, initialSelectedPath);

  batch(() => {
    state.setScope(options.scope);
    state.setCliBaseRef(options.scope.ref);
    state.setSessionBase(sessionBase);
    state.setIconsEnabled(options.icons);
    state.setOverflow(options.overflow);
    state.setEditorTemplate(resolveEditorTemplate(options.editor));
    state.setIdeTemplate(resolveIdeTemplate(options.ide));
    state.setGitModel(model);
    state.setRepoRoot(model.repoRoot);
    state.setMainWorktreePath(mainWorktreePath);
    state.setLastChange(Date.now());
    state.setSelectedPath(initialSelectedPath);
    state.setFocusedNodeId(initialSelectedPath === undefined ? "" : `file:${initialSelectedPath}`);
    state.setExpandedDirectories(initialExpanded);
    state.setCheckerState(initialCheckerState(model.changed));
  });
  void state.runChecks(model);

  // A bad config never blocks startup; the first issue surfaces as a notice.
  const issues = [...configIssues, ...themeIssues];
  if (issues.length > 0) {
    state.notify(issues[0] ?? "config has issues");
  }

  // OpenTUI's exitOnCtrlC only calls renderer.destroy(), never process.exit, so
  // The background git poll keeps the event loop alive and the process lags
  // Before exiting. Route ctrl-c through our own quit() (in the keymap) instead.
  void render(() => <App />, renderer);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

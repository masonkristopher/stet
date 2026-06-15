#!/usr/bin/env bun

import { render } from "@opentui/solid";
import { Effect } from "effect";
import { batch } from "solid-js";

import packageJson from "../package.json";
import { App } from "./App";
import { helpText, parseArgs } from "./cli";
import { initialCheckerState } from "./diagnostics/checker";
import type { GitModel } from "./git/model";
import { Git } from "./git/service";
import { defaultExpandedDirectories, expandAncestorsForPath } from "./git/tree";
import { Process } from "./process";
import { runtime } from "./runtime";
import { state } from "./state";
import { createSyntaxConfig } from "./syntax/highlight";
import { darkTheme } from "./theme/dark";
import { resolveTheme } from "./theme/resolve";

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

  const theme = resolveTheme(darkTheme);

  // The startup model carries only the changed set (repoFiles fill in on the
  // Slow poll once mounted), the same shape the running app uses.
  const startup = Effect.gen(function* startupModel() {
    const subprocess = yield* Process;
    const git = yield* Git;
    const repoRoot = (yield* subprocess.run(
      ["git", "rev-parse", "--show-toplevel"],
      process.cwd(),
    )).stdout.trim();
    const changed = yield* git.changedFiles(repoRoot, options.scope);
    return { changed, repoRoot };
  });

  const [{ changed, repoRoot }, syntax] = await Promise.all([
    runtime.runPromise(startup),
    createSyntaxConfig(theme.colors.syntax),
  ]);

  // oxlint-disable-next-line no-magic-numbers -- one-time startup model assembly
  const model: GitModel = { repoRoot, ...changed, repoFiles: [], repoFilesKey: "" };
  const initialSelectedPath = model.changed[0]?.path ?? model.repoFiles[0]?.path;
  const baseExpanded = defaultExpandedDirectories(model.changed.map((file) => file.path));
  const initialExpanded =
    initialSelectedPath === undefined
      ? baseExpanded
      : expandAncestorsForPath(baseExpanded, initialSelectedPath);

  batch(() => {
    state.setSyntax(syntax);
    state.setStatus(syntax.status);
    state.setScope(options.scope);
    state.setIconsEnabled(options.icons);
    state.setGitModel(model);
    state.setRepoRoot(model.repoRoot);
    state.setLastChange(Date.now());
    state.setSelectedPath(initialSelectedPath);
    state.setFocusedNodeId(initialSelectedPath === undefined ? "" : `file:${initialSelectedPath}`);
    state.setExpandedDirectories(initialExpanded);
    state.setCheckerState(initialCheckerState(model.changed));
  });
  void state.runChecks(model);

  void render(() => <App />, { exitOnCtrlC: true });
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

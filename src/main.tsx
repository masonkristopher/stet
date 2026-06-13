#!/usr/bin/env bun

import { RegistryProvider } from "@effect/atom-react"
import { createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"
import { Effect, Layer } from "effect"
import packageJson from "../package.json"
import { App } from "./App"
import { helpText, parseArgs } from "./cli"
import type { GitModel } from "./git"
import { Git, GitLive } from "./services/git"
import { Process, ProcessLive } from "./services/process"
import { createSyntaxConfig } from "./syntax"
import { ThemeProvider } from "./theme/context"
import { darkTheme } from "./theme/dark"
import { resolveTheme } from "./theme/resolve"

try {
  const options = parseArgs(Bun.argv.slice(2))

  if (options.help) {
    console.log(helpText())
    process.exit(0)
  }

  if (options.version) {
    console.log(packageJson.version)
    process.exit(0)
  }

  // Future system light/dark slot: pick the theme via
  // ThemeForMode(await renderer.waitForThemeMode() ?? "dark") instead
  const theme = resolveTheme(darkTheme)
  // Discover the repo root and load the changed set through the same services
  // The running app uses; repoFiles fill in on the slow poll once mounted.
  const startup = Effect.gen(function* startupModel() {
    const subprocess = yield* Process
    const git = yield* Git
    const repoRoot = (yield* subprocess.run(["git", "rev-parse", "--show-toplevel"], process.cwd())).stdout.trim()
    const changed = yield* git.changedFiles(repoRoot, options.scope)
    return { changed, repoRoot }
  }).pipe(Effect.provide(GitLive.pipe(Layer.provideMerge(ProcessLive))))
  const [{ changed, repoRoot }, syntax, renderer] = await Promise.all([
    Effect.runPromise(startup),
    createSyntaxConfig(theme.colors.syntax),
    createCliRenderer({ exitOnCtrlC: true }),
  ])
  // oxlint-disable-next-line react-perf/jsx-no-new-object-as-prop -- one-time startup render, not inside a component
  const model: GitModel = { repoRoot, ...changed, repoFiles: [], repoFilesKey: "" }
  createRoot(renderer).render(
    <RegistryProvider>
      <ThemeProvider theme={theme}>
        <App model={model} scope={options.scope} syntax={syntax} />
      </ThemeProvider>
    </RegistryProvider>,
  )
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}

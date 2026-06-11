#!/usr/bin/env bun

import { createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"
import packageJson from "../package.json"
import { App } from "./App"
import { helpText, parseArgs } from "./cli"
import { loadChangedFiles, resolveRepoRoot, type GitModel } from "./git"
import { createSyntaxConfig } from "./syntax"

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

  const repoRoot = resolveRepoRoot(process.cwd())
  const [changedResult, syntax, renderer] = await Promise.all([
    loadChangedFiles(repoRoot, options.scope),
    createSyntaxConfig(),
    createCliRenderer({ exitOnCtrlC: true }),
  ])
  // oxlint-disable-next-line react-perf/jsx-no-new-object-as-prop -- one-time startup render, not inside a component
  const model: GitModel = { repoRoot, ...changedResult, repoFiles: [], repoFilesKey: "" }
  createRoot(renderer).render(<App model={model} scope={options.scope} syntax={syntax} />)
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}

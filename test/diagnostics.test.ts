import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer, Stream } from "effect"
import {
  allFindings,
  checkerSummary,
  countBySeverity,
  discoverCheckerCommands,
  findingsLineMap,
  initialCheckerState,
  parseLintOutput,
  parsePrettierList,
  parseTypeScriptOutput,
  stateForResolvedChecker,
  type CheckerFileState,
  type CheckerName,
  type CheckerState,
  type Diagnostic,
} from "../src/diagnostics"
import type { ChangedFile } from "../src/git"
import { Diagnostics, DiagnosticsLive } from "../src/services/diagnostics"
import { ProcessLive } from "../src/services/process"

// Run the diagnostics service to completion, collecting each checker's final
// State, the streaming equivalent of the old runDiagnostics callback.
function collectStates(repoRoot: string, files: ChangedFile[]) {
  return Effect.runPromise(
    Diagnostics.pipe(
      Effect.flatMap((diagnostics) => Stream.runCollect(diagnostics.run(repoRoot, files))),
      Effect.map(
        (updates) => new Map<CheckerName, Map<string, CheckerFileState>>([...updates].map((update) => [update.checker, update.state])),
      ),
      Effect.provide(DiagnosticsLive.pipe(Layer.provide(ProcessLive))),
    ),
  )
}

const file: ChangedFile = {
  additions: 1,
  binary: false,
  deletions: 0,
  kind: "modified",
  mtimeMs: 0,
  path: "src/a.ts",
  stage: "unstaged",
  warnings: [],
}

function diagnostic(overrides: Partial<Diagnostic>): Diagnostic {
  return { checker: "typecheck", line: 3, message: "nope", path: "src/a.ts", severity: "error", ...overrides }
}

function stateWith(diagnostics: Diagnostic[]): CheckerState {
  return {
    ...initialCheckerState([file]),
    typecheck: stateForResolvedChecker("typecheck", [file], diagnostics, "/repo"),
  }
}

describe("initialCheckerState", () => {
  test("starts every checker as pending", () => {
    const state = initialCheckerState([file])
    expect(state.lint.get("src/a.ts")?.status).toBe("pending")
    expect(state.prettier.get("src/a.ts")?.status).toBe("pending")
    expect(state.typecheck.get("src/a.ts")?.status).toBe("pending")
  })
})

describe("stateForResolvedChecker", () => {
  test("retains findings for files outside the changed set", () => {
    const state = stateForResolvedChecker("typecheck", [file], [diagnostic({ path: "/repo/src/unchanged.ts" })], "/repo")

    expect(state.get("src/unchanged.ts")?.status).toBe("findings")
    expect(state.get("src/unchanged.ts")?.diagnostics[0]?.path).toBe("src/unchanged.ts")
    expect(state.get("src/a.ts")?.status).toBe("clean")
  })
})

describe("problem helpers", () => {
  test("allFindings sorts by severity, path, then line", () => {
    const state = stateWith([
      diagnostic({ line: 1, path: "/repo/src/b.ts", severity: "warning" }),
      diagnostic({ line: 9, path: "/repo/src/b.ts", severity: "error" }),
      diagnostic({ line: 2, path: "/repo/src/a.ts", severity: "error" }),
    ])

    expect(allFindings(state).map((finding) => `${finding.path}:${finding.line}`)).toEqual(["src/a.ts:2", "src/b.ts:9", "src/b.ts:1"])
  })

  test("countBySeverity tallies errors and warnings", () => {
    const state = stateWith([diagnostic({}), diagnostic({ line: 5 }), diagnostic({ line: 7, severity: "warning" })])
    expect(countBySeverity(allFindings(state))).toEqual({ errors: 2, warnings: 1 })
  })

  test("checkerSummary tallies a single path and tracks pending", () => {
    const state = stateWith([diagnostic({}), diagnostic({ path: "/repo/src/other.ts" })])
    // Lint and prettier are still pending in stateWith; typecheck resolved
    expect(checkerSummary("src/a.ts", state)).toEqual({ errors: 1, failed: false, pending: true, warnings: 0 })
  })

  test("checkerSummary surfaces failed runs", () => {
    const state: CheckerState = {
      ...initialCheckerState([file]),
      lint: new Map([["src/a.ts", { count: 0, diagnostics: [], message: "boom\ndetail", status: "failed" }]]),
    }
    expect(checkerSummary("src/a.ts", state).failed).toBe(true)
  })

  test("findingsLineMap groups by line number", () => {
    const state = stateWith([diagnostic({}), diagnostic({ message: "again" }), diagnostic({ line: undefined, message: "no line" })])
    const byLine = findingsLineMap("src/a.ts", state)

    expect(byLine.get(3)?.map((finding) => finding.message)).toEqual(["nope", "again"])
    expect(byLine.size).toBe(1)
  })
})

describe("diagnostic parsers", () => {
  test("parses eslint json", () => {
    const diagnostics = parseLintOutput({
      exitCode: 1,
      stderr: "",
      stdout: JSON.stringify([{ filePath: "src/a.ts", messages: [{ line: 3, message: "bad", severity: 2 }] }]),
    })
    expect(diagnostics).toEqual([{ checker: "lint", line: 3, message: "bad", path: "src/a.ts", severity: "error" }])
  })

  test("parses oxlint json", () => {
    const diagnostics = parseLintOutput({
      exitCode: 1,
      stderr: "",
      stdout: JSON.stringify({
        diagnostics: [{ filename: "src/a.ts", labels: [{ span: { line: 7 } }], message: "bad", severity: "warning" }],
      }),
    })
    expect(diagnostics).toEqual([{ checker: "lint", line: 7, message: "bad", path: "src/a.ts", severity: "warning" }])
  })

  test("treats unparseable lint output with exit 0 as clean", () => {
    expect(parseLintOutput({ exitCode: 0, stderr: "", stdout: "Found 0 warnings and 0 errors.\n" })).toEqual([])
  })

  test("treats unparseable lint output with exit 1 as findings, not failure", () => {
    expect(parseLintOutput({ exitCode: 1, stderr: "", stdout: "src/a.ts:1:1: error no-unused-vars\nmore" })).toEqual([
      { checker: "lint", message: "src/a.ts:1:1: error no-unused-vars", path: "", severity: "error" },
    ])
  })

  test("parses prettier list output", () => {
    expect(parsePrettierList({ stdout: "Checking formatting...\nsrc/a.ts\n" })).toEqual([
      { checker: "prettier", message: "Formatting differs from Prettier", path: "src/a.ts", severity: "warning" },
    ])
  })

  test("parses TypeScript diagnostics", () => {
    expect(parseTypeScriptOutput({ stderr: "", stdout: "src/a.ts(4,12): error TS2322: nope" })).toEqual([
      { checker: "typecheck", line: 4, message: "nope", path: "src/a.ts", severity: "error" },
    ])
  })
})

describe("the diagnostics service", () => {
  async function lintStatuses(lintScript: string) {
    const dir = mkdtempSync(join(tmpdir(), "sideye-diagnostics-"))
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { lint: lintScript } }))
      const states = await collectStates(dir, [file])
      return states.get("lint")
    } finally {
      rmSync(dir, { force: true, recursive: true })
    }
  }

  test("unconfigured checkers resolve as unavailable instead of clean or failed", async () => {
    // Deleted-only changes leave no paths to lint or format
    const deleted: ChangedFile = { ...file, kind: "deleted" }
    const dir = mkdtempSync(join(tmpdir(), "sideye-diagnostics-"))
    try {
      const states = await collectStates(dir, [deleted])
      expect(states.get("lint")?.get("src/a.ts")?.status).toBe("unavailable")
      expect(states.get("prettier")?.get("src/a.ts")?.status).toBe("unavailable")
    } finally {
      rmSync(dir, { force: true, recursive: true })
    }
  })

  test("a lint script that crashes resolves as failed", async () => {
    const lint = await lintStatuses("exit 2")
    expect(lint?.get("src/a.ts")?.status).toBe("failed")
  })

  test("a clean lint script with text output resolves as clean", async () => {
    const lint = await lintStatuses("echo Found 0 warnings && exit 0")
    expect(lint?.get("src/a.ts")?.status).toBe("clean")
  })

  test("a lint script with text findings resolves as findings, not failure", async () => {
    const lint = await lintStatuses("echo problems found && exit 1")
    expect(lint?.get("src/a.ts")?.status).toBe("clean")
    expect(lint?.get("")?.status).toBe("findings")
  })
})

function makeWorkspace(packages: { name: string; hasTypecheck?: boolean; hasTsconfig?: boolean }[]) {
  const dir = mkdtempSync(join(tmpdir(), "sideye-workspace-"))
  writeFileSync(join(dir, "package.json"), JSON.stringify({ workspaces: ["packages/*"] }))
  mkdirSync(join(dir, "packages"))
  for (const pkg of packages) {
    const pkgDir = join(dir, "packages", pkg.name)
    mkdirSync(pkgDir)
    const scripts: Record<string, string> = {}
    if (pkg.hasTypecheck === true) {
      scripts.typecheck = `echo "src/a.ts(1,1): error TS2322: type error" && exit 1`
    }
    writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ scripts }))
    if (pkg.hasTsconfig === true) {
      writeFileSync(join(pkgDir, "tsconfig.json"), JSON.stringify({ compilerOptions: {} }))
    }
  }
  return dir
}

describe("workspace typecheck discovery", () => {
  test("discovers only the package containing changed files", () => {
    const dir = makeWorkspace([
      { hasTsconfig: true, name: "core" },
      { hasTsconfig: true, name: "ui" },
    ])
    try {
      const coreFile: ChangedFile = { ...file, path: "packages/core/src/a.ts" }
      const commands = discoverCheckerCommands(dir, [coreFile]).filter((c) => c.checker === "typecheck")
      expect(commands).toHaveLength(1)
      expect(commands[0].cwd).toBe(join(dir, "packages", "core"))
    } finally {
      rmSync(dir, { force: true, recursive: true })
    }
  })

  test("merges diagnostics from multiple affected packages with normalized paths", async () => {
    const dir = makeWorkspace([
      { hasTypecheck: true, name: "core" },
      { hasTypecheck: true, name: "ui" },
    ])
    try {
      const files: ChangedFile[] = [
        { ...file, path: "packages/core/src/a.ts" },
        { ...file, path: "packages/ui/src/a.ts" },
      ]
      const states = await collectStates(dir, files)
      const typecheck = states.get("typecheck")
      // Both packages reported errors; paths should be monorepo-relative
      const allPaths = [...(typecheck?.keys() ?? [])]
      expect(allPaths).toContain("packages/core/src/a.ts")
      expect(allPaths).toContain("packages/ui/src/a.ts")
    } finally {
      rmSync(dir, { force: true, recursive: true })
    }
  })

  test("reports unavailable when no workspace packages contain changed files", () => {
    const dir = makeWorkspace([{ hasTsconfig: true, name: "core" }])
    try {
      const otherFile: ChangedFile = { ...file, path: "docs/readme.md" }
      const commands = discoverCheckerCommands(dir, [otherFile]).filter((c) => c.checker === "typecheck")
      expect(commands).toHaveLength(1)
      expect(commands[0].command).toBeUndefined()
      expect(commands[0].unavailableMessage).toContain("no workspace packages contain changed files")
    } finally {
      rmSync(dir, { force: true, recursive: true })
    }
  })

  test("discovers packages from pnpm-workspace.yaml", () => {
    const dir = mkdtempSync(join(tmpdir(), "sideye-pnpm-"))
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "myapp" }))
      writeFileSync(join(dir, "pnpm-workspace.yaml"), "packages:\n  - 'packages/*'\n")
      mkdirSync(join(dir, "packages"))
      const pkgDir = join(dir, "packages", "core")
      mkdirSync(pkgDir)
      writeFileSync(join(pkgDir, "package.json"), JSON.stringify({}))
      writeFileSync(join(pkgDir, "tsconfig.json"), JSON.stringify({ compilerOptions: {} }))
      const coreFile: ChangedFile = { ...file, path: "packages/core/src/a.ts" }
      const commands = discoverCheckerCommands(dir, [coreFile]).filter((c) => c.checker === "typecheck")
      expect(commands).toHaveLength(1)
      expect(commands[0].cwd).toBe(pkgDir)
    } finally {
      rmSync(dir, { force: true, recursive: true })
    }
  })

  test("reports unavailable when no tsconfig.json at root and no workspaces configured", () => {
    const dir = mkdtempSync(join(tmpdir(), "sideye-noconfig-"))
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "myapp" }))
      const commands = discoverCheckerCommands(dir, [file]).filter((c) => c.checker === "typecheck")
      expect(commands).toHaveLength(1)
      expect(commands[0].command).toBeUndefined()
      expect(commands[0].unavailableMessage).toContain("no tsconfig.json at repo root")
    } finally {
      rmSync(dir, { force: true, recursive: true })
    }
  })
})

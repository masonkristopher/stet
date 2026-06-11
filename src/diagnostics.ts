import { existsSync, readdirSync, readFileSync } from "node:fs"
import { isAbsolute, join } from "node:path"
import type { ChangedFile } from "./git"
import { runCommandAsync } from "./process"

export const checkerNames = ["lint", "prettier", "typecheck"] as const
export type CheckerName = (typeof checkerNames)[number]
export type CheckerStatus = "pending" | "clean" | "findings" | "failed" | "unavailable"

export type Diagnostic = {
  checker: CheckerName
  path: string
  line?: number
  severity: "error" | "warning" | "info"
  message: string
}

export type CheckerFileState = {
  status: CheckerStatus
  count: number
  diagnostics: Diagnostic[]
  message?: string
}

export type CheckerState = Record<CheckerName, Map<string, CheckerFileState>>

type PackageJson = { scripts?: Record<string, string>; workspaces?: string[] | { packages: string[] } }

type CheckerCommand = {
  checker: CheckerName
  command?: string[]
  cwd?: string
  parser: (result: { stdout: string; stderr: string; exitCode?: number }) => Diagnostic[]
  allowedExitCodes: number[]
  unavailableMessage?: string
}

type DiscoverChecker = (repoRoot: string, packageJson: PackageJson | undefined, changedPaths: string[]) => CheckerCommand[]

// adding a checker means one name in checkerNames and one entry here; the
// Record type makes the compiler reject a missing entry
const checkerRegistry: Record<CheckerName, DiscoverChecker> = {
  lint: lintCommand,
  prettier: prettierCommand,
  typecheck: typecheckCommand,
}

export function initialCheckerState(files: ChangedFile[]): CheckerState {
  const state = {} as CheckerState
  for (const checker of checkerNames) {
    state[checker] = initialFileState(files)
  }

  return state
}

export function markPending(state: CheckerState, files: ChangedFile[], changedPaths: string[]): CheckerState {
  const changed = new Set(changedPaths)
  const next = {} as CheckerState
  for (const checker of checkerNames) {
    const map = new Map(state[checker])
    for (const file of files) {
      if (map.get(file.path) === undefined || changed.has(file.path)) {
        map.set(file.path, { status: "pending", count: 0, diagnostics: [] })
      }
    }
    next[checker] = map
  }

  return next
}

export function directorySummary(path: string, state: CheckerState) {
  const prefix = path === "" ? "" : `${path}/`
  let pending = false
  let failed = false
  const diagnostics: Diagnostic[] = []
  for (const checker of checkerNames) {
    for (const [filePath, fileState] of state[checker]) {
      if (!filePath.startsWith(prefix)) continue
      pending = pending || fileState.status === "pending"
      failed = failed || fileState.status === "failed"
      diagnostics.push(...fileState.diagnostics)
    }
  }
  return { pending, failed, ...countBySeverity(diagnostics) }
}

export function checkerSummary(path: string, state: CheckerState) {
  let pending = false
  let failed = false
  const diagnostics: Diagnostic[] = []

  for (const checker of checkerNames) {
    const fileState = state[checker].get(path)
    if (fileState === undefined) {
      continue
    }

    pending = pending || fileState.status === "pending"
    failed = failed || fileState.status === "failed"
    diagnostics.push(...fileState.diagnostics)
  }

  return { pending, failed, ...countBySeverity(diagnostics) }
}

const severityRank = { error: 0, warning: 1, info: 2 } as const

export function allFindings(state: CheckerState): Diagnostic[] {
  const findings: Diagnostic[] = []
  for (const checker of checkerNames) {
    for (const fileState of state[checker].values()) {
      findings.push(...fileState.diagnostics)
    }
  }

  return findings.toSorted(
    (a, b) =>
      severityRank[a.severity] - severityRank[b.severity] ||
      a.path.localeCompare(b.path) ||
      (a.line ?? Number.MAX_SAFE_INTEGER) - (b.line ?? Number.MAX_SAFE_INTEGER),
  )
}

export function countBySeverity(diagnostics: Iterable<Diagnostic>) {
  let errors = 0
  let warnings = 0
  for (const diagnostic of diagnostics) {
    if (diagnostic.severity === "error") {
      errors += 1
    } else {
      warnings += 1
    }
  }

  return { errors, warnings }
}

export function findingsLineMap(path: string, state: CheckerState) {
  const byLine = new Map<number, Diagnostic[]>()
  for (const checker of checkerNames) {
    for (const diagnostic of state[checker].get(path)?.diagnostics ?? []) {
      if (diagnostic.line === undefined) {
        continue
      }

      const existing = byLine.get(diagnostic.line)
      if (existing === undefined) {
        byLine.set(diagnostic.line, [diagnostic])
      } else {
        existing.push(diagnostic)
      }
    }
  }

  return byLine
}

export async function runDiagnostics(
  repoRoot: string,
  files: ChangedFile[],
  onCheckerDone: (checker: CheckerName, state: Map<string, CheckerFileState>) => void,
  signal?: AbortSignal,
) {
  const commands = discoverCheckerCommands(repoRoot, files)

  // group by checker; most have one command, typecheck may have one per workspace package
  const byChecker = new Map<CheckerName, CheckerCommand[]>()
  for (const command of commands) {
    const list = byChecker.get(command.checker)
    if (list === undefined) {
      byChecker.set(command.checker, [command])
    } else {
      list.push(command)
    }
  }

  await Promise.all(
    [...byChecker.entries()].map(async ([checker, checkerCommands]) => {
      if (checkerCommands.length === 1 && checkerCommands[0].command === undefined) {
        const message = checkerCommands[0].unavailableMessage ?? `${checker} is not configured`
        onCheckerDone(checker, stateForEveryFile(files, "unavailable", message))
        return
      }

      const allDiagnostics: Diagnostic[] = []
      let firstFailure: Error | undefined

      await Promise.all(
        checkerCommands
          .filter((c) => c.command !== undefined)
          .map(async (command) => {
            try {
              const cwd = command.cwd ?? repoRoot
              // biome-ignore lint/style/noNonNullAssertion: filtered above
              const result = await runCommandAsync(command.command!, cwd, command.allowedExitCodes, signal)
              const diagnostics = command.parser(result)
              for (const d of diagnostics) {
                // resolve paths from per-package cwd to absolute so stateForResolvedChecker can relativize them
                const resolvedPath = command.cwd !== undefined && !isAbsolute(d.path) ? join(command.cwd, d.path) : d.path
                allDiagnostics.push({ ...d, path: resolvedPath })
              }
            } catch (error) {
              if (firstFailure === undefined) {
                firstFailure = error instanceof Error ? error : new Error(String(error))
              }
            }
          }),
      )

      if (firstFailure !== undefined && allDiagnostics.length === 0) {
        onCheckerDone(checker, stateForEveryFile(files, "failed", firstFailure.message))
      } else {
        onCheckerDone(checker, stateForResolvedChecker(checker, files, allDiagnostics, repoRoot))
      }
    }),
  )
}

export function discoverCheckerCommands(repoRoot: string, files: ChangedFile[]): CheckerCommand[] {
  const packageJson = readPackageJson(repoRoot)
  const changedPaths = files.filter((file) => file.kind !== "deleted").map((file) => file.path)

  return checkerNames.flatMap((checker) => checkerRegistry[checker](repoRoot, packageJson, changedPaths))
}

function lintCommand(repoRoot: string, packageJson: PackageJson | undefined, changedPaths: string[]): CheckerCommand[] {
  const script = packageJson?.scripts?.lint
  if (script !== undefined) {
    // eslint and oxlint accept --format json; other scripts fall back to
    // parseLintOutput's exit-code interpretation
    const jsonArgs = /^(?:eslint|oxlint)\b/.test(script) ? ["--format", "json"] : []
    return [{ checker: "lint", command: ["bun", "run", "lint", ...jsonArgs], parser: parseLintOutput, allowedExitCodes: [0, 1] }]
  }

  if (changedPaths.length === 0) {
    return [unconfiguredChecker("lint")]
  }

  if (hasBinary(repoRoot, "oxlint")) {
    return [
      {
        checker: "lint",
        command: ["bunx", "oxlint", "--format", "json", ...changedPaths],
        parser: parseLintOutput,
        allowedExitCodes: [0, 1],
      },
    ]
  }

  if (hasBinary(repoRoot, "eslint")) {
    return [
      {
        checker: "lint",
        command: ["bunx", "eslint", "--format", "json", ...changedPaths],
        parser: parseLintOutput,
        allowedExitCodes: [0, 1],
      },
    ]
  }

  return [unconfiguredChecker("lint")]
}

function prettierCommand(repoRoot: string, _packageJson: PackageJson | undefined, changedPaths: string[]): CheckerCommand[] {
  if (changedPaths.length === 0 || !hasBinary(repoRoot, "prettier")) {
    return [unconfiguredChecker("prettier")]
  }

  return [
    {
      checker: "prettier",
      command: ["bunx", "prettier", "--list-different", ...changedPaths],
      parser: parsePrettierList,
      allowedExitCodes: [0, 1],
    },
  ]
}

function typecheckCommand(repoRoot: string, packageJson: PackageJson | undefined, changedPaths: string[]): CheckerCommand[] {
  if (packageJson?.scripts?.typecheck !== undefined) {
    return [{ checker: "typecheck", command: ["bun", "run", "typecheck"], parser: parseTypeScriptOutput, allowedExitCodes: [0, 1, 2] }]
  }

  if (existsSync(`${repoRoot}/tsconfig.json`) && hasBinary(repoRoot, "tsc")) {
    return [{ checker: "typecheck", command: ["bunx", "tsc", "--noEmit"], parser: parseTypeScriptOutput, allowedExitCodes: [0, 1, 2] }]
  }

  return discoverWorkspaceTypechecks(repoRoot, packageJson, changedPaths)
}

function discoverWorkspaceTypechecks(repoRoot: string, packageJson: PackageJson | undefined, changedPaths: string[]): CheckerCommand[] {
  const workspaces = getWorkspacePatterns(repoRoot, packageJson)
  if (workspaces.length === 0) {
    return [
      {
        ...unconfiguredChecker("typecheck"),
        unavailableMessage: "no tsconfig.json at repo root; add a typecheck script to package.json",
      },
    ]
  }

  const packageDirs = expandWorkspacePatterns(repoRoot, workspaces)
  const affectedDirs = packageDirs.filter((dir) => {
    const relDir = relativize(dir, repoRoot)
    return changedPaths.some((p) => p === relDir || p.startsWith(`${relDir}/`))
  })

  const commands: CheckerCommand[] = []
  for (const pkgDir of affectedDirs) {
    const pkgJson = readPackageJson(pkgDir)
    if (pkgJson?.scripts?.typecheck !== undefined) {
      commands.push({
        checker: "typecheck",
        command: ["bun", "run", "typecheck"],
        cwd: pkgDir,
        parser: parseTypeScriptOutput,
        allowedExitCodes: [0, 1, 2],
      })
    } else if (existsSync(`${pkgDir}/tsconfig.json`) && hasBinary(repoRoot, "tsc")) {
      commands.push({
        checker: "typecheck",
        command: ["bunx", "tsc", "--noEmit"],
        cwd: pkgDir,
        parser: parseTypeScriptOutput,
        allowedExitCodes: [0, 1, 2],
      })
    }
  }

  if (commands.length === 0) {
    const reason =
      affectedDirs.length === 0
        ? "no workspace packages contain changed files"
        : "affected workspace packages have no tsconfig.json or typecheck script"
    return [{ ...unconfiguredChecker("typecheck"), unavailableMessage: reason }]
  }

  return commands
}

function getWorkspacePatterns(repoRoot: string, packageJson: PackageJson | undefined): string[] {
  const ws = packageJson?.workspaces
  const fromPackageJson: string[] =
    ws === undefined
      ? []
      : Array.isArray(ws)
        ? ws
        : Array.isArray((ws as { packages?: unknown }).packages)
          ? (ws as { packages: string[] }).packages
          : []
  return [...fromPackageJson, ...getPnpmWorkspacePatterns(repoRoot)]
}

function getPnpmWorkspacePatterns(repoRoot: string): string[] {
  const path = `${repoRoot}/pnpm-workspace.yaml`
  if (!existsSync(path)) return []
  const text = readFileSync(path, "utf8")
  const match = text.match(/^packages:\s*\n((?:[ \t]+-[^\n]*\n?)+)/m)
  if (match === null) return []
  return match[1]
    .split("\n")
    .map((line) =>
      line
        .replace(/^\s*-\s*/, "")
        .replace(/#.*$/, "")
        .replace(/^['"]|['"]$/g, "")
        .trim(),
    )
    .filter((line) => line !== "")
}

function expandWorkspacePatterns(repoRoot: string, patterns: string[]): string[] {
  const dirs: string[] = []
  for (const pattern of patterns) {
    if (pattern.endsWith("/*")) {
      const base = join(repoRoot, pattern.slice(0, -2))
      if (existsSync(base)) {
        for (const entry of readdirSync(base, { withFileTypes: true })) {
          if (entry.isDirectory()) {
            dirs.push(join(base, entry.name))
          }
        }
      }
    } else if (!pattern.includes("*")) {
      const dir = join(repoRoot, pattern)
      if (existsSync(dir)) {
        dirs.push(dir)
      }
    }
  }
  return dirs
}

export function parseLintOutput(output: { stdout: string; stderr: string; exitCode?: number }): Diagnostic[] {
  const stdout = output.stdout.trim()
  const fromJson = stdout === "" ? [] : parseLintJson(stdout)
  if (fromJson !== undefined) {
    return fromJson
  }

  // text output: trust the exit code — 0 is clean, 1 is findings, and
  // anything else was already rejected by allowedExitCodes as a failure
  if (output.exitCode === 0) {
    return []
  }

  const summary = (stdout !== "" ? stdout : output.stderr.trim()).split("\n")[0] ?? ""
  return [{ checker: "lint", path: "", severity: "error", message: summary === "" ? "lint reported findings" : summary }]
}

function parseLintJson(stdout: string): Diagnostic[] | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return undefined
  }

  if (Array.isArray(parsed)) {
    // eslint --format json
    const files = parsed as Array<{ filePath?: string; messages?: Array<{ line?: number; severity?: number; message?: string }> }>
    return files.flatMap((file) =>
      (file.messages ?? []).map((message) => ({
        checker: "lint" as const,
        path: file.filePath ?? "",
        line: message.line,
        severity: message.severity === 2 ? ("error" as const) : ("warning" as const),
        message: message.message ?? "lint finding",
      })),
    )
  }

  if (typeof parsed === "object" && parsed !== null && "diagnostics" in parsed) {
    // oxlint --format json
    const report = parsed as {
      diagnostics?: Array<{ filename?: string; message?: string; severity?: string; labels?: Array<{ span?: { line?: number } }> }>
    }
    return (report.diagnostics ?? []).map((diagnostic) => ({
      checker: "lint" as const,
      path: diagnostic.filename ?? "",
      line: diagnostic.labels?.[0]?.span?.line,
      severity: diagnostic.severity === "warning" ? ("warning" as const) : ("error" as const),
      message: diagnostic.message ?? "oxlint finding",
    }))
  }

  return undefined
}

export function parsePrettierList(output: { stdout: string }): Diagnostic[] {
  return output.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("Checking formatting") && !line.startsWith("All matched files"))
    .map((path) => ({
      checker: "prettier" as const,
      path,
      severity: "warning" as const,
      message: "Formatting differs from Prettier",
    }))
}

export function parseTypeScriptOutput(output: { stdout: string; stderr: string; exitCode?: number }): Diagnostic[] {
  const diagnostics = `${output.stdout}\n${output.stderr}`.split("\n").flatMap((line) => {
    const match = line.match(/^(.+?)\((\d+),(\d+)\):\s+error\s+TS\d+:\s+(.+)$/)
    if (match === null) {
      return []
    }

    return [
      {
        checker: "typecheck" as const,
        path: match[1],
        line: Number.parseInt(match[2], 10),
        severity: "error" as const,
        message: match[4],
      },
    ]
  })

  if (diagnostics.length === 0 && output.exitCode !== undefined && output.exitCode !== 0) {
    const text = `${output.stdout}\n${output.stderr}`.trim()
    throw new Error(text === "" ? "typecheck failed without parseable diagnostics" : text)
  }

  return diagnostics
}

export function stateForResolvedChecker(checker: CheckerName, files: ChangedFile[], diagnostics: Diagnostic[], repoRoot: string) {
  const byPath = new Map<string, Diagnostic[]>()
  for (const diagnostic of diagnostics) {
    const path = relativize(diagnostic.path, repoRoot)
    const existing = byPath.get(path)
    const normalized = { ...diagnostic, path, checker }
    if (existing === undefined) {
      byPath.set(path, [normalized])
    } else {
      existing.push(normalized)
    }
  }

  // keep findings for every reported path (tsc runs project-wide), not just changed files
  const state = new Map<string, CheckerFileState>()
  for (const [path, fileDiagnostics] of byPath) {
    state.set(path, { status: "findings", count: fileDiagnostics.length, diagnostics: fileDiagnostics })
  }

  for (const file of files) {
    if (!state.has(file.path)) {
      state.set(file.path, { status: "clean", count: 0, diagnostics: [] })
    }
  }

  return state
}

function stateForEveryFile(files: ChangedFile[], status: "failed" | "unavailable", message: string) {
  return new Map(
    files.map((file) => [
      file.path,
      {
        status,
        count: 0,
        diagnostics: [],
        message,
      },
    ]),
  )
}

function unconfiguredChecker(checker: CheckerName): CheckerCommand {
  return {
    checker,
    parser: () => [],
    allowedExitCodes: [0],
    unavailableMessage: `${checker} is not configured`,
  }
}

function initialFileState(files: ChangedFile[]) {
  return new Map(
    files.map((file) => [
      file.path,
      {
        status: "pending" as const,
        count: 0,
        diagnostics: [],
      },
    ]),
  )
}

function readPackageJson(repoRoot: string): PackageJson | undefined {
  const path = `${repoRoot}/package.json`
  if (!existsSync(path)) {
    return undefined
  }

  return JSON.parse(readFileSync(path, "utf8")) as PackageJson
}

function hasBinary(repoRoot: string, binary: string) {
  return existsSync(`${repoRoot}/node_modules/.bin/${binary}`) || Bun.which(binary) !== null
}

function relativize(path: string, repoRoot: string) {
  const prefix = repoRoot.endsWith("/") ? repoRoot : `${repoRoot}/`
  return (path.startsWith(prefix) ? path.slice(prefix.length) : path).replace(/^\.\//, "")
}

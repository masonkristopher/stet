import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { ChangedFile } from "./git"

export const checkerNames = ["lint", "prettier", "typecheck"] as const
export type CheckerName = (typeof checkerNames)[number]
type CheckerStatus = "pending" | "clean" | "findings" | "failed" | "unavailable"

export interface Diagnostic {
  checker: CheckerName
  path: string
  line?: number
  severity: "error" | "warning" | "info"
  message: string
}

export interface CheckerFileState {
  status: CheckerStatus
  count: number
  diagnostics: Diagnostic[]
  message?: string
}

export type CheckerState = Record<CheckerName, Map<string, CheckerFileState>>

interface PackageJson {
  scripts?: Record<string, string>
  workspaces?: string[] | { packages: string[] }
}

export interface CheckerCommand {
  checker: CheckerName
  command?: string[]
  cwd?: string
  parser: (result: { stdout: string; stderr: string; exitCode?: number }) => Diagnostic[]
  allowedExitCodes: number[]
  unavailableMessage?: string
}

type DiscoverChecker = (repoRoot: string, packageJson: PackageJson | undefined, changedPaths: string[]) => CheckerCommand[]

// Adding a checker means one name in checkerNames and one entry here; the
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
        map.set(file.path, { count: 0, diagnostics: [], status: "pending" })
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
      if (!filePath.startsWith(prefix)) {
        continue
      }
      pending ||= fileState.status === "pending"
      failed ||= fileState.status === "failed"
      diagnostics.push(...fileState.diagnostics)
    }
  }
  return { failed, pending, ...countBySeverity(diagnostics) }
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

    pending ||= fileState.status === "pending"
    failed ||= fileState.status === "failed"
    diagnostics.push(...fileState.diagnostics)
  }

  return { failed, pending, ...countBySeverity(diagnostics) }
}

const severityRank = { error: 0, info: 2, warning: 1 } as const

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

export function discoverCheckerCommands(repoRoot: string, files: ChangedFile[]): CheckerCommand[] {
  const packageJson = readPackageJson(repoRoot)
  const changedPaths = files.filter((file) => file.kind !== "deleted").map((file) => file.path)

  return checkerNames.flatMap((checker) => checkerRegistry[checker](repoRoot, packageJson, changedPaths))
}

function lintCommand(repoRoot: string, packageJson: PackageJson | undefined, changedPaths: string[]): CheckerCommand[] {
  const script = packageJson?.scripts?.lint
  if (script !== undefined) {
    // eslint and oxlint accept --format json; other scripts fall back to
    // ParseLintOutput's exit-code interpretation
    const jsonArgs = /^(?:eslint|oxlint)\b/.test(script) ? ["--format", "json"] : []
    return [{ allowedExitCodes: [0, 1], checker: "lint", command: ["bun", "run", "lint", ...jsonArgs], parser: parseLintOutput }]
  }

  if (changedPaths.length === 0) {
    return [unconfiguredChecker("lint")]
  }

  if (hasBinary(repoRoot, "oxlint")) {
    return [
      {
        allowedExitCodes: [0, 1],
        checker: "lint",
        command: ["bunx", "oxlint", "--format", "json", ...changedPaths],
        parser: parseLintOutput,
      },
    ]
  }

  if (hasBinary(repoRoot, "eslint")) {
    return [
      {
        allowedExitCodes: [0, 1],
        checker: "lint",
        command: ["bunx", "eslint", "--format", "json", ...changedPaths],
        parser: parseLintOutput,
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
      allowedExitCodes: [0, 1],
      checker: "prettier",
      command: ["bunx", "prettier", "--list-different", ...changedPaths],
      parser: parsePrettierList,
    },
  ]
}

function typecheckCommand(repoRoot: string, packageJson: PackageJson | undefined, changedPaths: string[]): CheckerCommand[] {
  if (packageJson?.scripts?.typecheck !== undefined) {
    return [{ allowedExitCodes: [0, 1, 2], checker: "typecheck", command: ["bun", "run", "typecheck"], parser: parseTypeScriptOutput }]
  }

  if (existsSync(`${repoRoot}/tsconfig.json`) && hasBinary(repoRoot, "tsc")) {
    return [{ allowedExitCodes: [0, 1, 2], checker: "typecheck", command: ["bunx", "tsc", "--noEmit"], parser: parseTypeScriptOutput }]
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
        allowedExitCodes: [0, 1, 2],
        checker: "typecheck",
        command: ["bun", "run", "typecheck"],
        cwd: pkgDir,
        parser: parseTypeScriptOutput,
      })
    } else if (existsSync(`${pkgDir}/tsconfig.json`) && hasBinary(repoRoot, "tsc")) {
      commands.push({
        allowedExitCodes: [0, 1, 2],
        checker: "typecheck",
        command: ["bunx", "tsc", "--noEmit"],
        cwd: pkgDir,
        parser: parseTypeScriptOutput,
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
  if (!existsSync(path)) {
    return []
  }
  const text = readFileSync(path, "utf8")
  const match = text.match(/^packages:\s*\n(?<block>(?:[ \t]+-[^\n]*\n?)+)/m)
  if (match === null) {
    return []
  }
  return (match.groups?.block ?? "")
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

  // Text output: trust the exit code — 0 is clean, 1 is findings, and
  // Anything else was already rejected by allowedExitCodes as a failure
  if (output.exitCode === 0) {
    return []
  }

  const summary = (stdout !== "" ? stdout : output.stderr.trim()).split("\n")[0] ?? ""
  return [{ checker: "lint", message: summary === "" ? "lint reported findings" : summary, path: "", severity: "error" }]
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
    const files = parsed as { filePath?: string; messages?: { line?: number; severity?: number; message?: string }[] }[]
    return files.flatMap((file) =>
      (file.messages ?? []).map((message) => ({
        checker: "lint" as const,
        line: message.line,
        message: message.message ?? "lint finding",
        path: file.filePath ?? "",
        severity: message.severity === 2 ? ("error" as const) : ("warning" as const),
      })),
    )
  }

  if (typeof parsed === "object" && parsed !== null && "diagnostics" in parsed) {
    // Oxlint --format json
    const report = parsed as {
      diagnostics?: { filename?: string; message?: string; severity?: string; labels?: { span?: { line?: number } }[] }[]
    }
    return (report.diagnostics ?? []).map((diagnostic) => ({
      checker: "lint" as const,
      line: diagnostic.labels?.[0]?.span?.line,
      message: diagnostic.message ?? "oxlint finding",
      path: diagnostic.filename ?? "",
      severity: diagnostic.severity === "warning" ? ("warning" as const) : ("error" as const),
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
      message: "Formatting differs from Prettier",
      path,
      severity: "warning" as const,
    }))
}

export function parseTypeScriptOutput(output: { stdout: string; stderr: string; exitCode?: number }): Diagnostic[] {
  const diagnostics = `${output.stdout}\n${output.stderr}`.split("\n").flatMap((line) => {
    const match = line.match(/^(?<path>.+?)\((?<line>\d+),(?<col>\d+)\):\s+error\s+TS\d+:\s+(?<message>.+)$/)
    if (match === null) {
      return []
    }

    return [
      {
        checker: "typecheck" as const,
        line: Number.parseInt(match.groups?.line ?? "0", 10),
        message: match.groups?.message ?? "",
        path: match.groups?.path ?? "",
        severity: "error" as const,
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
    const normalized = { ...diagnostic, checker, path }
    if (existing === undefined) {
      byPath.set(path, [normalized])
    } else {
      existing.push(normalized)
    }
  }

  // Keep findings for every reported path (tsc runs project-wide), not just changed files
  const state = new Map<string, CheckerFileState>()
  for (const [path, fileDiagnostics] of byPath) {
    state.set(path, { count: fileDiagnostics.length, diagnostics: fileDiagnostics, status: "findings" })
  }

  for (const file of files) {
    if (!state.has(file.path)) {
      state.set(file.path, { count: 0, diagnostics: [], status: "clean" })
    }
  }

  return state
}

export function stateForEveryFile(files: ChangedFile[], status: "failed" | "unavailable", message: string) {
  return new Map(
    files.map((file) => [
      file.path,
      {
        count: 0,
        diagnostics: [],
        message,
        status,
      },
    ]),
  )
}

function unconfiguredChecker(checker: CheckerName): CheckerCommand {
  return {
    allowedExitCodes: [0],
    checker,
    parser: () => [],
    unavailableMessage: `${checker} is not configured`,
  }
}

function initialFileState(files: ChangedFile[]) {
  return new Map(
    files.map((file) => [
      file.path,
      {
        count: 0,
        diagnostics: [],
        status: "pending" as const,
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

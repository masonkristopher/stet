import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { ChangedFile } from "../git/model";

export const checkerNames = ["lint", "typecheck"] as const;
export type CheckerName = (typeof checkerNames)[number];
type CheckerStatus = "pending" | "clean" | "findings" | "failed" | "unavailable";

export interface Diagnostic {
  checker: CheckerName;
  path: string;
  line?: number;
  severity: "error" | "warning" | "info";
  message: string;
}

export interface CheckerFileState {
  status: CheckerStatus;
  count: number;
  diagnostics: Diagnostic[];
  message?: string;
}

export type CheckerState = Record<CheckerName, Map<string, CheckerFileState>>;

interface PackageJson {
  scripts?: Record<string, string>;
  workspaces?: string[] | { packages: string[] };
  packageManager?: string;
}

export interface CheckerCommand {
  checker: CheckerName;
  command?: string[];
  cwd?: string;
  parser: (result: { stdout: string; stderr: string; exitCode?: number }) => Diagnostic[];
  allowedExitCodes: number[];
  unavailableMessage?: string;
}

type DiscoverChecker = (
  repoRoot: string,
  packageJson: PackageJson | undefined,
  changedPaths: string[],
) => CheckerCommand[];

// Adding a checker means one name in checkerNames and one entry here; the
// Record type makes the compiler reject a missing entry
const checkerRegistry: Record<CheckerName, DiscoverChecker> = {
  lint: lintCommand,
  typecheck: typecheckCommand,
};

export function initialCheckerState(files: ChangedFile[]): CheckerState {
  return {
    lint: initialFileState(files),
    typecheck: initialFileState(files),
  };
}

export function markPending(
  state: CheckerState,
  files: ChangedFile[],
  changedPaths: string[],
): CheckerState {
  const changed = new Set(changedPaths);
  function mark(map: Map<string, CheckerFileState>) {
    const next = new Map(map);
    for (const file of files) {
      if (next.get(file.path) === undefined || changed.has(file.path)) {
        next.set(file.path, { count: 0, diagnostics: [], status: "pending" });
      }
    }
    return next;
  }
  return {
    lint: mark(state.lint),
    typecheck: mark(state.typecheck),
  };
}

export function directorySummary(path: string, state: CheckerState) {
  const prefix = path === "" ? "" : `${path}/`;
  let pending = false;
  let failed = false;
  const diagnostics: Diagnostic[] = [];
  for (const checker of checkerNames) {
    for (const [filePath, fileState] of state[checker]) {
      if (!filePath.startsWith(prefix)) {
        continue;
      }
      pending ||= fileState.status === "pending";
      failed ||= fileState.status === "failed";
      diagnostics.push(...fileState.diagnostics);
    }
  }
  return { failed, pending, ...countBySeverity(diagnostics) };
}

export function checkerSummary(path: string, state: CheckerState) {
  let pending = false;
  let failed = false;
  const diagnostics: Diagnostic[] = [];

  for (const checker of checkerNames) {
    const fileState = state[checker].get(path);
    if (fileState === undefined) {
      continue;
    }

    pending ||= fileState.status === "pending";
    failed ||= fileState.status === "failed";
    diagnostics.push(...fileState.diagnostics);
  }

  return { failed, pending, ...countBySeverity(diagnostics) };
}

const severityRank = { error: 0, info: 2, warning: 1 } as const;

export function allFindings(state: CheckerState): Diagnostic[] {
  const findings: Diagnostic[] = [];
  for (const checker of checkerNames) {
    for (const fileState of state[checker].values()) {
      findings.push(...fileState.diagnostics);
    }
  }

  return findings.toSorted(
    (a, b) =>
      severityRank[a.severity] - severityRank[b.severity] ||
      a.path.localeCompare(b.path) ||
      (a.line ?? Number.MAX_SAFE_INTEGER) - (b.line ?? Number.MAX_SAFE_INTEGER),
  );
}

export function countBySeverity(diagnostics: Iterable<Diagnostic>) {
  let errors = 0;
  let warnings = 0;
  for (const diagnostic of diagnostics) {
    if (diagnostic.severity === "error") {
      errors += 1;
    } else {
      warnings += 1;
    }
  }

  return { errors, warnings };
}

export function findingsLineMap(path: string, state: CheckerState) {
  const findings = checkerNames
    .flatMap((checker) => state[checker].get(path)?.diagnostics ?? [])
    .filter(
      (diagnostic): diagnostic is Diagnostic & { line: number } => diagnostic.line !== undefined,
    );

  return Map.groupBy(findings, (diagnostic) => diagnostic.line);
}

export function discoverCheckerCommands(repoRoot: string, files: ChangedFile[]): CheckerCommand[] {
  const packageJson = readPackageJson(repoRoot);
  const changedPaths = files.filter((file) => file.kind !== "deleted").map((file) => file.path);

  return checkerNames.flatMap((checker) =>
    checkerRegistry[checker](repoRoot, packageJson, changedPaths),
  );
}

function lintCommand(
  repoRoot: string,
  packageJson: PackageJson | undefined,
  changedPaths: string[],
): CheckerCommand[] {
  const script = packageJson?.scripts?.lint;
  if (script !== undefined) {
    // eslint and oxlint accept --format json; other scripts fall back to
    // ParseLintOutput's exit-code interpretation
    const jsonArgs = /^(?:eslint|oxlint)\b/.test(script) ? ["--format", "json"] : [];
    return [
      {
        allowedExitCodes: [0, 1],
        checker: "lint",
        command: scriptCommand(repoRoot, "lint", jsonArgs),
        parser: parseLintOutput,
      },
    ];
  }

  if (changedPaths.length === 0) {
    return [unconfiguredChecker("lint")];
  }

  const oxlint = resolveBinary(repoRoot, "oxlint");
  if (oxlint !== undefined) {
    return [
      {
        allowedExitCodes: [0, 1],
        checker: "lint",
        command: [oxlint, "--format", "json", ...changedPaths],
        parser: parseLintOutput,
      },
    ];
  }

  const eslint = resolveBinary(repoRoot, "eslint");
  if (eslint !== undefined) {
    return [
      {
        allowedExitCodes: [0, 1],
        checker: "lint",
        command: [eslint, "--format", "json", ...changedPaths],
        parser: parseLintOutput,
      },
    ];
  }

  return [unconfiguredChecker("lint")];
}

function typecheckCommand(
  repoRoot: string,
  packageJson: PackageJson | undefined,
  changedPaths: string[],
): CheckerCommand[] {
  if (packageJson?.scripts?.typecheck !== undefined) {
    return [
      {
        allowedExitCodes: [0, 1, 2],
        checker: "typecheck",
        command: scriptCommand(repoRoot, "typecheck"),
        parser: parseTypeScriptOutput,
      },
    ];
  }

  const rootTsconfig = existsSync(`${repoRoot}/tsconfig.json`);
  if (rootTsconfig) {
    const tsc = resolveBinary(repoRoot, "tsc");
    if (tsc !== undefined) {
      return [
        {
          allowedExitCodes: [0, 1, 2],
          checker: "typecheck",
          command: [tsc, "--noEmit"],
          parser: parseTypeScriptOutput,
        },
      ];
    }
  }

  // A root tsconfig may be a base config; let workspaces resolve their own tsc first.
  const workspace = discoverWorkspaceTypechecks(repoRoot, packageJson, changedPaths);
  if (rootTsconfig && !workspace.some((command) => command.command !== undefined)) {
    return [
      {
        ...unconfiguredChecker("typecheck"),
        unavailableMessage: "tsconfig.json found but the tsc binary could not be resolved",
      },
    ];
  }

  return workspace;
}

function discoverWorkspaceTypechecks(
  repoRoot: string,
  packageJson: PackageJson | undefined,
  changedPaths: string[],
): CheckerCommand[] {
  const workspaces = getWorkspacePatterns(repoRoot, packageJson);
  if (workspaces.length === 0) {
    return [
      {
        ...unconfiguredChecker("typecheck"),
        unavailableMessage: "no tsconfig.json at repo root; add a typecheck script to package.json",
      },
    ];
  }

  const packageDirs = expandWorkspacePatterns(repoRoot, workspaces);
  const affectedDirs = packageDirs.filter((dir) => {
    const relDir = relativize(dir, repoRoot);
    return changedPaths.some((p) => p === relDir || p.startsWith(`${relDir}/`));
  });

  const commands: CheckerCommand[] = [];
  for (const pkgDir of affectedDirs) {
    const pkgJson = readPackageJson(pkgDir);
    if (pkgJson?.scripts?.typecheck !== undefined) {
      commands.push({
        allowedExitCodes: [0, 1, 2],
        checker: "typecheck",
        // Detect the PM at the repo root (where the lockfile lives), not in pkgDir.
        command: scriptCommand(repoRoot, "typecheck"),
        cwd: pkgDir,
        parser: parseTypeScriptOutput,
      });
      continue;
    }
    // Pnpm/yarn keep tsc in the package's own .bin; npm/bun often hoist to root
    const tsc = existsSync(`${pkgDir}/tsconfig.json`)
      ? (resolveBinary(pkgDir, "tsc") ?? resolveBinary(repoRoot, "tsc"))
      : undefined;
    if (tsc !== undefined) {
      commands.push({
        allowedExitCodes: [0, 1, 2],
        checker: "typecheck",
        command: [tsc, "--noEmit"],
        cwd: pkgDir,
        parser: parseTypeScriptOutput,
      });
    }
  }

  if (commands.length === 0) {
    const reason =
      affectedDirs.length === 0
        ? "no workspace packages contain changed files"
        : "affected workspace packages have no tsconfig.json or typecheck script";
    return [{ ...unconfiguredChecker("typecheck"), unavailableMessage: reason }];
  }

  return commands;
}

function getWorkspacePatterns(repoRoot: string, packageJson: PackageJson | undefined): string[] {
  const ws = packageJson?.workspaces;
  const fromPackageJson = ws === undefined ? [] : Array.isArray(ws) ? ws : ws.packages;
  return [...fromPackageJson, ...getPnpmWorkspacePatterns(repoRoot)];
}

function getPnpmWorkspacePatterns(repoRoot: string): string[] {
  const path = `${repoRoot}/pnpm-workspace.yaml`;
  if (!existsSync(path)) {
    return [];
  }
  const text = readFileSync(path, "utf8");
  const match = /^packages:\s*\n(?<block>(?:[ \t]+-[^\n]*\n?)+)/m.exec(text);
  if (match === null) {
    return [];
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
    .filter((line) => line !== "");
}

function expandWorkspacePatterns(repoRoot: string, patterns: string[]): string[] {
  const dirs: string[] = [];
  for (const pattern of patterns) {
    if (pattern.endsWith("/*")) {
      const base = join(repoRoot, pattern.slice(0, -2));
      if (existsSync(base)) {
        for (const entry of readdirSync(base, { withFileTypes: true })) {
          if (entry.isDirectory()) {
            dirs.push(join(base, entry.name));
          }
        }
      }
    } else if (!pattern.includes("*")) {
      const dir = join(repoRoot, pattern);
      if (existsSync(dir)) {
        dirs.push(dir);
      }
    }
  }
  return dirs;
}

export function parseLintOutput(output: {
  stdout: string;
  stderr: string;
  exitCode?: number;
}): Diagnostic[] {
  const stdout = output.stdout.trim();
  const fromJson = stdout === "" ? [] : parseLintJson(stdout);
  if (fromJson !== undefined) {
    return fromJson;
  }

  // Text output: trust the exit code — 0 is clean, 1 is findings, and
  // Anything else was already rejected by allowedExitCodes as a failure
  if (output.exitCode === 0) {
    return [];
  }

  const summary = (stdout !== "" ? stdout : output.stderr.trim()).split("\n")[0] ?? "";
  return [
    {
      checker: "lint",
      message: summary === "" ? "lint reported findings" : summary,
      path: "",
      severity: "error",
    },
  ];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseLintJson(stdout: string): Diagnostic[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return undefined;
  }

  if (Array.isArray(parsed)) {
    // eslint --format json
    return parsed.filter(isRecord).flatMap((file) => {
      const messages: unknown[] = Array.isArray(file.messages) ? file.messages : [];
      return messages.filter(isRecord).map((message) => ({
        checker: "lint" as const,
        line: typeof message.line === "number" ? message.line : undefined,
        message: typeof message.message === "string" ? message.message : "lint finding",
        path: typeof file.filePath === "string" ? file.filePath : "",
        severity: message.severity === 2 ? ("error" as const) : ("warning" as const),
      }));
    });
  }

  if (isRecord(parsed) && Array.isArray(parsed.diagnostics)) {
    // Oxlint --format json
    return parsed.diagnostics.filter(isRecord).map((diagnostic) => {
      const labels: unknown[] = Array.isArray(diagnostic.labels) ? diagnostic.labels : [];
      const span = isRecord(labels[0]) && isRecord(labels[0].span) ? labels[0].span : undefined;
      return {
        checker: "lint" as const,
        line: span !== undefined && typeof span.line === "number" ? span.line : undefined,
        message: typeof diagnostic.message === "string" ? diagnostic.message : "oxlint finding",
        path: typeof diagnostic.filename === "string" ? diagnostic.filename : "",
        severity: diagnostic.severity === "warning" ? ("warning" as const) : ("error" as const),
      };
    });
  }

  return undefined;
}

export function parseTypeScriptOutput(output: {
  stdout: string;
  stderr: string;
  exitCode?: number;
}): Diagnostic[] {
  const diagnostics = `${output.stdout}\n${output.stderr}`.split("\n").flatMap((line) => {
    const match =
      /^(?<path>.+?)\((?<line>\d+),(?<col>\d+)\):\s+error\s+TS\d+:\s+(?<message>.+)$/.exec(line);
    if (match === null) {
      return [];
    }

    return [
      {
        checker: "typecheck" as const,
        line: Number.parseInt(match.groups?.line ?? "0", 10),
        message: match.groups?.message ?? "",
        path: match.groups?.path ?? "",
        severity: "error" as const,
      },
    ];
  });

  if (diagnostics.length === 0 && output.exitCode !== undefined && output.exitCode !== 0) {
    const text = `${output.stdout}\n${output.stderr}`.trim();
    throw new Error(text === "" ? "typecheck failed without parseable diagnostics" : text);
  }

  return diagnostics;
}

export function stateForResolvedChecker(
  checker: CheckerName,
  files: ChangedFile[],
  diagnostics: Diagnostic[],
  repoRoot: string,
) {
  const normalized = diagnostics.map((diagnostic) => ({
    ...diagnostic,
    checker,
    path: relativize(diagnostic.path, repoRoot),
  }));
  const byPath = Map.groupBy(normalized, (diagnostic) => diagnostic.path);

  // Keep findings for every reported path (tsc runs project-wide), not just changed files
  const state = new Map<string, CheckerFileState>();
  for (const [path, fileDiagnostics] of byPath) {
    state.set(path, {
      count: fileDiagnostics.length,
      diagnostics: fileDiagnostics,
      status: "findings",
    });
  }

  for (const file of files) {
    if (!state.has(file.path)) {
      state.set(file.path, { count: 0, diagnostics: [], status: "clean" });
    }
  }

  return state;
}

export function stateForEveryFile(
  files: ChangedFile[],
  status: "failed" | "unavailable",
  message: string,
) {
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
  );
}

function unconfiguredChecker(checker: CheckerName): CheckerCommand {
  return {
    allowedExitCodes: [0],
    checker,
    parser: () => [],
    unavailableMessage: `${checker} is not configured`,
  };
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
  );
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === "string");
}

function isWorkspaces(value: unknown): value is string[] | { packages: string[] } {
  if (Array.isArray(value)) {
    return value.every((entry) => typeof entry === "string");
  }
  return (
    isRecord(value) &&
    Array.isArray(value.packages) &&
    value.packages.every((entry) => typeof entry === "string")
  );
}

function readPackageJson(repoRoot: string): PackageJson | undefined {
  const path = `${repoRoot}/package.json`;
  if (!existsSync(path)) {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) {
    return undefined;
  }

  return {
    packageManager: typeof parsed.packageManager === "string" ? parsed.packageManager : undefined,
    scripts: isStringRecord(parsed.scripts) ? parsed.scripts : undefined,
    workspaces: isWorkspaces(parsed.workspaces) ? parsed.workspaces : undefined,
  };
}

/**
 * Picks the runner for a target repo's package.json scripts. The `packageManager` field is
 * corepack-authoritative; lockfiles are the fallback signal. Defaults to bun, matching sideye's own
 * runtime.
 */
function detectPackageManager(repoRoot: string) {
  const field = readPackageJson(repoRoot)?.packageManager?.split("@")[0];
  if (field === "pnpm" || field === "yarn" || field === "npm" || field === "bun") {
    return field;
  }
  if (existsSync(`${repoRoot}/pnpm-lock.yaml`)) {
    return "pnpm";
  }
  if (existsSync(`${repoRoot}/yarn.lock`)) {
    return "yarn";
  }
  if (existsSync(`${repoRoot}/package-lock.json`)) {
    return "npm";
  }
  return "bun";
}

function scriptCommand(repoRoot: string, script: string, extraArgs: string[] = []) {
  // Npm requires `--` before forwarded args; pnpm/yarn/bun accept it too
  const forwarded = extraArgs.length === 0 ? [] : ["--", ...extraArgs];
  return [detectPackageManager(repoRoot), "run", script, ...forwarded];
}

/**
 * Resolves a checker binary without a package-manager wrapper: prefer the repo-local
 * `node_modules/.bin` path, else the bare name if on PATH. Avoids coupling the target repo to bunx
 * and any registry re-resolution.
 */
function resolveBinary(dir: string, binary: string) {
  const local = `${dir}/node_modules/.bin/${binary}`;
  if (existsSync(local)) {
    return local;
  }
  return Bun.which(binary) ?? undefined;
}

function relativize(path: string, repoRoot: string) {
  const prefix = repoRoot.endsWith("/") ? repoRoot : `${repoRoot}/`;
  return (path.startsWith(prefix) ? path.slice(prefix.length) : path).replace(/^\.\//, "");
}

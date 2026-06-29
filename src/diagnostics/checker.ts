import { existsSync } from "node:fs";

import type { ChangedFile } from "@/git/model";
import { relativize } from "@/utils/path";

// Diagnostics collapse to a single source now that they come from language servers; each diagnostic
// Carries its own LSP `source` label (e.g. "ts", "eslint"). The keyed-map shape is retained so the
// Summary, badge, and line-map helpers stay generic over the source set.
export const checkerNames = ["diagnostics"] as const;
export type CheckerName = (typeof checkerNames)[number];
type CheckerStatus = "pending" | "clean" | "findings" | "failed" | "unavailable";

export interface Diagnostic {
  checker: CheckerName;
  path: string;
  line?: number;
  /** 1-based start column, present when the diagnostic carries a line (LSP always supplies it). */
  column?: number;
  /** 1-based end of the range, kept for caret placement and future range highlighting. */
  endLine?: number;
  endColumn?: number;
  severity: "error" | "warning" | "info";
  message: string;
  /** The LSP `source` of the diagnostic, shown as a label (e.g. "ts", "eslint"). */
  source?: string;
}

export interface CheckerFileState {
  status: CheckerStatus;
  count: number;
  diagnostics: Diagnostic[];
  message?: string;
}

export type CheckerState = Record<CheckerName, Map<string, CheckerFileState>>;

export function initialCheckerState(files: ChangedFile[]): CheckerState {
  return {
    diagnostics: initialFileState(files),
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
    diagnostics: mark(state.diagnostics),
  };
}

export function directorySummary(path: string, state: CheckerState) {
  const prefix = path === "" ? "" : `${path}/`;
  let pending = false;
  let failed = false;
  let unavailable = false;
  const diagnostics: Diagnostic[] = [];
  for (const checker of checkerNames) {
    for (const [filePath, fileState] of state[checker]) {
      if (!filePath.startsWith(prefix)) {
        continue;
      }
      pending ||= fileState.status === "pending";
      failed ||= fileState.status === "failed";
      unavailable ||= fileState.status === "unavailable";
      diagnostics.push(...fileState.diagnostics);
    }
  }
  return { failed, pending, unavailable, ...countBySeverity(diagnostics) };
}

export function checkerSummary(path: string, state: CheckerState) {
  let pending = false;
  let failed = false;
  let unavailable = false;
  const diagnostics: Diagnostic[] = [];

  for (const checker of checkerNames) {
    const fileState = state[checker].get(path);
    if (fileState === undefined) {
      continue;
    }

    pending ||= fileState.status === "pending";
    failed ||= fileState.status === "failed";
    unavailable ||= fileState.status === "unavailable";
    diagnostics.push(...fileState.diagnostics);
  }

  return { failed, pending, unavailable, ...countBySeverity(diagnostics) };
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
  let info = 0;
  for (const diagnostic of diagnostics) {
    if (diagnostic.severity === "error") {
      errors += 1;
    } else if (diagnostic.severity === "warning") {
      warnings += 1;
    } else {
      info += 1;
    }
  }

  return { errors, info, warnings };
}

export function findingsLineMap(path: string, state: CheckerState) {
  const findings = checkerNames
    .flatMap((checker) => state[checker].get(path)?.diagnostics ?? [])
    .filter(
      (diagnostic): diagnostic is Diagnostic & { line: number } => diagnostic.line !== undefined,
    );

  return Map.groupBy(findings, (diagnostic) => diagnostic.line);
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

  // Keep findings for every reported path (the server reports cross-file errors), not just changed files
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

/**
 * Resolves a server binary without a package-manager wrapper: prefer the repo-local
 * `node_modules/.bin` path, else the bare name if on PATH. Avoids coupling the target repo to bunx
 * and any registry re-resolution.
 */
export function resolveBinary(dir: string, binary: string) {
  const local = `${dir}/node_modules/.bin/${binary}`;
  if (existsSync(local)) {
    return local;
  }
  return Bun.which(binary) ?? undefined;
}

import { allFindings, checkerNames, countBySeverity } from "./checker";
import type { CheckerName, CheckerState, Diagnostic } from "./checker";

/**
 * One rendered row of the problems panel, each exactly one terminal row (the blank line between
 * groups is an explicit `spacer` row, so the windowed renderer's slice math stays uniform).
 * Headers, spacers, and help sub-lines are decorations between the navigable `problem`/`failure`
 * rows; the renderer and the keymap both walk this flat list, so navigation skips the non-navigable
 * kinds and the highlight covers a `problem` plus the `help` it `owner`s.
 */
export type ProblemItem =
  | { kind: "spacer" }
  | { kind: "failure-header" }
  | { kind: "failure"; checker: CheckerName; line: string; isFirst: boolean }
  | {
      kind: "file-header";
      path: string;
      errors: number;
      warnings: number;
      info: number;
    }
  | { kind: "problem"; problem: Diagnostic; summary: string; labelWidth: number }
  | { kind: "help"; owner: number; text: string };

/**
 * The rows the panel cursor can land on: located diagnostics and checker-failure lines (so long
 * failure output can be scrolled through), but not the headers or the help sub-lines. The state
 * memo, keymap, and panel highlight all share this so selection stays consistent.
 */
export function isNavigableProblemItem(item: ProblemItem) {
  return item.kind === "problem" || item.kind === "failure";
}

/**
 * The location shown in the panel's left column: `line:col` when the diagnostic carries a column,
 * `line` alone otherwise, and "" when it has no line at all.
 */
export function problemLocationLabel(diagnostic: Diagnostic) {
  if (diagnostic.line === undefined) {
    return "";
  }
  return diagnostic.column === undefined
    ? String(diagnostic.line)
    : `${diagnostic.line}:${diagnostic.column}`;
}

const isHelpLine = (line: string) => /^(?:help|hint):/i.test(line);

/**
 * Splits an LSP message into its primary text and the hint lines a linter tacks on (oxlint sends
 * `"<message>\nhelp: <fix>"`). Only explicit `help:`/`hint:` lines become help; every other line,
 * including continuation lines of a multi-line diagnostic (e.g. tsc's "not assignable" detail),
 * stays in the summary so no primary text is lost. Blank lines are dropped.
 */
export function splitDiagnosticMessage(message: string) {
  const lines = message
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  return {
    help: lines.filter(isHelpLine),
    summary: lines.filter((line) => !isHelpLine(line)).join(" "),
  };
}

const sourceLabels: Record<string, string> = { typescript: "tsc" };

/**
 * The short tag shown in the panel's right column. The LSP `source` is kept verbatim on the
 * diagnostic; only the display is shortened, and only where the server reports a long name (`oxc`,
 * `eslint` are already short).
 */
export function sourceLabel(source: string) {
  return sourceLabels[source] ?? source;
}

const severityOrder = { error: 0, info: 2, warning: 1 } as const;

/**
 * Builds the grouped, ordered row list. Checker-process failures lead, under a single header; then
 * diagnostics group by file, with groups ordered by their worst contained severity (then path) so
 * the most important findings stay at the top, and findings ordered by line within a file.
 * `findings` lets the caller pass an already-computed `allFindings(state)` (the state layer derives
 * both from one memo) instead of paying the full-sort twice per checker update.
 */
export function buildProblemItems(
  state: CheckerState,
  findings: Diagnostic[] = allFindings(state),
): ProblemItem[] {
  const items: ProblemItem[] = [];

  // A failed server stamps the same message onto every file it covers, so collect every failed
  // File's message but show each distinct failure once (a `Set` dedupes the repeats) rather than
  // The first file's alone.
  const failureMessages = checkerNames.flatMap((checker) => {
    const messages = [...state[checker].values()]
      .filter((fileState) => fileState.status === "failed")
      .map((fileState) => fileState.message)
      .filter((message): message is string => message !== undefined);
    return [...new Set(messages)].map((message) => ({ checker, message }));
  });

  if (failureMessages.length > 0) {
    items.push({ kind: "failure-header" });
    failureMessages.forEach(({ checker, message }) => {
      message
        .split("\n")
        .filter((line) => line.trim() !== "")
        .forEach((line, lineIndex) => {
          items.push({
            checker,
            isFirst: lineIndex === 0,
            kind: "failure",
            line,
          });
        });
    });
  }

  const groups = [...Map.groupBy(findings, (diagnostic) => diagnostic.path).entries()]
    .map(([path, diagnostics]) => {
      const counts = countBySeverity(diagnostics);
      const worst = counts.errors > 0 ? 0 : counts.warnings > 0 ? 1 : 2;
      return {
        counts,
        diagnostics: diagnostics.toSorted(
          (a, b) =>
            (a.line ?? Number.MAX_SAFE_INTEGER) - (b.line ?? Number.MAX_SAFE_INTEGER) ||
            (a.column ?? 0) - (b.column ?? 0) ||
            severityOrder[a.severity] - severityOrder[b.severity],
        ),
        path,
        worst,
      };
    })
    .toSorted((a, b) => a.worst - b.worst || a.path.localeCompare(b.path));

  groups.forEach((group) => {
    // The blank line between groups is a real row, so the windowed renderer can
    // Treat every item as exactly one terminal row.
    if (items.length > 0) {
      items.push({ kind: "spacer" });
    }
    items.push({
      errors: group.counts.errors,
      info: group.counts.info,
      kind: "file-header",
      path: group.path,
      warnings: group.counts.warnings,
    });
    const labelWidth = Math.max(
      1,
      ...group.diagnostics.map((diagnostic) => problemLocationLabel(diagnostic).length),
    );
    group.diagnostics.forEach((problem) => {
      const { help, summary } = splitDiagnosticMessage(problem.message);
      const owner = items.length;
      items.push({
        kind: "problem",
        labelWidth,
        problem,
        summary,
      });
      if (help.length > 0) {
        items.push({
          kind: "help",
          owner,
          text: help.join(" "),
        });
      }
    });
  });

  return items;
}

import type { Diagnostic } from "./diagnostics/checker";
import type { FileContent } from "./file/content";
import type { ChangedFile, Worktree } from "./git/model";
import type { ParsedDiffLine } from "./git/patch";

export function viewerTitle(
  selectedPath: string | undefined,
  selectedFile: ChangedFile | undefined,
  showFileContent: boolean,
  fileContent: FileContent | undefined,
) {
  if (selectedPath === undefined) {
    return "";
  }

  if (showFileContent) {
    const lines =
      fileContent?.kind === "text"
        ? ` · ${fileContent.lineCount} lines${fileContent.truncated ? " (truncated)" : ""}`
        : "";
    return `${selectedPath}${lines}`;
  }

  const rename = selectedFile?.oldPath === undefined ? "" : ` (from ${selectedFile.oldPath})`;
  const warnings =
    selectedFile === undefined || selectedFile.warnings.length === 0
      ? ""
      : ` !${selectedFile.warnings.join(",")}`;
  return `${selectedPath}${rename}  +${selectedFile?.additions ?? 0} -${selectedFile?.deletions ?? 0}${warnings}`;
}

export function worktreeLabel(worktree: Worktree) {
  return worktree.branch ?? `${worktree.head.slice(0, 7)} (detached)`;
}

export function placeholderText(content: FileContent | undefined) {
  if (content === undefined) {
    return "";
  }

  if (content.kind === "binary") {
    return "binary file";
  }

  if (content.kind === "too-large") {
    return `file too large (${Math.round(content.bytes / 1024)}kb) · f to load`;
  }

  return "file not found";
}

export function kindLetter(kind: ChangedFile["kind"]) {
  if (kind === "untracked") {
    return "U";
  }

  if (kind === "added") {
    return "A";
  }

  if (kind === "deleted") {
    return "D";
  }

  if (kind === "renamed") {
    return "R";
  }

  return "M";
}

export function nearestNavigableIndex(lines: ParsedDiffLine[], target: number) {
  let best = -1;
  let bestDistance = Number.POSITIVE_INFINITY;
  lines.forEach((line, index) => {
    const reference = line.newLine ?? line.oldLine;
    if (reference === undefined) {
      return;
    }

    const distance = Math.abs(reference - target);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = index;
    }
  });

  return best;
}

export function orderedFindingPaths(problems: Diagnostic[]) {
  return [...new Set(problems.map((problem) => problem.path))];
}

export function nextFindingPath(paths: string[], selectedPath: string | undefined) {
  if (paths.length === 0) {
    return undefined;
  }

  const current = selectedPath === undefined ? -1 : paths.indexOf(selectedPath);
  return paths[(current + 1) % paths.length];
}

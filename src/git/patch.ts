import type { CopyReferencePayload } from "../clipboard/reference";

export interface ParsedDiffLine {
  type: "context" | "add" | "remove";
  oldLine?: number;
  newLine?: number;
  content: string;
  raw: string;
}

interface ParsedHunk {
  index: number;
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: ParsedDiffLine[];
}

export interface ParsedPatch {
  header: string[];
  hunks: ParsedHunk[];
}

const hunkPattern =
  /^@@ -(?<oldStart>\d+)(?:,(?<oldLines>\d+))? \+(?<newStart>\d+)(?:,(?<newLines>\d+))? @@/;

export function parsePatch(diff: string): ParsedPatch {
  const header: string[] = [];
  const hunks: ParsedHunk[] = [];
  let current: ParsedHunk | undefined;
  let oldLine = 0;
  let newLine = 0;
  // The @@ header's line counts say exactly how much body follows; while they
  // Are unspent, every -/+/space line is content — even raw "---…"/"+++…",
  // Which only mark file headers between hunks (e.g. a removed "-- comment")
  let remainingOld = 0;
  let remainingNew = 0;

  for (const raw of diff.split("\n")) {
    if (current !== undefined && (remainingOld > 0 || remainingNew > 0)) {
      if (raw.startsWith("+")) {
        current.lines.push({ content: raw.slice(1), newLine, raw, type: "add" });
        newLine += 1;
        remainingNew -= 1;
        continue;
      }

      if (raw.startsWith("-")) {
        current.lines.push({ content: raw.slice(1), oldLine, raw, type: "remove" });
        oldLine += 1;
        remainingOld -= 1;
        continue;
      }

      if (raw.startsWith(" ")) {
        current.lines.push({ content: raw.slice(1), newLine, oldLine, raw, type: "context" });
        oldLine += 1;
        newLine += 1;
        remainingOld -= 1;
        remainingNew -= 1;
        continue;
      }

      if (raw.startsWith("\\")) {
        // "\ No newline at end of file" annotates the previous line
        continue;
      }

      // Anything else means the counts were inconsistent; close the hunk
      remainingOld = 0;
      remainingNew = 0;
    }

    const hunkMatch = hunkPattern.exec(raw);
    if (hunkMatch !== null) {
      current = {
        header: raw,
        index: hunks.length,
        lines: [],
        newLines: Number.parseInt(hunkMatch.groups?.newLines ?? "1", 10),
        newStart: Number.parseInt(hunkMatch.groups?.newStart ?? "0", 10),
        oldLines: Number.parseInt(hunkMatch.groups?.oldLines ?? "1", 10),
        oldStart: Number.parseInt(hunkMatch.groups?.oldStart ?? "0", 10),
      };
      oldLine = current.oldStart;
      newLine = current.newStart;
      remainingOld = current.oldLines;
      remainingNew = current.newLines;
      hunks.push(current);
      continue;
    }

    if (hunks.length === 0 && raw !== "") {
      header.push(raw);
    }
  }

  return { header, hunks };
}

export function lineReference(path: string, line: ParsedDiffLine): CopyReferencePayload {
  return { line: line.newLine ?? line.oldLine, path, snippet: line.content };
}

export function renderPatch(diff: string, options: { full: boolean; maxLines: number }) {
  const parsed = parsePatch(diff);
  if (parsed.hunks.length === 0) {
    return { bodyLineCount: 0, diff, parsed, truncated: false };
  }

  const lines: string[] = [...parsed.header];
  let emittedBodyLines = 0;
  let truncated = false;

  for (const hunk of parsed.hunks) {
    if (!options.full && emittedBodyLines >= options.maxLines) {
      truncated = true;
      break;
    }

    lines.push(hunk.header);

    for (const line of hunk.lines) {
      if (!options.full && emittedBodyLines >= options.maxLines) {
        truncated = true;
        break;
      }

      lines.push(line.raw);
      emittedBodyLines += 1;
    }

    if (truncated) {
      break;
    }
  }

  return { bodyLineCount: emittedBodyLines, diff: lines.join("\n"), parsed, truncated };
}

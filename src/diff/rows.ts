import type { RenderSpan } from "./hast";

type DiffLineType = "context" | "add" | "remove";

// Structural subset of `@pierre/diffs` FileDiffMetadata that the row builder
// Reads. The real metadata satisfies this, and the narrower shape keeps this
// Module dependency-free and directly testable.
type HunkContentInput =
  | { type: "context"; lines: number; additionLineIndex: number; deletionLineIndex: number }
  | {
      type: "change";
      additions: number;
      deletions: number;
      additionLineIndex: number;
      deletionLineIndex: number;
    };

interface HunkInput {
  collapsedBefore: number;
  additionStart: number;
  deletionStart: number;
  hunkContent: HunkContentInput[];
}

export interface DiffMetaInput {
  hunks: HunkInput[];
  additionLines: string[];
  deletionLines: string[];
}

export type DiffRow =
  | { kind: "separator"; text: string; count: number }
  | {
      kind: "line";
      navIndex: number;
      type: DiffLineType;
      oldLine?: number;
      newLine?: number;
      spans: RenderSpan[];
    }
  // A collapsed region placeholder produced by `applyCollapsedRegions`, never by
  // `buildDiffRows`: a user fold (▸ N lines folded) or an expandable git-elided gap
  // (⋯ N unmodified lines). Non-navigable, so the caret skips it like a separator.
  | {
      kind: "marker";
      regionKind: "fold" | "gap";
      key: string;
      count: number;
      /** A collapsed gap/fold shows its "expand" affordance; an expanded gap shows "hide". */
      collapsed: boolean;
    };

export type DiffLineRow = Extract<DiffRow, { kind: "line" }>;

export interface NavigableLine {
  type: DiffLineType;
  oldLine?: number;
  newLine?: number;
  content: string;
}

export interface BuiltDiff {
  rows: DiffRow[];
  /** Line rows dropped by the `maxLines` cap (0 when the whole diff fit). */
  hiddenLines: number;
}

export function isLineRow(row: DiffRow): row is DiffLineRow {
  return row.kind === "line";
}

function stripNewline(text: string) {
  return text.endsWith("\n") ? text.slice(0, -1) : text;
}

function collapsedLabel(count: number) {
  return count === 1 ? "1 unmodified line" : `${count} unmodified lines`;
}

function spansAt(spans: RenderSpan[][], lines: string[], index: number): RenderSpan[] {
  const highlighted = spans[index];
  if (highlighted !== undefined && highlighted.length > 0) {
    return highlighted;
  }

  return [{ text: stripNewline(lines[index] ?? "") }];
}

/**
 * Build the unified row stream from `@pierre/diffs` metadata plus the flattened per-line spans
 * (index-aligned to `meta.additionLines`/`deletionLines`). Line rows carry a contiguous `navIndex`
 * so the cursor, diagnostics, and find can index navigable lines exactly as the old parsed-patch
 * model did. Body (line) rows are capped at `maxLines` unless `full`, mirroring the previous
 * viewer.
 */
export function buildDiffRows(
  meta: DiffMetaInput,
  addSpans: RenderSpan[][],
  delSpans: RenderSpan[][],
  options: { full: boolean; maxLines: number },
): BuiltDiff {
  const rows: DiffRow[] = [];
  let navIndex = 0;

  const pushLine = (
    type: DiffLineType,
    oldLine: number | undefined,
    newLine: number | undefined,
    spans: RenderSpan[],
  ) => {
    rows.push({ kind: "line", navIndex, newLine, oldLine, spans, type });
    navIndex += 1;
  };

  for (const hunk of meta.hunks) {
    // The count of unchanged lines git collapsed before this hunk; rendered as a
    // Separator so the gutter's line-number jump isn't read as contiguous. Zero
    // (a hunk at line 1, e.g. the whole-file context patch) gets no separator.
    if (hunk.collapsedBefore > 0) {
      rows.push({
        count: hunk.collapsedBefore,
        kind: "separator",
        text: collapsedLabel(hunk.collapsedBefore),
      });
    }
    let oldLine = hunk.deletionStart;
    let newLine = hunk.additionStart;

    for (const content of hunk.hunkContent) {
      if (content.type === "context") {
        for (let offset = 0; offset < content.lines; offset += 1) {
          const index = content.additionLineIndex + offset;
          pushLine("context", oldLine, newLine, spansAt(addSpans, meta.additionLines, index));
          oldLine += 1;
          newLine += 1;
        }
        continue;
      }

      for (let offset = 0; offset < content.deletions; offset += 1) {
        const index = content.deletionLineIndex + offset;
        pushLine("remove", oldLine, undefined, spansAt(delSpans, meta.deletionLines, index));
        oldLine += 1;
      }

      for (let offset = 0; offset < content.additions; offset += 1) {
        const index = content.additionLineIndex + offset;
        pushLine("add", undefined, newLine, spansAt(addSpans, meta.additionLines, index));
        newLine += 1;
      }
    }
  }

  if (options.full) {
    return { hiddenLines: 0, rows };
  }

  let body = 0;
  for (let index = 0; index < rows.length; index += 1) {
    if (rows[index]?.kind !== "line") {
      continue;
    }
    body += 1;
    if (body > options.maxLines) {
      return {
        hiddenLines: rows.slice(index).filter((row) => row.kind === "line").length,
        rows: rows.slice(0, index),
      };
    }
  }

  return { hiddenLines: 0, rows };
}

/** The navigable (cursorable) lines in order; `navIndex` equals array position. */
export function navigableLinesFromRows(rows: DiffRow[]): NavigableLine[] {
  return rows.filter(isLineRow).map((row) => ({
    content: row.spans.map((span) => span.text).join(""),
    newLine: row.newLine,
    oldLine: row.oldLine,
    type: row.type,
  }));
}

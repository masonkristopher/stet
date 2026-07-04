import type { RenderSpan } from "./hast";
import { navigableLinesFromRows } from "./rows";
import type { DiffRow, NavigableLine } from "./rows";

/**
 * A collapsible region computed from indentation: a header line whose following lines are more
 * indented. `headerNavIndex`/`endNavIndex` are positions in the navigable (line-only) list the
 * region is computed over; `count` is the body line count hidden when the region folds (the header
 * stays). The `key` is side-qualified by the header's own line number so it survives the phase-1 ->
 * phase-2 highlight swap and matches whether it is computed over the raw or the collapsed set.
 */
export interface FoldRegion {
  key: string;
  headerNavIndex: number;
  endNavIndex: number;
  count: number;
}

/** Full source of a file's one side, so an expanded gap can be filled with its unchanged lines. */
export interface GapSource {
  lines: string[];
}

export function foldKey(line: NavigableLine) {
  return line.newLine === undefined ? `fold:o${line.oldLine}` : `fold:n${line.newLine}`;
}

function indentWidth(content: string) {
  return content.length - content.trimStart().length;
}

function isBlank(content: string) {
  return content.trim().length === 0;
}

/**
 * Indent-based fold regions over a navigable line list. Every non-blank line whose following
 * non-blank lines are more indented heads a region running to the last such line (interior blanks
 * fold with it, trailing blanks do not). Nesting falls out naturally: an inner block heads its own
 * region inside its parent's. Pure and language-agnostic, mirroring `flattenTree`.
 */
export function computeFoldRegions(navigable: NavigableLine[]): FoldRegion[] {
  const regions: FoldRegion[] = [];

  for (let index = 0; index < navigable.length; index += 1) {
    const header = navigable[index];
    if (header === undefined || isBlank(header.content)) {
      continue;
    }

    const headerIndent = indentWidth(header.content);
    let end = index;
    for (let scan = index + 1; scan < navigable.length; scan += 1) {
      const scanned = navigable[scan];
      if (scanned === undefined) {
        break;
      }
      if (isBlank(scanned.content)) {
        continue;
      }
      if (indentWidth(scanned.content) > headerIndent) {
        end = scan;
        continue;
      }
      break;
    }

    if (end > index) {
      regions.push({
        count: end - index,
        endNavIndex: end,
        headerNavIndex: index,
        key: foldKey(header),
      });
    }
  }

  return regions;
}

const ATX_HEADING = /^ {0,3}(?<hashes>#{1,6})(?:\s|$)/;
const CODE_FENCE = /^ {0,3}(?:```|~~~)/;

function headingLevel(content: string) {
  return ATX_HEADING.exec(content)?.groups?.hashes.length ?? 0;
}

/**
 * Heading-based fold regions for markdown. A section headed by an ATX heading (`#`..`######`) folds
 * down to the last line before the next heading of the same or higher level (or the end); nesting
 * falls out the same way indent regions nest. Fences are tracked so a `#` inside a code block is
 * not read as a heading. Same `FoldRegion`/`foldKey` shape as `computeFoldRegions`, so every caller
 * and the fold `Set` are unchanged. Indent-based folding does almost nothing here (markdown sits at
 * column 0), so this is the language-aware alternative.
 */
export function computeMarkdownFoldRegions(navigable: NavigableLine[]): FoldRegion[] {
  const inFence: boolean[] = [];
  let fenced = false;
  for (let index = 0; index < navigable.length; index += 1) {
    inFence[index] = fenced;
    if (CODE_FENCE.test(navigable[index]?.content ?? "")) {
      fenced = !fenced;
    }
  }

  const levelAt = (index: number) => {
    const line = navigable[index];
    return line === undefined || inFence[index] ? 0 : headingLevel(line.content);
  };

  const regions: FoldRegion[] = [];
  for (let index = 0; index < navigable.length; index += 1) {
    const level = levelAt(index);
    if (level === 0) {
      continue;
    }
    let end = index;
    for (let scan = index + 1; scan < navigable.length; scan += 1) {
      const scanLevel = levelAt(scan);
      if (scanLevel > 0 && scanLevel <= level) {
        break;
      }
      end = scan;
    }
    // Trailing blank lines belong to the gap before the next heading, not the section.
    while (end > index && isBlank(navigable[end]?.content ?? "")) {
      end -= 1;
    }
    const header = navigable[index];
    if (end > index && header !== undefined) {
      regions.push({
        count: end - index,
        endNavIndex: end,
        headerNavIndex: index,
        key: foldKey(header),
      });
    }
  }

  return regions;
}

export type FoldMode = "indent" | "markdown";

/** Pick the region model for a file's language: heading-based for markdown, else indentation. */
export function foldRegionsFor(navigable: NavigableLine[], mode: FoldMode) {
  return mode === "markdown"
    ? computeMarkdownFoldRegions(navigable)
    : computeFoldRegions(navigable);
}

function nextLineRow(rows: DiffRow[], from: number) {
  for (let index = from; index < rows.length; index += 1) {
    const row = rows[index];
    if (row?.kind === "line") {
      return row;
    }
  }
  return undefined;
}

interface ApplyOptions {
  folded: ReadonlySet<string>;
  expandedGaps: ReadonlySet<string>;
  gapSource?: GapSource;
  mode?: FoldMode;
}

/**
 * Rewrite the row stream for the current collapsed state: drop folded bodies behind a fold marker,
 * and turn each git-elided separator into a gap marker (or, when expanded and a source is loaded,
 * the revealed unchanged lines behind a "hide" marker). `navIndex` is re-densified over the
 * surviving/added line rows and `navigable` rebuilt, so the caret indexes only visible lines and
 * can never land inside a collapsed region. Markers are non-navigable, exactly like the separators
 * they replace.
 */
export function applyCollapsedRegions(rows: DiffRow[], options: ApplyOptions) {
  const foldedRegions = foldRegionsFor(
    navigableLinesFromRows(rows),
    options.mode ?? "indent",
  ).filter((region) => options.folded.has(region.key));
  const regionByHeader = new Map(foldedRegions.map((region) => [region.headerNavIndex, region]));

  const out: DiffRow[] = [];
  let navIndex = 0;
  let skipUntil = -1;
  let gapOrdinal = 0;

  const pushLine = (
    type: NavigableLine["type"],
    oldLine: number | undefined,
    newLine: number | undefined,
    spans: RenderSpan[],
  ) => {
    out.push({ kind: "line", navIndex, newLine, oldLine, spans, type });
    navIndex += 1;
  };

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (row === undefined) {
      continue;
    }

    if (row.kind === "separator") {
      const key = `gap:${gapOrdinal}`;
      gapOrdinal += 1;
      const following = nextLineRow(rows, index + 1);
      // A gap can sit inside a fold region that spans an elided middle (edits at both
      // Ends of a block); hide it with the folded body. Its ordinal stays reserved
      // Above so the remaining gap keys don't shift when the region unfolds.
      if (following !== undefined && following.navIndex <= skipUntil) {
        continue;
      }
      const canReveal =
        options.expandedGaps.has(key) &&
        options.gapSource !== undefined &&
        following?.newLine !== undefined &&
        following.oldLine !== undefined;

      if (canReveal && following?.newLine !== undefined && following.oldLine !== undefined) {
        out.push({ collapsed: false, count: row.count, key, kind: "marker", regionKind: "gap" });
        const firstNew = following.newLine - row.count;
        const firstOld = following.oldLine - row.count;
        for (let offset = 0; offset < row.count; offset += 1) {
          const source = options.gapSource?.lines[firstNew - 1 + offset] ?? "";
          pushLine("context", firstOld + offset, firstNew + offset, [{ text: source }]);
        }
        continue;
      }

      out.push({ collapsed: true, count: row.count, key, kind: "marker", regionKind: "gap" });
      continue;
    }

    if (row.kind !== "line") {
      out.push(row);
      continue;
    }

    if (row.navIndex <= skipUntil) {
      continue;
    }

    pushLine(row.type, row.oldLine, row.newLine, row.spans);

    const region = regionByHeader.get(row.navIndex);
    if (region !== undefined) {
      out.push({
        collapsed: true,
        count: region.count,
        key: region.key,
        kind: "marker",
        regionKind: "fold",
      });
      skipUntil = region.endNavIndex;
    }
  }

  return { navigable: navigableLinesFromRows(out), rows: out };
}

/**
 * After a toggle changes which lines are navigable, keep the caret on the same file line; if that
 * line was hidden by a fold, fall back to the nearest visible line above it (the fold header). Same
 * "store as a file line, map it back" idea the navigation history uses.
 */
export function remapCursorAfterToggle(
  previous: NavigableLine[],
  cursorIndex: number,
  next: NavigableLine[],
) {
  const anchor = previous[cursorIndex];
  if (anchor === undefined) {
    return Math.max(0, Math.min(cursorIndex, next.length - 1));
  }

  const sameLine = (line: NavigableLine) =>
    anchor.newLine === undefined
      ? line.oldLine === anchor.oldLine && line.newLine === undefined
      : line.newLine === anchor.newLine;

  const exact = next.findIndex(sameLine);
  if (exact !== -1) {
    return exact;
  }

  const anchorKey = anchor.newLine ?? anchor.oldLine ?? 0;
  let fallback = 0;
  for (let index = 0; index < next.length; index += 1) {
    const line = next[index];
    if (line === undefined) {
      continue;
    }
    if ((line.newLine ?? line.oldLine ?? 0) <= anchorKey) {
      fallback = index;
      continue;
    }
    break;
  }
  return fallback;
}

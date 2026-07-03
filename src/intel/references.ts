/**
 * Attach a source-line preview to each reference location, so the results overlay can show
 * `path:line:col` alongside the line it points at. Pure (no Effect/Solid), so it unit-tests like
 * `intel/protocol.ts`; the caller reads each file's text and hands over a path-keyed map of its
 * lines.
 */
import type { NormalizedLocation } from "./protocol";

export interface ReferenceResult extends NormalizedLocation {
  /** The referenced source line, leading whitespace trimmed; empty when unavailable. */
  text: string;
}

/** One row of the overlay list: a per-file header, or a match carrying its `results` index. */
export type ReferenceRow =
  | { kind: "header"; path: string }
  | { kind: "match"; index: number; match: ReferenceResult };

// Flatten results into the overlay's row list, a header before each file's first match then
// One row per match. The match keeps its `results` index (the cursor space), so the windowed
// List drives selection and scroll off row position while jumps still address results directly.
// Pure like `attachReferencePreviews`, so the window math unit-tests without a renderer.
//
// Precondition: `results` must already be grouped by path (a header opens on every path change,
// Comparing only the previous element), so unsorted input would emit duplicate headers for the
// Same file. Callers sort with `toSorted(byReferenceOrder)` before `attachReferencePreviews`.
export function buildReferenceRows(results: ReferenceResult[]): ReferenceRow[] {
  return results.flatMap((match, index) =>
    index === 0 || results[index - 1]?.path !== match.path
      ? [
          { kind: "header", path: match.path },
          { index, kind: "match", match },
        ]
      : [{ index, kind: "match", match }],
  );
}

// The overlay groups by file (a header per path run) and sizes its scrollbox by
// `rows + files`, both of which assume results are contiguous by path. The LSP does not
// Promise that order, so sort by path then position to make grouping deterministic.
export function byReferenceOrder(a: NormalizedLocation, b: NormalizedLocation) {
  return a.path.localeCompare(b.path) || a.line - b.line || a.column - b.column;
}

// A location whose file was unreadable (absent from `linesByPath`) or whose 1-based line
// Is out of range still gets a row, just with an empty preview, rather than being dropped.
function previewLine(lines: string[] | undefined, line: number): string {
  return lines?.[line - 1]?.trimStart() ?? "";
}

export function attachReferencePreviews(
  locations: NormalizedLocation[],
  linesByPath: Map<string, string[]>,
): ReferenceResult[] {
  return locations.map((location) => ({
    ...location,
    text: previewLine(linesByPath.get(location.path), location.line),
  }));
}

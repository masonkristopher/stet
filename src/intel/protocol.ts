/**
 * LSP wire types for code-intelligence replies and the mapping onto sideye's `NormalizedLocation`.
 * Pure (no Effect/Solid), so it unit-tests like `git/tree`. The 1-based line/column mirror
 * `diagnostics/protocol.ts` so a result flows straight into a `JumpTarget`.
 */
import { fileURLToPath } from "node:url";

interface LspPosition {
  line: number;
  character: number;
}

interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

interface LspLocation {
  uri: string;
  range: LspRange;
}

interface LspLocationLink {
  targetUri: string;
  targetRange: LspRange;
  targetSelectionRange?: LspRange;
}

// A `CallHierarchyItem`: the two-step pull carries the prepared item back to the resolve request
// Verbatim, so `data` (opaque, server-defined) must ride along untouched or the resolve loses the
// Server's anchor.
interface LspHierarchyItem {
  name: string;
  kind: number;
  uri: string;
  range: LspRange;
  selectionRange: LspRange;
  detail?: string;
  data?: unknown;
}

export interface NormalizedLocation {
  path: string;
  /** 1-based (LSP positions are 0-based). */
  line: number;
  /** 1-based start column (LSP `character` is a 0-based UTF-16 offset). */
  column: number;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isPosition(value: unknown): value is LspPosition {
  return isObject(value) && typeof value.line === "number" && typeof value.character === "number";
}

function isRange(value: unknown): value is LspRange {
  return isObject(value) && isPosition(value.start) && isPosition(value.end);
}

function isLocation(value: unknown): value is LspLocation {
  return isObject(value) && typeof value.uri === "string" && isRange(value.range);
}

function isLocationLink(value: unknown): value is LspLocationLink {
  return (
    isObject(value) &&
    typeof value.targetUri === "string" &&
    isRange(value.targetRange) &&
    // `targetSelectionRange` is optional, but a present-but-malformed one would crash the `.start`
    // Read in `mapItem`; require it to be a valid range when supplied so the link is skipped instead.
    (value.targetSelectionRange === undefined || isRange(value.targetSelectionRange))
  );
}

function locationFrom(uri: string, start: LspPosition): NormalizedLocation | undefined {
  // A server may point at a non-file resource (e.g. `untitled:`, `jdt://`); `fileURLToPath` throws
  // On those, so skip them and let the other results through rather than aborting the whole reply.
  if (!uri.startsWith("file:")) {
    return undefined;
  }
  return { column: start.character + 1, line: start.line + 1, path: fileURLToPath(uri) };
}

function mapItem(item: unknown): NormalizedLocation | undefined {
  if (isLocation(item)) {
    return locationFrom(item.uri, item.range.start);
  }
  // A `LocationLink` points at the symbol's name range (`targetSelectionRange`) when present,
  // Falling back to the whole declaration (`targetRange`).
  if (isLocationLink(item)) {
    return locationFrom(item.targetUri, (item.targetSelectionRange ?? item.targetRange).start);
  }
  return undefined;
}

function isNormalized(value: NormalizedLocation | undefined): value is NormalizedLocation {
  return value !== undefined;
}

/** `textDocument/definition` replies with a single `Location`, a list, a `LocationLink[]`, or null. */
export function normalizeDefinition(reply: unknown): NormalizedLocation[] {
  if (Array.isArray(reply)) {
    return reply.map(mapItem).filter(isNormalized);
  }
  const single = mapItem(reply);
  return single === undefined ? [] : [single];
}

/** `textDocument/references` replies with a `Location[]` or null (never a single or a link). */
export function normalizeReferences(reply: unknown): NormalizedLocation[] {
  return Array.isArray(reply) ? reply.map(mapItem).filter(isNormalized) : [];
}

function isHierarchyItem(value: unknown): value is LspHierarchyItem {
  return (
    isObject(value) &&
    typeof value.name === "string" &&
    typeof value.kind === "number" &&
    typeof value.uri === "string" &&
    isRange(value.range) &&
    isRange(value.selectionRange)
  );
}

// A hierarchy row jumps to the symbol's name (`selectionRange`), like an outline entry, not to the
// Whole declaration or an individual call site: one row per related symbol, navigable to it.
function hierarchyItemLocation(item: LspHierarchyItem): NormalizedLocation | undefined {
  return locationFrom(item.uri, item.selectionRange.start);
}

/**
 * `textDocument/prepareCallHierarchy` replies with a `CallHierarchyItem[]` or null. Returns the
 * first item verbatim (its opaque `data` intact) to feed the resolve step, or undefined when the
 * caret is not on a resolvable symbol so the caller degrades to empty.
 */
export function firstHierarchyItem(reply: unknown): LspHierarchyItem | undefined {
  return Array.isArray(reply) ? reply.find(isHierarchyItem) : undefined;
}

// Incoming calls wrap the caller under `from`, outgoing calls the callee under `to`; both carry the
// Call-site ranges (`fromRanges`) we don't surface, since each row is the related symbol itself.
function normalizeCalls(reply: unknown, key: "from" | "to"): NormalizedLocation[] {
  if (!Array.isArray(reply)) {
    return [];
  }
  return reply
    .map((call) =>
      isObject(call) && isHierarchyItem(call[key]) ? hierarchyItemLocation(call[key]) : undefined,
    )
    .filter(isNormalized);
}

/** `callHierarchy/incomingCalls` replies with a `CallHierarchyIncomingCall[]` (`{ from }`) or null. */
export function normalizeIncomingCalls(reply: unknown): NormalizedLocation[] {
  return normalizeCalls(reply, "from");
}

/** `callHierarchy/outgoingCalls` replies with a `CallHierarchyOutgoingCall[]` (`{ to }`) or null. */
export function normalizeOutgoingCalls(reply: unknown): NormalizedLocation[] {
  return normalizeCalls(reply, "to");
}

/**
 * One piece of a hover reply: a fenced code block (carrying its language, for syntax highlighting)
 * or a run of prose. The fence delimiters themselves are dropped; the card highlights code segments
 * and renders prose plain.
 */
export type HoverSegment =
  | { kind: "code"; lang: string | undefined; lines: string[] }
  | { kind: "prose"; lines: string[] };

function trimBlankEdges(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start]?.trim() === "") {
    start += 1;
  }
  while (end > start && lines[end - 1]?.trim() === "") {
    end -= 1;
  }
  return lines.slice(start, end);
}

// Split a markdown string into ordered code-fence and prose segments. A line whose
// First non-space is ``` toggles code mode; the opening fence's info string is the
// Code language, and the fence lines themselves are dropped.
function markdownSegments(text: string): HoverSegment[] {
  const segments: HoverSegment[] = [];
  let prose: string[] = [];
  let code: string[] | undefined;
  let lang: string | undefined;
  const flushProse = () => {
    const lines = trimBlankEdges(prose);
    if (lines.length > 0) {
      segments.push({ kind: "prose", lines });
    }
    prose = [];
  };
  for (const line of text.split("\n")) {
    if (line.trimStart().startsWith("```")) {
      if (code === undefined) {
        flushProse();
        lang = line.trimStart().slice(3).trim() || undefined;
        code = [];
      } else {
        segments.push({ kind: "code", lang, lines: trimBlankEdges(code) });
        code = undefined;
        lang = undefined;
      }
      continue;
    }
    (code ?? prose).push(line);
  }
  // An unterminated fence (a malformed reply) still yields its code.
  if (code !== undefined) {
    segments.push({ kind: "code", lang, lines: trimBlankEdges(code) });
  }
  flushProse();
  return segments;
}

function segmentsFromItem(item: unknown): HoverSegment[] {
  if (typeof item === "string") {
    return markdownSegments(item);
  }
  if (!isObject(item)) {
    return [];
  }
  // A `MarkedString` code segment carries its own language and is not fenced.
  if (typeof item.language === "string" && typeof item.value === "string") {
    return [
      {
        kind: "code",
        lang: item.language || undefined,
        lines: trimBlankEdges(item.value.split("\n")),
      },
    ];
  }
  // A `MarkupContent`: markdown may carry fences, plaintext is prose.
  if (typeof item.value === "string") {
    return item.kind === "markdown"
      ? markdownSegments(item.value)
      : [{ kind: "prose", lines: trimBlankEdges(item.value.split("\n")) }];
  }
  return [];
}

/**
 * `textDocument/hover` replies with `{ contents, range? }` or null, where `contents` is a
 * `MarkupContent`, a `MarkedString`, or a `MarkedString[]`. Parsed into ordered code/prose
 * segments; an empty array means there is nothing to show.
 */
export function parseHover(reply: unknown): HoverSegment[] {
  if (!isObject(reply)) {
    return [];
  }
  const { contents } = reply;
  const items = Array.isArray(contents) ? contents : [contents];
  return items.flatMap(segmentsFromItem).filter((segment) => segment.lines.length > 0);
}

/**
 * LSP `SymbolKind` (the numeric enum from the spec). Kept as a plain object of named constants
 * rather than a TS `enum` so it stays a pure value with no emit; the overlay maps each number to a
 * codicon/label without importing anything runtime-heavy.
 */
export const SymbolKind = {
  Array: 18,
  Boolean: 17,
  Class: 5,
  Constant: 14,
  Constructor: 9,
  Enum: 10,
  EnumMember: 22,
  Event: 24,
  Field: 8,
  File: 1,
  Function: 12,
  Interface: 11,
  Key: 20,
  Method: 6,
  Module: 2,
  Namespace: 3,
  Null: 21,
  Number: 16,
  Object: 19,
  Operator: 25,
  Package: 4,
  Property: 7,
  String: 15,
  Struct: 23,
  TypeParameter: 26,
  Variable: 13,
} as const;

/** One flattened outline entry: a symbol with its 1-based name position and its nesting depth. */
export interface NormalizedSymbol {
  name: string;
  /**
   * The LSP `SymbolKind` number (see `SymbolKind`); an unknown kind renders with the fallback
   * glyph.
   */
  kind: number;
  /** 1-based line of the symbol's name (LSP positions are 0-based). */
  line: number;
  /** 1-based start column of the symbol's name. */
  column: number;
  /** Nesting level in the outline; 0 for a top-level symbol, +1 per parent. */
  depth: number;
}

interface LspDocumentSymbol {
  name: string;
  kind: number;
  range: LspRange;
  selectionRange: LspRange;
  children?: unknown;
}

interface LspSymbolInformation {
  name: string;
  kind: number;
  location: LspLocation;
}

function isDocumentSymbol(value: unknown): value is LspDocumentSymbol {
  return (
    isObject(value) &&
    typeof value.name === "string" &&
    typeof value.kind === "number" &&
    isRange(value.range) &&
    isRange(value.selectionRange)
  );
}

function isSymbolInformation(value: unknown): value is LspSymbolInformation {
  return (
    isObject(value) &&
    typeof value.name === "string" &&
    typeof value.kind === "number" &&
    isLocation(value.location)
  );
}

// Order symbols by their name position: the LSP does not promise document order, and the outline
// Reads top-to-bottom by where each symbol sits, not by reply order.
function bySymbolPosition(a: NormalizedSymbol, b: NormalizedSymbol) {
  return a.line - b.line || a.column - b.column;
}

function byDocumentSymbolPosition(a: LspDocumentSymbol, b: LspDocumentSymbol) {
  return (
    a.selectionRange.start.line - b.selectionRange.start.line ||
    a.selectionRange.start.character - b.selectionRange.start.character
  );
}

// A hierarchical `DocumentSymbol` carries its own name range (`selectionRange`) and may nest
// Children; flatten pre-order so a parent precedes its members, each child one level deeper.
// Siblings are sorted by position before recursing, so each subtree stays contiguous and ordered.
function flattenDocumentSymbol(symbol: LspDocumentSymbol, depth: number): NormalizedSymbol[] {
  const start = symbol.selectionRange.start;
  const self: NormalizedSymbol = {
    column: start.character + 1,
    depth,
    kind: symbol.kind,
    line: start.line + 1,
    name: symbol.name,
  };
  const children = Array.isArray(symbol.children)
    ? symbol.children.filter(isDocumentSymbol).toSorted(byDocumentSymbolPosition)
    : [];
  return [self, ...children.flatMap((child) => flattenDocumentSymbol(child, depth + 1))];
}

/**
 * `textDocument/documentSymbol` replies with a hierarchical `DocumentSymbol[]` (nested, the common
 * case) or a flat `SymbolInformation[]`, or null. Flattened pre-order into a depth-tagged,
 * position-ordered outline; unrecognized entries are skipped rather than aborting the reply.
 */
export function normalizeDocumentSymbols(reply: unknown): NormalizedSymbol[] {
  if (!Array.isArray(reply)) {
    return [];
  }
  const documentSymbols = reply.filter(isDocumentSymbol);
  if (documentSymbols.length > 0) {
    return documentSymbols
      .toSorted(byDocumentSymbolPosition)
      .flatMap((symbol) => flattenDocumentSymbol(symbol, 0));
  }
  // A flat `SymbolInformation[]` has no nesting; take each at depth 0 in position order.
  return reply
    .filter(isSymbolInformation)
    .map((item) => ({
      column: item.location.range.start.character + 1,
      depth: 0,
      kind: item.kind,
      line: item.location.range.start.line + 1,
      name: item.name,
    }))
    .toSorted(bySymbolPosition);
}

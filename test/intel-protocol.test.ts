import { expect, test } from "bun:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  firstHierarchyItem,
  normalizeDefinition,
  normalizeDocumentSymbols,
  normalizeIncomingCalls,
  normalizeOutgoingCalls,
  normalizeReferences,
  parseHover,
  SymbolKind,
} from "@/intel/protocol";

const uri = pathToFileURL("/repo/src/target.ts").href;
const path = fileURLToPath(uri);
const range = { end: { character: 9, line: 4 }, start: { character: 2, line: 4 } };

test("normalizeDefinition returns empty for null", () => {
  expect(normalizeDefinition(null)).toEqual([]);
});

test("normalizeDefinition maps a single Location to 1-based path:line:col", () => {
  expect(normalizeDefinition({ range, uri })).toEqual([{ column: 3, line: 5, path }]);
});

test("normalizeDefinition maps a Location array", () => {
  const other = {
    range: { end: { character: 1, line: 0 }, start: { character: 0, line: 0 } },
    uri,
  };
  expect(normalizeDefinition([{ range, uri }, other])).toEqual([
    { column: 3, line: 5, path },
    { column: 1, line: 1, path },
  ]);
});

test("normalizeDefinition prefers a LocationLink's targetSelectionRange over targetRange", () => {
  const link = {
    targetRange: { end: { character: 0, line: 10 }, start: { character: 0, line: 3 } },
    targetSelectionRange: range,
    targetUri: uri,
  };
  expect(normalizeDefinition([link])).toEqual([{ column: 3, line: 5, path }]);
});

test("normalizeDefinition falls back to a LocationLink's targetRange", () => {
  const link = { targetRange: range, targetUri: uri };
  expect(normalizeDefinition([link])).toEqual([{ column: 3, line: 5, path }]);
});

test("normalizeDefinition drops malformed items", () => {
  expect(normalizeDefinition([{ range, uri }, { nope: true }, null])).toEqual([
    { column: 3, line: 5, path },
  ]);
});

test("normalizeDefinition drops a LocationLink with a present-but-malformed targetSelectionRange", () => {
  // A non-nullish, non-range selection range must not reach the `.start` read; skip the link.
  const link = { targetRange: range, targetSelectionRange: 42, targetUri: uri };
  expect(normalizeDefinition([link, { range, uri }])).toEqual([{ column: 3, line: 5, path }]);
});

test("normalizeDefinition skips non-file URIs instead of throwing", () => {
  const untitled = { range, uri: "untitled:Untitled-1" };
  expect(normalizeDefinition([untitled, { range, uri }])).toEqual([{ column: 3, line: 5, path }]);
  expect(normalizeDefinition(untitled)).toEqual([]);
});

test("normalizeReferences maps a Location array and ignores a non-array reply", () => {
  expect(normalizeReferences([{ range, uri }])).toEqual([{ column: 3, line: 5, path }]);
  expect(normalizeReferences(null)).toEqual([]);
  expect(normalizeReferences({ range, uri })).toEqual([]);
});

test("parseHover returns an empty array for a null reply", () => {
  expect(parseHover(null)).toEqual([]);
});

test("parseHover reads a plaintext MarkupContent as prose", () => {
  expect(parseHover({ contents: { kind: "plaintext", value: "const alpha: number" } })).toEqual([
    { kind: "prose", lines: ["const alpha: number"] },
  ]);
});

test("parseHover reads a MarkedString code segment with its language", () => {
  expect(parseHover({ contents: { language: "typescript", value: "function f(): void" } })).toEqual(
    [{ kind: "code", lang: "typescript", lines: ["function f(): void"] }],
  );
});

test("parseHover splits a MarkedString array into code and prose, skipping empties", () => {
  expect(
    parseHover({ contents: [{ language: "typescript", value: "const a: 1" }, "", "Docs here."] }),
  ).toEqual([
    { kind: "code", lang: "typescript", lines: ["const a: 1"] },
    { kind: "prose", lines: ["Docs here."] },
  ]);
});

test("parseHover captures the fence language and drops the fence lines and blank runs", () => {
  const markdown = "```typescript\nconst alpha: number\n```\n\n\nA constant.";
  expect(parseHover({ contents: { kind: "markdown", value: markdown } })).toEqual([
    { kind: "code", lang: "typescript", lines: ["const alpha: number"] },
    { kind: "prose", lines: ["A constant."] },
  ]);
});

test("parseHover keeps a multi-line code block and a bare fence has no language", () => {
  const markdown = "```\nline one\nline two\n```";
  expect(parseHover({ contents: { kind: "markdown", value: markdown } })).toEqual([
    { kind: "code", lang: undefined, lines: ["line one", "line two"] },
  ]);
});

// A DocumentSymbol carries a whole-declaration `range` and a name-only `selectionRange`; the
// Normalizer reads the name position, so give the two different starts to prove it picks the latter.
const documentSymbol = (
  name: string,
  kind: number,
  selectionStart: { line: number; character: number },
  children?: unknown,
) => ({
  children,
  kind,
  name,
  range: {
    end: { character: 0, line: selectionStart.line + 5 },
    start: { character: 0, line: selectionStart.line },
  },
  selectionRange: {
    end: { character: selectionStart.character + 3, line: selectionStart.line },
    start: selectionStart,
  },
});

test("normalizeDocumentSymbols returns empty for a non-array reply", () => {
  expect(normalizeDocumentSymbols(null)).toEqual([]);
  expect(normalizeDocumentSymbols({ nope: true })).toEqual([]);
});

test("normalizeDocumentSymbols flattens a hierarchy pre-order, position-sorted, with depth", () => {
  // Provided out of source order (class before the earlier function; methods reversed) to prove
  // Both the top-level and per-parent sibling sorts run, and the name position is used.
  const reply = [
    documentSymbol("Alpha", SymbolKind.Class, { character: 6, line: 5 }, [
      documentSymbol("beta", SymbolKind.Method, { character: 2, line: 8 }),
      documentSymbol("gamma", SymbolKind.Method, { character: 2, line: 6 }),
    ]),
    documentSymbol("doThing", SymbolKind.Function, { character: 9, line: 1 }),
  ];
  expect(normalizeDocumentSymbols(reply)).toEqual([
    { column: 10, depth: 0, kind: SymbolKind.Function, line: 2, name: "doThing" },
    { column: 7, depth: 0, kind: SymbolKind.Class, line: 6, name: "Alpha" },
    { column: 3, depth: 1, kind: SymbolKind.Method, line: 7, name: "gamma" },
    { column: 3, depth: 1, kind: SymbolKind.Method, line: 9, name: "beta" },
  ]);
});

test("normalizeDocumentSymbols skips malformed entries", () => {
  const reply = [
    documentSymbol("Alpha", SymbolKind.Class, { character: 0, line: 0 }),
    { nope: true },
    null,
  ];
  expect(normalizeDocumentSymbols(reply)).toEqual([
    { column: 1, depth: 0, kind: SymbolKind.Class, line: 1, name: "Alpha" },
  ]);
});

test("normalizeDocumentSymbols reads a flat SymbolInformation[] at depth 0, position-sorted", () => {
  const symbolInformation = (name: string, kind: number, line: number, character: number) => ({
    kind,
    location: { range: { end: { character, line }, start: { character, line } }, uri },
    name,
  });
  const reply = [
    symbolInformation("second", SymbolKind.Variable, 4, 2),
    symbolInformation("first", SymbolKind.Function, 1, 0),
  ];
  expect(normalizeDocumentSymbols(reply)).toEqual([
    { column: 1, depth: 0, kind: SymbolKind.Function, line: 2, name: "first" },
    { column: 3, depth: 0, kind: SymbolKind.Variable, line: 5, name: "second" },
  ]);
});

// A hierarchy item carries a whole-declaration `range` and a name-only `selectionRange`; the
// Normalizer reads the name position, so give the two different starts to prove it picks the latter.
const hierarchyItem = (data?: unknown) => ({
  data,
  kind: SymbolKind.Function,
  name: "target",
  range: { end: { character: 0, line: 10 }, start: { character: 0, line: 3 } },
  selectionRange: range,
  uri,
});

test("firstHierarchyItem returns the first valid item verbatim, keeping its opaque data", () => {
  const item = hierarchyItem({ id: 7 });
  expect(firstHierarchyItem([item])).toBe(item);
  expect(firstHierarchyItem([item])?.data).toEqual({ id: 7 });
});

test("firstHierarchyItem returns undefined for null, an empty array, and all-malformed items", () => {
  expect(firstHierarchyItem(null)).toBeUndefined();
  expect(firstHierarchyItem([])).toBeUndefined();
  expect(firstHierarchyItem([{ nope: true }, null])).toBeUndefined();
});

test("normalizeIncomingCalls reads the caller under `from`, dropping calls without a valid from", () => {
  const reply = [
    { from: hierarchyItem(), fromRanges: [range] },
    { from: { nope: true }, fromRanges: [] },
    null,
  ];
  expect(normalizeIncomingCalls(reply)).toEqual([{ column: 3, line: 5, path }]);
  expect(normalizeIncomingCalls(null)).toEqual([]);
});

test("normalizeOutgoingCalls reads the callee under `to`", () => {
  expect(normalizeOutgoingCalls([{ fromRanges: [range], to: hierarchyItem() }])).toEqual([
    { column: 3, line: 5, path },
  ]);
});

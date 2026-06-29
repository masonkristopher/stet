import { expect, test } from "bun:test";

import { isLspDiagnostic, mapLspDiagnostic } from "@/diagnostics/protocol";

const range = { end: { character: 5, line: 0 }, start: { character: 1, line: 0 } };

test("maps the 0-based LSP start line to a 1-based line", () => {
  const mapped = mapLspDiagnostic(
    {
      message: "oops",
      range: { end: { character: 0, line: 41 }, start: { character: 0, line: 41 } },
    },
    "file:///repo/src/a.ts",
  );
  expect(mapped.line).toBe(42);
});

test("preserves the 1-based start column and the end range", () => {
  const mapped = mapLspDiagnostic(
    { message: "m", range: { end: { character: 9, line: 7 }, start: { character: 4, line: 3 } } },
    "file:///repo/a.ts",
  );
  expect(mapped.line).toBe(4);
  expect(mapped.column).toBe(5);
  expect(mapped.endLine).toBe(8);
  expect(mapped.endColumn).toBe(10);
});

test("narrows a diagnostic only when both ends of the range are positions", () => {
  expect(isLspDiagnostic({ message: "m", range })).toBe(true);
  expect(isLspDiagnostic({ message: "m", range: { start: range.start } })).toBe(false);
  expect(isLspDiagnostic({ message: "m", range: { end: { line: 0 }, start: range.start } })).toBe(
    false,
  );
});

test("maps LSP severities onto the domain vocabulary", () => {
  const severityOf = (severity: number | undefined) =>
    mapLspDiagnostic({ message: "m", range, severity }, "file:///repo/a.ts").severity;
  expect(severityOf(1)).toBe("error");
  expect(severityOf(2)).toBe("warning");
  expect(severityOf(3)).toBe("info");
  expect(severityOf(4)).toBe("info");
  expect(severityOf(undefined)).toBe("error");
});

test("converts a file URI to an absolute filesystem path", () => {
  const mapped = mapLspDiagnostic({ message: "m", range }, "file:///repo/src/a.ts");
  expect(mapped.path).toBe("/repo/src/a.ts");
});

test("carries the LSP source label through", () => {
  const mapped = mapLspDiagnostic({ message: "m", range, source: "ts" }, "file:///repo/a.ts");
  expect(mapped.source).toBe("ts");
});

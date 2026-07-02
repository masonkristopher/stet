import { describe, expect, test } from "bun:test";

import type { CheckerState, Diagnostic } from "@/diagnostics/checker";
import {
  buildProblemItems,
  isNavigableProblemItem,
  problemLocationLabel,
  sourceLabel,
  splitDiagnosticMessage,
} from "@/diagnostics/problems";

function diagnostic(overrides: Partial<Diagnostic>): Diagnostic {
  return {
    checker: "diagnostics",
    line: 1,
    message: "nope",
    path: "src/a.ts",
    severity: "error",
    ...overrides,
  };
}

function stateWith(diagnostics: Diagnostic[]): CheckerState {
  const byPath = Map.groupBy(diagnostics, (finding) => finding.path);
  const map = new Map(
    [...byPath].map(([path, findings]) => [
      path,
      { count: findings.length, diagnostics: findings, status: "findings" as const },
    ]),
  );
  return { diagnostics: map };
}

describe("splitDiagnosticMessage", () => {
  test("a single-line message has no help", () => {
    expect(splitDiagnosticMessage("Property 'dir' does not exist")).toEqual({
      help: [],
      summary: "Property 'dir' does not exist",
    });
  });

  test("oxlint help text splits off the first line", () => {
    expect(
      splitDiagnosticMessage(
        "Comments should not begin with a lowercase letter\nhelp: Change the first letter to uppercase",
      ),
    ).toEqual({
      help: ["help: Change the first letter to uppercase"],
      summary: "Comments should not begin with a lowercase letter",
    });
  });

  test("blank continuation lines are dropped", () => {
    expect(splitDiagnosticMessage("summary\n\n  help: do it  ")).toEqual({
      help: ["help: do it"],
      summary: "summary",
    });
  });

  test("recognizes a hint: prefix too", () => {
    expect(splitDiagnosticMessage("do this\nhint: try that")).toEqual({
      help: ["hint: try that"],
      summary: "do this",
    });
  });

  test("keeps multi-line non-help continuation in the summary", () => {
    expect(
      splitDiagnosticMessage("Type 'A' is not assignable to type 'B'.\n  Property 'x' is missing."),
    ).toEqual({
      help: [],
      summary: "Type 'A' is not assignable to type 'B'. Property 'x' is missing.",
    });
  });
});

describe("isNavigableProblemItem", () => {
  test("located diagnostics and failure lines are navigable; headers and help are not", () => {
    const items = buildProblemItems({
      diagnostics: new Map([
        ["src/a.ts", { count: 0, diagnostics: [], message: "boom\ndetail", status: "failed" }],
      ]),
    });
    // The failed file yields only a failure-header + failure lines, plus none of the
    // Navigable located diagnostics; the failure lines must still be reachable.
    const navigableKinds = items.filter(isNavigableProblemItem).map((item) => item.kind);
    expect(new Set(navigableKinds)).toEqual(new Set(["failure"]));

    const withDiagnostic = buildProblemItems(
      stateWith([diagnostic({ message: "summary\nhelp: fix" })]),
    );
    expect(withDiagnostic.filter(isNavigableProblemItem).map((item) => item.kind)).toEqual([
      "problem",
    ]);
    expect(withDiagnostic.some((item) => item.kind === "help")).toBe(true);
  });
});

describe("problemLocationLabel", () => {
  test("shows line:col, line alone, or nothing", () => {
    expect(problemLocationLabel(diagnostic({ column: 7, line: 2 }))).toBe("2:7");
    expect(problemLocationLabel(diagnostic({ column: undefined, line: 2 }))).toBe("2");
    expect(problemLocationLabel(diagnostic({ column: 7, line: undefined }))).toBe("");
  });
});

describe("sourceLabel", () => {
  test("shortens the long typescript source to tsc", () => {
    expect(sourceLabel("typescript")).toBe("tsc");
  });

  test("passes already-short and unknown sources through unchanged", () => {
    expect(sourceLabel("oxc")).toBe("oxc");
    expect(sourceLabel("eslint")).toBe("eslint");
  });
});

describe("buildProblemItems", () => {
  test("groups diagnostics under a per-file header with severity counts", () => {
    const items = buildProblemItems(
      stateWith([
        diagnostic({ line: 2, message: "a" }),
        diagnostic({ line: 5, message: "b", severity: "warning" }),
      ]),
    );

    expect(items[0]).toEqual({
      errors: 1,
      info: 0,
      kind: "file-header",
      path: "src/a.ts",
      warnings: 1,
    });
    expect(items.filter((item) => item.kind === "problem")).toHaveLength(2);
  });

  test("separates groups with a spacer row, never before the first", () => {
    const items = buildProblemItems(
      stateWith([
        diagnostic({ message: "a", path: "src/a.ts" }),
        diagnostic({ message: "b", path: "src/b.ts" }),
      ]),
    );

    expect(items.map((item) => item.kind)).toEqual([
      "file-header",
      "problem",
      "spacer",
      "file-header",
      "problem",
    ]);
  });

  test("widens the location column to the widest line:col in the group", () => {
    const items = buildProblemItems(
      stateWith([
        diagnostic({ column: 3, line: 2, message: "a" }),
        diagnostic({ column: 40, line: 120, message: "b" }),
      ]),
    );
    const widths = items
      .filter((item) => item.kind === "problem")
      .map((item) => item.kind === "problem" && item.labelWidth);
    // "120:40" is the widest at 6 characters; every row shares it so summaries align.
    expect(widths).toEqual([6, 6]);
  });

  test("orders file groups by worst severity, then path", () => {
    const items = buildProblemItems(
      stateWith([
        diagnostic({ path: "src/a.ts", severity: "warning" }),
        diagnostic({ path: "src/z.ts", severity: "error" }),
        diagnostic({ path: "src/b.ts", severity: "warning" }),
      ]),
    );

    expect(items.filter((item) => item.kind === "file-header").map((item) => item.path)).toEqual([
      "src/z.ts",
      "src/a.ts",
      "src/b.ts",
    ]);
  });

  test("orders findings within a file by line", () => {
    const items = buildProblemItems(
      stateWith([
        diagnostic({ line: 25, message: "late" }),
        diagnostic({ line: 2, message: "early" }),
      ]),
    );

    expect(
      items.filter((item) => item.kind === "problem").map((item) => item.problem.line),
    ).toEqual([2, 25]);
  });

  test("a help sub-line points at its owning problem's flat index", () => {
    const items = buildProblemItems(
      stateWith([diagnostic({ line: 2, message: "summary\nhelp: fix it" })]),
    );

    const helpIndex = items.findIndex((item) => item.kind === "help");
    const help = items[helpIndex];
    expect(help?.kind === "help" && items[help.owner]?.kind === "problem").toBe(true);
    expect(help?.kind === "help" && help.owner).toBe(helpIndex - 1);
  });

  test("checker failures lead, under a single failure header", () => {
    const state: CheckerState = {
      diagnostics: new Map([
        ["src/a.ts", { count: 0, diagnostics: [], message: "boom\ndetail", status: "failed" }],
      ]),
    };
    const items = buildProblemItems(state);

    expect(items[0]?.kind).toBe("failure-header");
    expect(items.filter((item) => item.kind === "failure").map((item) => item.line)).toEqual([
      "boom",
      "detail",
    ]);
  });

  test("includes every distinct failure message but dedupes the repeats across files", () => {
    const items = buildProblemItems({
      diagnostics: new Map([
        ["a.ts", { count: 0, diagnostics: [], message: "server crashed", status: "failed" }],
        // A failed server repeats its message on every file it covers — show it once.
        ["b.ts", { count: 0, diagnostics: [], message: "server crashed", status: "failed" }],
        ["c.ts", { count: 0, diagnostics: [], message: "different failure", status: "failed" }],
      ]),
    });

    expect(items.filter((item) => item.kind === "failure").map((item) => item.line)).toEqual([
      "server crashed",
      "different failure",
    ]);
  });

  test("no problems yields no rows", () => {
    expect(buildProblemItems({ diagnostics: new Map() })).toEqual([]);
  });
});

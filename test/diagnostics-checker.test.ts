import { describe, expect, test } from "bun:test";

import {
  allFindings,
  checkerSummary,
  countBySeverity,
  findingsLineMap,
  initialCheckerState,
  markPending,
  stateForResolvedChecker,
} from "@/diagnostics/checker";
import type { CheckerState, Diagnostic } from "@/diagnostics/checker";
import type { ChangedFile } from "@/git/model";

const file: ChangedFile = {
  additions: 1,
  binary: false,
  deletions: 0,
  kind: "modified",
  mtimeMs: 0,
  path: "src/a.ts",
  stage: "unstaged",
  warnings: [],
};

function diagnostic(overrides: Partial<Diagnostic>): Diagnostic {
  return {
    checker: "diagnostics",
    line: 3,
    message: "nope",
    path: "src/a.ts",
    severity: "error",
    ...overrides,
  };
}

function stateWith(diagnostics: Diagnostic[]): CheckerState {
  return {
    diagnostics: stateForResolvedChecker("diagnostics", [file], diagnostics, "/repo"),
  };
}

describe("initialCheckerState", () => {
  test("starts every changed file as pending", () => {
    const state = initialCheckerState([file]);
    expect(state.diagnostics.get("src/a.ts")?.status).toBe("pending");
  });

  test("holds only the given changed files, so a worktree switch drops the prior set", () => {
    // Worktree A had findings in src/a.ts; switching to B reseeds from B's changed set,
    // So A's path is gone rather than carried forward forever.
    const state = initialCheckerState([{ ...file, path: "src/b.ts" }]);
    expect([...state.diagnostics.keys()]).toEqual(["src/b.ts"]);
    expect(state.diagnostics.has("src/a.ts")).toBe(false);
  });
});

describe("markPending", () => {
  test("with no changed paths, keeps existing diagnostics and only pends files new to the set", () => {
    const existing: CheckerState = {
      diagnostics: new Map([
        ["src/a.ts", { count: 1, diagnostics: [diagnostic({})], status: "findings" }],
      ]),
    };
    const next = markPending(existing, [file, { ...file, path: "src/b.ts" }], []);
    // The re-check keeps a's prior findings in place rather than blanking them to pending.
    expect(next.diagnostics.get("src/a.ts")?.status).toBe("findings");
    // A file new to the set gets a pending placeholder, never a false clean.
    expect(next.diagnostics.get("src/b.ts")?.status).toBe("pending");
  });
});

describe("stateForResolvedChecker", () => {
  test("retains findings for files outside the changed set", () => {
    const state = stateForResolvedChecker(
      "diagnostics",
      [file],
      [diagnostic({ path: "/repo/src/unchanged.ts" })],
      "/repo",
    );

    expect(state.get("src/unchanged.ts")?.status).toBe("findings");
    expect(state.get("src/unchanged.ts")?.diagnostics[0]?.path).toBe("src/unchanged.ts");
    expect(state.get("src/a.ts")?.status).toBe("clean");
  });

  test("carries the LSP source label through onto each finding", () => {
    const state = stateForResolvedChecker(
      "diagnostics",
      [file],
      [diagnostic({ source: "ts" })],
      "/repo",
    );
    expect(state.get("src/a.ts")?.diagnostics[0]?.source).toBe("ts");
  });
});

describe("problem helpers", () => {
  test("allFindings sorts by severity, path, then line", () => {
    const state = stateWith([
      diagnostic({ line: 1, path: "/repo/src/b.ts", severity: "warning" }),
      diagnostic({ line: 9, path: "/repo/src/b.ts", severity: "error" }),
      diagnostic({ line: 2, path: "/repo/src/a.ts", severity: "error" }),
    ]);

    expect(allFindings(state).map((finding) => `${finding.path}:${finding.line}`)).toEqual([
      "src/a.ts:2",
      "src/b.ts:9",
      "src/b.ts:1",
    ]);
  });

  test("countBySeverity tallies errors and warnings", () => {
    const state = stateWith([
      diagnostic({}),
      diagnostic({ line: 5 }),
      diagnostic({ line: 7, severity: "warning" }),
    ]);
    expect(countBySeverity(allFindings(state))).toEqual({ errors: 2, info: 0, warnings: 1 });
  });

  test("countBySeverity counts info separately, not as a warning", () => {
    const state = stateWith([
      diagnostic({ severity: "warning" }),
      diagnostic({ line: 5, severity: "info" }),
      diagnostic({ line: 7, severity: "info" }),
    ]);
    expect(countBySeverity(allFindings(state))).toEqual({ errors: 0, info: 2, warnings: 1 });
  });

  test("checkerSummary tallies a single path", () => {
    const state = stateWith([diagnostic({}), diagnostic({ path: "/repo/src/other.ts" })]);
    expect(checkerSummary("src/a.ts", state)).toEqual({
      errors: 1,
      failed: false,
      info: 0,
      pending: false,
      unavailable: false,
      warnings: 0,
    });
  });

  test("checkerSummary reflects a pending file", () => {
    const state: CheckerState = {
      diagnostics: new Map([["src/a.ts", { count: 0, diagnostics: [], status: "pending" }]]),
    };
    expect(checkerSummary("src/a.ts", state).pending).toBe(true);
  });

  test("checkerSummary flags an unavailable file (never reads as clean)", () => {
    const state: CheckerState = {
      diagnostics: new Map([
        ["src/a.ts", { count: 0, diagnostics: [], message: "no server", status: "unavailable" }],
      ]),
    };
    const summary = checkerSummary("src/a.ts", state);
    expect(summary.unavailable).toBe(true);
    expect(summary.failed).toBe(false);
    expect(summary.errors).toBe(0);
  });

  test("checkerSummary surfaces failed runs", () => {
    const state: CheckerState = {
      diagnostics: new Map([
        ["src/a.ts", { count: 0, diagnostics: [], message: "boom\ndetail", status: "failed" }],
      ]),
    };
    expect(checkerSummary("src/a.ts", state).failed).toBe(true);
  });

  test("findingsLineMap groups by line number", () => {
    const state = stateWith([
      diagnostic({}),
      diagnostic({ message: "again" }),
      diagnostic({ line: undefined, message: "no line" }),
    ]);
    const byLine = findingsLineMap("src/a.ts", state);

    expect(byLine.get(3)?.map((finding) => finding.message)).toEqual(["nope", "again"]);
    expect(byLine.size).toBe(1);
  });
});

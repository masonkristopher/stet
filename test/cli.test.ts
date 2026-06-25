import { describe, expect, test } from "bun:test";

import { helpText, parseArgs, scopeKinds, scopeLabel, scopePickerLabel } from "../src/cli";

describe("parseArgs", () => {
  test("defaults to all changes vs HEAD", () => {
    expect(parseArgs([]).scope).toEqual({ kind: "all", ref: "HEAD" });
  });

  test("accepts a comparison ref", () => {
    expect(parseArgs(["main"]).scope).toEqual({ kind: "all", ref: "main" });
  });

  test("supports staged comparisons", () => {
    expect(parseArgs(["--staged", "HEAD~2"]).scope).toEqual({ kind: "staged", ref: "HEAD~2" });
  });

  test("supports unstaged comparisons", () => {
    expect(parseArgs(["--unstaged"]).scope).toEqual({ kind: "unstaged", ref: "HEAD" });
  });

  test("enables file-type icons by default", () => {
    expect(parseArgs([]).icons).toBe(true);
  });

  test("disables icons with --no-icons", () => {
    expect(parseArgs(["--no-icons"]).icons).toBe(false);
  });

  test("overflows long lines by default", () => {
    expect(parseArgs([]).overflow).toBe("scroll");
  });

  test("wraps long lines with --wrap", () => {
    expect(parseArgs(["--wrap"]).overflow).toBe("wrap");
  });

  test("rejects unknown options", () => {
    expect(() => parseArgs(["--nope"])).toThrow("Unknown option: --nope");
  });
});

describe("scopeKinds", () => {
  test("lists the scopes in picker order", () => {
    expect(scopeKinds).toEqual(["unstaged", "staged", "all", "session", "last-commit"]);
  });
});

describe("scopeLabel", () => {
  test("labels each scope", () => {
    expect(scopeLabel({ kind: "all", ref: "HEAD" })).toBe("worktree vs HEAD");
    expect(scopeLabel({ kind: "staged", ref: "main" })).toBe("staged vs main");
    expect(scopeLabel({ kind: "unstaged", ref: "HEAD" })).toBe("unstaged");
    expect(scopeLabel({ kind: "session", ref: "abc123" })).toBe("since session start");
    expect(scopeLabel({ headRef: "HEAD", kind: "last-commit", ref: "abc123" })).toBe("last commit");
  });
});

describe("scopePickerLabel", () => {
  test("gives a ref-agnostic label per kind", () => {
    expect(scopePickerLabel("unstaged")).toBe("unstaged");
    expect(scopePickerLabel("staged")).toBe("staged");
    expect(scopePickerLabel("all")).toBe("all changes");
    expect(scopePickerLabel("session")).toBe("since session start");
    expect(scopePickerLabel("last-commit")).toBe("last commit");
  });
});

describe("helpText", () => {
  test("describes the companion keys clearly", () => {
    expect(helpText()).toContain(
      "s          open the scope picker (unstaged/staged/all/session/last commit)",
    );
    expect(helpText()).toContain("c          toggle changes-only filter for the tree");
    expect(helpText()).toContain("v          toggle diff <-> full file view");
    expect(helpText()).toContain("p          toggle the problems panel");
    expect(helpText()).toContain(".          jump to the most recently changed file");
    expect(helpText()).toContain(
      "y          copy the focused file's path (tree) or path:line (viewer)",
    );
    expect(helpText()).toContain("The view is live");
  });
});

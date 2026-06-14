import { describe, expect, test } from "bun:test";

import { helpText, nextScope, parseArgs, scopeLabel } from "../src/cli";

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

  test("rejects unknown options", () => {
    expect(() => parseArgs(["--nope"])).toThrow("Unknown option: --nope");
  });
});

describe("nextScope", () => {
  test("cycles all -> staged -> unstaged -> all", () => {
    expect(nextScope("all")).toBe("staged");
    expect(nextScope("staged")).toBe("unstaged");
    expect(nextScope("unstaged")).toBe("all");
  });
});

describe("scopeLabel", () => {
  test("labels each scope", () => {
    expect(scopeLabel({ kind: "all", ref: "HEAD" })).toBe("worktree vs HEAD");
    expect(scopeLabel({ kind: "staged", ref: "main" })).toBe("staged vs main");
    expect(scopeLabel({ kind: "unstaged", ref: "HEAD" })).toBe("unstaged");
  });
});

describe("helpText", () => {
  test("describes the companion keys clearly", () => {
    expect(helpText()).toContain("s          cycle scope: all changes -> staged -> unstaged");
    expect(helpText()).toContain("c          toggle changes-only filter for the tree");
    expect(helpText()).toContain("v          toggle diff <-> full file view");
    expect(helpText()).toContain("p          toggle the problems panel");
    expect(helpText()).toContain(".          jump to the most recently changed file");
    expect(helpText()).toContain("y          copy path:line + snippet at the cursor");
    expect(helpText()).toContain("The view is live");
  });
});

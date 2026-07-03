import { describe, expect, test } from "bun:test";

import { helpText, parseArgs, parseCommand, scopeKinds, scopeLabel, scopeMenuLabel } from "@/cli";

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

  test("rejects --staged and --unstaged together", () => {
    expect(() => parseArgs(["--staged", "--unstaged"])).toThrow(
      "--staged and --unstaged are mutually exclusive",
    );
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

  test("accepts --editor as a separate argument", () => {
    expect(parseArgs(["--editor", "nvim +{line} {file}"]).editor).toBe("nvim +{line} {file}");
  });

  test("accepts --editor= inline syntax", () => {
    expect(parseArgs(["--editor=code --goto {file}:{line}"]).editor).toBe(
      "code --goto {file}:{line}",
    );
  });

  test("--editor does not affect scope", () => {
    const result = parseArgs(["--staged", "--editor", "hx {file}:{line}"]);
    expect(result.scope.kind).toBe("staged");
    expect(result.editor).toBe("hx {file}:{line}");
  });

  test("accepts --ide as a separate argument", () => {
    expect(parseArgs(["--ide", "code --goto {file}:{line}"]).ide).toBe("code --goto {file}:{line}");
  });

  test("accepts --ide= inline syntax", () => {
    expect(parseArgs(["--ide=zed {file}:{line}"]).ide).toBe("zed {file}:{line}");
  });

  test("--ide does not affect --editor or scope", () => {
    const result = parseArgs([
      "--editor",
      "nvim +{line} {file}",
      "--ide",
      "code --goto {file}:{line}",
    ]);
    expect(result.editor).toBe("nvim +{line} {file}");
    expect(result.ide).toBe("code --goto {file}:{line}");
    expect(result.scope.kind).toBe("all");
  });

  test("throws when --editor is empty", () => {
    expect(() => parseArgs(["--editor", ""])).toThrow("--editor requires a non-empty value");
  });

  test("throws when --ide is empty", () => {
    expect(() => parseArgs(["--ide", ""])).toThrow("--ide requires a non-empty value");
  });

  test("throws when --editor has no value", () => {
    expect(() => parseArgs(["--editor"])).toThrow("Option '--editor <value>' argument missing");
  });

  test("throws when --ide has no value", () => {
    expect(() => parseArgs(["--ide"])).toThrow("Option '--ide <value>' argument missing");
  });

  test("editor defaults to undefined when not provided", () => {
    expect(parseArgs([]).editor).toBeUndefined();
  });

  test("ide defaults to undefined when not provided", () => {
    expect(parseArgs([]).ide).toBeUndefined();
  });

  test("rejects unknown options", () => {
    expect(() => parseArgs(["--nope"])).toThrow("Unknown option '--nope'");
  });
});

describe("parseCommand", () => {
  test("dispatches the upgrade subcommand", () => {
    expect(parseCommand(["upgrade"])).toEqual({ kind: "upgrade" });
  });

  test("rejects an extra argument after upgrade", () => {
    expect(() => parseCommand(["upgrade", "0.4.1"])).toThrow("Unexpected argument: 0.4.1");
  });

  test("rejects an unknown flag after upgrade", () => {
    expect(() => parseCommand(["upgrade", "--force"])).toThrow("Unknown option: --force");
  });

  test("falls through to the run command for everything else", () => {
    expect(parseCommand(["--staged", "main"])).toEqual({
      kind: "run",
      options: parseArgs(["--staged", "main"]),
    });
  });

  test("treats a bare ref as a run command", () => {
    const command = parseCommand(["main"]);
    expect(command.kind).toBe("run");
    expect(command.kind === "run" && command.options.scope).toEqual({ kind: "all", ref: "main" });
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

describe("scopeMenuLabel", () => {
  test("gives a ref-agnostic label per kind", () => {
    expect(scopeMenuLabel("unstaged")).toBe("unstaged");
    expect(scopeMenuLabel("staged")).toBe("staged");
    expect(scopeMenuLabel("all")).toBe("all changes");
    expect(scopeMenuLabel("session")).toBe("since session start");
    expect(scopeMenuLabel("last-commit")).toBe("last commit");
  });
});

describe("helpText", () => {
  test("describes the companion keys clearly", () => {
    expect(helpText()).toContain(
      "s          open the scope picker (kinds, or drill into recent commits)",
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

  test("documents the --editor and --ide flags", () => {
    expect(helpText()).toContain("--editor <template>");
    expect(helpText()).toContain("--ide <template>");
    expect(helpText()).toContain("{file}");
    expect(helpText()).toContain("{line}");
  });

  test("documents the e and o keybindings", () => {
    expect(helpText()).toContain("e          open in terminal editor");
    expect(helpText()).toContain("o          open in GUI / IDE");
  });

  test("documents the upgrade command", () => {
    expect(helpText()).toContain("sideye upgrade");
    expect(helpText()).toContain("Update sideye to the latest release");
  });
});

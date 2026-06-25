import { describe, expect, test } from "bun:test";
import {
  buildEditorCommand,
  helpText,
  parseArgs,
  resolveEditorTemplate,
  resolveIdeTemplate,
  scopeKinds,
  scopeLabel,
  scopePickerLabel,
} from "../src/cli";
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
    expect(parseArgs(["--ide", "code --goto {file}:{line}"]).ide).toBe(
      "code --goto {file}:{line}",
    );
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

  test("throws when --editor has no value", () => {
    expect(() => parseArgs(["--editor"])).toThrow("--editor requires a value");
  });

  test("throws when --ide has no value", () => {
    expect(() => parseArgs(["--ide"])).toThrow("--ide requires a value");
  });

  test("editor defaults to undefined when not provided", () => {
    expect(parseArgs([]).editor).toBeUndefined();
  });

  test("ide defaults to undefined when not provided", () => {
    expect(parseArgs([]).ide).toBeUndefined();
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
    expect(helpText()).toContain("y          copy path:line + snippet at the cursor");
    expect(helpText()).toContain("The view is live");
  });

  test("documents the --editor and --ide flags", () => {
    expect(helpText()).toContain("--editor <template>");
    expect(helpText()).toContain("--ide <template>");
    expect(helpText()).toContain("{file}");
    expect(helpText()).toContain("{line}");
  });

  test("documents the e and E keybindings", () => {
    expect(helpText()).toContain("e          open in terminal editor");
    expect(helpText()).toContain("E          open in GUI / IDE");
  });
});

describe("buildEditorCommand", () => {
  test("substitutes {file} and {line} in a vim-style template", () => {
    expect(buildEditorCommand("vim +{line} {file}", "/repo/src/foo.ts", 42)).toEqual([
      "vim",
      "+42",
      "/repo/src/foo.ts",
    ]);
  });

  test("substitutes {file}:{line} in a colon-separated template", () => {
    expect(buildEditorCommand("hx {file}:{line}", "/repo/src/foo.ts", 10)).toEqual([
      "hx",
      "/repo/src/foo.ts:10",
    ]);
  });

  test("substitutes VSCode --goto style", () => {
    expect(buildEditorCommand("code --goto {file}:{line}", "/repo/src/foo.ts", 5)).toEqual([
      "code",
      "--goto",
      "/repo/src/foo.ts:5",
    ]);
  });

  test("drops args that contain {line} when no line is provided", () => {
    expect(buildEditorCommand("vim +{line} {file}", "/repo/src/foo.ts", undefined)).toEqual([
      "vim",
      "/repo/src/foo.ts",
    ]);
  });

  test("keeps {file}:{line} args with no line by dropping the whole arg", () => {
    expect(buildEditorCommand("hx {file}:{line}", "/repo/src/foo.ts", undefined)).toEqual(["hx"]);
  });

  test("handles a template with no {line} placeholder when line is undefined", () => {
    expect(buildEditorCommand("cat {file}", "/repo/src/foo.ts", undefined)).toEqual([
      "cat",
      "/repo/src/foo.ts",
    ]);
  });

  test("handles a template with no {line} placeholder when line is provided", () => {
    expect(buildEditorCommand("cat {file}", "/repo/src/foo.ts", 99)).toEqual([
      "cat",
      "/repo/src/foo.ts",
    ]);
  });
});

describe("resolveEditorTemplate", () => {
  test("returns the explicit value when provided", () => {
    expect(resolveEditorTemplate("nvim +{line} {file}")).toBe("nvim +{line} {file}");
  });

  test("returns a template containing {file} when nothing is configured", () => {
    expect(resolveEditorTemplate(undefined)).toContain("{file}");
  });
});

describe("resolveIdeTemplate", () => {
  test("returns the explicit value when provided", () => {
    expect(resolveIdeTemplate("code --goto {file}:{line}")).toBe("code --goto {file}:{line}");
  });

  test("returns undefined when nothing is configured", () => {
    const saved = {
      EDITOR: process.env["EDITOR"],
      SIDEYE_IDE: process.env["SIDEYE_IDE"],
      VISUAL: process.env["VISUAL"],
    };
    delete process.env["SIDEYE_IDE"];
    delete process.env["VISUAL"];
    delete process.env["EDITOR"];
    try {
      expect(resolveIdeTemplate(undefined)).toBeUndefined();
    } finally {
      if (saved.SIDEYE_IDE !== undefined) {
        process.env["SIDEYE_IDE"] = saved.SIDEYE_IDE;
      }
      if (saved.VISUAL !== undefined) {
        process.env["VISUAL"] = saved.VISUAL;
      }
      if (saved.EDITOR !== undefined) {
        process.env["EDITOR"] = saved.EDITOR;
      }
    }
  });

  test("uses SIDEYE_IDE env var over $VISUAL", () => {
    const saved = process.env["SIDEYE_IDE"];
    process.env["SIDEYE_IDE"] = "zed {file}:{line}";
    try {
      expect(resolveIdeTemplate(undefined)).toBe("zed {file}:{line}");
    } finally {
      if (saved !== undefined) {
        process.env["SIDEYE_IDE"] = saved;
      } else {
        delete process.env["SIDEYE_IDE"];
      }
    }
  });

  test("explicit value wins over SIDEYE_IDE", () => {
    const saved = process.env["SIDEYE_IDE"];
    process.env["SIDEYE_IDE"] = "zed {file}:{line}";
    try {
      expect(resolveIdeTemplate("subl {file}:{line}")).toBe("subl {file}:{line}");
    } finally {
      if (saved !== undefined) {
        process.env["SIDEYE_IDE"] = saved;
      } else {
        delete process.env["SIDEYE_IDE"];
      }
    }
  });
});

import { describe, expect, test } from "bun:test";

import {
  buildEditorCommand,
  resolveEditorTemplate,
  resolveIdeTemplate,
} from "../src/editor/reference";

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

  test("keeps {file} in combined {file}:{line} token when no line is provided", () => {
    expect(buildEditorCommand("hx {file}:{line}", "/repo/src/foo.ts", undefined)).toEqual([
      "hx",
      "/repo/src/foo.ts",
    ]);
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

  test("expands a bare known editor name to its full template", () => {
    expect(resolveEditorTemplate("nvim")).toBe("nvim +{line} {file}");
    expect(resolveEditorTemplate("code")).toBe("code --goto {file}:{line}");
    expect(resolveEditorTemplate("hx")).toBe("hx {file}:{line}");
  });

  test("appends default suffix for an unknown bare editor name", () => {
    expect(resolveEditorTemplate("myed")).toBe("myed +{line} {file}");
  });

  test("passes through a value that already contains {file}", () => {
    expect(resolveEditorTemplate("nvim +{line} {file}")).toBe("nvim +{line} {file}");
  });

  test("explicit value (CLI flag or config) beats SIDEYE_EDITOR", () => {
    const saved = process.env.SIDEYE_EDITOR;
    process.env.SIDEYE_EDITOR = "nano +{line} {file}";
    try {
      expect(resolveEditorTemplate("nvim +{line} {file}")).toBe("nvim +{line} {file}");
    } finally {
      if (saved !== undefined) {
        process.env.SIDEYE_EDITOR = saved;
      } else {
        delete process.env.SIDEYE_EDITOR;
      }
    }
  });

  test("SIDEYE_EDITOR is returned verbatim when it already contains {file}", () => {
    const saved = process.env.SIDEYE_EDITOR;
    process.env.SIDEYE_EDITOR = "emacsclient -nw +{line} {file}";
    try {
      expect(resolveEditorTemplate(undefined)).toBe("emacsclient -nw +{line} {file}");
    } finally {
      if (saved !== undefined) {
        process.env.SIDEYE_EDITOR = saved;
      } else {
        delete process.env.SIDEYE_EDITOR;
      }
    }
  });

  test("falls through to $VISUAL when $EDITOR is empty string", () => {
    const savedEditor = process.env.EDITOR;
    const savedVisual = process.env.VISUAL;
    process.env.EDITOR = "";
    process.env.VISUAL = "hx";
    try {
      expect(resolveEditorTemplate(undefined)).toBe("hx {file}:{line}");
    } finally {
      if (savedEditor !== undefined) {
        process.env.EDITOR = savedEditor;
      } else {
        delete process.env.EDITOR;
      }
      if (savedVisual !== undefined) {
        process.env.VISUAL = savedVisual;
      } else {
        delete process.env.VISUAL;
      }
    }
  });

  test("SIDEYE_EDITOR beats $EDITOR", () => {
    const savedSideye = process.env.SIDEYE_EDITOR;
    const savedEditor = process.env.EDITOR;
    process.env.SIDEYE_EDITOR = "hx {file}:{line}";
    process.env.EDITOR = "vim";
    try {
      expect(resolveEditorTemplate(undefined)).toBe("hx {file}:{line}");
    } finally {
      if (savedSideye !== undefined) {
        process.env.SIDEYE_EDITOR = savedSideye;
      } else {
        delete process.env.SIDEYE_EDITOR;
      }
      if (savedEditor !== undefined) {
        process.env.EDITOR = savedEditor;
      } else {
        delete process.env.EDITOR;
      }
    }
  });
});

describe("resolveIdeTemplate", () => {
  test("returns the explicit value when provided", () => {
    expect(resolveIdeTemplate("code --goto {file}:{line}")).toBe("code --goto {file}:{line}");
  });

  test("expands a bare known IDE name to its full template", () => {
    expect(resolveIdeTemplate("code")).toBe("code --goto {file}:{line}");
    expect(resolveIdeTemplate("zed")).toBe("zed {file}:{line}");
    expect(resolveIdeTemplate("subl")).toBe("subl {file}:{line}");
  });

  test("appends default suffix for an unknown bare IDE name", () => {
    expect(resolveIdeTemplate("myide")).toBe("myide {file}:{line}");
  });

  test("returns undefined when nothing is configured", () => {
    const saved = {
      EDITOR: process.env.EDITOR,
      SIDEYE_IDE: process.env.SIDEYE_IDE,
      VISUAL: process.env.VISUAL,
    };
    delete process.env.SIDEYE_IDE;
    delete process.env.VISUAL;
    delete process.env.EDITOR;
    try {
      expect(resolveIdeTemplate(undefined)).toBeUndefined();
    } finally {
      if (saved.SIDEYE_IDE !== undefined) {
        process.env.SIDEYE_IDE = saved.SIDEYE_IDE;
      }
      if (saved.VISUAL !== undefined) {
        process.env.VISUAL = saved.VISUAL;
      }
      if (saved.EDITOR !== undefined) {
        process.env.EDITOR = saved.EDITOR;
      }
    }
  });

  test("uses SIDEYE_IDE env var over $VISUAL", () => {
    const saved = process.env.SIDEYE_IDE;
    process.env.SIDEYE_IDE = "zed {file}:{line}";
    try {
      expect(resolveIdeTemplate(undefined)).toBe("zed {file}:{line}");
    } finally {
      if (saved !== undefined) {
        process.env.SIDEYE_IDE = saved;
      } else {
        delete process.env.SIDEYE_IDE;
      }
    }
  });

  test("explicit value wins over SIDEYE_IDE", () => {
    const saved = process.env.SIDEYE_IDE;
    process.env.SIDEYE_IDE = "zed {file}:{line}";
    try {
      expect(resolveIdeTemplate("subl {file}:{line}")).toBe("subl {file}:{line}");
    } finally {
      if (saved !== undefined) {
        process.env.SIDEYE_IDE = saved;
      } else {
        delete process.env.SIDEYE_IDE;
      }
    }
  });
});

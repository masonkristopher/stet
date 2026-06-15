import { describe, expect, test } from "bun:test";

import { filetypeFor, supportedFiletypeFor } from "../src/syntax/filetype";

describe("supportedFiletypeFor", () => {
  test("returns bundled OpenTUI parser filetypes", () => {
    expect(supportedFiletypeFor("src/a.ts")).toBe("typescript");
    expect(supportedFiletypeFor("src/a.js")).toBe("javascript");
    expect(supportedFiletypeFor("README.md")).toBe("markdown");
    expect(supportedFiletypeFor("docs/page.mdx")).toBe("markdown");
    expect(supportedFiletypeFor("src/main.zig")).toBe("zig");
  });

  test("returns vendored parser filetypes", () => {
    expect(supportedFiletypeFor("src/a.tsx")).toBe("tsx");
    expect(supportedFiletypeFor("src/a.jsx")).toBe("tsx");
    expect(supportedFiletypeFor("install.sh")).toBe("bash");
    expect(supportedFiletypeFor("scripts/setup.bash")).toBe("bash");
    expect(supportedFiletypeFor(".zshrc.zsh")).toBe("bash");
    expect(supportedFiletypeFor("package.json")).toBe("json");
    expect(supportedFiletypeFor("tsconfig.jsonc")).toBe("json");
    expect(supportedFiletypeFor(".github/workflows/ci.yml")).toBe("yaml");
    expect(supportedFiletypeFor("config.yaml")).toBe("yaml");
  });

  test("leaves unsupported filetypes undefined", () => {
    expect(supportedFiletypeFor("src/a.css")).toBeUndefined();
    expect(supportedFiletypeFor("src/a.py")).toBeUndefined();
    expect(supportedFiletypeFor("Makefile")).toBeUndefined();
  });
});

describe("filetypeFor", () => {
  test("falls back to text", () => {
    expect(filetypeFor("src/a.css")).toBe("text");
  });
});

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { SyntaxStyle, getTreeSitterClient } from "@opentui/core";

import { diffFiletypeFor, expandCaptureStyles, type SyntaxConfig } from "../src/syntax/highlight";
import { darkTheme } from "../src/theme/dark";

const baseCaptureStyles = darkTheme.syntax;

const disabledSyntax: SyntaxConfig = {
  enabled: false,
  status: "syntax disabled",
};

const enabledSyntax: SyntaxConfig = {
  enabled: true,
  querySources: [],
  status: "syntax highlighting ready",
  style: SyntaxStyle.fromStyles(baseCaptureStyles),
  treeSitterClient: getTreeSitterClient(),
};

describe("diffFiletypeFor", () => {
  test("uses supported parser filetypes when syntax is enabled", () => {
    expect(diffFiletypeFor("src/main.ts", enabledSyntax)).toBe("typescript");
    expect(diffFiletypeFor("src/App.tsx", enabledSyntax)).toBe("tsx");
    expect(diffFiletypeFor("README.md", enabledSyntax)).toBe("markdown");
    expect(diffFiletypeFor("install.sh", enabledSyntax)).toBe("bash");
    expect(diffFiletypeFor("package.json", enabledSyntax)).toBe("json");
    expect(diffFiletypeFor("tsconfig.jsonc", enabledSyntax)).toBe("json");
    expect(diffFiletypeFor(".github/workflows/ci.yml", enabledSyntax)).toBe("yaml");
    expect(diffFiletypeFor("config.yaml", enabledSyntax)).toBe("yaml");
  });

  test("falls back to text for unsupported or disabled syntax", () => {
    expect(diffFiletypeFor("bun.lock", enabledSyntax)).toBe("text");
    expect(diffFiletypeFor("src/App.tsx", disabledSyntax)).toBe("text");
  });
});

describe("expandCaptureStyles", () => {
  test("aliases an unknown dotted capture to its longest styled prefix", () => {
    const expanded = expandCaptureStyles(baseCaptureStyles, ["(import_statement) @keyword.import"]);
    expect(expanded["keyword.import"]).toEqual(baseCaptureStyles.keyword);
  });

  test("prefers a longer prefix over the first segment", () => {
    const expanded = expandCaptureStyles(baseCaptureStyles, ["(link) @markup.link.url"]);
    expect(expanded["markup.link.url"]).toEqual(baseCaptureStyles["markup.link"]);
    expect(expanded["markup.link.url"]).not.toEqual(baseCaptureStyles.markup);
  });

  test("never overrides an explicit theme entry", () => {
    const expanded = expandCaptureStyles(baseCaptureStyles, ["(heading) @markup.heading.1"]);
    expect(expanded["markup.heading.1"]).toEqual(baseCaptureStyles["markup.heading.1"]);
  });
});

describe("capture coverage", () => {
  const repoRoot = join(import.meta.dir, "..");
  const queryFiles = [
    join(repoRoot, "assets/tree-sitter/bash/highlights.scm"),
    join(repoRoot, "assets/tree-sitter/json/highlights.scm"),
    join(repoRoot, "assets/tree-sitter/yaml/highlights.scm"),
    join(repoRoot, "assets/tree-sitter/typescript/test-globals.scm"),
    join(repoRoot, "node_modules/@opentui/core/assets/javascript/highlights.scm"),
    join(repoRoot, "node_modules/@opentui/core/assets/typescript/highlights.scm"),
    join(repoRoot, "node_modules/@opentui/core/assets/zig/highlights.scm"),
    join(repoRoot, "node_modules/@opentui/core/assets/markdown/highlights.scm"),
    join(repoRoot, "node_modules/@opentui/core/assets/markdown_inline/highlights.scm"),
  ];

  // Meta captures that intentionally carry no style of their own
  const metaCaptures = new Set([
    "spell",
    "nospell",
    "conceal",
    "none",
    "embedded",
    "cImport",
    "import",
    "_lang",
    "",
  ]);

  // After expansion every capture a grammar emits must have an exact entry,
  // Because OpenTUI's fallback (first dotted segment) loses specificity
  test("every emitted capture resolves to an exact expanded style", () => {
    const sources = queryFiles.map((file) => readFileSync(file, "utf8"));
    const expanded = expandCaptureStyles(baseCaptureStyles, sources);
    const unresolved: string[] = [];

    for (const [index, source] of sources.entries()) {
      const captures = new Set((source.match(/@[\w.]*/g) ?? []).map((capture) => capture.slice(1)));
      for (const capture of captures) {
        if (metaCaptures.has(capture) || capture.startsWith("_")) {
          continue;
        }
        if (expanded[capture] === undefined) {
          unresolved.push(`@${capture} (${queryFiles[index]})`);
        }
      }
    }

    expect(unresolved).toEqual([]);
  });
});

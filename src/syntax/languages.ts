import bashHighlights from "../../assets/tree-sitter/bash/highlights.scm" with { type: "file" };
import bashWasm from "../../assets/tree-sitter/bash/tree-sitter-bash.wasm" with { type: "file" };
import jsonHighlights from "../../assets/tree-sitter/json/highlights.scm" with { type: "file" };
import jsonWasm from "../../assets/tree-sitter/json/tree-sitter-json.wasm" with { type: "file" };
import tsxJsxHighlights from "../../assets/tree-sitter/tsx/jsx.scm" with { type: "file" };
import tsxWasm from "../../assets/tree-sitter/tsx/tree-sitter-tsx.wasm" with { type: "file" };
import tsTestGlobalsHighlights from "../../assets/tree-sitter/typescript/test-globals.scm" with { type: "file" };
import yamlHighlights from "../../assets/tree-sitter/yaml/highlights.scm" with { type: "file" };
import yamlWasm from "../../assets/tree-sitter/yaml/tree-sitter-yaml.wasm" with { type: "file" };
import jsBundledHighlights from "../../node_modules/@opentui/core/assets/javascript/highlights.scm" with { type: "file" };
import markdownBundledHighlights from "../../node_modules/@opentui/core/assets/markdown/highlights.scm" with { type: "file" };
import markdownInlineBundledHighlights from "../../node_modules/@opentui/core/assets/markdown_inline/highlights.scm" with { type: "file" };
import tsBundledHighlights from "../../node_modules/@opentui/core/assets/typescript/highlights.scm" with { type: "file" };
import tsBundledWasm from "../../node_modules/@opentui/core/assets/typescript/tree-sitter-typescript.wasm" with { type: "file" };
import zigBundledHighlights from "../../node_modules/@opentui/core/assets/zig/highlights.scm" with { type: "file" };

export interface Language {
  filetype: string;
  extensions: string[];
  // Every highlight query the filetype renders with; also feeds capture-style expansion
  highlights: string[];
  // Grammar to register with the tree-sitter client; absent means the parser
  // Ships bundled with @opentui/core and registers itself
  wasm?: string;
  aliases?: string[];
  // A bundled parser can only be replaced after the client initializes
  replacesBundled?: boolean;
}

// One language = one entry (plus asset files); filetype.ts and syntax.ts both
// Derive from this table
export const languages: Language[] = [
  {
    extensions: [".ts"],
    filetype: "typescript",
    highlights: [tsBundledHighlights, tsTestGlobalsHighlights],
    replacesBundled: true,
    wasm: tsBundledWasm,
  },
  {
    // The bundled typescript and javascript grammars mishandle JSX, so .tsx and
    // .jsx render with the tsx grammar (a superset that parses both)
    aliases: ["typescriptreact", "javascriptreact"],
    extensions: [".tsx", ".jsx"],
    filetype: "tsx",
    highlights: [tsBundledHighlights, tsxJsxHighlights, tsTestGlobalsHighlights],
    wasm: tsxWasm,
  },
  { extensions: [".js"], filetype: "javascript", highlights: [jsBundledHighlights] },
  {
    extensions: [".sh", ".bash", ".zsh"],
    filetype: "bash",
    highlights: [bashHighlights],
    wasm: bashWasm,
  },
  {
    extensions: [".json", ".jsonc"],
    filetype: "json",
    highlights: [jsonHighlights],
    wasm: jsonWasm,
  },
  { extensions: [".yaml", ".yml"], filetype: "yaml", highlights: [yamlHighlights], wasm: yamlWasm },
  {
    extensions: [".md", ".mdx"],
    filetype: "markdown",
    highlights: [markdownBundledHighlights, markdownInlineBundledHighlights],
  },
  { extensions: [".zig"], filetype: "zig", highlights: [zigBundledHighlights] },
];

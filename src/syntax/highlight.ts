import { SyntaxStyle, getTreeSitterClient, type TreeSitterClient } from "@opentui/core";

import type { SyntaxCaptureStyles } from "../theme/tokens";
import { supportedFiletypeFor } from "./filetype";
import { languages } from "./languages";

export type SyntaxConfig =
  | {
      enabled: true;
      querySources: string[];
      style: SyntaxStyle;
      treeSitterClient: TreeSitterClient;
      status: string;
    }
  | {
      enabled: false;
      status: string;
    };

// OpenTUI resolves a capture as exact name -> first dotted segment -> default,
// So a dotted capture without an exact entry silently loses its specific
// Style. Alias every dotted capture the given queries emit to its longest
// Styled prefix (e.g. a future "keyword.import" -> "keyword").
export function expandCaptureStyles(
  captureStyles: SyntaxCaptureStyles,
  querySources: string[],
): SyntaxCaptureStyles {
  const expanded = { ...captureStyles };

  for (const source of querySources) {
    for (const name of captureNames(source)) {
      if (expanded[name] !== undefined || !name.includes(".")) {
        continue;
      }

      const parts = name.split(".");
      for (let length = parts.length - 1; length >= 1; length -= 1) {
        const style = expanded[parts.slice(0, length).join(".")];
        if (style !== undefined) {
          expanded[name] = style;
          break;
        }
      }
    }
  }

  return expanded;
}

function captureNames(source: string) {
  const matches = source.match(/@[\w.]+/g) ?? [];
  return new Set(
    matches.map((capture) => capture.slice(1)).filter((name) => !name.startsWith("_")),
  );
}

// The rebuild seam for a future runtime theme switch: compile a new
// SyntaxStyle from another theme's capture styles and the already-loaded
// QuerySources, then pass it to <diff syntaxStyle> — no tree-sitter re-init
function compileSyntaxStyle(
  captureStyles: SyntaxCaptureStyles,
  querySources: string[],
): SyntaxStyle {
  return SyntaxStyle.fromStyles(expandCaptureStyles(captureStyles, querySources));
}

export async function createSyntaxConfig(
  captureStyles: SyntaxCaptureStyles,
): Promise<SyntaxConfig> {
  try {
    const treeSitterClient = getTreeSitterClient();

    for (const language of languages) {
      if (language.wasm !== undefined && language.replacesBundled !== true) {
        treeSitterClient.addFiletypeParser({
          aliases: language.aliases,
          filetype: language.filetype,
          queries: { highlights: language.highlights },
          wasm: language.wasm,
        });
      }
    }

    await treeSitterClient.initialize();

    // A parser that replaces a bundled one must register after initialize()
    // Or the bundled default wins; aliases must be re-supplied
    for (const language of languages) {
      if (language.wasm !== undefined && language.replacesBundled === true) {
        treeSitterClient.addFiletypeParser({
          aliases: language.aliases,
          filetype: language.filetype,
          queries: { highlights: language.highlights },
          wasm: language.wasm,
        });
      }
    }

    const querySources = await Promise.all(
      languages.flatMap((language) => language.highlights).map((path) => Bun.file(path).text()),
    );

    return {
      enabled: true,
      querySources,
      status: "syntax highlighting ready",
      style: compileSyntaxStyle(captureStyles, querySources),
      treeSitterClient,
    };
  } catch (error) {
    return {
      enabled: false,
      status: error instanceof Error ? `syntax disabled: ${error.message}` : "syntax disabled",
    };
  }
}

export function diffFiletypeFor(path: string, syntax: SyntaxConfig) {
  if (!syntax.enabled) {
    return "text";
  }

  return supportedFiletypeFor(path) ?? "text";
}

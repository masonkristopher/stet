import type { ThemeRegistration } from "@pierre/diffs";

import type { Theme } from "./tokens";

export const STET_SHIKI_THEME_NAME = "stet";

// Builds a Shiki theme from any stet Theme, mapping TextMate scopes onto its
// `syntax` tokens so `@pierre/diffs`/Shiki highlights diffs from the same single
// Source of truth as the rest of the UI (no separate palette). Font styles are
// Emphasis, not color, so they are theme-independent. Driven by the Theme rather
// Than hardcoded to dark, so the light theme gets a matching registration for free.
export function shikiTheme(theme: Theme, type: "dark" | "light"): ThemeRegistration {
  const {
    comment,
    function: fn,
    keyword,
    keywordControl,
    keywordImport,
    member,
    number,
    operator,
    punctuation,
    string,
    tag,
    type: typeColor,
  } = theme.syntax;

  return {
    bg: theme.surface.base,
    fg: theme.text.primary,
    name: STET_SHIKI_THEME_NAME,
    settings: [
      { scope: ["comment"], settings: { fontStyle: "italic", foreground: comment } },
      {
        scope: ["keyword", "storage", "storage.type", "storage.modifier", "keyword.control"],
        settings: { fontStyle: "bold", foreground: keyword },
      },
      // More specific than the broad keyword rule above, so TextMate matching picks
      // These: module keywords (import/export/from/default) and the control-flow
      // Family (async via storage.modifier.async; await/return/throw/yield/break via
      // Keyword.control.flow, which the grammar does not split per-word).
      {
        scope: [
          "keyword.control.import",
          "keyword.control.export",
          "keyword.control.from",
          "keyword.control.default",
        ],
        settings: { fontStyle: "bold", foreground: keywordImport },
      },
      {
        scope: ["keyword.control.flow", "storage.modifier.async"],
        settings: { fontStyle: "bold", foreground: keywordControl },
      },
      {
        scope: ["keyword.operator", "punctuation.accessor", "operator"],
        settings: { foreground: operator },
      },
      { scope: ["string", "string.quoted", "string.template"], settings: { foreground: string } },
      { scope: ["constant.character.escape", "string.regexp"], settings: { foreground: operator } },
      { scope: ["constant.numeric"], settings: { foreground: number } },
      { scope: ["constant.language"], settings: { fontStyle: "bold", foreground: number } },
      {
        scope: ["constant", "support.constant", "variable.other.constant"],
        settings: { foreground: number },
      },
      {
        scope: ["entity.name.function", "support.function", "meta.function-call.generic"],
        settings: { foreground: fn },
      },
      {
        scope: ["entity.name.type", "support.type", "support.class", "entity.name.class"],
        settings: { foreground: typeColor },
      },
      {
        scope: ["variable.other.property", "meta.object-literal.key", "support.variable"],
        settings: { foreground: member },
      },
      { scope: ["entity.name.namespace", "entity.name.label"], settings: { foreground: member } },
      { scope: ["entity.name.tag"], settings: { foreground: tag } },
      {
        scope: ["entity.other.attribute-name"],
        settings: { fontStyle: "italic", foreground: typeColor },
      },
      { scope: ["variable"], settings: { foreground: theme.text.primary } },
      { scope: ["punctuation"], settings: { foreground: punctuation } },
      // Markdown
      { scope: ["markup.heading"], settings: { fontStyle: "bold", foreground: keyword } },
      { scope: ["markup.bold"], settings: { fontStyle: "bold" } },
      { scope: ["markup.italic"], settings: { fontStyle: "italic" } },
      { scope: ["markup.inline.raw", "markup.raw"], settings: { foreground: string } },
      { scope: ["markup.underline.link"], settings: { fontStyle: "underline", foreground: fn } },
    ],
    type,
  };
}

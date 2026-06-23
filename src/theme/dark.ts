import type { Theme } from "./tokens";

// Catppuccin Mocha as the foundation (soft base, pastel discipline) with a Ghost in
// The Shell lean: the cool Teal/Sky/Sapphire/Blue family leads the syntax field while
// Pink stays at the forefront for sideye's identity (keyword, focus border, accent,
// Recency). Shared hexes are intentionally repeated across tokens (e.g. Green in
// Diff.addedSign / stage.staged / kind.added / success): each role may diverge in
// Another theme, so call sites must not assume they match.
export const darkTheme: Theme = {
  accent: { primary: "#f5c2e7" },
  // Focus border is a whole-pane perimeter painted in the Pink identity accent; the
  // Small active accents (input cursor, find prefix) share accent.primary.
  border: { focused: "#f5c2e7", unfocused: "#313244" },
  diff: {
    addedBg: "#253b2d",
    addedLineNumberBg: "#2a4a2d",
    addedSign: "#a6e3a1",
    lineNumberFg: "#585b70",
    removedBg: "#421b30",
    removedLineNumberBg: "#581932",
    removedSign: "#f38ba8",
  },
  find: { matchBg: "#364d63" },
  kind: {
    added: "#a6e3a1",
    deleted: "#f38ba8",
    modified: "#f9e2af",
    renamed: "#cba6f7",
    untracked: "#a6e3a1",
  },
  recency: { aged: "#6c7086", fresh: "#f5c2e7" },
  scrollbar: { thumb: "#585b70" },
  severity: {
    error: "#f38ba8",
    errorGutterBg: "#5a3d50",
    info: "#89dceb",
    infoGutterBg: "#3a4f5f",
    warning: "#f9e2af",
    warningGutterBg: "#575150",
  },
  stage: {
    mixed: "#fab387",
    staged: "#a6e3a1",
    unstaged: "#f9e2af",
    untracked: "#9399b2",
  },
  success: "#a6e3a1",
  surface: { base: "#1e1e2e", cursor: "#45475a", panel: "#181825" },
  syntax: {
    comment: "#7f849c",
    function: "#74c7ec",
    keyword: "#f5c2e7",
    keywordControl: "#fab387",
    keywordImport: "#cba6f7",
    member: "#89b4fa",
    number: "#f9e2af",
    operator: "#89dceb",
    punctuation: "#9399b2",
    string: "#a6e3a1",
    tag: "#b4befe",
    type: "#94e2d5",
  },
  text: {
    faint: "#6c7086",
    muted: "#7f849c",
    primary: "#cdd6f4",
    secondary: "#a6adc8",
    selected: "#cdd6f4",
    strong: "#bac2de",
  },
};

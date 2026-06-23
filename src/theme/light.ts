import type { Theme } from "./tokens";

// The light counterpart to darkTheme: Catppuccin Latte as the foundation, mirroring
// Mocha's roles key-for-key (the theme test asserts parity) with the same GITS-cool
// Syntax lean. Pink stays at the forefront, but Latte's named Pink is too low-contrast
// For dense text, so keyword + focus border use a deeper sideye-pink (#b83080) while
// The thin caret/find accent and recency dot keep the vivid Latte Pink.
export const lightTheme: Theme = {
  accent: { primary: "#ea76cb" },
  border: { focused: "#b83080", unfocused: "#bcc0cc" },
  diff: {
    addedBg: "#d3e4d5",
    addedLineNumberBg: "#c2dcc0",
    addedSign: "#40a02b",
    lineNumberFg: "#9ca0b0",
    removedBg: "#ebd1db",
    removedLineNumberBg: "#e8bbc8",
    removedSign: "#d20f39",
  },
  find: { matchBg: "#c6e1e8" },
  kind: {
    added: "#40a02b",
    deleted: "#d20f39",
    modified: "#df8e1d",
    renamed: "#8839ef",
    untracked: "#40a02b",
  },
  recency: { aged: "#9ca0b0", fresh: "#ea76cb" },
  scrollbar: { thumb: "#acb0be" },
  severity: {
    error: "#d20f39",
    errorGutterBg: "#eac8d3",
    info: "#04a5e5",
    infoGutterBg: "#c5e3f2",
    warning: "#df8e1d",
    warningGutterBg: "#ebdbc5",
  },
  stage: {
    mixed: "#fe640b",
    staged: "#40a02b",
    unstaged: "#df8e1d",
    untracked: "#7c7f93",
  },
  success: "#40a02b",
  surface: { base: "#eff1f5", cursor: "#ccd0da", panel: "#e6e9ef" },
  syntax: {
    comment: "#8c8fa1",
    function: "#209fb5",
    keyword: "#b83080",
    keywordControl: "#fe640b",
    keywordImport: "#8839ef",
    member: "#1e66f5",
    number: "#df8e1d",
    operator: "#04a5e5",
    punctuation: "#7c7f93",
    string: "#40a02b",
    tag: "#7287fd",
    type: "#179299",
  },
  text: {
    faint: "#9ca0b0",
    muted: "#8c8fa1",
    primary: "#4c4f69",
    secondary: "#6c6f85",
    selected: "#4c4f69",
    strong: "#5c5f77",
  },
};

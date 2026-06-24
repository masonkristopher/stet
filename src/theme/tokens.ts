import type { ChangeKind, StageState } from "../git/model";

// Every value is a plain hex string so a user-supplied theme (e.g. parsed from
// JSON) can satisfy this type directly; RGBA precomputation happens in resolve.ts
export interface Theme {
  accent: { primary: string };
  border: { focused: string; unfocused: string };
  diff: {
    addedBg: string;
    addedLineNumberBg: string;
    addedSign: string;
    lineNumberFg: string;
    removedBg: string;
    removedLineNumberBg: string;
    removedSign: string;
  };
  find: { matchBg: string };
  kind: Record<ChangeKind, string>;
  // Recency dot ramps fresh -> aged across an activity's lifetime, then vanishes.
  recency: { fresh: string; aged: string };
  // Only the thumb is themed; the track stays transparent so it inherits
  // Whatever surface it scrolls over (rgba.transparent at the call sites).
  scrollbar: { thumb: string };
  severity: {
    error: string;
    warning: string;
    info: string;
  };
  stage: Record<StageState, string>;
  success: string;
  surface: { base: string; cursor: string; panel: string };
  syntax: {
    comment: string;
    keyword: string;
    keywordControl: string;
    keywordImport: string;
    operator: string;
    string: string;
    number: string;
    function: string;
    type: string;
    member: string;
    tag: string;
    punctuation: string;
  };
  text: {
    faint: string;
    muted: string;
    primary: string;
    secondary: string;
    selected: string;
    strong: string;
  };
}

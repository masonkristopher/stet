import { Schema } from "effect";

import type { ChangeKind, StageState } from "@/git/model";

// Every value is a 6-digit lowercase hex string. `ThemeSchema` is the single
// Source of truth: the `Theme` type is derived from it, and a user-supplied
// Theme (parsed from JSON config) is validated against it. RGBA precomputation
// Happens in resolve.ts.
const Hex = Schema.String.pipe(
  Schema.check(
    Schema.isPattern(/^#[0-9a-f]{6}$/, {
      message: "expected a 6-digit lowercase hex color, e.g. #1a2b3c",
    }),
  ),
);

// Typed as a full record over the git-status unions, so adding a `ChangeKind` or
// `StageState` without a matching token here is a compile error rather than a
// Silently unthemed status.
const kindTokens: Record<ChangeKind, typeof Hex> = {
  added: Hex,
  deleted: Hex,
  modified: Hex,
  renamed: Hex,
  untracked: Hex,
};

const stageTokens: Record<StageState, typeof Hex> = {
  mixed: Hex,
  staged: Hex,
  unstaged: Hex,
  untracked: Hex,
};

export const ThemeSchema = Schema.Struct({
  accent: Schema.Struct({ primary: Hex }),
  border: Schema.Struct({ focused: Hex, unfocused: Hex }),
  // Background of the word under the in-line caret; reads on top of the cursor-row
  // Highlight, so it is distinct from `surface.cursor` and `find.matchBg`.
  caret: Schema.Struct({ wordBg: Hex }),
  diff: Schema.Struct({
    addedBg: Hex,
    addedLineNumberBg: Hex,
    addedSign: Hex,
    lineNumberFg: Hex,
    removedBg: Hex,
    removedLineNumberBg: Hex,
    removedSign: Hex,
  }),
  find: Schema.Struct({ matchBg: Hex }),
  kind: Schema.Struct(kindTokens),
  // Recency dot ramps fresh -> aged across an activity's lifetime, then vanishes.
  recency: Schema.Struct({ aged: Hex, fresh: Hex }),
  // Only the thumb is themed; the track stays transparent so it inherits
  // Whatever surface it scrolls over (rgba.transparent at the call sites).
  scrollbar: Schema.Struct({ thumb: Hex }),
  severity: Schema.Struct({ error: Hex, info: Hex, warning: Hex }),
  stage: Schema.Struct(stageTokens),
  success: Hex,
  surface: Schema.Struct({ base: Hex, cursor: Hex, panel: Hex }),
  syntax: Schema.Struct({
    comment: Hex,
    function: Hex,
    keyword: Hex,
    keywordControl: Hex,
    keywordImport: Hex,
    member: Hex,
    number: Hex,
    operator: Hex,
    punctuation: Hex,
    string: Hex,
    tag: Hex,
    type: Hex,
  }),
  text: Schema.Struct({
    faint: Hex,
    muted: Hex,
    primary: Hex,
    secondary: Hex,
    selected: Hex,
    strong: Hex,
  }),
});

export type Theme = Schema.Schema.Type<typeof ThemeSchema>;

import type { SyntaxStyle } from "@opentui/core";

import type { ChangeKind, StageState } from "../git/model";

export type SyntaxCaptureStyles = Parameters<typeof SyntaxStyle.fromStyles>[0];

// Every value is a plain hex string so a user-supplied theme (e.g. parsed from
// JSON) can satisfy this type directly; RGBA precomputation happens in resolve.ts
export interface Theme {
  accent: { dim: string; primary: string };
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
  kind: Record<ChangeKind, string>;
  scrollbar: { thumb: string; track: string };
  severity: { error: string; errorGutterBg: string; warning: string; warningGutterBg: string };
  stage: Record<StageState, string>;
  success: string;
  surface: { base: string; cursor: string; panel: string };
  syntax: SyntaxCaptureStyles;
  text: {
    faint: string;
    muted: string;
    primary: string;
    secondary: string;
    selected: string;
    strong: string;
  };
}

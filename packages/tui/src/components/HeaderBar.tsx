import { basename } from "node:path";

import { Show } from "solid-js";

import { scopeLabel } from "@/cli";
import { state } from "@/state";
import { useTheme } from "@/theme/context";
import { truncate } from "@/utils/text";

// Nerd Font (Material Design) glyphs for the header's git identity, code points verbatim from the
// Official Nerd Fonts glyphnames.json (never hand-guessed). Repo is md-source_repository (U+F0CCF),
// Worktree is md-file_tree (U+F0645), branch is md-source_branch (U+F062C). Decorative only: gated
// On `iconsEnabled` and dropped under `--no-icons`, where the repo name and branch text carry it.
const REPO_GLYPH = "\u{f0ccf}";
const WORKTREE_GLYPH = "\u{f0645}";
const BRANCH_GLYPH = "\u{f062c}";

// A shown glyph occupies a fixed 2-cell box; ` · ` joins the identity and the right-side fields.
const GLYPH_CELLS = 2;
const SEP = " · ";
// The row's own horizontal inset, on both edges. `available()` budgets against it, so the two must
// Move together or the line is measured wider than it paints.
const PADDING = 1;
// Floors so a squeezed line degrades to a readable stub rather than a lone ellipsis, and so a branch
// With almost no room is dropped outright instead of shown as `…`.
const MIN_SCOPE = 8;
const MIN_BRANCH = 4;

export function HeaderBar() {
  const theme = useTheme();
  // A commit scope pins a historical commit, so the identity (and especially the branch, which is
  // Unrelated to a fixed commit) is dropped: the commit subject is the thing under inspection, and
  // The terminal title still carries repo/worktree. This also frees the line for the subject.
  const isCommit = () => state.scope().kind === "commit";
  const inWorktree = () => {
    const main = state.mainWorktreePath();
    return main !== "" && state.gitModel().repoRoot !== main;
  };
  // In a linked worktree the primary token is the worktree folder (usually the branch); in the main
  // Checkout it is the repo (the stable main worktree). The leading glyph says which of the two.
  const worktreeFolder = () => basename(state.gitModel().repoRoot);
  const primary = () =>
    inWorktree() ? worktreeFolder() : basename(state.mainWorktreePath()) || worktreeFolder();
  // The branch shown next to the primary name, except in a worktree whose folder already is the
  // Branch (strict match) where it would just duplicate the primary token.
  const rawBranch = () => {
    const branch = state.gitModel().branch;
    if (branch === undefined) {
      return undefined;
    }
    return inWorktree() && branch === worktreeFolder() ? undefined : branch;
  };

  const glyphCells = () => (state.iconsEnabled() ? GLYPH_CELLS : 0);
  const available = () => Math.max(0, state.terminalWidth() - PADDING * 2);
  // The right-side fields that are never truncated: the changed count and optional diagnostics badge.
  const tail = () => {
    const changed = `${state.gitModel().changed.length} changed`;
    const counts = state.countsText();
    return counts === "" ? changed : `${changed}${SEP}${counts}`;
  };
  // A commit fills the left slot (where identity sits otherwise) and spans the width up to the tail,
  // Truncating with an ellipsis only when the full subject genuinely does not fit.
  const commitSubject = () => {
    const budget = available() - Bun.stringWidth(tail()) - SEP.length;
    return truncate(state.commitScopeLabel(), Math.max(MIN_SCOPE, budget));
  };
  // Truncate the branch to whatever the line has left after the primary name and the right side;
  // Below the floor the whole branch group is dropped rather than shown as a stub.
  const branchText = () => {
    const branch = rawBranch();
    if (branch === undefined) {
      return undefined;
    }
    const rightWidth = Bun.stringWidth(`${scopeLabel(state.scope())}${SEP}${tail()}`);
    const leftFixed = glyphCells() + Bun.stringWidth(primary()) + SEP.length + glyphCells();
    const budget = available() - rightWidth - leftFixed;
    return budget < MIN_BRANCH ? undefined : truncate(branch, budget);
  };

  return (
    <box
      height={1}
      flexDirection="row"
      justifyContent="space-between"
      paddingLeft={PADDING}
      paddingRight={PADDING}
      backgroundColor={theme.colors.surface.base}
    >
      <Show
        when={isCommit()}
        fallback={
          <box flexDirection="row">
            <Show when={state.iconsEnabled()}>
              <box width={GLYPH_CELLS} overflow="hidden">
                <text fg={theme.colors.text.muted}>
                  {inWorktree() ? WORKTREE_GLYPH : REPO_GLYPH}
                </text>
              </box>
            </Show>
            <text fg={theme.colors.text.strong}>{primary()}</text>
            <Show when={branchText()}>
              {(branch) => (
                <box flexDirection="row">
                  <text fg={theme.colors.text.secondary}>{SEP}</text>
                  <Show when={state.iconsEnabled()}>
                    <box width={GLYPH_CELLS} overflow="hidden">
                      <text fg={theme.colors.text.muted}>{BRANCH_GLYPH}</text>
                    </box>
                  </Show>
                  <text fg={theme.colors.text.secondary}>{branch()}</text>
                </box>
              )}
            </Show>
          </box>
        }
      >
        <text fg={theme.colors.text.secondary}>{commitSubject()}</text>
      </Show>
      <text fg={theme.colors.text.secondary}>
        {isCommit() ? tail() : `${scopeLabel(state.scope())}${SEP}${tail()}`}
      </text>
    </box>
  );
}

import type { ScrollBoxRenderable } from "@opentui/core";
import { batch, createEffect, Index, Show } from "solid-js";

import { recencyFraction } from "@/git/activity";
import { WORKTREE_ACTIVE_MS } from "@/git/worktree";
import { state } from "@/state";
import { useTheme } from "@/theme/context";
import { worktreeLabel } from "@/ui-helpers";
import { lerpHex } from "@/utils/color";
import { relativeTime } from "@/utils/relative-time";
import { collapseHome, truncate, truncateLeft } from "@/utils/text";

// Every cell is a fixed-width box, never a padded string: a whitespace-only `<text>` measures zero
// Cells in a flex row, so a worktree with no age would pull the columns right of it out of line.
// `11mo` is the widest age `relativeTime` produces.
const MARKER_CELLS = 2;
const AGE_CELLS = 4;
const GAP = 2;
const LABEL_MIN = 8;
// The overlay's border takes two cells and each row's own padding takes two more, so the columns
// Have four fewer than `overlayWidth`. Budgeting against the padding alone overruns the row by
// Exactly the border, and the renderer silently clips the overrun off the right edge.
const CHROME_CELLS = 4;

export function WorktreeCombobox() {
  const theme = useTheme();
  let worktreeComboboxRef: ScrollBoxRenderable | undefined;

  createEffect(() => {
    worktreeComboboxRef?.scrollChildIntoView(`worktree-combobox-${state.worktreeComboboxIndex()}`);
  });

  const repoRoot = () => state.gitModel().repoRoot;
  const highlighted = () => state.worktreeComboboxResults()?.[state.worktreeComboboxIndex()];

  // The label takes every cell the fixed columns leave, so a branch name stops truncating.
  const labelCells = () =>
    Math.max(LABEL_MIN, state.overlayWidth() - CHROME_CELLS - MARKER_CELLS - GAP - AGE_CELLS);
  // The path is one line for the highlighted worktree, not a column on every row: the worktrees of a
  // Repo share a long prefix, so a per-row path left-truncated to a fixed width slices that shared
  // Prefix at a different offset on every row (`…trees/`, `…ude/`, `…ees/`) and cuts the leaf, the
  // Only part that differs. Here it is complete: a real path fits the full overlay width, and
  // TruncateLeft only ever fires on a genuinely narrow terminal.
  const detailPath = () => {
    const worktree = highlighted();
    return worktree === undefined
      ? ""
      : truncateLeft(collapseHome(worktree.path), state.overlayWidth() - CHROME_CELLS);
  };

  // The age is the row: how long ago an agent (or git) last touched that worktree. A worktree whose
  // Summary has not landed, or whose directory is gone so it can never be read, leaves the cell
  // Empty rather than guessing. The column stays reserved either way, so a summary never shifts the
  // Row.
  const ageText = (at: number | undefined) =>
    at === undefined ? "" : relativeTime(Math.floor(at / 1000), Math.floor(state.now() / 1000));
  // It carries the fade the dot carries elsewhere: pink on a worktree touched just now, cooling into
  // The faint gray the ramp ends on as it goes quieter. It ramps over WORKTREE_ACTIVE_MS, not the
  // 30s a changed file stays fresh for, because work there arrives in bursts with pauses of minutes
  // Between them; the file-level window would grey out a worktree that was touched a minute ago.
  // This ranks recent activity, it does not claim anyone is still there. The word itself is the
  // Signal, so the row still reads under NO_COLOR; color only ranks it.
  const ageColor = (at: number | undefined) => {
    const fraction = recencyFraction(at, state.now(), WORKTREE_ACTIVE_MS);
    return fraction === undefined
      ? theme.colors.text.faint
      : lerpHex(theme.colors.recency.fresh, theme.colors.recency.aged, fraction);
  };

  function onInput(value: string) {
    batch(() => {
      state.setWorktreeComboboxQuery(value);
      state.setWorktreeComboboxIndex(0);
    });
  }

  function onSubmit() {
    const worktree = highlighted();
    if (worktree === undefined) {
      state.setWorktreeComboboxOpen(false);
    } else {
      void state.switchWorktree(worktree);
    }
  }

  return (
    <box
      position="absolute"
      left={state.overlayLeft()}
      top={1}
      width={state.overlayWidth()}
      flexDirection="column"
      borderStyle="single"
      borderColor={theme.colors.border.focused}
      backgroundColor={theme.colors.surface.panel}
      zIndex={100}
    >
      <input
        focused
        width="100%"
        placeholder="switch worktree…"
        backgroundColor={theme.colors.surface.panel}
        focusedBackgroundColor={theme.colors.surface.panel}
        textColor={theme.colors.text.primary}
        focusedTextColor={theme.colors.text.primary}
        cursorColor={theme.colors.accent.primary}
        onInput={onInput}
        onSubmit={onSubmit}
      />
      <scrollbox
        ref={(el) => (worktreeComboboxRef = el)}
        width="100%"
        height={Math.min(12, Math.max(1, state.worktreeComboboxResults()?.length ?? 1))}
        scrollY
        viewportCulling
        scrollbarOptions={{
          trackOptions: {
            backgroundColor: theme.rgba.transparent,
            foregroundColor: theme.colors.scrollbar.thumb,
          },
        }}
      >
        <Show
          when={state.worktreeComboboxResults() !== undefined}
          fallback={
            <box id="worktree-combobox-loading" paddingLeft={1}>
              <text fg={theme.colors.text.muted}>loading…</text>
            </box>
          }
        >
          <Show
            when={(state.worktreeComboboxResults()?.length ?? 0) > 0}
            fallback={
              <box id="worktree-combobox-empty" paddingLeft={1}>
                <text fg={theme.colors.text.muted}>
                  {state.worktreeComboboxQuery() === "" ? "no worktrees" : "no matches"}
                </text>
              </box>
            }
          >
            {/* Id-by-index is required: reordering must never change a live renderable's id */}
            <Index each={state.worktreeComboboxResults()}>
              {(worktree, index) => {
                const summary = () => state.worktreeSummaries().get(worktree().path);
                const activityAt = () => summary()?.lastActivityAt;
                const current = () => worktree().path === repoRoot();
                const badges = () =>
                  [worktree().locked ? "locked" : "", worktree().prunable ? "prunable" : ""]
                    .filter((badge) => badge !== "")
                    .join(" ");
                const nameFg = () =>
                  index === state.worktreeComboboxIndex()
                    ? theme.colors.text.selected
                    : theme.colors.text.strong;
                // The badge shares the label's column rather than claiming one of its own: `locked`
                // And `prunable` are rare, and a column reserved for them on every row would be
                // Empty nearly always while costing the branch name the cells it needs.
                const nameCells = () =>
                  Math.max(4, labelCells() - (badges() === "" ? 0 : badges().length + 1));
                return (
                  <box
                    id={`worktree-combobox-${index}`}
                    height={1}
                    width="100%"
                    flexDirection="row"
                    paddingLeft={1}
                    paddingRight={1}
                    backgroundColor={
                      index === state.worktreeComboboxIndex()
                        ? theme.colors.surface.cursor
                        : theme.colors.surface.panel
                    }
                    onMouseDown={() => batch(() => void state.switchWorktree(worktree()))}
                  >
                    {/* Every text is pinned to one line (height 1 + wrapMode none): a branch name or
                        path long enough to wrap would lay the row out two cells tall and mangle the
                        list, exactly as it would in the scope menu's commit rows. */}
                    <box width={MARKER_CELLS} flexShrink={0} flexDirection="row">
                      <Show when={current()}>
                        <text wrapMode="none" height={1} fg={nameFg()}>
                          ●
                        </text>
                      </Show>
                    </box>
                    <box width={labelCells()} flexShrink={0} flexDirection="row">
                      <text wrapMode="none" height={1} fg={nameFg()}>
                        {truncate(worktreeLabel(worktree()), nameCells())}
                      </text>
                      <Show when={badges() !== ""}>
                        <text
                          wrapMode="none"
                          height={1}
                          marginLeft={1}
                          fg={theme.colors.severity.warning}
                        >
                          {badges()}
                        </text>
                      </Show>
                    </box>
                    <box
                      width={AGE_CELLS}
                      marginLeft={GAP}
                      flexShrink={0}
                      flexDirection="row"
                      justifyContent="flex-end"
                    >
                      <Show when={ageText(activityAt()) !== ""}>
                        <text wrapMode="none" height={1} fg={ageColor(activityAt())}>
                          {ageText(activityAt())}
                        </text>
                      </Show>
                    </box>
                  </box>
                );
              }}
            </Index>
          </Show>
        </Show>
      </scrollbox>
      {/* Where the highlighted worktree actually lives. Fixed height whether or not a row is
          highlighted (loading, no matches), so the overlay never shifts under the hint. */}
      <box height={1} paddingLeft={1} paddingRight={1} backgroundColor={theme.colors.surface.panel}>
        <text wrapMode="none" height={1} fg={theme.colors.text.muted}>
          {detailPath()}
        </text>
      </box>
      <box height={1} paddingLeft={1} backgroundColor={theme.colors.surface.panel}>
        <text fg={theme.colors.text.muted}>↑↓ navigate · ⏎ switch · esc close</text>
      </box>
    </box>
  );
}

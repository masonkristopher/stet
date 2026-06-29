import type { ScrollBoxRenderable } from "@opentui/core";
import { batch, createEffect, Index, Show } from "solid-js";

import { state } from "@/state";
import { useTheme } from "@/theme/context";
import { worktreeLabel } from "@/ui-helpers";
import { collapseHome, truncateLeft } from "@/utils/text";

export function WorktreeCombobox() {
  const theme = useTheme();
  let worktreeComboboxRef: ScrollBoxRenderable | undefined;

  createEffect(() => {
    worktreeComboboxRef?.scrollChildIntoView(`worktree-combobox-${state.worktreeComboboxIndex()}`);
  });

  const repoRoot = () => state.gitModel().repoRoot;

  function onInput(value: string) {
    batch(() => {
      state.setWorktreeComboboxQuery(value);
      state.setWorktreeComboboxIndex(0);
    });
  }

  function onSubmit() {
    const worktree = state.worktreeComboboxResults()?.[state.worktreeComboboxIndex()];
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
                const current = () => worktree().path === repoRoot();
                const badges = () =>
                  [worktree().locked ? "locked" : "", worktree().prunable ? "prunable" : ""]
                    .filter((badge) => badge !== "")
                    .join(" ");
                const nameFg = () =>
                  index === state.worktreeComboboxIndex()
                    ? theme.colors.text.selected
                    : theme.colors.text.strong;
                return (
                  <box
                    id={`worktree-combobox-${index}`}
                    width="100%"
                    flexDirection="row"
                    justifyContent="space-between"
                    paddingLeft={1}
                    paddingRight={1}
                    backgroundColor={
                      index === state.worktreeComboboxIndex()
                        ? theme.colors.surface.cursor
                        : theme.colors.surface.panel
                    }
                    onMouseDown={() => batch(() => void state.switchWorktree(worktree()))}
                  >
                    <text
                      fg={nameFg()}
                    >{`${current() ? "● " : "  "}${worktreeLabel(worktree())}`}</text>
                    <box flexDirection="row">
                      {badges() === "" ? null : (
                        <text fg={theme.colors.severity.warning}>{`${badges()} `}</text>
                      )}
                      <text fg={theme.colors.text.muted}>
                        {truncateLeft(
                          collapseHome(worktree().path),
                          Math.max(
                            10,
                            state.overlayWidth() - worktreeLabel(worktree()).length - 16,
                          ),
                        )}
                      </text>
                    </box>
                  </box>
                );
              }}
            </Index>
          </Show>
        </Show>
      </scrollbox>
      <box height={1} paddingLeft={1} backgroundColor={theme.colors.surface.panel}>
        <text fg={theme.colors.text.muted}>↑↓ navigate · ⏎ switch · esc close</text>
      </box>
    </box>
  );
}

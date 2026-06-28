import type { ScrollBoxRenderable } from "@opentui/core";
import { batch, createEffect, Index, Show } from "solid-js";

import { state } from "../state";
import { useTheme } from "../theme/context";
import { worktreeLabel } from "../ui-helpers";
import { collapseHome, truncateLeft } from "../utils/text";

export function WorktreeMenu() {
  const theme = useTheme();
  let worktreeMenuRef: ScrollBoxRenderable | undefined;

  createEffect(() => {
    worktreeMenuRef?.scrollChildIntoView(`worktree-menu-${state.worktreeMenuIndex()}`);
  });

  const repoRoot = () => state.gitModel().repoRoot;

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
      <box height={1} paddingLeft={1} backgroundColor={theme.colors.surface.panel}>
        <text fg={theme.colors.text.strong}>switch worktree</text>
      </box>
      <scrollbox
        ref={(el) => (worktreeMenuRef = el)}
        width="100%"
        height={Math.min(12, Math.max(1, state.worktrees()?.length ?? 1))}
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
          when={state.worktrees() !== undefined}
          fallback={
            <box id="worktree-menu-loading" paddingLeft={1}>
              <text fg={theme.colors.text.muted}>loading…</text>
            </box>
          }
        >
          <Show
            when={(state.worktrees()?.length ?? 0) > 0}
            fallback={
              <box id="worktree-menu-empty" paddingLeft={1}>
                <text fg={theme.colors.text.muted}>no worktrees</text>
              </box>
            }
          >
            {/* Id-by-index is required: reordering must never change a live renderable's id */}
            <Index each={state.worktrees()}>
              {(worktree, index) => {
                const current = () => worktree().path === repoRoot();
                const badges = () =>
                  [worktree().locked ? "locked" : "", worktree().prunable ? "prunable" : ""]
                    .filter((badge) => badge !== "")
                    .join(" ");
                const nameFg = () =>
                  index === state.worktreeMenuIndex()
                    ? theme.colors.text.selected
                    : theme.colors.text.strong;
                return (
                  <box
                    id={`worktree-menu-${index}`}
                    width="100%"
                    flexDirection="row"
                    justifyContent="space-between"
                    paddingLeft={1}
                    paddingRight={1}
                    backgroundColor={
                      index === state.worktreeMenuIndex()
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

import type { ScrollBoxRenderable } from "@opentui/core";
import { createEffect, Index, Show } from "solid-js";

import { state } from "../state";
import { useTheme } from "../theme/context";
import { worktreeLabel } from "../ui-helpers";
import { collapseHome, truncateLeft } from "../utils/text";

export function WorktreePicker() {
  const theme = useTheme();
  let worktreeRef: ScrollBoxRenderable | undefined;

  createEffect(() => {
    worktreeRef?.scrollChildIntoView(`worktree-${state.worktreeIndex()}`);
  });

  const repoRoot = () => state.gitModel().repoRoot;

  return (
    <box
      position="absolute"
      left={state.paletteLeft()}
      top={1}
      width={state.paletteWidth()}
      flexDirection="column"
      borderStyle="single"
      borderColor={theme.colors.border.focused}
      backgroundColor={theme.colors.surface.panel}
      zIndex={100}
    >
      <box height={1} paddingLeft={1} backgroundColor={theme.colors.surface.panel}>
        <text fg={theme.colors.accent.primary}>worktrees</text>
      </box>
      <scrollbox
        ref={(el) => (worktreeRef = el)}
        width="100%"
        height={Math.min(12, Math.max(1, state.worktrees()?.length ?? 1))}
        scrollY
        viewportCulling
      >
        <Show
          when={state.worktrees() !== undefined}
          fallback={
            <box id="worktree-loading" paddingLeft={1}>
              <text fg={theme.colors.text.muted}>loading…</text>
            </box>
          }
        >
          <Show
            when={(state.worktrees()?.length ?? 0) > 0}
            fallback={
              <box id="worktree-empty" paddingLeft={1}>
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
                  index === state.worktreeIndex()
                    ? theme.colors.text.selected
                    : current()
                      ? theme.colors.accent.primary
                      : theme.colors.text.strong;
                return (
                  <box
                    id={`worktree-${index}`}
                    width="100%"
                    flexDirection="row"
                    justifyContent="space-between"
                    paddingLeft={1}
                    paddingRight={1}
                    backgroundColor={
                      index === state.worktreeIndex()
                        ? theme.colors.surface.cursor
                        : theme.colors.surface.panel
                    }
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
                            state.paletteWidth() - worktreeLabel(worktree()).length - 16,
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
    </box>
  );
}

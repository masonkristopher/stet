import type { ScrollBoxRenderable } from "@opentui/core";
import { createEffect, For, Show } from "solid-js";

import { state } from "@/state";
import { useTheme } from "@/theme/context";
import { createDoubleClickGuard } from "@/utils/double-click";

import { TreeRow } from "./TreeRow";

export function Sidebar() {
  const theme = useTheme();
  let sidebarRef: ScrollBoxRenderable | undefined;
  // One guard for the whole tree: double-clicking a file row pins it, mirroring
  // The tab strip. Owned here (not per row) so it outlives a row remount.
  const isDoubleFileClick = createDoubleClickGuard();

  // Keep the focused row in view as the cursor moves.
  createEffect(() => {
    const rows = state.treeRows();
    const focusedRow = rows[state.focusedRowIndex()];
    if (focusedRow !== undefined) {
      sidebarRef?.scrollChildIntoView(focusedRow.node.id);
    }
  });

  const focused = () => state.focusedPane() === "tree";

  return (
    <box
      width={state.sidebarWidth()}
      height="100%"
      flexDirection="column"
      borderStyle="single"
      borderColor={focused() ? theme.colors.border.focused : theme.colors.border.unfocused}
      onMouseDown={() => state.setFocusedPane("tree")}
    >
      <scrollbox
        ref={(el) => {
          // The scrollbox is focusable by default and, once a mouse click or
          // Wheel gives it keyboard focus, its own handler scrolls by 1/5 of a
          // Viewport on each arrow/j/k press, fighting the tree's cursor-follow
          // And leaving the highlight offscreen. Sideye drives all navigation
          // Through its own keymap, so the viewport must never capture keys.
          el.focusable = false;
          sidebarRef = el;
        }}
        width="100%"
        height={state.paneHeight()}
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
          when={state.treeRows().length > 0}
          fallback={
            <box
              id="tree-empty"
              width="100%"
              height={state.paneHeight()}
              flexDirection="column"
              justifyContent="center"
              alignItems="center"
              backgroundColor={theme.colors.surface.base}
            >
              <text fg={theme.colors.text.muted}>
                {state.changesOnly() ? "no changes" : "no files"}
              </text>
              <text fg={theme.colors.text.faint}>
                {state.changesOnly() ? "press c to show all" : "this repository has no files yet"}
              </text>
            </box>
          }
        >
          <For each={state.treeRows()}>
            {(row) => <TreeRow row={row} isDoubleClick={isDoubleFileClick} />}
          </For>
          <Show when={state.treeRows().length < state.paneHeight()}>
            <box
              id="tree-filler"
              width="100%"
              height={state.paneHeight() - state.treeRows().length}
              backgroundColor={theme.colors.surface.base}
            />
          </Show>
        </Show>
      </scrollbox>
    </box>
  );
}

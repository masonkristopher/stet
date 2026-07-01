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
      backgroundColor={theme.colors.surface.base}
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
        // The scrollbox pins its content to minHeight 100%, so it sits exactly at
        // The viewport edge; on the first layout frame the viewport is briefly 1 row
        // Short (the horizontal scrollbar transiently claims a row), tipping content
        // Over and flashing a vertical scrollbar. Unpin it so content tracks the
        // Actual rows — a 1-row viewport wobble then can't overflow unless the rows do.
        contentOptions={{ minHeight: 0 }}
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
            // No rows yet. During the deferred repoFiles load, render nothing: the
            // Scrollbox is already a fixed paneHeight, so the pane stays blank and
            // Reserved on its own. An explicit full-height child would instead overlap
            // The incoming rows mid-swap and flash a scrollbar. Only a genuinely
            // Loaded, file-less repo gets the real empty state.
            <Show when={!state.repoFilesLoading()}>
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
            </Show>
          }
        >
          <For each={state.treeRows()}>
            {(row) => <TreeRow row={row} isDoubleClick={isDoubleFileClick} />}
          </For>
        </Show>
      </scrollbox>
    </box>
  );
}

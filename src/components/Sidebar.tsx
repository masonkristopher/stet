import { createMemo, Index, Show } from "solid-js";

import { state } from "@/state";
import { useTheme } from "@/theme/context";
import { createDoubleClickGuard } from "@/utils/double-click";

import { TreeRow } from "./TreeRow";
import { windowWheelHandler } from "./wheel";

export function Sidebar() {
  const theme = useTheme();
  // One guard for the whole tree: double-clicking a file row pins it, mirroring
  // The tab strip. Owned here (not per row) so it outlives a row remount.
  const isDoubleFileClick = createDoubleClickGuard();

  const focused = () => state.focusedPane() === "tree";

  // Window the tree to the viewport, the SearchPane pattern: only ~paneHeight
  // TreeRow renderables ever exist, so a 100k-file repo mounts and scrolls at
  // The same cost as a small one. The cursor-follow and clamp live in state.
  const visibleRows = createMemo(() => {
    const start = state.sidebarScrollTop();
    return state.treeRows().slice(start, start + state.paneHeight());
  });

  const onWheel = windowWheelHandler({
    rowCount: () => state.treeRows().length,
    scrollTop: state.sidebarScrollTop,
    setScrollTop: state.setSidebarScrollTop,
    viewport: state.paneHeight,
  });

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
      <box
        ref={(el) => {
          // A click activates a row; it must never start a text selection.
          el.selectable = false;
        }}
        width="100%"
        height={state.paneHeight()}
        flexDirection="column"
        onMouseScroll={onWheel}
      >
        <Show
          when={state.treeRows().length > 0}
          fallback={
            // No rows yet. During the deferred repoFiles load, render nothing: the
            // Window is already a fixed paneHeight, so the pane stays blank and
            // Reserved on its own. Only a genuinely loaded, file-less repo gets
            // The real empty state.
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
          <Index each={visibleRows()}>
            {(row) => <TreeRow row={row()} isDoubleClick={isDoubleFileClick} />}
          </Index>
        </Show>
      </box>
    </box>
  );
}

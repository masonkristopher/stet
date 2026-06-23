import type { ScrollBoxRenderable } from "@opentui/core";
import { createEffect, For, Show } from "solid-js";

import { state } from "../state";
import { useTheme } from "../theme/context";
import { TreeRow } from "./TreeRow";

export function Sidebar() {
  const theme = useTheme();
  let sidebarRef: ScrollBoxRenderable | undefined;

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
    >
      <scrollbox
        ref={(el) => (sidebarRef = el)}
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
        <For each={state.treeRows()}>{(row) => <TreeRow row={row} />}</For>
        <Show when={state.treeRows().length < state.paneHeight()}>
          <box
            id="tree-filler"
            width="100%"
            height={state.paneHeight() - state.treeRows().length}
            backgroundColor={theme.colors.surface.base}
          />
        </Show>
      </scrollbox>
    </box>
  );
}

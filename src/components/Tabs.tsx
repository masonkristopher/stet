import { createTextAttributes } from "@opentui/core";
import { batch, createMemo, Index, Show } from "solid-js";

import { state } from "@/state";
import { useTheme } from "@/theme/context";
import { createDoubleClickGuard } from "@/utils/double-click";
import { truncateLeft, truncateName } from "@/utils/text";

// The active tab shows its path (truncated from the left to keep the filename);
// Inactive tabs show just the basename. RIGHT_RESERVE keeps room for the status
// Segment (scope · stats · ln N) so the strip never shoves it off the row.
const PATH_MAX = 40;
const TAB_MAX = 24;
const RIGHT_RESERVE = 18;

function baseName(path: string) {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? path : path.slice(slash + 1);
}

// The inline tab strip: it replaces the viewer title when more than one tab is
// Open, reusing the existing title row (zero extra rows). The visible tabs are a
// Window centered on the active one, with ‹ › when more are clipped, so the
// Active tab is always shown however narrow the viewer.
export function Tabs() {
  const theme = useTheme();
  const isDoubleClick = createDoubleClickGuard();

  const layout = createMemo(() => {
    const cells = state.tabItems().map((tab) => {
      const label =
        tab.path === undefined
          ? "·"
          : tab.active
            ? truncateLeft(tab.path, PATH_MAX)
            : truncateName(baseName(tab.path), TAB_MAX);
      return {
        active: tab.active,
        id: tab.id,
        label,
        preview: tab.preview,
        // Display columns (a label can hold a wide glyph), plus the 1-col pad
        // Each side; the overflow window budgets against this.
        width: Bun.stringWidth(label) + 2,
      };
    });
    if (cells.length === 0) {
      return { cells, moreLeft: false, moreRight: false };
    }
    const active = Math.max(
      0,
      cells.findIndex((cell) => cell.active),
    );
    const budget = Math.max(8, state.terminalWidth() - state.sidebarWidth() - 4 - RIGHT_RESERVE);
    const last = cells.length - 1;
    // A clipped side shows a ‹ / › glyph (one column each), so a candidate window
    // Must fit its own width plus the markers it would still leave on; expanding to
    // An edge drops that side's marker and frees its column.
    const markers = (from: number, to: number) => (from > 0 ? 1 : 0) + (to < last ? 1 : 0);
    let start = active;
    let end = active;
    let used = cells[active].width;
    for (;;) {
      const canRight =
        end < last && used + cells[end + 1].width + markers(start, end + 1) <= budget;
      const canLeft =
        start > 0 && used + cells[start - 1].width + markers(start - 1, end) <= budget;
      if (!canRight && !canLeft) {
        break;
      }
      // Bias outward evenly, preferring the right so the active tab drifts left.
      if (canRight && (!canLeft || end - active <= active - start)) {
        end += 1;
        used += cells[end].width;
      } else {
        start -= 1;
        used += cells[start].width;
      }
    }
    return {
      cells: cells.slice(start, end + 1),
      moreLeft: start > 0,
      moreRight: end < cells.length - 1,
    };
  });

  return (
    <box flexDirection="row" flexShrink={1} overflow="hidden">
      <Show when={layout().moreLeft}>
        <text fg={theme.colors.text.faint}>{"‹"}</text>
      </Show>
      <Index each={layout().cells}>
        {(cell) => (
          <box
            // Non-selectable so a double-click on a tab label doesn't start an
            // OpenTUI text selection (a stray highlight); the strip is chrome,
            // Not content (mirrors Sidebar's focusable ref).
            ref={(el) => (el.selectable = false)}
            onMouseDown={() =>
              batch(() => {
                state.activateTab(cell().id);
                if (isDoubleClick(cell().id)) {
                  state.pinActiveTab();
                }
              })
            }
          >
            {/* Hierarchy by type, not chrome: the active tab is the one full-
                strength label, the rest recede to muted; the preview is italic. */}
            <text
              ref={(el) => (el.selectable = false)}
              fg={cell().active ? theme.colors.text.primary : theme.colors.text.muted}
              attributes={createTextAttributes({ italic: cell().preview })}
            >
              {` ${cell().label} `}
            </text>
          </box>
        )}
      </Index>
      <Show when={layout().moreRight}>
        <text fg={theme.colors.text.faint}>{"›"}</text>
      </Show>
    </box>
  );
}

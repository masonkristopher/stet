import { createMemo, For } from "solid-js";

import { state } from "../state";
import { useTheme } from "../theme/context";

// The combo column is padded to this width; the action text wraps in whatever
// Remains of the overlay row after it.
const COMBO_WIDTH = 11;

// Word-wrapped line count of `text` at display `width` (matches OpenTUI's word
// Wrap). Widths are display columns via `Bun.stringWidth`, not code units, so a
// Wide glyph counts correctly. At least one line.
function wrappedLineCount(text: string, width: number) {
  if (width <= 0) {
    return 1;
  }
  let lines = 1;
  let col = 0;
  for (const word of text.split(" ")) {
    const w = Bun.stringWidth(word);
    if (col === 0) {
      col = w;
    } else if (col + 1 + w <= width) {
      col += 1 + w;
    } else {
      lines += 1;
      col = w;
    }
  }
  return lines;
}

// Mirrors the Keys table in README.md
const KEY_HELP: [combo: string, action: string][] = [
  ["j / k", "move in the tree, viewer, or problems panel"],
  ["h / l", "collapse / expand folders (tree) or hop the caret by word (viewer)"],
  ["tab", "switch focus between tree and viewer"],
  ["enter", "open the focused item / jump to a problem"],
  ["ctrl-p", "go to file: fuzzy-search the whole repo"],
  ["/", "find in the viewer; n/N cycle matches, esc clears"],
  ["ctrl-f", "search file contents; ctrl-a toggles changes/repo"],
  ["e", "open in terminal editor (suspends TUI, --editor template)"],
  ["o", "open in GUI / IDE (renderer stays live, --ide template)"],
  ["s", "cycle scope: all changes → staged → unstaged"],
  ["t", "theme switcher: filter, live-preview, apply"],
  ["w", "switch to another git worktree"],
  ["c", "toggle changes-only filter for the tree"],
  ["v", "toggle diff ↔ full file view for a changed file"],
  ["z", "toggle long-line wrap in the viewer"],
  ["p", "toggle the problems panel"],
  ["b", "toggle the file tree sidebar"],
  ["[ / ] / \\", "shrink (collapses past min) / grow / reset sidebar"],
  [".", "jump to the most recently changed file"],
  ["n", "jump to the next file with findings"],
  ["y", "copy path (tree) or path:line:col (viewer; path:line on a line-number click)"],
  ["f", "load full content when truncated"],
  ["r", "re-run checks"],
  ["ctrl-d/u", "half-page cursor movement in the viewer"],
  ["g / G", "jump to first / last line"],
  ["< / >", "back / forward through viewer history"],
  ["ctrl-t", "pin / unpin the current file as a tab"],
  ["ctrl-w", "close the active tab"],
  ["{ / }", "previous / next tab"],
  ["?", "show all keybindings"],
  ["q / esc", "quit (esc closes panels first)"],
];

export function HelpDialog() {
  const theme = useTheme();
  // Size the list by its rendered height (descriptions can wrap to two lines), so
  // The overlay shows every shortcut without scrolling whenever the terminal has
  // The room; sizing by entry count alone clipped wrapped rows off the bottom.
  const listHeight = createMemo(() => {
    // Row interior after the border (2), scrollbar gutter (1), padding (2), and
    // The combo column — slightly conservative so the list never clips a row.
    const actionWidth = state.overlayWidth() - 5 - COMBO_WIDTH;
    const rendered = KEY_HELP.reduce(
      (sum, [, action]) => sum + wrappedLineCount(action, actionWidth),
      0,
    );
    return Math.min(rendered, Math.max(1, state.terminalHeight() - 7));
  });
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
        <text fg={theme.colors.text.strong}>keyboard shortcuts</text>
      </box>
      <scrollbox
        width="100%"
        height={listHeight()}
        scrollY
        viewportCulling
        scrollbarOptions={{
          trackOptions: {
            backgroundColor: theme.rgba.transparent,
            foregroundColor: theme.colors.scrollbar.thumb,
          },
        }}
      >
        <For each={KEY_HELP}>
          {([combo, action]) => (
            <box
              id={`help-dialog-${combo}`}
              width="100%"
              flexDirection="row"
              paddingLeft={1}
              paddingRight={1}
              backgroundColor={theme.colors.surface.panel}
            >
              <text fg={theme.colors.text.strong}>{combo.padEnd(COMBO_WIDTH)}</text>
              <text fg={theme.colors.text.secondary}>{action}</text>
            </box>
          )}
        </For>
      </scrollbox>
      <box height={1} paddingLeft={1} backgroundColor={theme.colors.surface.panel}>
        <text fg={theme.colors.text.muted}>esc close</text>
      </box>
    </box>
  );
}

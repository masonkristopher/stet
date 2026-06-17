import { For } from "solid-js";

import { state } from "../state";
import { useTheme } from "../theme/context";

// Mirrors the Keys table in README.md
const KEY_HELP: [combo: string, action: string][] = [
  ["j / k", "move in the tree, viewer, or problems panel"],
  ["h / l", "collapse / expand folders"],
  ["tab", "switch focus between tree and viewer"],
  ["enter", "open the focused item / jump to a problem"],
  ["ctrl-p", "go to file: fuzzy-search the whole repo"],
  ["/", "find in the viewer; n/N cycle matches, esc clears"],
  ["ctrl-f", "search file contents; ctrl-a toggles changes/repo"],
  ["s", "cycle scope: all changes → staged → unstaged"],
  ["w", "switch to another git worktree"],
  ["c", "toggle changes-only filter for the tree"],
  ["v", "toggle diff ↔ full file view for a changed file"],
  ["z", "toggle long-line wrap in the viewer"],
  ["p", "toggle the problems panel"],
  ["b", "toggle the file tree sidebar"],
  ["[ / ] / \\", "shrink (collapses past min) / grow / reset sidebar"],
  [".", "jump to the most recently changed file"],
  ["n", "jump to the next file with findings"],
  ["y", "copy path:line + snippet at the cursor"],
  ["f", "load full content when truncated"],
  ["r", "re-run checks"],
  ["ctrl-d/u", "half-page cursor movement in the viewer"],
  ["g / G", "jump to first / last line"],
  ["?", "show all keybindings"],
  ["q / esc", "quit (esc closes panels first)"],
];

export function HelpOverlay() {
  const theme = useTheme();
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
        <text fg={theme.colors.accent.primary}>keys</text>
      </box>
      <scrollbox
        width="100%"
        height={Math.min(KEY_HELP.length, Math.max(1, state.terminalHeight() - 6))}
        scrollY
        viewportCulling
        scrollbarOptions={{
          trackOptions: {
            backgroundColor: theme.colors.scrollbar.track,
            foregroundColor: theme.colors.scrollbar.thumb,
          },
        }}
      >
        <For each={KEY_HELP}>
          {([combo, action]) => (
            <box
              id={`help-${combo}`}
              width="100%"
              flexDirection="row"
              paddingLeft={1}
              paddingRight={1}
              backgroundColor={theme.colors.surface.panel}
            >
              <text fg={theme.colors.accent.primary}>{combo.padEnd(11)}</text>
              <text fg={theme.colors.text.secondary}>{action}</text>
            </box>
          )}
        </For>
      </scrollbox>
    </box>
  );
}

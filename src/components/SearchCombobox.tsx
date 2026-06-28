import type { ScrollBoxRenderable } from "@opentui/core";
import { batch, createEffect, createMemo, For, Show } from "solid-js";

import { state } from "../state";
import { useTheme } from "../theme/context";
import { truncate } from "../utils/text";

export function SearchCombobox() {
  const theme = useTheme();
  let searchComboboxRef: ScrollBoxRenderable | undefined;

  createEffect(() => {
    searchComboboxRef?.scrollChildIntoView(`search-combobox-${state.searchComboboxIndex()}`);
  });

  // Jumping to a match is the same whether it comes from the input's submit (the
  // Highlighted row) or a click on a specific row.
  function openMatch(match: { path: string; line: number }) {
    batch(() => {
      state.selectFile(match.path);
      state.setFocusedPane("diff");
      state.setJumpTarget({ escalate: true, line: match.line, path: match.path });
      state.setSearchComboboxOpen(false);
    });
  }

  function onSubmit() {
    const match = state.searchComboboxResults()[state.searchComboboxIndex()];
    if (match !== undefined) {
      openMatch(match);
    } else {
      state.setSearchComboboxOpen(false);
    }
  }

  function onInput(value: string) {
    state.setSearchComboboxQuery(value);
    state.setSearchComboboxIndex(0);
  }

  const results = () => state.searchComboboxResults();
  const fileCount = createMemo(() => new Set(results().map((match) => match.path)).size);
  const scopeLabel = () => (state.searchComboboxScope() === "changed" ? "changes" : "repo");
  // A "+" marks a result set clamped by the result cap, so the limit isn't silent.
  const summary = () => {
    const more = state.searchComboboxTruncated() ? "+" : "";
    return `${results().length}${more} match${results().length === 1 ? "" : "es"} in ${fileCount()} file${fileCount() === 1 ? "" : "s"}`;
  };
  const statusLabel = () => {
    if (results().length > 0) {
      return summary();
    }
    return state.searchComboboxQuery() === "" ? "type to search…" : "no matches";
  };

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
        placeholder={`search in ${scopeLabel()}…`}
        backgroundColor={theme.colors.surface.panel}
        focusedBackgroundColor={theme.colors.surface.panel}
        textColor={theme.colors.text.primary}
        focusedTextColor={theme.colors.text.primary}
        cursorColor={theme.colors.accent.primary}
        onInput={onInput}
        onSubmit={onSubmit}
      />
      <Show when={results().length > 0}>
        <scrollbox
          ref={(el) => (searchComboboxRef = el)}
          width="100%"
          height={Math.min(14, Math.max(1, results().length + fileCount()))}
          scrollY
          viewportCulling
          scrollbarOptions={{
            trackOptions: {
              backgroundColor: theme.rgba.transparent,
              foregroundColor: theme.colors.scrollbar.thumb,
            },
          }}
        >
          {/* Match index is the cursor space; a file header renders above the first
              match of each file. Ids by index so reordering never moves a live id. */}
          <For each={results()}>
            {(match, index) => (
              <box width="100%" flexDirection="column">
                <Show when={index() === 0 || results()[index() - 1]?.path !== match.path}>
                  <box paddingLeft={1} paddingRight={1}>
                    <text fg={theme.colors.text.strong}>{match.path}</text>
                  </box>
                </Show>
                <box
                  id={`search-combobox-${index()}`}
                  width="100%"
                  flexDirection="row"
                  paddingLeft={1}
                  paddingRight={1}
                  backgroundColor={
                    index() === state.searchComboboxIndex()
                      ? theme.colors.surface.cursor
                      : theme.colors.surface.panel
                  }
                  onMouseDown={() => openMatch(match)}
                >
                  <text fg={theme.colors.text.muted}>{`${match.line}  `}</text>
                  <text
                    fg={
                      index() === state.searchComboboxIndex()
                        ? theme.colors.text.selected
                        : theme.colors.text.secondary
                    }
                  >
                    {truncate(match.text.trimStart(), Math.max(8, state.overlayWidth() - 10))}
                  </text>
                </box>
              </box>
            )}
          </For>
        </scrollbox>
      </Show>
      <box
        height={1}
        flexDirection="row"
        justifyContent="space-between"
        paddingLeft={1}
        paddingRight={1}
      >
        <text fg={theme.colors.text.muted}>{statusLabel()}</text>
        <text fg={theme.colors.text.faint}>{scopeLabel()}</text>
      </box>
      <box height={1} paddingLeft={1} backgroundColor={theme.colors.surface.panel}>
        <text fg={theme.colors.text.muted}>↑↓ navigate · ⏎ open · ctrl-a scope · esc close</text>
      </box>
    </box>
  );
}

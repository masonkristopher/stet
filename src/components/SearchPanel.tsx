import type { ScrollBoxRenderable } from "@opentui/core";
import { batch, createEffect, createMemo, For, Show } from "solid-js";

import { state } from "../state";
import { useTheme } from "../theme/context";
import { truncate } from "../utils/text";

export function SearchPanel() {
  const theme = useTheme();
  let searchRef: ScrollBoxRenderable | undefined;

  createEffect(() => {
    searchRef?.scrollChildIntoView(`search-${state.searchIndex()}`);
  });

  function onSubmit() {
    const match = state.searchResults()[state.searchIndex()];
    batch(() => {
      if (match !== undefined) {
        state.selectFile(match.path);
        state.setFocusedPane("diff");
        state.setJumpTarget({ escalate: true, line: match.line, path: match.path });
      }
      state.setSearchOpen(false);
    });
  }

  function onInput(value: string) {
    state.setSearchQuery(value);
    state.setSearchIndex(0);
  }

  const results = () => state.searchResults();
  const fileCount = createMemo(() => new Set(results().map((match) => match.path)).size);
  const scopeLabel = () => (state.searchScope() === "changed" ? "changes" : "repo");
  // A "+" marks a result set clamped by the result cap, so the limit isn't silent.
  const summary = () => {
    const more = state.searchTruncated() ? "+" : "";
    return `${results().length}${more} match${results().length === 1 ? "" : "es"} in ${fileCount()} file${fileCount() === 1 ? "" : "s"}`;
  };

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
      <input
        focused
        width="100%"
        placeholder={`search in ${scopeLabel()}…`}
        backgroundColor={theme.colors.surface.panel}
        focusedBackgroundColor={theme.colors.surface.panel}
        textColor={theme.colors.text.primary}
        cursorColor={theme.colors.accent.primary}
        onInput={onInput}
        onSubmit={onSubmit}
      />
      <scrollbox
        ref={(el) => (searchRef = el)}
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
        <Show
          when={results().length > 0}
          fallback={
            <box id="search-empty" paddingLeft={1}>
              <text fg={theme.colors.text.muted}>
                {state.searchQuery() === "" ? "type to search…" : "no matches"}
              </text>
            </box>
          }
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
                  id={`search-${index()}`}
                  width="100%"
                  flexDirection="row"
                  paddingLeft={1}
                  paddingRight={1}
                  backgroundColor={
                    index() === state.searchIndex()
                      ? theme.colors.surface.cursor
                      : theme.colors.surface.panel
                  }
                >
                  <text fg={theme.colors.text.muted}>{`${match.line}  `}</text>
                  <text
                    fg={
                      index() === state.searchIndex()
                        ? theme.colors.text.selected
                        : theme.colors.text.secondary
                    }
                  >
                    {truncate(match.text.trimStart(), Math.max(8, state.paletteWidth() - 10))}
                  </text>
                </box>
              </box>
            )}
          </For>
        </Show>
      </scrollbox>
      <box
        height={1}
        flexDirection="row"
        justifyContent="space-between"
        paddingLeft={1}
        paddingRight={1}
      >
        <text fg={theme.colors.text.muted}>{results().length === 0 ? "" : summary()}</text>
        <text fg={theme.colors.text.faint}>{`${scopeLabel()} · ctrl-a scope`}</text>
      </box>
    </box>
  );
}

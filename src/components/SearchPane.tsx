import { fg, StyledText } from "@opentui/core";
import type { InputRenderable, TextRenderable } from "@opentui/core";
import { batch, createEffect, createMemo, createSignal, Index, onCleanup, Show } from "solid-js";

import { highlightSnippet, languageForPath } from "@/diff/engine";
import type { RenderSpan } from "@/diff/hast";
import { sliceSpansWindow } from "@/diff/spans";
import { levelColor, levelGlyph } from "@/log/levels";
import { state } from "@/state";
import { activeThemeName } from "@/theme/active";
import { useTheme } from "@/theme/context";
import { createDoubleClickGuard } from "@/utils/double-click";
import { fileIcon } from "@/utils/file-icon";
import { truncate } from "@/utils/text";
import { isNavigableSearchItem } from "@/viewer/search-items";
import type { SearchItem } from "@/viewer/search-items";

import { windowWheelHandler } from "./wheel";

// A contiguous run of line rows (one excerpt): highlighted as a block so Shiki
// Tokenizes with real surrounding context, then mapped back to rows by offset.
interface Excerpt {
  key: string;
  path: string;
  texts: string[];
  itemStart: number;
}

const asHeader = (item: SearchItem) => (item.kind === "header" ? item : undefined);
const asLine = (item: SearchItem) => (item.kind === "line" ? item : undefined);

// One result code line as a single StyledText buffer (the diff's StyledLine
// Pattern): per-token colors without one <text> per token, set imperatively
// Because StyledText is not a typed JSX child.
function CodeText(props: { spans: () => RenderSpan[]; width: () => number }) {
  const theme = useTheme();
  let ref: TextRenderable | undefined;
  createEffect(() => {
    if (ref === undefined) {
      return;
    }
    const windowed = sliceSpansWindow(props.spans(), 0, props.width());
    ref.content = new StyledText(
      (windowed.length === 0 ? [{ text: "" }] : windowed).map((span) =>
        fg(span.fg ?? theme.colors.text.primary)(span.text),
      ),
    );
  });
  return <text ref={(el) => (ref = el)} wrapMode="none" height={1} />;
}

/**
 * The full-view project search pane: it swaps in for the file view inside the Viewer's border
 * (`mainView === "search"`). Chrome rows (query, filter, summary, footer) are fixed-height in every
 * state, so idle/searching/ready/ error swaps never shift layout; the results band windows over the
 * flat `searchItems` list, one terminal row per item.
 */
export function SearchPane() {
  const theme = useTheme();

  const innerWidth = () => Math.max(1, state.terminalWidth() - state.sidebarWidth() - 2);
  // The cell names the *effective* universe: widened -> repo; otherwise the
  // Active diff scope, so a staged/session lens is never misread as all changes.
  const scopeLabel = () => {
    if (state.searchScope() === "repo") {
      return "repo";
    }
    const kind = state.scope().kind;
    return kind === "all" ? "changes" : kind === "last-commit" ? "last commit" : kind;
  };
  const focusIn = (target: "query" | "glob") =>
    state.focusedPane() === "search" && state.searchFocus() === target;

  const fileCount = createMemo(() => new Set(state.searchResults().map((m) => m.path)).size);
  const summary = () => {
    const count = state.searchResults().length;
    const more = state.searchTruncated() ? "+" : "";
    return `${count}${more} match${count === 1 ? "" : "es"} in ${fileCount()} file${fileCount() === 1 ? "" : "s"}`;
  };
  const statusText = () => {
    switch (state.searchStatus()) {
      case "idle": {
        return "type to search";
      }
      case "searching": {
        return state.searchResults().length === 0 ? "searching…" : `${summary()} · searching…`;
      }
      case "error": {
        return `${levelGlyph("error")} search failed · check the pattern`;
      }
      default: {
        return state.searchResults().length === 0 ? "no matches" : summary();
      }
    }
  };
  const statusColor = () =>
    state.searchStatus() === "error" ? levelColor(theme.colors, "error") : theme.colors.text.muted;

  // Group the visible flat items back into excerpts for highlighting, and map
  // Each line item to its excerpt + offset so a row can find its spans.
  const excerptData = createMemo(() => {
    const excerpts: Excerpt[] = [];
    const byItem = new Map<number, { key: string; offset: number }>();
    let current: Excerpt | undefined;
    let currentLine = 0;
    state.searchItems().forEach((item, index) => {
      if (item.kind !== "line") {
        current = undefined;
        return;
      }
      if (current !== undefined && item.path === current.path && item.line === currentLine + 1) {
        current.texts.push(item.text);
      } else {
        current = {
          itemStart: index,
          key: `${item.path}:${item.line}`,
          path: item.path,
          texts: [item.text],
        };
        excerpts.push(current);
      }
      currentLine = item.line;
      byItem.set(index, { key: current.key, offset: current.texts.length - 1 });
    });
    return { byItem, excerpts };
  });

  // Highlighted spans per excerpt, keyed path:startLine. A new snapshot or a
  // Theme flip invalidates everything; rows render plain and upgrade in place
  // (identical text, so the swap never shifts layout).
  const [spanCache, setSpanCache] = createSignal(new Map<string, RenderSpan[][]>());
  createEffect(() => {
    state.searchResults();
    activeThemeName();
    setSpanCache(new Map());
  });

  // Highlight only the excerpts intersecting the viewport, on demand, through
  // The diff's shared highlighter (never rejects; falls back to plain spans).
  createEffect(() => {
    const from = state.searchScrollTop();
    const to = from + state.searchListHeight();
    const cache = spanCache();
    const pending = excerptData().excerpts.filter(
      (excerpt) =>
        excerpt.itemStart < to &&
        excerpt.itemStart + excerpt.texts.length > from &&
        !cache.has(excerpt.key),
    );
    if (pending.length === 0) {
      return;
    }
    const cancelled = { current: false };
    onCleanup(() => {
      cancelled.current = true;
    });
    pending.forEach((excerpt) => {
      void highlightSnippet(excerpt.texts.join("\n"), languageForPath(excerpt.path)).then(
        (lines) => {
          if (!cancelled.current) {
            setSpanCache((previous) => new Map(previous).set(excerpt.key, lines));
          }
        },
      );
    });
  });

  const rowSpans = (item: { text: string }, index: number): RenderSpan[] => {
    const ref = excerptData().byItem.get(index);
    const lines = ref === undefined ? undefined : spanCache().get(ref.key);
    return lines?.[ref?.offset ?? 0] ?? [{ text: item.text }];
  };

  const visibleItems = createMemo(() => {
    const start = state.searchScrollTop();
    return state
      .searchItems()
      .slice(start, start + state.searchListHeight())
      .map((item, offset) => ({ index: start + offset, item }));
  });

  const rowBackground = (item: SearchItem, index: number) => {
    const selected = index === state.searchIndex();
    if (item.kind === "line" && item.match !== undefined) {
      return selected ? theme.rgba.findMatchBgActive : theme.colors.find.matchBg;
    }
    return selected ? theme.colors.surface.cursor : undefined;
  };

  const submit = () => {
    const items = state.searchItems();
    const selected = items[state.searchIndex()];
    const target =
      selected?.kind === "line" && selected.match !== undefined
        ? state.searchIndex()
        : items.findIndex((item) => item.kind === "line" && item.match !== undefined);
    if (target !== -1) {
      state.jumpToSearchItem(target);
    }
  };

  const onQueryInput = (value: string) => {
    batch(() => {
      state.setSearchQuery(value);
      state.setSearchIndex(0);
      state.setSearchScrollTop(0);
    });
  };

  const onGlobInput = (value: string) => {
    batch(() => {
      state.setSearchGlob(value);
      state.setSearchIndex(0);
      state.setSearchScrollTop(0);
    });
  };

  const onWheel = windowWheelHandler({
    rowCount: () => state.searchItems().length,
    scrollTop: state.searchScrollTop,
    setScrollTop: state.setSearchScrollTop,
    viewport: state.searchListHeight,
  });

  // A single click selects (a focus-intent click must never navigate the whole
  // View away, mirroring the diff where a click only moves the cursor); a
  // Double click opens. Headers keep single-click collapse (non-destructive).
  const isDoubleClick = createDoubleClickGuard();
  const clickRow = (item: SearchItem, index: number) => {
    batch(() => {
      state.setFocusedPane("search");
      state.setSearchFocus("results");
      if (item.kind === "header") {
        state.toggleSearchGroup(item.path);
        return;
      }
      if (item.kind !== "line") {
        return;
      }
      if (isDoubleClick(item.id)) {
        state.jumpToSearchItem(index);
        return;
      }
      // Select the clicked row, or the nearest navigable one above a context row.
      const items = state.searchItems();
      const selected = items.findLastIndex(
        (candidate, candidateIndex) => candidateIndex <= index && isNavigableSearchItem(candidate),
      );
      if (selected !== -1) {
        state.setSearchSelection(selected);
      }
    });
  };

  // Toggle cells signal state by shape (brackets) as well as color, so on/off
  // Reads under NO_COLOR; the whole cell is the click target.
  const toggleCell = (on: boolean, glyph: string) => (on ? `[${glyph}]` : ` ${glyph} `);
  const toggleColor = (on: boolean) => (on ? theme.colors.accent.primary : theme.colors.text.muted);

  const inputColors = {
    backgroundColor: theme.colors.surface.panel,
    cursorColor: theme.colors.accent.primary,
    focusedBackgroundColor: theme.colors.surface.panel,
    focusedTextColor: theme.colors.text.primary,
    textColor: theme.colors.text.primary,
  };

  return (
    <box flexDirection="column" flexGrow={1}>
      <box
        height={1}
        flexDirection="row"
        paddingLeft={1}
        paddingRight={1}
        backgroundColor={theme.colors.surface.panel}
      >
        <box flexGrow={1}>
          <input
            ref={(el: InputRenderable) => {
              el.value = state.searchQuery();
            }}
            focused={focusIn("query")}
            width="100%"
            placeholder="search…"
            {...inputColors}
            onInput={onQueryInput}
            onSubmit={submit}
          />
        </box>
        <box ref={(el) => (el.selectable = false)} onMouseDown={() => state.toggleSearchRegex()}>
          <text fg={toggleColor(state.searchRegex())}>{toggleCell(state.searchRegex(), ".*")}</text>
        </box>
        <text> </text>
        <box ref={(el) => (el.selectable = false)} onMouseDown={() => state.toggleSearchCase()}>
          <text fg={toggleColor(state.searchCaseSensitive())}>
            {toggleCell(state.searchCaseSensitive(), "Aa")}
          </text>
        </box>
      </box>
      <box
        height={1}
        flexDirection="row"
        paddingLeft={1}
        paddingRight={1}
        backgroundColor={theme.colors.surface.panel}
      >
        <text fg={theme.colors.text.muted}>{"in "}</text>
        <box flexGrow={1}>
          <input
            ref={(el: InputRenderable) => {
              el.value = state.searchGlob();
            }}
            focused={focusIn("glob")}
            width="100%"
            placeholder="src/ *.ts !*.test.ts"
            {...inputColors}
            onInput={onGlobInput}
            onSubmit={submit}
          />
        </box>
        <box ref={(el) => (el.selectable = false)} onMouseDown={() => state.toggleSearchScope()}>
          <text fg={theme.colors.text.muted}>{`[${scopeLabel()}]`}</text>
        </box>
      </box>
      <box height={1} paddingLeft={1} paddingRight={1}>
        <text fg={statusColor()}>{truncate(statusText(), Math.max(8, innerWidth() - 2))}</text>
      </box>
      <box
        ref={(el) => (el.selectable = false)}
        flexGrow={1}
        flexDirection="column"
        onMouseScroll={onWheel}
      >
        <Show
          when={state.searchItems().length > 0}
          fallback={
            <box
              height={state.searchListHeight()}
              flexDirection="column"
              justifyContent="center"
              alignItems="center"
            >
              <Show
                when={state.searchStatus() === "error"}
                fallback={
                  <>
                    <text fg={theme.colors.text.muted}>
                      {state.searchStatus() === "searching"
                        ? "searching…"
                        : state.searchStatus() === "ready"
                          ? "no matches"
                          : "type to search"}
                    </text>
                    <text fg={theme.colors.text.faint}>
                      {state.searchScope() === "changed"
                        ? `in ${scopeLabel()} · ctrl-g for the whole repo`
                        : "across the whole repo"}
                    </text>
                  </>
                }
              >
                <text fg={levelColor(theme.colors, "error")}>
                  {`${levelGlyph("error")} search failed`}
                </text>
                <text fg={theme.colors.text.faint}>
                  {state.searchRegex() ? "check the pattern · ctrl-r for literal" : "try again"}
                </text>
              </Show>
            </box>
          }
        >
          <Index each={visibleItems()}>
            {(row) => (
              <box
                ref={(el) => (el.selectable = false)}
                height={1}
                width="100%"
                flexDirection="row"
                backgroundColor={rowBackground(row().item, row().index)}
                onMouseDown={() => clickRow(row().item, row().index)}
              >
                <Show when={asHeader(row().item)}>
                  {(header) => (
                    <box
                      height={1}
                      flexGrow={1}
                      flexDirection="row"
                      justifyContent="space-between"
                      paddingLeft={1}
                      paddingRight={1}
                    >
                      <box flexDirection="row">
                        <text
                          fg={
                            row().index === state.searchIndex()
                              ? theme.colors.text.selected
                              : theme.colors.text.strong
                          }
                        >
                          {`${header().collapsed ? "▸" : "▾"} `}
                        </text>
                        {/* Fixed 2-cell icon box, the tree-row pattern: Nerd Font
                            glyphs can be double-width, so the box keeps the path
                            column steady across file types. */}
                        <Show when={state.iconsEnabled()}>
                          <box width={2} overflow="hidden">
                            <text fg={theme.colors.text.muted}>
                              {fileIcon(header().path.split("/").at(-1) ?? header().path)}
                            </text>
                          </box>
                        </Show>
                        <text
                          fg={
                            row().index === state.searchIndex()
                              ? theme.colors.text.selected
                              : theme.colors.text.strong
                          }
                        >
                          {truncate(
                            header().path,
                            Math.max(8, innerWidth() - (state.iconsEnabled() ? 10 : 8)),
                          )}
                        </text>
                      </box>
                      <text fg={theme.colors.text.muted}>{String(header().count)}</text>
                    </box>
                  )}
                </Show>
                <Show when={asLine(row().item)}>
                  {(line) => (
                    <>
                      <text
                        fg={
                          line().match === undefined
                            ? theme.colors.text.faint
                            : theme.colors.text.muted
                        }
                      >
                        {` ${String(line().line).padStart(line().lineWidth)} `}
                      </text>
                      <CodeText
                        spans={() => rowSpans(line(), row().index)}
                        width={() => Math.max(1, innerWidth() - line().lineWidth - 2)}
                      />
                    </>
                  )}
                </Show>
                <Show when={row().item.kind === "gap"}>
                  <text fg={theme.colors.text.faint}>{" ⋯"}</text>
                </Show>
              </box>
            )}
          </Index>
        </Show>
      </box>
      {/* Contextual per sub-focus, naming only the keys that focus honors: the
          inputs surface the query toggles, the results surface the result
          actions. Both fit narrower panes than one exhaustive line would. */}
      <box height={1} paddingLeft={1} backgroundColor={theme.colors.surface.panel}>
        <text fg={theme.colors.text.muted}>
          {truncate(
            state.searchFocus() === "results"
              ? "⏎ open · e editor · y copy · h/l fold · g/G ends · esc"
              : "⏎ open · ↓ results · ctrl-r regex · ctrl-x case · ctrl-g repo · ctrl-s scope · esc",
            Math.max(8, innerWidth() - 2),
          )}
        </text>
      </box>
    </box>
  );
}

import { createEffect, createMemo, createSignal, Index, onCleanup, Show } from "solid-js";

import { highlightSnippet, languageForPath } from "@/diff/engine";
import type { RenderSpan } from "@/diff/hast";
import type { ReferenceRow } from "@/intel/references";
import { levelColor, levelGlyph } from "@/log/levels";
import { state } from "@/state";
import { activeThemeName } from "@/theme/active";
import { useTheme } from "@/theme/context";

import { CodeLine } from "./CodeLine";
import { FileIcon } from "./FileIcon";
import { ListScrollbar } from "./ListScrollbar";
import { windowWheelHandler } from "./wheel";

const asHeader = (row: ReferenceRow) => (row.kind === "header" ? row : undefined);
const asMatch = (row: ReferenceRow) => (row.kind === "match" ? row : undefined);

// A query-less palette-family overlay: the results list for `textDocument/references`
// (and go-to-definition's multi-result case). Mirrors the FileCombobox's chrome minus
// The input; every status (loading/empty/error/ready) is a designed screen so it never
// Shows a blank pane, and the box grows in place rather than reflowing the diff beneath it.
//
// The list windows like the problems panel (an explicit `referencesScrollTop` followed off
// The cursor), not a native scrollbox: `scrollChildIntoView` scroll-follow was unreliable in
// The full app (its delta depends on render/layout timing under `viewportCulling`), while the
// Windowed pattern derives the visible slice declaratively and is the one the panes ship.
export function ReferencesOverlay() {
  const theme = useTheme();

  const results = () => state.referencesResults();
  const fileCount = createMemo(() => new Set(results().map((match) => match.path)).size);
  // Pad `line:col` to the widest in the set so the previews start at the same cell; a
  // Monospace column is free, so the list reads as a table rather than a ragged edge.
  const locWidth = createMemo(() =>
    results().reduce((max, match) => Math.max(max, `${match.line}:${match.column}`.length), 0),
  );
  const summary = () => {
    const count = results().length;
    // Every label is a plural noun ("references", "incoming calls", …); drop the trailing "s" for a
    // Single result so the count reads grammatically ("1 incoming call in 1 file").
    const label = state.referencesLabel();
    const noun = count === 1 ? label.replace(/s$/, "") : label;
    return `${count} ${noun} in ${fileCount()} file${fileCount() === 1 ? "" : "s"}`;
  };
  // A call hierarchy carries a direction Tab flips; references/definitions don't, so the hint only
  // Advertises the toggle where it does something.
  const isHierarchy = () =>
    state.referencesLabel() !== "references" && state.referencesLabel() !== "definitions";

  const viewport = () => state.referencesViewport();
  const visibleRows = createMemo(() => {
    const start = state.referencesScrollTop();
    return state.referencesRows().slice(start, start + viewport());
  });
  const onWheel = windowWheelHandler({
    rowCount: () => state.referencesRows().length,
    scrollTop: state.referencesScrollTop,
    setScrollTop: state.setReferencesScrollTop,
    viewport,
  });
  const rowBg = (row: ReferenceRow) =>
    row.kind === "match" && row.index === state.referencesIndex()
      ? theme.colors.surface.cursor
      : theme.colors.surface.panel;

  // Each preview is one scattered source line, so it highlights as a standalone
  // Snippet keyed by result index; a new result set or a theme flip clears the
  // Cache, and rows upgrade plain -> highlighted in place (identical text, so the
  // Swap never shifts layout), the same contract the search pane uses.
  const [spanCache, setSpanCache] = createSignal(new Map<number, RenderSpan[]>());
  createEffect(() => {
    results();
    activeThemeName();
    setSpanCache(new Map());
  });
  createEffect(() => {
    // Re-highlight on a theme flip too: the clear effect above empties the cache
    // On `activeThemeName()`, and this effect must re-run to refill it (it reads no
    // Cache signal that would otherwise retrigger it), or previews strand on plain.
    activeThemeName();
    if (state.referencesStatus() !== "ready") {
      return;
    }
    const cancelled = { current: false };
    onCleanup(() => {
      cancelled.current = true;
    });
    results().forEach((match, index) => {
      void highlightSnippet(match.text, languageForPath(match.path)).then((lines) => {
        if (!cancelled.current) {
          setSpanCache((previous) =>
            new Map(previous).set(index, lines[0] ?? [{ text: match.text }]),
          );
        }
      });
    });
  });
  const rowSpans = (index: number, text: string): RenderSpan[] =>
    spanCache().get(index) ?? [{ text }];

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
      <box height={1} paddingLeft={1} paddingRight={1}>
        <text fg={theme.colors.text.strong}>{state.referencesLabel()}</text>
      </box>
      <Show when={state.referencesStatus() === "loading"}>
        <box height={1} paddingLeft={1} paddingRight={1}>
          <text fg={theme.colors.text.muted}>{`finding ${state.referencesLabel()}…`}</text>
        </box>
      </Show>
      <Show when={state.referencesStatus() === "empty"}>
        <box height={1} paddingLeft={1} paddingRight={1}>
          <text fg={theme.colors.text.muted}>{`no ${state.referencesLabel()}`}</text>
        </box>
      </Show>
      <Show when={state.referencesStatus() === "error"}>
        <box height={1} paddingLeft={1} paddingRight={1}>
          <text
            fg={levelColor(theme.colors, "error")}
          >{`${levelGlyph("error")} language server unreachable`}</text>
        </box>
      </Show>
      <Show when={state.referencesStatus() === "ready"}>
        <box width="100%" height={viewport()} flexDirection="row" onMouseScroll={onWheel}>
          <box ref={(el) => (el.selectable = false)} flexGrow={1} flexDirection="column">
            {/* Windowed slice: only the visible rows mount, so a large result set never
                stalls the renderer. A slot swaps kind in place as the window scrolls. */}
            <Index each={visibleRows()}>
              {(row) => (
                <box
                  ref={(el) => (el.selectable = false)}
                  width="100%"
                  height={1}
                  backgroundColor={rowBg(row())}
                  onMouseDown={() => {
                    const match = asMatch(row());
                    if (match !== undefined) {
                      state.jumpToReference(match.index);
                    }
                  }}
                >
                  <Show when={asHeader(row())}>
                    {(header) => (
                      <box flexDirection="row" paddingLeft={1} paddingRight={1}>
                        <FileIcon name={header().path.split("/").at(-1) ?? header().path} />
                        <text fg={theme.colors.text.strong}>{header().path}</text>
                      </box>
                    )}
                  </Show>
                  <Show when={asMatch(row())}>
                    {(match) => (
                      <box width="100%" flexDirection="row" paddingLeft={1} paddingRight={1}>
                        <text fg={theme.colors.text.muted}>
                          {`${`${match().match.line}:${match().match.column}`.padEnd(locWidth())}  `}
                        </text>
                        <CodeLine
                          spans={() => rowSpans(match().index, match().match.text)}
                          width={() => Math.max(8, state.overlayWidth() - locWidth() - 7)}
                        />
                      </box>
                    )}
                  </Show>
                </box>
              )}
            </Index>
          </box>
          <ListScrollbar
            rowCount={() => state.referencesRows().length}
            viewport={viewport}
            scrollTop={state.referencesScrollTop}
          />
        </box>
      </Show>
      <box height={1} paddingLeft={1} paddingRight={1}>
        <text fg={theme.colors.text.muted}>
          {state.referencesStatus() === "ready" ? summary() : ""}
        </text>
      </box>
      <box height={1} paddingLeft={1} backgroundColor={theme.colors.surface.panel}>
        <text fg={theme.colors.text.muted}>
          ↑↓ navigate · ⏎ open{isHierarchy() ? " · ⇥ direction" : ""} · esc close
        </text>
      </box>
    </box>
  );
}

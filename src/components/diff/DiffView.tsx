import {
  fg,
  StyledText,
  type MouseEvent,
  type ScrollBoxRenderable,
  type TextRenderable,
} from "@opentui/core";
import { useRenderer } from "@opentui/solid";
import {
  createEffect,
  createMemo,
  createSignal,
  Index,
  on,
  onCleanup,
  Show,
  untrack,
} from "solid-js";

import { isLineRow, type DiffLineRow, type DiffRow } from "../../diff/rows";
import { sliceSpansWindow } from "../../diff/spans";
import { visibleWindow, visibleWindowVariable } from "../../diff/windowing";
import { state } from "../../state";
import { useTheme } from "../../theme/context";
import { createLineMeasurer } from "./line-measure";

// One renderable per line: the per-token colors live inside a single StyledText
// Buffer instead of one <text> per token (a screenful of highlighted code was
// Hundreds of flex nodes). Content is set imperatively because the binding's
// `content` prop stringifies objects and StyledText is not a typed JSX child.
function StyledLine(props: { row: DiffLineRow; wrap: boolean; width: number; scrollX: number }) {
  const theme = useTheme();
  let ref: TextRenderable | undefined;
  createEffect(() => {
    if (ref === undefined) {
      return;
    }
    const { row } = props;
    const sign = row.type === "add" ? "+" : row.type === "remove" ? "-" : " ";
    const signColor =
      row.type === "add"
        ? theme.colors.diff.addedSign
        : row.type === "remove"
          ? theme.colors.diff.removedSign
          : theme.colors.text.faint;
    // Scroll mode: render the horizontal window [scrollX, scrollX+width) so all
    // Lines shift together (the sign stays fixed). Wrap mode keeps full spans.
    const spans = props.wrap
      ? row.spans
      : sliceSpansWindow(row.spans, props.scrollX, props.width - 1);
    ref.content = new StyledText([
      fg(signColor)(sign),
      ...spans.map((part) => fg(part.fg ?? theme.colors.text.primary)(part.text)),
    ]);
  });
  return <text ref={(el) => (ref = el)} wrapMode={props.wrap ? "word" : "none"} />;
}

// Sideye-owned diff renderer: only the visible row slice is mounted (windowed),
// And the line-number gutter is padded to a file-wide fixed width so it never
// Oscillates. That stable width is the property that keeps OpenTUI's layout from
// Thrashing into the scheduler wedge the built-in `<diff>` triggered.
export function DiffView() {
  const theme = useTheme();
  const measurer = createLineMeasurer(useRenderer().widthMethod);
  onCleanup(() => measurer.destroy());
  let scrollRef: ScrollBoxRenderable | undefined;
  const [scrollTop, setScrollTop] = createSignal(0);
  const [scrollX, setScrollX] = createSignal(0);

  const rows = createMemo<DiffRow[]>(() => state.diffView()?.render.rows ?? []);
  const wrap = () => state.overflow() === "wrap";
  const findMatchSet = createMemo(() => new Set(state.findMatches()));

  // Row indices of the navigable (line) rows, so a cursor navIndex maps to its
  // Position in the full row stream (which also contains hunk headers).
  const lineRowIndices = createMemo(() => {
    const indices: number[] = [];
    rows().forEach((row, index) => {
      if (row.kind === "line") {
        indices.push(index);
      }
    });
    return indices;
  });

  // File-wide max line-number digit count -> a gutter width that is constant for
  // The whole file, never resized from the visible slice.
  const numberWidth = createMemo(() => {
    let max = 1;
    for (const row of rows()) {
      if (isLineRow(row)) {
        max = Math.max(max, row.newLine ?? 0, row.oldLine ?? 0);
      }
    }
    return String(max).length;
  });
  const gutterWidth = () => numberWidth() + 1;

  const contentWidth = () =>
    Math.max(1, state.terminalWidth() - state.sidebarWidth() - 2 - gutterWidth());

  // Per-row terminal heights for windowing spacers and cursor-follow. In non-wrap
  // Mode every row is exactly one terminal row (`wrapMode="none"`), so heights are
  // Uniform; in wrap mode each line row is measured exactly against OpenTUI's own
  // Word-wrap engine so the cumulative offsets match the rendered layout.
  const heights = createMemo(() => {
    if (!wrap()) {
      return rows().map(() => 1);
    }
    const width = contentWidth();
    return rows().map((row) => {
      if (row.kind !== "line") {
        return 1;
      }
      // Include the +/-/space sign StyledLine prepends, so the measured wrap
      // Width matches what actually renders (the sign only shifts the first row).
      const sign = row.type === "add" ? "+" : row.type === "remove" ? "-" : " ";
      return measurer.measure(sign + row.spans.map((span) => span.text).join(""), width);
    });
  });

  // Widest line in the file (display columns), so horizontal scroll has a stable
  // Range that doesn't shift as you scroll vertically.
  const longestLine = createMemo(() => {
    let max = 0;
    for (const row of rows()) {
      if (isLineRow(row)) {
        max = Math.max(max, Bun.stringWidth(row.spans.map((span) => span.text).join("")));
      }
    }
    return max;
  });
  const maxScrollX = () => Math.max(0, longestLine() - (contentWidth() - 1));

  // The deepest the viewport can scroll: total content height (sum of per-row
  // Heights — `rows().length` in non-wrap, the wrapped total otherwise) minus the
  // Viewport. Bounds the wheel-driven scrollTop so it never runs past the content.
  const maxScrollY = () =>
    Math.max(0, heights().reduce((sum, height) => sum + height, 0) - state.viewerHeight());

  // Mount a few rows beyond the viewport as a buffer so a fast scroll tick never
  // Flashes an unmounted row at the viewport edge.
  const OVERSCAN = 8;
  const window = createMemo(() =>
    wrap()
      ? visibleWindowVariable(heights(), scrollTop(), state.viewerHeight(), OVERSCAN)
      : visibleWindow(rows().length, scrollTop(), state.viewerHeight(), OVERSCAN),
  );
  const visibleRows = createMemo(() => rows().slice(window().start, window().end));

  // Reset horizontal scroll when the file changes; clamp it when the range shrinks
  // (terminal resize / shorter file).
  createEffect(
    on(
      () => state.diffView()?.path,
      () => setScrollX(0),
    ),
  );
  createEffect(() => {
    const max = maxScrollX();
    if (scrollX() > max) {
      setScrollX(max);
    }
  });

  // Wheel: left/right scroll long lines horizontally (shared across all lines —
  // The whole view shifts); up/down drive scrollTop directly and move the
  // Scrollbox to match. Both axes own the scroll and zero the native delta so the
  // Scrollbox never also acts on it: scrollTop must stay the single source of
  // Truth for the window, or a native read-back races the uncommitted scroll and
  // The slice trails the visible content, blanking the lower viewport.
  const HORIZONTAL_STEP = 4;
  const VERTICAL_STEP = 3;
  const onWheel = (event: MouseEvent) => {
    const direction = event.scroll?.direction;
    const delta = event.scroll?.delta ?? 1;
    if (direction === "left" || direction === "right") {
      if (!wrap()) {
        const sign = direction === "right" ? 1 : -1;
        setScrollX((previous) =>
          Math.max(0, Math.min(previous + sign * delta * HORIZONTAL_STEP, maxScrollX())),
        );
      }
      if (event.scroll !== undefined) {
        event.scroll.delta = 0;
      }
      return;
    }
    const sign = direction === "down" ? 1 : -1;
    setScrollTop((previous) => {
      const next = Math.max(0, Math.min(previous + sign * delta * VERTICAL_STEP, maxScrollY()));
      scrollRef?.scrollTo(next);
      return next;
    });
    if (event.scroll !== undefined) {
      event.scroll.delta = 0;
    }
  };

  // Keep the cursor's row inside the viewport by scrolling the box to it. Reads
  // The current scroll offset untracked: this effect must fire only when the
  // Cursor or layout moves, never when scrollTop itself changes. Tracking scrollTop
  // Would make it re-run on every wheel tick and snap the off-screen cursor back
  // Into view, so free wheel scrolling could never leave the cursor's screen.
  createEffect(() => {
    const cursorRow = lineRowIndices()[state.cursorIndex()];
    if (cursorRow === undefined || scrollRef === undefined) {
      return;
    }
    const rowHeights = heights();
    const top = rowHeights.slice(0, cursorRow).reduce((sum, height) => sum + height, 0);
    const height = rowHeights[cursorRow] ?? 1;
    const viewport = state.viewerHeight();
    const current = untrack(scrollTop);
    const next =
      top < current ? top : top + height > current + viewport ? top + height - viewport : current;
    if (next !== current) {
      scrollRef.scrollTo(next);
      setScrollTop(next);
    }
  });

  const isCursor = (row: DiffLineRow) => row.navIndex === state.cursorIndex();

  const gutterBackground = (row: DiffLineRow) => {
    if (isCursor(row)) {
      return theme.colors.surface.cursor;
    }
    const findings = row.newLine === undefined ? undefined : state.lineMap().get(row.newLine);
    if (findings !== undefined) {
      return findings.some((finding) => finding.severity === "error")
        ? theme.colors.severity.errorGutterBg
        : findings.some((finding) => finding.severity === "warning")
          ? theme.colors.severity.warningGutterBg
          : theme.colors.severity.infoGutterBg;
    }
    return row.type === "add"
      ? theme.colors.diff.addedLineNumberBg
      : row.type === "remove"
        ? theme.colors.diff.removedLineNumberBg
        : undefined;
  };

  const contentBackground = (row: DiffLineRow) => {
    if (isCursor(row)) {
      return theme.colors.surface.cursor;
    }
    if (findMatchSet().has(row.navIndex)) {
      return theme.colors.find.matchBg;
    }
    return row.type === "add"
      ? theme.colors.diff.addedBg
      : row.type === "remove"
        ? theme.colors.diff.removedBg
        : undefined;
  };

  const lineLabel = (row: DiffLineRow) =>
    String(row.newLine ?? row.oldLine ?? "").padStart(numberWidth());

  const separatorText = (row: DiffRow) => (row.kind === "separator" ? row.text : "");
  const asLineRow = (row: DiffRow) => (isLineRow(row) ? row : undefined);

  return (
    <scrollbox
      ref={(el) => (scrollRef = el)}
      width="100%"
      height={state.viewerHeight()}
      scrollY
      onMouseScroll={onWheel}
      scrollbarOptions={{
        trackOptions: {
          backgroundColor: theme.rgba.transparent,
          foregroundColor: theme.colors.scrollbar.thumb,
        },
        visible: false,
      }}
    >
      <box width="100%" height={window().topSpacer} />
      <Index each={visibleRows()}>
        {(row) => (
          <Show
            when={asLineRow(row())}
            fallback={
              <box width="100%" backgroundColor={theme.colors.surface.panel}>
                <text fg={theme.colors.text.faint}>
                  {`${"⋯".padStart(numberWidth())} ${separatorText(row())}`}
                </text>
              </box>
            }
          >
            {(line) => (
              <box width="100%" flexDirection="row">
                <text fg={theme.colors.diff.lineNumberFg} bg={gutterBackground(line())}>
                  {`${lineLabel(line())} `}
                </text>
                <box flexGrow={1} backgroundColor={contentBackground(line())}>
                  <StyledLine
                    row={line()}
                    wrap={wrap()}
                    width={contentWidth()}
                    scrollX={scrollX()}
                  />
                </box>
              </box>
            )}
          </Show>
        )}
      </Index>
      <box width="100%" height={window().bottomSpacer} />
    </scrollbox>
  );
}

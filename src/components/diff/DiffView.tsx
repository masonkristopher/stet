import { bg, fg, StyledText } from "@opentui/core";
import type { MouseEvent, RGBA, ScrollBoxRenderable, TextRenderable } from "@opentui/core";
import { useRenderer } from "@opentui/solid";
import { batch, createEffect, createMemo, Index, onCleanup, Show, untrack } from "solid-js";

import { followScrollTop, followScrollX } from "@/diff/follow";
import { isLineRow } from "@/diff/rows";
import type { DiffLineRow, DiffRow } from "@/diff/rows";
import { columnToIndex, markRange, sliceSpansWindow } from "@/diff/spans";
import type { HighlightSpan } from "@/diff/spans";
import { visibleWindow, visibleWindowVariable } from "@/diff/windowing";
import { wordAt } from "@/diff/words";
import { levelGlyph } from "@/log/levels";
import { state } from "@/state";
import { useTheme } from "@/theme/context";
import { caretCell } from "@/viewer/anchor";

import { CommandMenu } from "../CommandMenu";
import { isRightClick } from "../mouse";
import { CaretCard } from "./CaretCard";
import { createLineMeasurer } from "./line-measure";

// The caret word's display-column range on the cursor line, [from, to). Undefined
// On a line with no word under the caret.
interface CaretRange {
  from: number;
  to: number;
}

// One renderable per line: the per-token colors live inside a single StyledText
// Buffer instead of one <text> per token (a screenful of highlighted code was
// Hundreds of flex nodes). Content is set imperatively because the binding's
// `content` prop stringifies objects and StyledText is not a typed JSX child.
function StyledLine(props: {
  row: DiffLineRow;
  wrap: boolean;
  width: number;
  scrollX: number;
  caret: CaretRange | undefined;
}) {
  const theme = useTheme();
  let ref: TextRenderable | undefined;
  createEffect(() => {
    if (ref === undefined) {
      return;
    }
    const { row } = props;
    // The change bar and line metadata live in the fixed gutter (so they stay put while
    // The code scrolls); this buffer renders code only.
    const windowed = props.wrap
      ? row.spans
      : sliceSpansWindow(row.spans, props.scrollX, props.width);
    // The caret word gets a background. Its range is in content display columns;
    // In scroll mode the window starts at scrollX, so shift the range by it. In
    // Wrap mode the column styling follows the word wherever it wraps.
    const offset = props.wrap ? 0 : props.scrollX;
    const spans: HighlightSpan[] =
      props.caret === undefined
        ? windowed
        : markRange(windowed, props.caret.from - offset, props.caret.to - offset);
    ref.content = new StyledText(
      spans.map((part) => {
        const chunk = fg(part.fg ?? theme.colors.text.primary)(part.text);
        return part.highlight === true ? bg(theme.colors.caret.wordBg)(chunk) : chunk;
      }),
    );
  });
  return (
    <text
      ref={(el) => {
        ref = el;
        // Opt this text leaf out of OpenTUI's native text selection (which a drag
        // Would otherwise start on the deepest hit, painting its own colorful
        // Highlight over our band); stet owns the line selection.
        el.selectable = false;
      }}
      wrapMode={props.wrap ? "word" : "none"}
    />
  );
}

// Stet-owned diff renderer: only the visible row slice is mounted (windowed),
// And the line-number gutter is padded to a file-wide fixed width so it never
// Oscillates. That stable width is the property that keeps OpenTUI's layout from
// Thrashing into the scheduler wedge the built-in `<diff>` triggered.
export function DiffView() {
  const theme = useTheme();
  const renderer = useRenderer();
  const measurer = createLineMeasurer(renderer.widthMethod);
  onCleanup(() => measurer.destroy());
  let scrollRef: ScrollBoxRenderable | undefined;
  // Scroll offsets live in `state` (lifted out of this component) so a navigation
  // Can capture and restore them; this view is just their reader/writer.
  const scrollTop = state.viewerScrollTop;
  const setScrollTop = state.setViewerScrollTop;
  const scrollX = state.viewerScrollX;
  const setScrollX = state.setViewerScrollX;

  const rows = createMemo<DiffRow[]>(() => state.viewerRows());
  const wrap = () => state.overflow() === "wrap";

  // Drag-select origin, captured on the press: the row's index into `rows()` and the
  // Press cell's y. On drag we derive the target row from the live `event.y` (OpenTUI
  // Pins drag events to the first-captured row, so its own `line()` can't follow the
  // Pointer), then snap to the nearest line row so folds/gaps between rows are skipped.
  let dragOrigin: { rowIndex: number; y: number } | undefined;
  // Nearest line row's navIndex for every `rows()` index (the line at or before it,
  // Else the first line after), precomputed so a drag tick is an O(1) lookup instead
  // Of re-scanning rows() each time.
  const nearestNavByRow = createMemo(() => {
    const all = rows();
    let last = all.find(isLineRow)?.navIndex;
    return all.map((row) => {
      if (isLineRow(row)) {
        last = row.navIndex;
      }
      return last;
    });
  });
  const navIndexForRow = (rowIndex: number) => nearestNavByRow()[rowIndex];
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
  // The gutter is a change bar, the number, then the glyph: fixed cells left of the code,
  // So a clean line reserves the bar/glyph columns and never shifts (bar + number + space
  // + glyph + space).
  const gutterWidth = () => numberWidth() + 4;

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
      // The gutter (bar/number/glyph) is fixed, so the content that wraps is code only.
      return measurer.measure(row.spans.map((span) => span.text).join(""), width);
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
  const maxScrollX = () => Math.max(0, longestLine() - contentWidth());

  // The deepest the viewport can scroll: total content height (sum of per-row
  // Heights — `rows().length` in non-wrap, the wrapped total otherwise) minus the
  // Viewport. Bounds the wheel-driven scrollTop so it never runs past the content.
  const maxScrollY = () =>
    Math.max(0, heights().reduce((sum, height) => sum + height, 0) - state.viewerHeight());

  // Context rows kept between the cursor and the top/bottom edge as it moves.
  const CURSOR_SCROLL_MARGIN = 3;

  // Mount a few rows beyond the viewport as a buffer so a fast scroll tick never
  // Flashes an unmounted row at the viewport edge.
  const OVERSCAN = 8;
  const window = createMemo(() =>
    wrap()
      ? visibleWindowVariable(heights(), scrollTop(), state.viewerHeight(), OVERSCAN)
      : visibleWindow(rows().length, scrollTop(), state.viewerHeight(), OVERSCAN),
  );
  const visibleRows = createMemo(() => rows().slice(window().start, window().end));

  // Clamp horizontal scroll when the range shrinks (terminal resize / shorter
  // File). The reset-on-file-change is now owned by the viewer's pendingRestore.
  createEffect(() => {
    const max = maxScrollX();
    if (scrollX() > max) {
      setScrollX(max);
    }
  });
  // Clamp scrollTop when the content shrinks under it (toggle to a shorter file,
  // Terminal resize), mirroring the scrollX clamp. Reads scrollTop untracked so it
  // Fires on a height/viewport change, not on every scroll tick, and never feeds
  // Back into the reconciler below.
  createEffect(() => {
    const max = maxScrollY();
    if (untrack(scrollTop) > max) {
      setScrollTop(max);
    }
  });

  // The scrollbox's physical scroll is a pure projection of the scrollTop signal:
  // The windowed slice (driven by scrollTop) and what's painted must never disagree.
  // The scrollbox clamps scrollTo to `scrollSize - viewportSize`, where scrollSize is
  // The content height *as last laid out*. Right after a content swap grows the file,
  // OpenTUI's layout overwrites scrollSize with a transiently-stale height and
  // Re-clamps the physical scroll toward 0, stranding the viewport in the empty top
  // Spacer (the toggle-blank bug). It is a race: whether a follow-up frame re-applies
  // The scroll after layout settles is non-deterministic, so a one-shot scrollTo can
  // Lose. Reconcile every rendered frame instead: re-assert the scrollbar's metrics
  // From the content height we already compute (the per-row heights the spacers
  // Reconstruct) and project scrollTop onto the physical scroll. While the two
  // Diverge we request another frame, so a clamped scroll always recovers within a
  // Frame or two; once aligned every call is a cheap early-return/no-op and the
  // Renderer goes idle. scrollTop stays the single source of truth.
  const syncScroll = async () => {
    if (scrollRef === undefined) {
      return;
    }
    const want = untrack(scrollTop);
    const diverged = scrollRef.scrollTop !== want;
    scrollRef.verticalScrollBar.scrollSize = untrack(heights).reduce(
      (sum, height) => sum + height,
      0,
    );
    scrollRef.verticalScrollBar.viewportSize = state.viewerHeight();
    scrollRef.scrollTo(want);
    if (diverged) {
      renderer.requestRender();
    }
  };
  renderer.setFrameCallback(syncScroll);
  onCleanup(() => renderer.removeFrameCallback(syncScroll));

  // Wheel: left/right scroll long lines horizontally (shared across all lines, so
  // The whole view shifts); up/down drive scrollTop directly (the reconciler above
  // Projects it onto the scrollbox). Both axes own the scroll and zero the native
  // Delta so the scrollbox never also acts on it: scrollTop must stay the single
  // Source of truth for the window, or a native read-back races the uncommitted
  // Scroll and the slice trails the visible content, blanking the lower viewport.
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
    setScrollTop((previous) =>
      Math.max(0, Math.min(previous + sign * delta * VERTICAL_STEP, maxScrollY())),
    );
    if (event.scroll !== undefined) {
      event.scroll.delta = 0;
    }
  };

  // Keep the cursor's row inside the viewport by scrolling the box to it, with a
  // Margin of context rows so the cursor never glues to the very edge (where a
  // Frame of scheduling lag could push it off screen). Reads the current scroll
  // Offset untracked: this effect must fire only when the cursor or layout moves,
  // Never when scrollTop itself changes. Tracking scrollTop would make it re-run
  // On every wheel tick and snap the off-screen cursor back into view, so free
  // Wheel scrolling could never leave the cursor's screen.
  createEffect(() => {
    const cursorRow = lineRowIndices()[state.cursorIndex()];
    if (cursorRow === undefined || scrollRef === undefined) {
      return;
    }
    const rowHeights = heights();
    const top = rowHeights.slice(0, cursorRow).reduce((sum, height) => sum + height, 0);
    const current = untrack(scrollTop);
    const next = followScrollTop({
      current,
      height: rowHeights[cursorRow] ?? 1,
      margin: CURSOR_SCROLL_MARGIN,
      maxScroll: maxScrollY(),
      top,
      viewport: state.viewerHeight(),
    });
    if (next !== current) {
      setScrollTop(next);
    }
  });

  const isCursor = (row: DiffLineRow) => row.navIndex === state.cursorIndex();
  // A row inside the active line selection. Selected rows reuse the cursor lift
  // (`resolveBackground`'s active branch), so the band is theme-correct per diff
  // State with no new token; the focus row still shows its caret word on top.
  const isSelected = (row: DiffLineRow) => {
    const range = state.selectionRange();
    return range !== undefined && row.navIndex >= range[0] && row.navIndex <= range[1];
  };

  // The caret word's display-column range on the cursor line, derived from the
  // Caret offset; undefined when the caret sits in a gap (no word to highlight).
  const caretRange = createMemo<CaretRange | undefined>(() => {
    const word = state.caretWord();
    if (word === undefined) {
      return undefined;
    }
    const content = state.cursorLineContent();
    const from = Bun.stringWidth(content.slice(0, word.start));
    return {
      from,
      to: from + Bun.stringWidth(content.slice(word.start, word.end)),
    };
  });

  // The cursor row's cumulative top, the same sum the vertical-follow effect uses,
  // Lifted to a memo so the caret-anchored card reads it without recomputing.
  const cursorTop = createMemo(() => {
    const cursorRow = lineRowIndices()[state.cursorIndex()];
    if (cursorRow === undefined) {
      return undefined;
    }
    return heights()
      .slice(0, cursorRow)
      .reduce((sum, height) => sum + height, 0);
  });
  // The viewer interior width (gutter + content, inside the border), the coordinate
  // Space the card's absolute left/clamp live in.
  const innerWidth = () => contentWidth() + gutterWidth();

  // The caret's on-screen cell, in viewer-content coordinates, for the context menu
  // (the same geometry the CaretCard anchors against). A line-level caret (a gutter
  // Click, no word) has no `caretRange`, so fall back to the line start rather than
  // Leaving the open menu unanchored and invisible. Undefined only when there is no
  // Cursor line or it is scrolled out of view, which hides the menu.
  const commandAnchor = createMemo(() => {
    const top = cursorTop();
    if (top === undefined) {
      return undefined;
    }
    return caretCell({
      caretFrom: caretRange()?.from ?? 0,
      contentLeft: gutterWidth(),
      cursorTop: top,
      scrollTop: state.viewerScrollTop(),
      scrollX: state.viewerScrollX(),
      viewportHeight: state.viewerHeight(),
      viewportWidth: innerWidth(),
    });
  });

  // A viewer menu with no on-screen anchor (the caret is scrolled out of view) would
  // Render nothing yet still gate the keyboard, so Shift+F10 on an off-screen caret
  // Would trap it. Close it instead, so opening an unanchorable menu is a no-op.
  createEffect(() => {
    if (
      state.commandMenuOpen() &&
      state.commandMenuContext() === "viewer" &&
      commandAnchor() === undefined
    ) {
      state.closeCommandMenu();
    }
  });

  // Keep the caret word in view as it hops along a long line (scroll mode only;
  // Wrap mode has no horizontal scroll). Reads scrollX untracked, like the vertical
  // Follow, so free horizontal wheel scrolling is never snapped back.
  const CARET_SCROLL_MARGIN = 4;
  createEffect(() => {
    const range = caretRange();
    if (range === undefined || wrap()) {
      return;
    }
    const current = untrack(scrollX);
    const next = followScrollX({
      current,
      from: range.from,
      margin: CARET_SCROLL_MARGIN,
      maxScroll: maxScrollX(),
      to: range.to,
      viewport: contentWidth(),
    });
    if (next !== current) {
      setScrollX(next);
    }
  });

  // The gutter reads left to right as change bar, number, glyph, then code, carrying two
  // Orthogonal signals on separate channels: the far-left change bar and the number digits
  // Take the diff state (add green / remove red / context neutral), a dedicated glyph cell
  // Takes the diagnostic severity. The bar is a single ¼-block glyph, add vs remove told
  // Apart by color alone (a deliberate call: equal footprint over a NO_COLOR distinction,
  // Which the +/- column used to carry). It is a Block Element (reliably one cell wide),
  // Never Box-Drawing, whose rarer glyphs fall back to a mis-metriced font and misalign the
  // Gutter. The severity glyph only ever lands on an added or context row since a removed
  // Line has no new-line number to map findings by.
  const findingsFor = (row: DiffLineRow) =>
    row.newLine === undefined ? undefined : state.lineMap().get(row.newLine);

  const gutterNumberColor = (row: DiffLineRow) =>
    row.type === "add"
      ? theme.colors.diff.addedSign
      : row.type === "remove"
        ? theme.colors.diff.removedSign
        : theme.colors.diff.lineNumberFg;

  const changeBar = (row: DiffLineRow) => (row.type === "context" ? " " : "▎");
  const changeBarColor = (row: DiffLineRow) =>
    row.type === "add"
      ? theme.colors.diff.addedSign
      : row.type === "remove"
        ? theme.colors.diff.removedSign
        : theme.colors.text.faint;

  // The strongest severity on the line, or undefined when it has no findings. Feeds a
  // Bare glyph (paired with color per the severity rule, so it reads under NO_COLOR)
  // Rather than recoloring the number.
  const lineSeverity = (row: DiffLineRow) => {
    const findings = findingsFor(row);
    if (findings === undefined) {
      return undefined;
    }
    return findings.some((finding) => finding.severity === "error")
      ? "error"
      : findings.some((finding) => finding.severity === "warning")
        ? "warning"
        : "info";
  };

  // A width-1 glyph cell (blank when the line is clean, so the gutter never shifts),
  // Colored by severity. `severity.info` directly, not `levelColor` (which maps info to
  // A neutral text role for status lines, not the info-diagnostic hue used here).
  const diagnosticGlyph = (row: DiffLineRow) => {
    const severity = lineSeverity(row);
    return severity === undefined ? " " : levelGlyph(severity);
  };
  const diagnosticColor = (row: DiffLineRow) => {
    const severity = lineSeverity(row);
    return severity === undefined
      ? theme.colors.diff.lineNumberFg
      : theme.colors.severity[severity];
  };

  // Each line's background: a find match wins, else a faint add/remove tint (the change
  // Bar and colored number carry the diff state; this is just a subtle block cue). The
  // Cursor lift brightens whatever state the line has rather than replacing it, so a
  // Selected tinted line stays its own color; a context line falls back to the neutral
  // Cursor highlight (or nothing when it isn't the cursor).
  const contentState = (row: DiffLineRow) => {
    if (findMatchSet().has(row.navIndex)) {
      return {
        active: theme.rgba.findMatchBgActive,
        normal: theme.colors.find.matchBg,
      };
    }
    return row.type === "add"
      ? { active: theme.rgba.addedBgActive, normal: theme.colors.diff.addedBg }
      : row.type === "remove"
        ? {
            active: theme.rgba.removedBgActive,
            normal: theme.colors.diff.removedBg,
          }
        : undefined;
  };

  const resolveBackground = (
    background: { normal: string; active: RGBA } | undefined,
    cursor: boolean,
  ) => (cursor ? (background?.active ?? theme.colors.surface.cursor) : background?.normal);

  // The gutter shares the line's add/remove tint so a changed line reads as one band edge
  // To edge. It follows diff state only, not the find match (a search hit stays a
  // Content-only highlight; the changed-line band stays stable underneath it).
  const gutterState = (row: DiffLineRow) =>
    row.type === "add"
      ? { active: theme.rgba.addedBgActive, normal: theme.colors.diff.addedBg }
      : row.type === "remove"
        ? {
            active: theme.rgba.removedBgActive,
            normal: theme.colors.diff.removedBg,
          }
        : undefined;

  const gutterBackground = (row: DiffLineRow) =>
    resolveBackground(gutterState(row), isCursor(row) || isSelected(row));
  const contentBackground = (row: DiffLineRow) =>
    resolveBackground(contentState(row), isCursor(row) || isSelected(row));

  const lineLabel = (row: DiffLineRow) =>
    String(row.newLine ?? row.oldLine ?? "").padStart(numberWidth());

  const asLineRow = (row: DiffRow) => (isLineRow(row) ? row : undefined);
  // A collapsed-region marker: a fold (`▸ N lines folded`), a collapsed git gap
  // (`⋯ N unmodified lines`), or an expanded gap's re-collapse handle (`⋯ hide N …`).
  const markerGlyph = (row: DiffRow) =>
    row.kind === "marker" && row.regionKind === "fold" ? "▸" : "⋯";
  const markerLabel = (row: DiffRow) => {
    if (row.kind !== "marker") {
      return "";
    }
    const noun = row.count === 1 ? "line" : "lines";
    if (row.regionKind === "fold") {
      return `${row.count} ${noun} folded`;
    }
    return row.collapsed
      ? `${row.count} unmodified ${noun}`
      : `hide ${row.count} unmodified ${noun}`;
  };
  const toggleMarker = (row: DiffRow) => {
    if (row.kind !== "marker") {
      return;
    }
    if (row.regionKind === "fold") {
      state.toggleFold(row.key);
    } else {
      state.toggleGap(row.key);
    }
  };

  return (
    <box position="relative" width="100%" height={state.viewerHeight()}>
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
        {/* Non-wrap rows are pinned to height 1 because `heights()` counts every such
          row as one terminal row, and the spacers/maxScrollY derive from that. Some
          graphemes (emoji with a U+FE0F variation selector) otherwise lay a
          `wrapMode="none"` text out two rows tall, under-counting the content height
          and stranding the file's last line below the fold. Separators count as 1 in
          both modes, so they pin unconditionally. */}
        <Index each={visibleRows()}>
          {(row, rowIndex) => (
            <Show
              when={asLineRow(row())}
              fallback={
                <box
                  ref={(el) => (el.selectable = false)}
                  width="100%"
                  height={1}
                  backgroundColor={theme.colors.surface.panel}
                  onMouseDown={(event: MouseEvent) => {
                    event.stopPropagation();
                    batch(() => {
                      state.setFocusedPane("diff");
                      toggleMarker(row());
                    });
                  }}
                >
                  <text ref={(el) => (el.selectable = false)} fg={theme.colors.text.faint}>
                    {`${markerGlyph(row())
                      .padStart(numberWidth() + 1)
                      .padEnd(gutterWidth())}${markerLabel(row())}`}
                  </text>
                </box>
              }
            >
              {(line) => (
                <box
                  // Own the line selection here, so disable OpenTUI's native text
                  // Selection on the row (it would otherwise start its own drag
                  // Highlight and copy button, fighting our band).
                  ref={(el) => (el.selectable = false)}
                  width="100%"
                  flexDirection="row"
                  // Explicit per-row height in both modes, from the same `heights()`
                  // The spacers and scroll math use. A `1 -> undefined` (fixed -> auto)
                  // Transition does not relayout the text leaf, so a `z` toggle into
                  // Wrap left long lines stuck at one row; `1 -> N` always relayouts.
                  height={heights()[window().start + rowIndex] ?? 1}
                  onMouseDown={(event: MouseEvent) => {
                    event.stopPropagation();
                    // Shift-click extends a whole-line selection to the clicked row,
                    // Keeping the anchor; a plain click sets the caret (and clears any
                    // Selection via setCursorRow), landing on the clicked word.
                    if (event.modifiers.shift) {
                      batch(() => {
                        state.setFocusedPane("diff");
                        state.extendSelectionTo(line().navIndex);
                      });
                      return;
                    }
                    // Remember where a drag would start from, so onMouseDrag can
                    // Follow the pointer by the event's live y (see navIndexForRow).
                    dragOrigin = { rowIndex: window().start + rowIndex, y: event.y };
                    batch(() => {
                      state.setFocusedPane("diff");
                      state.setCursorRow(line().navIndex);
                      // Land the caret on the clicked word: map the screen x onto a
                      // Content column (past the sidebar, viewer border, gutter, sign),
                      // Then snap to the word that owns it.
                      const content = line()
                        .spans.map((part) => part.text)
                        .join("");
                      // The horizontal scroll offset only applies in scroll mode; in
                      // Wrap mode there is none (a click on a wrapped continuation row
                      // Stays approximate, the v1 wrap caret limitation).
                      const column =
                        event.x -
                        (state.sidebarWidth() + 1 + gutterWidth()) +
                        (wrap() ? 0 : scrollX());
                      if (column >= 0) {
                        const index = columnToIndex(content, column);
                        state.setCursorColumn(wordAt(content, index)?.start ?? index);
                      } else {
                        // A click on the gutter/sign selects the line, not a symbol:
                        // `y` then copies path:line.
                        state.setCaretLineLevel(true);
                      }
                    });
                    // A right-click opens the context menu on the symbol just landed
                    // On (outside the batch above so the caret memos are fresh when the
                    // Menu reads them); a left-click leaves today's caret-move behavior.
                    if (isRightClick(event)) {
                      state.openCommandMenu("viewer");
                    }
                  }}
                  // Drag extends the selection. OpenTUI pins drag events to the first
                  // Row once captured, so derive the target row from the live event.y
                  // Against the press origin rather than this handler's own `line()`.
                  onMouseDrag={(event: MouseEvent) => {
                    event.stopPropagation();
                    const origin = dragOrigin;
                    if (origin === undefined) {
                      return;
                    }
                    const targetRow = Math.max(
                      0,
                      Math.min(origin.rowIndex + (event.y - origin.y), rows().length - 1),
                    );
                    const nav = navIndexForRow(targetRow);
                    if (nav !== undefined) {
                      batch(() => {
                        state.setFocusedPane("diff");
                        state.extendSelectionTo(nav);
                      });
                    }
                  }}
                  onMouseDragEnd={() => {
                    dragOrigin = undefined;
                  }}
                >
                  <text
                    ref={(el) => (el.selectable = false)}
                    fg={changeBarColor(line())}
                    bg={gutterBackground(line())}
                  >
                    {changeBar(line())}
                  </text>
                  <text
                    ref={(el) => (el.selectable = false)}
                    fg={gutterNumberColor(line())}
                    bg={gutterBackground(line())}
                  >
                    {`${lineLabel(line())} `}
                  </text>
                  <text
                    ref={(el) => (el.selectable = false)}
                    fg={diagnosticColor(line())}
                    bg={gutterBackground(line())}
                  >
                    {`${diagnosticGlyph(line())} `}
                  </text>
                  <box
                    ref={(el) => (el.selectable = false)}
                    flexGrow={1}
                    backgroundColor={contentBackground(line())}
                  >
                    <StyledLine
                      row={line()}
                      wrap={wrap()}
                      width={contentWidth()}
                      scrollX={scrollX()}
                      caret={isCursor(line()) ? caretRange() : undefined}
                    />
                  </box>
                </box>
              )}
            </Show>
          )}
        </Index>
        <box width="100%" height={window().bottomSpacer} />
      </scrollbox>
      <CaretCard
        cursorTop={cursorTop}
        caretFrom={() => caretRange()?.from}
        contentLeft={() => gutterWidth()}
        innerWidth={innerWidth}
      />
      <Show when={state.commandMenuOpen() && state.commandMenuContext() === "viewer"}>
        <CommandMenu
          anchor={commandAnchor}
          viewportWidth={innerWidth}
          viewportHeight={state.viewerHeight}
        />
      </Show>
    </box>
  );
}

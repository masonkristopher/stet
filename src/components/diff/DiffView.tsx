import {
  fg,
  StyledText,
  type MouseEvent,
  type RGBA,
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

import { followScrollTop } from "../../diff/follow";
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
  const renderer = useRenderer();
  const measurer = createLineMeasurer(renderer.widthMethod);
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

  // The gutter carries two orthogonal signals on separate channels: its background
  // Is the diff state (add/remove), and its line-number digits take the diagnostic
  // Severity color. They never fight, and a severity number only ever lands on a
  // Green (added) or base (context) gutter since removed lines have no new-line number.
  const findingsFor = (row: DiffLineRow) =>
    row.newLine === undefined ? undefined : state.lineMap().get(row.newLine);

  const gutterNumberColor = (row: DiffLineRow) => {
    const findings = findingsFor(row);
    if (findings === undefined) {
      return theme.colors.diff.lineNumberFg;
    }
    return findings.some((finding) => finding.severity === "error")
      ? theme.colors.severity.error
      : findings.some((finding) => finding.severity === "warning")
        ? theme.colors.severity.warning
        : theme.colors.severity.info;
  };

  // Each line's background resolves in two steps: its diff state, then a cursor lift
  // That brightens that state rather than replacing it, so a selected add/remove line
  // Stays its own color; only a plain context line falls back to the neutral highlight.
  const gutterState = (row: DiffLineRow) =>
    row.type === "add"
      ? { active: theme.rgba.addedLineNumberBgActive, normal: theme.colors.diff.addedLineNumberBg }
      : row.type === "remove"
        ? {
            active: theme.rgba.removedLineNumberBgActive,
            normal: theme.colors.diff.removedLineNumberBg,
          }
        : undefined;

  const contentState = (row: DiffLineRow) => {
    if (findMatchSet().has(row.navIndex)) {
      return { active: theme.rgba.findMatchBgActive, normal: theme.colors.find.matchBg };
    }
    return row.type === "add"
      ? { active: theme.rgba.addedBgActive, normal: theme.colors.diff.addedBg }
      : row.type === "remove"
        ? { active: theme.rgba.removedBgActive, normal: theme.colors.diff.removedBg }
        : undefined;
  };

  const resolveBackground = (bg: { normal: string; active: RGBA } | undefined, cursor: boolean) =>
    cursor ? (bg?.active ?? theme.colors.surface.cursor) : bg?.normal;

  const gutterBackground = (row: DiffLineRow) => resolveBackground(gutterState(row), isCursor(row));
  const contentBackground = (row: DiffLineRow) =>
    resolveBackground(contentState(row), isCursor(row));

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
                <text fg={gutterNumberColor(line())} bg={gutterBackground(line())}>
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

import type { MouseEvent } from "@opentui/core";
import { batch, createMemo, Index, Show } from "solid-js";

import { PROBLEMS_HEIGHT } from "@/constants";
import { problemLocationLabel, sourceLabel } from "@/diagnostics/problems";
import type { ProblemItem } from "@/diagnostics/problems";
import { levelGlyph } from "@/log/levels";
import { state } from "@/state";
import { useTheme } from "@/theme/context";
import { truncate } from "@/utils/text";

import { FileIcon } from "./FileIcon";
import { ListScrollbar } from "./ListScrollbar";
import { PaneFrame } from "./PaneFrame";
import { windowWheelHandler } from "./wheel";

const INDENT = 2;
const ICON = 2;
const MIN_SUMMARY = 12;

// Every ProblemItem is exactly one terminal row (group spacing is an explicit
// Spacer item), so the panel windows to its fixed viewport like the sidebar:
// Only ~viewport rows are ever mounted, and a diagnostics storm re-renders a
// Handful of slots instead of recreating a renderable per finding. Slots swap
// Items in place under <Index>, so each kind renders through a reactive <Show>.
const asFailure = (item: ProblemItem) => (item.kind === "failure" ? item : undefined);
const asFileHeader = (item: ProblemItem) => (item.kind === "file-header" ? item : undefined);
const asProblem = (item: ProblemItem) => (item.kind === "problem" ? item : undefined);
const asHelp = (item: ProblemItem) => (item.kind === "help" ? item : undefined);

export function ProblemsPanel() {
  const theme = useTheme();
  const viewport = PROBLEMS_HEIGHT - 2;

  const visibleItems = createMemo(() => {
    const start = state.problemsScrollTop();
    return state
      .allProblemItems()
      .slice(start, start + viewport)
      .map((item, offset) => ({ index: start + offset, item }));
  });

  const focused = () => state.focusedPane() === "problems";
  // The cursor lives on a `problem` or `failure` row; a `problem`'s `help` sub-line
  // Shares the highlight so the entry reads as one block, and a header never lights up.
  const selected = (index: number, item: ProblemItem) =>
    focused() &&
    (((item.kind === "problem" || item.kind === "failure") && index === state.problemIndex()) ||
      (item.kind === "help" && item.owner === state.problemIndex()));
  const rowBg = (index: number, item: ProblemItem) =>
    selected(index, item) ? theme.colors.surface.cursor : theme.colors.surface.base;

  // Border (2) + scrollbar (1) eat the panel width before the row's own padding.
  const contentWidth = () => Math.max(0, state.terminalWidth() - 3);

  const severityColor = (severity: "error" | "warning" | "info") =>
    severity === "error"
      ? theme.colors.severity.error
      : severity === "warning"
        ? theme.colors.severity.warning
        : theme.colors.severity.info;

  const onWheel = windowWheelHandler({
    rowCount: () => state.allProblemItems().length,
    scrollTop: state.problemsScrollTop,
    setScrollTop: state.setProblemsScrollTop,
    viewport: () => viewport,
  });

  // Clicking reproduces the keyboard outcome for the row: a problem opens its
  // Location, a failure line just takes the cursor, decorations do nothing.
  // StopPropagation keeps outer focus handlers out of it.
  const clickRow = (event: MouseEvent, index: number, item: ProblemItem) => {
    if (item.kind === "failure") {
      event.stopPropagation();
      batch(() => {
        state.setFocusedPane("problems");
        state.setProblemIndex(index);
      });
      return;
    }
    if (item.kind === "problem") {
      event.stopPropagation();
      batch(() => {
        state.setProblemIndex(index);
        state.selectFile(
          item.problem.path,
          item.problem.line === undefined
            ? undefined
            : { column: item.problem.column, escalate: true, line: item.problem.line },
        );
        state.setFocusedPane("diff");
      });
    }
  };

  return (
    <PaneFrame focused={focused()} height={PROBLEMS_HEIGHT} width="100%">
      <box width="100%" height={viewport} flexDirection="row" onMouseScroll={onWheel}>
        <box
          ref={(el) => {
            // A click activates a row; it must never start a text selection.
            el.selectable = false;
          }}
          flexGrow={1}
          flexDirection="column"
        >
          <Show
            when={state.allProblemItems().length > 0}
            fallback={
              <box id="problem-empty" paddingLeft={1}>
                <text fg={theme.colors.text.muted}>no problems</text>
              </box>
            }
          >
            <Index each={visibleItems()}>
              {(row) => (
                <box
                  width="100%"
                  height={1}
                  overflow="hidden"
                  backgroundColor={rowBg(row().index, row().item)}
                  onMouseDown={(event: MouseEvent) => clickRow(event, row().index, row().item)}
                >
                  <Show when={row().item.kind === "failure-header"}>
                    <box width="100%" paddingLeft={1}>
                      <text fg={theme.colors.severity.error}>checks failed</text>
                    </box>
                  </Show>
                  <Show when={asFailure(row().item)}>
                    {(item) => (
                      <box
                        width="100%"
                        flexDirection="row"
                        paddingLeft={1 + INDENT}
                        paddingRight={1}
                      >
                        <text fg={theme.colors.severity.error}>
                          {item().isFirst ? `${levelGlyph("error")} ` : "  "}
                        </text>
                        <text fg={theme.colors.text.secondary}>{item().line}</text>
                      </box>
                    )}
                  </Show>
                  <Show when={asFileHeader(row().item)}>
                    {(item) => {
                      const counts = () =>
                        [
                          {
                            color: theme.colors.severity.error,
                            glyph: levelGlyph("error"),
                            n: item().errors,
                          },
                          {
                            color: theme.colors.severity.warning,
                            glyph: levelGlyph("warning"),
                            n: item().warnings,
                          },
                          {
                            color: theme.colors.severity.info,
                            glyph: levelGlyph("info"),
                            n: item().info,
                          },
                        ].filter((count) => count.n > 0);
                      return (
                        <box
                          width="100%"
                          flexDirection="row"
                          justifyContent="space-between"
                          paddingLeft={1}
                          paddingRight={1}
                        >
                          <box flexDirection="row">
                            <FileIcon name={item().path.split("/").at(-1) ?? item().path} />
                            <text fg={theme.colors.text.strong}>
                              {truncate(
                                item().path,
                                Math.max(
                                  0,
                                  contentWidth() -
                                    2 -
                                    counts().length * 4 -
                                    (state.iconsEnabled() ? 2 : 0),
                                ),
                              )}
                            </text>
                          </box>
                          <box flexDirection="row">
                            <Index each={counts()}>
                              {(count) => (
                                <text fg={count().color}>{` ${count().glyph} ${count().n}`}</text>
                              )}
                            </Index>
                          </box>
                        </box>
                      );
                    }}
                  </Show>
                  <Show when={asHelp(row().item)}>
                    {(item) => (
                      <box width="100%" paddingLeft={1 + INDENT + ICON} paddingRight={1}>
                        <text fg={theme.colors.text.faint}>
                          {`└ ${truncate(item().text, Math.max(0, contentWidth() - (1 + INDENT + ICON) - 1 - 2))}`}
                        </text>
                      </box>
                    )}
                  </Show>
                  <Show when={asProblem(row().item)}>
                    {(item) => {
                      const source = () =>
                        sourceLabel(item().problem.source ?? item().problem.checker);
                      const lineLabel = () => {
                        const location = problemLocationLabel(item().problem);
                        return location === "" ? "" : location.padStart(item().labelWidth);
                      };
                      // Everything the message shares its row with: paddingLeft (1 + INDENT),
                      // PaddingRight (1), the icon, and the location column (line:col + trailing space).
                      const overhead = () => 1 + INDENT + 1 + ICON + item().labelWidth + 1;
                      // Reserve room for the source too, then degrade: drop the right-pinned
                      // Source before truncating the message below readability.
                      const withSource = () => contentWidth() - overhead() - (source().length + 1);
                      const showSource = () => withSource() >= MIN_SUMMARY;
                      const budget = () =>
                        Math.max(0, showSource() ? withSource() : contentWidth() - overhead());
                      return (
                        <box
                          width="100%"
                          flexDirection="row"
                          justifyContent="space-between"
                          paddingLeft={1 + INDENT}
                          paddingRight={1}
                        >
                          <box flexDirection="row">
                            <text
                              fg={severityColor(item().problem.severity)}
                            >{`${levelGlyph(item().problem.severity)} `}</text>
                            <text fg={theme.colors.text.muted}>{`${lineLabel()} `}</text>
                            <text fg={theme.colors.text.secondary}>
                              {truncate(item().summary, budget())}
                            </text>
                          </box>
                          <Show when={showSource()}>
                            <text fg={theme.colors.text.muted}>{source()}</text>
                          </Show>
                        </box>
                      );
                    }}
                  </Show>
                </box>
              )}
            </Index>
          </Show>
        </box>
        <ListScrollbar
          rowCount={() => state.allProblemItems().length}
          viewport={() => viewport}
          scrollTop={state.problemsScrollTop}
        />
      </box>
    </PaneFrame>
  );
}

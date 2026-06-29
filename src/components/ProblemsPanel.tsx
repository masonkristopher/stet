import type { MouseEvent, ScrollBoxRenderable } from "@opentui/core";
import { batch, createEffect, For, Show } from "solid-js";

import { PROBLEMS_HEIGHT } from "@/constants";
import { problemLocationLabel, sourceLabel } from "@/diagnostics/problems";
import type { ProblemItem } from "@/diagnostics/problems";
import { state } from "@/state";
import { useTheme } from "@/theme/context";
import { truncate } from "@/utils/text";

const INDENT = 2;
const ICON = 2;
const MIN_SUMMARY = 12;

export function ProblemsPanel() {
  const theme = useTheme();
  let problemsRef: ScrollBoxRenderable | undefined;

  createEffect(() => {
    problemsRef?.scrollChildIntoView(state.allProblemItems()[state.problemIndex()]?.id ?? "");
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
  const severityIcon = (severity: "error" | "warning" | "info") =>
    severity === "error" ? "✖" : severity === "warning" ? "⚠" : "ℹ";

  return (
    <box
      height={PROBLEMS_HEIGHT}
      width="100%"
      flexDirection="column"
      borderStyle="single"
      borderColor={focused() ? theme.colors.border.focused : theme.colors.border.unfocused}
    >
      <scrollbox
        ref={(el) => (problemsRef = el)}
        width="100%"
        height={PROBLEMS_HEIGHT - 2}
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
          when={state.allProblemItems().length > 0}
          fallback={
            <box id="problem-empty" paddingLeft={1}>
              <text fg={theme.colors.text.muted}>no problems</text>
            </box>
          }
        >
          <For each={state.allProblemItems()}>
            {(item, index) => {
              if (item.kind === "failure-header") {
                return (
                  <box id={item.id} width="100%" paddingLeft={1} paddingTop={index() === 0 ? 0 : 1}>
                    <text fg={theme.colors.severity.error}>checks failed</text>
                  </box>
                );
              }

              if (item.kind === "failure") {
                return (
                  <box
                    id={item.id}
                    width="100%"
                    flexDirection="row"
                    paddingLeft={1 + INDENT}
                    paddingRight={1}
                    backgroundColor={rowBg(index(), item)}
                    onMouseDown={(event: MouseEvent) => {
                      event.stopPropagation();
                      batch(() => {
                        state.setFocusedPane("problems");
                        state.setProblemIndex(index());
                      });
                    }}
                  >
                    <text fg={theme.colors.severity.error}>{item.isFirst ? "✖ " : "  "}</text>
                    <text fg={theme.colors.text.secondary}>{item.line}</text>
                  </box>
                );
              }

              if (item.kind === "file-header") {
                const counts = [
                  { color: theme.colors.severity.error, glyph: "✖", n: item.errors },
                  { color: theme.colors.severity.warning, glyph: "⚠", n: item.warnings },
                  { color: theme.colors.severity.info, glyph: "ℹ", n: item.info },
                ].filter((count) => count.n > 0);
                return (
                  <box
                    id={item.id}
                    width="100%"
                    flexDirection="row"
                    justifyContent="space-between"
                    paddingLeft={1}
                    paddingRight={1}
                    paddingTop={index() === 0 ? 0 : 1}
                  >
                    <text fg={theme.colors.text.strong}>
                      {truncate(item.path, Math.max(0, contentWidth() - 2 - counts.length * 4))}
                    </text>
                    <box flexDirection="row">
                      <For each={counts}>
                        {(count) => <text fg={count.color}>{` ${count.glyph} ${count.n}`}</text>}
                      </For>
                    </box>
                  </box>
                );
              }

              if (item.kind === "help") {
                return (
                  <box
                    id={item.id}
                    width="100%"
                    paddingLeft={1 + INDENT + ICON}
                    paddingRight={1}
                    backgroundColor={rowBg(index(), item)}
                  >
                    <text fg={theme.colors.text.faint}>
                      {`└ ${truncate(item.text, Math.max(0, contentWidth() - (1 + INDENT + ICON) - 1 - 2))}`}
                    </text>
                  </box>
                );
              }

              const { problem } = item;
              const source = sourceLabel(problem.source ?? problem.checker);
              const location = problemLocationLabel(problem);
              const lineLabel = location === "" ? "" : location.padStart(item.labelWidth);
              // Everything the message shares its row with: paddingLeft (1 + INDENT),
              // PaddingRight (1), the icon, and the location column (line:col + trailing space).
              const overhead = 1 + INDENT + 1 + ICON + item.labelWidth + 1;
              // Reserve room for the source too, then degrade: drop the right-pinned
              // Source before truncating the message below readability.
              const withSource = contentWidth() - overhead - (source.length + 1);
              const showSource = withSource >= MIN_SUMMARY;
              const budget = Math.max(0, showSource ? withSource : contentWidth() - overhead);
              return (
                <box
                  id={item.id}
                  width="100%"
                  flexDirection="row"
                  justifyContent="space-between"
                  paddingLeft={1 + INDENT}
                  paddingRight={1}
                  backgroundColor={rowBg(index(), item)}
                  onMouseDown={(event: MouseEvent) => {
                    event.stopPropagation();
                    batch(() => {
                      state.setProblemIndex(index());
                      state.selectFile(problem.path);
                      if (problem.line !== undefined) {
                        state.setJumpTarget({
                          column: problem.column,
                          escalate: true,
                          line: problem.line,
                          path: problem.path,
                        });
                      }
                      state.setFocusedPane("diff");
                    });
                  }}
                >
                  <box flexDirection="row">
                    <text
                      fg={severityColor(problem.severity)}
                    >{`${severityIcon(problem.severity)} `}</text>
                    <text fg={theme.colors.text.muted}>{`${lineLabel} `}</text>
                    <text fg={theme.colors.text.secondary}>{truncate(item.summary, budget)}</text>
                  </box>
                  <Show when={showSource}>
                    <text fg={theme.colors.text.muted}>{source}</text>
                  </Show>
                </box>
              );
            }}
          </For>
        </Show>
      </scrollbox>
    </box>
  );
}

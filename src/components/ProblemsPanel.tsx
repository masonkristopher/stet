import type { ScrollBoxRenderable } from "@opentui/core";
import { createEffect, For, Show } from "solid-js";

import { PROBLEMS_HEIGHT } from "../constants";
import { state } from "../state";
import { useTheme } from "../theme/context";

export function ProblemsPanel() {
  const theme = useTheme();
  let problemsRef: ScrollBoxRenderable | undefined;

  createEffect(() => {
    problemsRef?.scrollChildIntoView(state.allProblemItems()[state.problemIndex()]?.id ?? "");
  });

  const focused = () => state.focusedPane() === "problems";
  const rowBg = (index: number) =>
    index === state.problemIndex() && focused()
      ? theme.colors.surface.cursor
      : theme.colors.surface.base;

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
            {(item, index) =>
              item.kind === "failure" ? (
                <box
                  id={item.id}
                  width="100%"
                  flexDirection="row"
                  paddingLeft={1}
                  paddingRight={1}
                  backgroundColor={rowBg(index())}
                >
                  <text fg={theme.colors.severity.error}>{item.isFirst ? "✖ " : "  "}</text>
                  <text fg={theme.colors.text.secondary}>{item.line}</text>
                  {item.isFirst ? (
                    <text fg={theme.colors.text.muted}>{`  [${item.checker}]`}</text>
                  ) : null}
                </box>
              ) : (
                <box
                  id={item.id}
                  width="100%"
                  flexDirection="row"
                  paddingLeft={1}
                  paddingRight={1}
                  backgroundColor={rowBg(index())}
                >
                  <text
                    fg={
                      item.problem.severity === "error"
                        ? theme.colors.severity.error
                        : item.problem.severity === "warning"
                          ? theme.colors.severity.warning
                          : theme.colors.severity.info
                    }
                  >
                    {item.problem.severity === "error"
                      ? "✖ "
                      : item.problem.severity === "warning"
                        ? "⚠ "
                        : "ℹ "}
                  </text>
                  <text fg={theme.colors.text.strong}>
                    {`${item.problem.path}${item.problem.line === undefined ? "" : `:${item.problem.line}`} `}
                  </text>
                  <text fg={theme.colors.text.secondary}>{item.problem.message}</text>
                  <text
                    fg={theme.colors.text.muted}
                  >{`  [${item.problem.source ?? item.problem.checker}]`}</text>
                </box>
              )
            }
          </For>
        </Show>
      </scrollbox>
    </box>
  );
}

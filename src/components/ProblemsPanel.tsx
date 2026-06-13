import type { ScrollBoxRenderable } from "@opentui/core"
import type { RefObject } from "react"
import { PROBLEMS_HEIGHT } from "../constants"
import type { ProblemItem } from "../atoms/diagnostics"
import { useTheme } from "../theme/context"

interface ProblemsPanelProps {
  problemsRef: RefObject<ScrollBoxRenderable | null>
  allProblemItems: ProblemItem[]
  problemIndex: number
  focused: boolean
}

export function ProblemsPanel({ problemsRef, allProblemItems, problemIndex, focused }: ProblemsPanelProps) {
  const theme = useTheme()
  return (
    <box
      height={PROBLEMS_HEIGHT}
      width="100%"
      flexDirection="column"
      borderStyle="single"
      borderColor={focused ? theme.colors.border.focused : theme.colors.border.unfocused}
    >
      <scrollbox ref={problemsRef} width="100%" height={PROBLEMS_HEIGHT - 2} scrollY viewportCulling>
        {allProblemItems.length === 0 ? (
          <box id="problem-empty" paddingLeft={1}>
            <text fg={theme.colors.text.muted}>no problems</text>
          </box>
        ) : (
          <>
            {allProblemItems.map((item, index) =>
              item.kind === "failure" ? (
                <box
                  key={item.id}
                  id={item.id}
                  width="100%"
                  flexDirection="row"
                  paddingLeft={1}
                  paddingRight={1}
                  backgroundColor={index === problemIndex && focused ? theme.colors.surface.cursor : theme.colors.surface.base}
                >
                  <text fg={theme.colors.severity.error}>{item.isFirst ? "✖ " : "  "}</text>
                  <text fg={theme.colors.text.secondary}>{item.line}</text>
                  {item.isFirst && <text fg={theme.colors.text.muted}>{`  [${item.checker}]`}</text>}
                </box>
              ) : (
                <box
                  key={item.id}
                  id={item.id}
                  width="100%"
                  flexDirection="row"
                  paddingLeft={1}
                  paddingRight={1}
                  backgroundColor={index === problemIndex && focused ? theme.colors.surface.cursor : theme.colors.surface.base}
                >
                  <text fg={item.problem.severity === "error" ? theme.colors.severity.error : theme.colors.severity.warning}>
                    {item.problem.severity === "error" ? "✖ " : "⚠ "}
                  </text>
                  <text
                    fg={theme.colors.text.strong}
                  >{`${item.problem.path}${item.problem.line === undefined ? "" : `:${item.problem.line}`} `}</text>
                  <text fg={theme.colors.text.secondary}>{item.problem.message}</text>
                  <text fg={theme.colors.text.muted}>{`  [${item.problem.checker}]`}</text>
                </box>
              ),
            )}
          </>
        )}
      </scrollbox>
    </box>
  )
}

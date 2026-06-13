import type { DiffRenderable, LineColorConfig, RGBA } from "@opentui/core"
import { useAtomSet, useAtomValue } from "@effect/atom-react"
import { useRenderer } from "@opentui/react"
import type { Dispatch, SetStateAction } from "react"
import { useEffect, useMemo, useRef } from "react"
import { cursorIndexAtom, jumpTargetAtom } from "../atoms/diff"
import { DIFF_ID } from "../constants"
import type { Diagnostic } from "../diagnostics"
import type { ChangedFile } from "../git"
import type { ParsedDiffLine } from "../patch"
import { useTheme } from "../theme/context"
import { nearestNavigableIndex } from "../ui-helpers"

interface ScrollablePane {
  scrollY: number
  maxScrollY: number
}

interface UseDiffCursorArgs {
  navigableLines: ParsedDiffLine[]
  selectedPath: string | undefined
  selectedFile: ChangedFile | undefined
  truncated: boolean
  lineMap: Map<number, Diagnostic[]>
  viewerHeight: number
  fullContentPaths: Set<string>
  setFullContentPaths: Dispatch<SetStateAction<Set<string>>>
  fileView: boolean
  setFileView: Dispatch<SetStateAction<boolean>>
}

// Owns the diff cursor: its position, deferred jumps, and the line painting that
// Overlays add/remove/diagnostic tints plus the cursor row onto the diff pane.
export function useDiffCursor({
  navigableLines,
  selectedPath,
  selectedFile,
  truncated,
  lineMap,
  viewerHeight,
  fullContentPaths,
  setFullContentPaths,
  fileView,
  setFileView,
}: UseDiffCursorArgs) {
  const renderer = useRenderer()
  const theme = useTheme()
  const cursorIndex = useAtomValue(cursorIndexAtom)
  const setCursorIndex = useAtomSet(cursorIndexAtom)
  const jumpTarget = useAtomValue(jumpTargetAtom)
  const setJumpTarget = useAtomSet(jumpTargetAtom)
  const diffRef = useRef<DiffRenderable>(null)

  useEffect(() => {
    const firstChanged = navigableLines.findIndex((line) => line.type !== "context")
    setCursorIndex(firstChanged === -1 ? 0 : firstChanged)
    // Reset to the first change only when the file changes, not on live edits of the same file
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedPath])

  useEffect(() => {
    if (jumpTarget === undefined || jumpTarget.path !== selectedPath) {
      return
    }

    const index = navigableLines.findIndex((line) => line.newLine === jumpTarget.line)
    if (index !== -1) {
      setCursorIndex(index)
      setJumpTarget(undefined)
      return
    }

    // The line may simply not be rendered yet; un-truncate the current view first
    if (truncated && !fullContentPaths.has(jumpTarget.path)) {
      setFullContentPaths((current) => new Set(current).add(jumpTarget.path))
      return
    }

    if (jumpTarget.escalate && selectedFile !== undefined && !fileView) {
      setFileView(true)
      return
    }

    // Land on the nearest line instead of bouncing between views
    const nearest = nearestNavigableIndex(navigableLines, jumpTarget.line)
    if (nearest >= 0) {
      setCursorIndex(nearest)
    }
    setJumpTarget(undefined)
  }, [
    fileView,
    fullContentPaths,
    jumpTarget,
    navigableLines,
    selectedFile,
    selectedPath,
    truncated,
    setFileView,
    setFullContentPaths,
    setCursorIndex,
    setJumpTarget,
  ])

  // The add/remove/diagnostic tints only change with the content, so a cursor
  // Move just copies this map and overlays the cursor row
  const baseLineColors = useMemo(() => {
    const { addedBg, errorGutterBg, removedBg, transparent, warningGutterBg } = theme.rgba
    const colors = new Map<number, LineColorConfig>()
    navigableLines.forEach((line, index) => {
      let gutter = transparent
      let content = transparent
      if (line.type === "add") {
        content = addedBg
      } else if (line.type === "remove") {
        content = removedBg
      }

      const findings = line.newLine === undefined ? undefined : lineMap.get(line.newLine)
      if (findings !== undefined) {
        gutter = findings.some((finding) => finding.severity === "error") ? errorGutterBg : warningGutterBg
      }

      if (gutter !== transparent || content !== transparent) {
        colors.set(index, { content, gutter })
      }
    })
    return colors
  }, [lineMap, navigableLines, theme])

  useEffect(() => {
    const diff = diffRef.current
    if (diff === null || navigableLines.length === 0) {
      return
    }

    const last = navigableLines.length - 1
    if (cursorIndex > last) {
      setCursorIndex(last)
      return
    }

    // oxlint-disable-next-line func-style
    const paint = () => {
      const colors = new Map<number, string | RGBA | LineColorConfig>(baseLineColors)
      colors.set(cursorIndex, { content: theme.rgba.cursorBg, gutter: theme.rgba.cursorBg })
      diff.setLineColors(colors)
    }

    // The diff renderable repaints its own line colors when content settles;
    // Painting again in a microtask keeps the cursor/diagnostic tints on top
    paint()
    queueMicrotask(paint)

    const pane = diff.findDescendantById(`${DIFF_ID}-left-code`) as ScrollablePane | undefined
    if (pane !== undefined) {
      if (cursorIndex < pane.scrollY) {
        pane.scrollY = cursorIndex
      } else if (cursorIndex >= pane.scrollY + viewerHeight) {
        pane.scrollY = cursorIndex - viewerHeight + 1
      }
    }

    renderer.requestRender()
  }, [baseLineColors, cursorIndex, navigableLines, viewerHeight, renderer, theme, setCursorIndex])

  return { cursorIndex, diffRef, setCursorIndex, setJumpTarget }
}

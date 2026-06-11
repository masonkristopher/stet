import { RGBA, type DiffRenderable, type LineColorConfig, type ScrollBoxRenderable } from "@opentui/core"
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react"
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { emptyActivityLog, lastChangedAt, latestActivity, recordActivity, recencyLevel, RECENT_MS, type RecencyLevel } from "./activity"
import { nextScope, scopeLabel, type DiffScope } from "./cli"
import { copyToClipboard, formatCopyReference } from "./copy-reference"
import {
  allFindings,
  checkerNames,
  checkerSummary,
  directorySummary,
  countBySeverity,
  findingsLineMap,
  initialCheckerState,
  markPending,
  runDiagnostics,
  type CheckerName,
  type CheckerState,
  type Diagnostic,
} from "./diagnostics"
import { contentToContextPatch, loadFileContent, type FileContent } from "./file-view"
import { rankFiles } from "./fuzzy"
import type { ChangedFile, GitModel, StageState } from "./git"
import { loadChangedFiles, loadFileDiff, loadRepoFiles, mergeChanged } from "./git"
import { lineReference, renderPatch, type ParsedDiffLine } from "./patch"
import { diffFiletypeFor, type SyntaxConfig } from "./syntax"
import {
  buildFileTree,
  defaultExpandedDirectories,
  expandAncestorsForPath,
  findRowIndexForPath,
  firstFileInNode,
  flattenTree,
  type DirectoryNode,
  type FileTreeRow,
} from "./tree"

type AppProps = {
  model: GitModel
  scope: DiffScope
  syntax: SyntaxConfig
}

type ScrollablePane = { scrollY: number; maxScrollY: number }

// escalate lets a jump switch into file view to find its exact line; without
// it a miss lands on the nearest line in the current view
type JumpTarget = { path: string; line: number; escalate: boolean }

const DIFF_ID = "sideye-diff"
const PROBLEMS_HEIGHT = 10
const CURSOR_BG_HEX = "#3a1530"
const ADDED_BG_HEX = "#102a1c"
const REMOVED_BG_HEX = "#32131f"
const CURSOR_BG = RGBA.fromHex(CURSOR_BG_HEX)
const ADDED_BG = RGBA.fromHex(ADDED_BG_HEX)
const REMOVED_BG = RGBA.fromHex(REMOVED_BG_HEX)
const ERROR_GUTTER = RGBA.fromHex("#52141f")
const WARNING_GUTTER = RGBA.fromHex("#4a3a10")
const TRANSPARENT = RGBA.fromValues(0, 0, 0, 0)

export function App({ model: initialModel, scope: initialScope, syntax }: AppProps) {
  const renderer = useRenderer()
  const { width, height } = useTerminalDimensions()
  const [model, setModel] = useState(initialModel)
  const [scope, setScope] = useState(initialScope)
  const [changesOnly, setChangesOnly] = useState(false)
  const [selectedPath, setSelectedPath] = useState<string | undefined>(initialModel.changed[0]?.path ?? initialModel.repoFiles[0]?.path)
  const [focusedRowIndex, setFocusedRowIndex] = useState(0)
  const [checkerState, setCheckerState] = useState<CheckerState>(() => initialCheckerState(initialModel.changed))
  const [status, setStatus] = useState(syntax.status)
  const [expandedDirectories, setExpandedDirectories] = useState(() => {
    const expanded = defaultExpandedDirectories(initialModel.changed.map((file) => file.path))
    const selected = initialModel.changed[0]?.path ?? initialModel.repoFiles[0]?.path
    return selected === undefined ? expanded : expandAncestorsForPath(expanded, selected)
  })
  const [fullContentPaths, setFullContentPaths] = useState<Set<string>>(() => new Set())
  const [fileView, setFileView] = useState(false)
  const [focusedPane, setFocusedPane] = useState<"tree" | "diff" | "problems">("tree")
  const [problemsOpen, setProblemsOpen] = useState(false)
  const [problemIndex, setProblemIndex] = useState(0)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [paletteQuery, setPaletteQuery] = useState("")
  const [paletteIndex, setPaletteIndex] = useState(0)
  const [cursorIndex, setCursorIndex] = useState(0)
  const [jumpTarget, setJumpTarget] = useState<JumpTarget | undefined>(undefined)
  const [checksInFlight, setChecksInFlight] = useState(0)
  const [activityLog, setActivityLog] = useState(emptyActivityLog)
  const [now, setNow] = useState(() => Date.now())
  const sidebarRef = useRef<ScrollBoxRenderable>(null)
  const problemsRef = useRef<ScrollBoxRenderable>(null)
  const paletteRef = useRef<ScrollBoxRenderable>(null)
  const diffRef = useRef<DiffRenderable>(null)
  const previousChangedRef = useRef<ChangedFile[]>(initialModel.changed)
  const previousScopeKeyRef = useRef(initialModel.scopeKey)
  const runGenerationRef = useRef(0)
  const abortRef = useRef<AbortController | undefined>(undefined)

  const selectedFile = selectedPath === undefined ? undefined : model.changedByPath.get(selectedPath)
  const showFileContent = selectedPath !== undefined && (selectedFile === undefined || fileView)
  const tree = useMemo(
    () => buildFileTree(model.repoFiles, model.changedByPath, { changesOnly }),
    [changesOnly, model.changedByPath, model.repoFiles],
  )
  const treeRows = useMemo(() => flattenTree(tree, expandedDirectories), [expandedDirectories, tree])
  const problems = useMemo(() => allFindings(checkerState), [checkerState])
  const counts = useMemo(() => countBySeverity(problems), [problems])
  const checkerFailures = useMemo(
    () =>
      checkerNames.flatMap((checker) => {
        for (const [, fileState] of checkerState[checker]) {
          if (fileState.status === "failed" && fileState.message !== undefined) {
            return [{ checker, message: fileState.message }]
          }
        }
        return []
      }),
    [checkerState],
  )
  const allProblemItems = useMemo(() => {
    const items: Array<
      | { kind: "failure"; id: string; checker: CheckerName; line: string; isFirst: boolean }
      | { kind: "problem"; id: string; problem: Diagnostic }
    > = []
    checkerFailures.forEach(({ checker, message }, fi) => {
      message
        .split("\n")
        .filter((l) => l.trim() !== "")
        .forEach((line, li) => {
          items.push({ kind: "failure", id: `failure-${fi}-${li}`, checker, line, isFirst: li === 0 })
        })
    })
    problems.forEach((problem, index) => {
      items.push({ kind: "problem", id: `problem-${index}`, problem })
    })
    return items
  }, [checkerFailures, problems])
  const recencyByPath = useMemo(() => lastChangedAt(activityLog), [activityLog])
  const changedPathSet = useMemo(() => new Set(model.changedByPath.keys()), [model.changedByPath])
  // hoisted out of paletteResults so a keystroke only pays for ranking
  const allPaths = useMemo(
    () => [...new Set([...model.repoFiles.map((file) => file.path), ...model.changedByPath.keys()])],
    [model.changedByPath, model.repoFiles],
  )
  const paletteResults = useMemo(() => {
    if (!paletteOpen) {
      return []
    }

    return rankFiles(paletteQuery, allPaths, { lastChangedAt: recencyByPath, changed: changedPathSet, limit: 50 })
  }, [allPaths, changedPathSet, paletteOpen, paletteQuery, recencyByPath])
  const lineMap = useMemo(
    () => (selectedPath === undefined ? new Map<number, Diagnostic[]>() : findingsLineMap(selectedPath, checkerState)),
    [checkerState, selectedPath],
  )

  const fileContent = useMemo<FileContent | undefined>(() => {
    if (!showFileContent || selectedPath === undefined) {
      return undefined
    }

    const gitSpec =
      selectedFile?.kind === "deleted" ? (scope.kind === "unstaged" ? `:${selectedPath}` : `${scope.ref}:${selectedPath}`) : undefined
    return loadFileContent(model.repoRoot, selectedPath, { full: fullContentPaths.has(selectedPath), gitSpec })
    // model identity changes whenever git state changes, keeping live content fresh
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showFileContent, selectedPath, selectedFile, scope, model, fullContentPaths])

  const selectedDiff = useMemo(() => {
    if (selectedPath === undefined) {
      return ""
    }

    if (showFileContent) {
      return fileContent?.kind === "text" ? contentToContextPatch(selectedPath, fileContent.content) : ""
    }

    return selectedFile === undefined ? "" : loadFileDiff(model.repoRoot, scope, selectedFile)
  }, [fileContent, model.repoRoot, scope, selectedFile, selectedPath, showFileContent])

  const renderedPatch = useMemo(
    () =>
      renderPatch(selectedDiff, {
        full: showFileContent || (selectedPath !== undefined && fullContentPaths.has(selectedPath)),
        maxLines: 1600,
      }),
    [fullContentPaths, selectedDiff, selectedPath, showFileContent],
  )
  // clamp navigation to the lines renderPatch actually emitted, not the full parse
  const navigableLines = useMemo(
    () => renderedPatch.parsed.hunks.flatMap((hunk) => hunk.lines).slice(0, renderedPatch.bodyLineCount),
    [renderedPatch],
  )
  const truncated = renderedPatch.truncated || (fileContent?.kind === "text" && fileContent.truncated)

  function runChecks() {
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    const generation = runGenerationRef.current + 1
    runGenerationRef.current = generation

    setCheckerState(initialCheckerState(model.changed))
    setChecksInFlight((count) => count + 1)
    const failures: string[] = []
    return runDiagnostics(
      model.repoRoot,
      model.changed,
      (checker, nextState) => {
        // a newer run owns the state; drop results arriving from a stale run
        if (generation !== runGenerationRef.current) {
          return
        }

        setCheckerState((current) => ({ ...current, [checker]: nextState }))
        for (const fileState of nextState.values()) {
          if (fileState.status === "failed") {
            // a failed run stamps every file with the same run-level message
            failures.push(`${checker} failed: ${fileState.message?.split("\n")[0] ?? ""}`)
            break
          }
        }
      },
      controller.signal,
    ).finally(() => {
      setChecksInFlight((count) => Math.max(0, count - 1))
      // the run reports its own completion: every trigger path (mount, the r
      // key, the quiet-period rerun) gets a status, and only the latest run speaks
      if (generation === runGenerationRef.current) {
        setStatus(failures[0] ?? "checks finished")
      }
    })
  }

  const runChecksRef = useRef(runChecks)
  runChecksRef.current = runChecks

  useEffect(() => {
    runChecksRef.current()
    return () => abortRef.current?.abort()
  }, [])

  const lastChangeRef = useRef<number>(Date.now())

  useEffect(() => {
    let cancelled = false
    let fastInFlight = false
    let slowInFlight = false

    const loadFast = async () => {
      if (fastInFlight) return
      fastInFlight = true
      try {
        const next = await loadChangedFiles(initialModel.repoRoot, scope)
        if (!cancelled) {
          setModel((previous) => mergeChanged(previous, next))
        }
      } catch {
        // transient git failures (e.g. an agent holding index.lock) resolve on the next poll
      } finally {
        fastInFlight = false
      }
    }

    const loadSlow = async () => {
      if (slowInFlight) return
      slowInFlight = true
      try {
        const next = await loadRepoFiles(initialModel.repoRoot)
        if (!cancelled) {
          setModel((previous) =>
            previous.repoFilesKey === next.repoFilesKey
              ? previous
              : { ...previous, repoFiles: next.repoFiles, repoFilesKey: next.repoFilesKey },
          )
        }
      } catch {
        // ignore transient errors
      } finally {
        slowInFlight = false
      }
    }

    void loadFast()
    void loadSlow()

    // Adaptive fast poll: 750ms when active, 2000ms after 10s of quiet.
    let fastId: ReturnType<typeof setTimeout>
    const scheduleFast = () => {
      const quiet = Date.now() - lastChangeRef.current > 10_000
      fastId = setTimeout(
        () => {
          void loadFast()
          scheduleFast()
        },
        quiet ? 2_000 : 750,
      )
    }
    scheduleFast()

    // Separate long interval just for the expensive tracked-files list.
    const slowId = setInterval(() => void loadSlow(), 5_000)

    return () => {
      cancelled = true
      clearTimeout(fastId)
      clearInterval(slowId)
    }
  }, [initialModel.repoRoot, scope])

  useEffect(() => {
    const previousByPath = new Map(previousChangedRef.current.map((file) => [file.path, file]))
    const previousScopeKey = previousScopeKeyRef.current
    previousChangedRef.current = model.changed
    previousScopeKeyRef.current = model.scopeKey

    // a scope switch swaps the changed set wholesale; that is not agent
    // activity, but the new set still needs checker state, so re-run checks
    if (previousScopeKey !== model.scopeKey) {
      runChecksRef.current()
      return
    }

    const entries: Array<{ path: string; kind: "changed" | "appeared" | "removed" }> = []

    for (const file of model.changed) {
      const before = previousByPath.get(file.path)
      if (before === undefined) {
        entries.push({ path: file.path, kind: "appeared" })
      } else if (before.additions !== file.additions || before.deletions !== file.deletions) {
        entries.push({ path: file.path, kind: "changed" })
      }
      previousByPath.delete(file.path)
    }

    for (const path of previousByPath.keys()) {
      entries.push({ path, kind: "removed" })
    }

    if (entries.length > 0) {
      lastChangeRef.current = Date.now()
      setCheckerState((current) =>
        markPending(
          current,
          model.changed,
          entries.map((entry) => entry.path),
        ),
      )
      setActivityLog((current) => recordActivity(current, entries, Date.now()))
    }
  }, [model.changed, model.scopeKey])

  useEffect(() => {
    if (activityLog.events.length === 0) {
      return
    }

    // checks re-run once the repo has been quiet for 2s
    const id = setTimeout(() => runChecksRef.current(), 2_000)
    return () => clearTimeout(id)
  }, [activityLog])

  useEffect(() => {
    const latest = latestActivity(activityLog)
    if (latest === undefined || now - latest.at >= RECENT_MS) {
      return
    }

    const id = setTimeout(() => setNow(Date.now()), 1_000)
    return () => clearTimeout(id)
  }, [activityLog, now])

  useEffect(() => {
    if (selectedPath === undefined) {
      return
    }

    const rowIndex = findRowIndexForPath(treeRows, selectedPath)
    if (rowIndex >= 0) {
      setFocusedRowIndex(rowIndex)
    }
  }, [selectedPath, treeRows])

  useEffect(() => {
    const focusedRow = treeRows[focusedRowIndex]
    if (focusedRow !== undefined) {
      sidebarRef.current?.scrollChildIntoView(focusedRow.node.id)
    }
  }, [focusedRowIndex, treeRows])

  useEffect(() => {
    if (problemsOpen) {
      problemsRef.current?.scrollChildIntoView(allProblemItems[problemIndex]?.id ?? "")
    }
  }, [allProblemItems, problemIndex, problemsOpen])

  useEffect(() => {
    if (paletteOpen) {
      paletteRef.current?.scrollChildIntoView(`palette-${paletteIndex}`)
    }
  }, [paletteIndex, paletteOpen])

  useEffect(() => {
    const firstChanged = navigableLines.findIndex((line) => line.type !== "context")
    setCursorIndex(firstChanged === -1 ? 0 : firstChanged)
    // reset to the first change only when the file changes, not on live edits of the same file
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedPath])

  useEffect(() => {
    if (jumpTarget === undefined || jumpTarget.path !== selectedPath) {
      return
    }

    const index = navigableLines.findIndex((line) => line.newLine === jumpTarget.line)
    if (index >= 0) {
      setCursorIndex(index)
      setJumpTarget(undefined)
      return
    }

    // the line may simply not be rendered yet; un-truncate the current view first
    if (truncated && !fullContentPaths.has(jumpTarget.path)) {
      setFullContentPaths((current) => new Set(current).add(jumpTarget.path))
      return
    }

    if (jumpTarget.escalate && selectedFile !== undefined && !fileView) {
      setFileView(true)
      return
    }

    // land on the nearest line instead of bouncing between views
    const nearest = nearestNavigableIndex(navigableLines, jumpTarget.line)
    if (nearest >= 0) {
      setCursorIndex(nearest)
    }
    setJumpTarget(undefined)
  }, [fileView, fullContentPaths, jumpTarget, navigableLines, selectedFile, selectedPath, truncated])

  const problemsHeight = problemsOpen ? PROBLEMS_HEIGHT : 0
  const paneHeight = Math.max(1, height - 4 - problemsHeight)
  // the viewer pane spends one extra row on its path header
  const viewerHeight = Math.max(1, paneHeight - 1)

  // the add/remove/diagnostic tints only change with the content, so a cursor
  // move just copies this map and overlays the cursor row
  const baseLineColors = useMemo(() => {
    const colors = new Map<number, LineColorConfig>()
    navigableLines.forEach((line, index) => {
      let gutter = TRANSPARENT
      let content = TRANSPARENT
      if (line.type === "add") {
        content = ADDED_BG
      } else if (line.type === "remove") {
        content = REMOVED_BG
      }

      const findings = line.newLine === undefined ? undefined : lineMap.get(line.newLine)
      if (findings !== undefined) {
        gutter = findings.some((finding) => finding.severity === "error") ? ERROR_GUTTER : WARNING_GUTTER
      }

      if (gutter !== TRANSPARENT || content !== TRANSPARENT) {
        colors.set(index, { gutter, content })
      }
    })
    return colors
  }, [lineMap, navigableLines])

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

    const paint = () => {
      const colors = new Map<number, string | RGBA | LineColorConfig>(baseLineColors)
      colors.set(cursorIndex, { gutter: CURSOR_BG, content: CURSOR_BG })
      diff.setLineColors(colors)
    }

    // the diff renderable repaints its own line colors when content settles;
    // painting again in a microtask keeps the cursor/diagnostic tints on top
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
  }, [baseLineColors, cursorIndex, navigableLines, viewerHeight, renderer])

  useKeyboard((key) => {
    if (paletteOpen) {
      if (key.name === "escape") {
        setPaletteOpen(false)
      } else if (key.name === "down" || (key.ctrl && key.name === "n")) {
        setPaletteIndex((current) => Math.min(current + 1, Math.max(0, paletteResults.length - 1)))
      } else if (key.name === "up" || (key.ctrl && key.name === "p")) {
        setPaletteIndex((current) => Math.max(current - 1, 0))
      }
      // every other key belongs to the palette input
      return
    }

    if (key.ctrl && key.name === "p") {
      setPaletteOpen(true)
      setPaletteQuery("")
      setPaletteIndex(0)
      return
    }

    if (key.name === "q") {
      quit()
      return
    }

    if (key.name === "escape") {
      if (problemsOpen) {
        setProblemsOpen(false)
        setFocusedPane((current) => (current === "problems" ? "tree" : current))
      } else {
        quit()
      }
      return
    }

    if (key.name === "tab") {
      setFocusedPane((current) => (current === "diff" ? "tree" : "diff"))
      return
    }

    if (key.name === "p") {
      setProblemsOpen((open) => {
        setFocusedPane(open ? "tree" : "problems")
        return !open
      })
      return
    }

    if (key.name === "s") {
      setScope((current) => {
        const next = { ...current, kind: nextScope(current.kind) }
        setStatus(`scope: ${scopeLabel(next)}`)
        return next
      })
      return
    }

    if (key.name === "c") {
      setChangesOnly((current) => {
        setStatus(current ? "showing all files" : "showing changes only")
        return !current
      })
      return
    }

    if (key.name === ".") {
      const latest = latestActivity(activityLog)
      if (latest !== undefined) {
        selectFile(latest.path)
      }
      return
    }

    if (key.name === "v" && selectedFile !== undefined && selectedPath !== undefined) {
      const line = navigableLines[cursorIndex]
      const lineNumber = line?.newLine ?? line?.oldLine
      if (lineNumber !== undefined) {
        setJumpTarget({ path: selectedPath, line: lineNumber, escalate: false })
      }
      setFileView((current) => !current)
      return
    }

    if (key.name === "n") {
      const paths = orderedFindingPaths(problems)
      const next = nextFindingPath(paths, selectedPath)
      if (next !== undefined) {
        selectFile(next)
      }
      return
    }

    if (key.name === "r") {
      void runChecks()
      return
    }

    if (key.name === "f" && selectedPath !== undefined) {
      setFullContentPaths((current) => new Set(current).add(selectedPath))
      setStatus(`loaded full content for ${selectedPath}`)
      return
    }

    if (key.name === "y" && selectedPath !== undefined) {
      try {
        const line = navigableLines[cursorIndex]
        const reference = line === undefined ? { path: selectedPath } : lineReference(selectedPath, line)
        copyToClipboard(formatCopyReference(reference))
        setStatus(`copied ${formatCopyReference(reference).split("\n")[0]}`)
      } catch (error) {
        setStatus(error instanceof Error ? error.message : String(error))
      }
      return
    }

    if (focusedPane === "problems") {
      if (key.name === "j" || key.name === "down") {
        setProblemIndex((current) => Math.min(current + 1, Math.max(0, allProblemItems.length - 1)))
      } else if (key.name === "k" || key.name === "up") {
        setProblemIndex((current) => Math.max(current - 1, 0))
      } else if (key.name === "return") {
        const item = allProblemItems[problemIndex]
        if (item?.kind === "problem") {
          const { problem } = item
          selectFile(problem.path)
          if (problem.line !== undefined) {
            setJumpTarget({ path: problem.path, line: problem.line, escalate: true })
          }
          setFocusedPane("diff")
        }
      }
      return
    }

    if (focusedPane === "diff") {
      const last = navigableLines.length - 1
      const halfPage = Math.max(1, Math.floor(viewerHeight / 2))

      if (key.name === "j" || key.name === "down") {
        setCursorIndex((current) => Math.max(0, Math.min(current + 1, last)))
      } else if (key.name === "k" || key.name === "up") {
        setCursorIndex((current) => Math.max(current - 1, 0))
      } else if (key.ctrl && key.name === "d") {
        setCursorIndex((current) => Math.max(0, Math.min(current + halfPage, last)))
      } else if (key.ctrl && key.name === "u") {
        setCursorIndex((current) => Math.max(current - halfPage, 0))
      } else if (key.name === "g" && !key.shift) {
        setCursorIndex(0)
      } else if (key.name === "g" || key.name === "G") {
        setCursorIndex(Math.max(0, last))
      } else if (key.name === "h" || key.name === "left") {
        setFocusedPane("tree")
      }

      return
    }

    if (key.name === "j" || key.name === "down") {
      moveFocus(1, treeRows, setFocusedRowIndex, selectFile)
      return
    }

    if (key.name === "k" || key.name === "up") {
      moveFocus(-1, treeRows, setFocusedRowIndex, selectFile)
      return
    }

    if (key.name === "l" || key.name === "right") {
      const row = treeRows[focusedRowIndex]
      if (row?.node.type === "directory") {
        setExpandedDirectories((current) => new Set(current).add(row.node.id))
      } else if (row?.node.type === "file") {
        selectFile(row.node.path)
      }
      return
    }

    if (key.name === "h" || key.name === "left") {
      const row = treeRows[focusedRowIndex]
      if (row?.node.type === "directory") {
        setExpandedDirectories((current) => {
          const next = new Set(current)
          next.delete(row.node.id)
          return next
        })
      }
      return
    }

    if (key.name === "return") {
      const row = treeRows[focusedRowIndex]
      if (row !== undefined) {
        const file = firstFileInNode(row.node)
        if (file !== undefined) {
          selectFile(file.path)
        }
      }
    }
  })

  function quit() {
    abortRef.current?.abort()
    renderer.destroy()
  }

  const selectFile = useCallback((path: string) => {
    setSelectedPath(path)
    setFileView(false)
    setExpandedDirectories((current) => expandAncestorsForPath(current, path))
  }, [])

  const handlePaletteInput = useCallback((value: string) => {
    setPaletteQuery(value)
    setPaletteIndex(0)
  }, [])

  const pickPaletteResult = useCallback(() => {
    const path = paletteResults[paletteIndex]
    if (path !== undefined) {
      selectFile(path)
      setFocusedPane("diff")
    }
    setPaletteOpen(false)
  }, [paletteResults, paletteIndex, selectFile])

  const sidebarWidth = Math.max(34, Math.min(54, Math.floor(width * 0.34)))
  const paletteWidth = Math.max(30, Math.min(70, width - 8))
  const paletteLeft = Math.max(0, Math.floor((width - paletteWidth) / 2))
  const cursorLine = navigableLines[cursorIndex]
  const cursorLineNumber = cursorLine?.newLine ?? cursorLine?.oldLine
  const cursorFindings = cursorLine?.newLine === undefined ? undefined : lineMap.get(cursorLine.newLine)
  const latest = latestActivity(activityLog)
  const activityText =
    latest === undefined || now - latest.at >= RECENT_MS ? "" : `${Math.max(0, Math.round((now - latest.at) / 1000))}s ago ${latest.path}`
  const displayStatus = checksInFlight > 0 ? "running checks…" : status
  const statusRight = truncate(
    cursorFindings?.[0] !== undefined
      ? `${cursorFindings[0].checker}: ${cursorFindings[0].message}`
      : [activityText, truncated === true ? `${displayStatus} · truncated; f for full` : displayStatus]
          .filter((part) => part !== "")
          .join(" · "),
    Math.max(20, width - 50),
  )
  const countsText = `${counts.errors > 0 ? `✖${counts.errors}` : ""}${counts.warnings > 0 ? ` ⚠${counts.warnings}` : ""}`.trim()

  return (
    <box width="100%" height="100%" flexDirection="column" backgroundColor="#09090b">
      <box height={1} flexDirection="row" justifyContent="space-between" paddingLeft={1} paddingRight={1} backgroundColor="#111113">
        <text fg="#ff4fb8">sideye</text>
        <text fg="#a1a1aa">
          {scopeLabel(scope)} · {model.changed.length} changed{countsText === "" ? "" : ` · ${countsText}`}
        </text>
      </box>
      <box flexGrow={1} flexDirection="row">
        <box
          width={sidebarWidth}
          height="100%"
          flexDirection="column"
          borderStyle="single"
          borderColor={focusedPane === "tree" ? "#ff4fb8" : "#27272a"}
        >
          <scrollbox ref={sidebarRef} width="100%" height={paneHeight} scrollY viewportCulling>
            {treeRows.map((row) => (
              <TreeRow
                key={row.node.id}
                row={row}
                focused={row.index === focusedRowIndex}
                selectedPath={selectedPath}
                expandedDirectories={expandedDirectories}
                checkerState={checkerState}
                recencyByPath={recencyByPath}
                now={now}
              />
            ))}
          </scrollbox>
        </box>
        <box
          flexGrow={1}
          height="100%"
          flexDirection="column"
          borderStyle="single"
          borderColor={focusedPane === "diff" ? "#ff4fb8" : "#27272a"}
        >
          <box height={1} flexDirection="row" justifyContent="space-between" paddingLeft={1} paddingRight={1}>
            <text fg="#e4e4e7">{viewerTitle(selectedPath, selectedFile, showFileContent, fileContent)}</text>
            <text fg="#71717a">
              {showFileContent ? "file" : "diff"}
              {cursorLineNumber === undefined ? "" : ` · ln ${cursorLineNumber}`}
            </text>
          </box>
          {showFileContent && fileContent !== undefined && fileContent.kind !== "text" ? (
            <box height={viewerHeight} paddingLeft={1}>
              <text fg="#71717a">{placeholderText(fileContent)}</text>
            </box>
          ) : (
            <diff
              id={DIFF_ID}
              ref={diffRef}
              key={`${selectedPath ?? "empty"}:${showFileContent}:${selectedPath !== undefined && fullContentPaths.has(selectedPath)}`}
              width="100%"
              height={viewerHeight}
              diff={renderedPatch.diff}
              view="unified"
              filetype={selectedPath === undefined ? "text" : diffFiletypeFor(selectedPath, syntax)}
              syntaxStyle={syntax.enabled ? syntax.style : undefined}
              treeSitterClient={syntax.enabled ? syntax.treeSitterClient : undefined}
              showLineNumbers
              wrapMode="none"
              addedBg={ADDED_BG_HEX}
              removedBg={REMOVED_BG_HEX}
              addedLineNumberBg="#0d2117"
              removedLineNumberBg="#260f18"
              addedSignColor="#3ddc84"
              removedSignColor="#ff5c8a"
              lineNumberFg="#52525b"
            />
          )}
        </box>
      </box>
      {problemsOpen ? (
        <box
          height={PROBLEMS_HEIGHT}
          width="100%"
          flexDirection="column"
          borderStyle="single"
          borderColor={focusedPane === "problems" ? "#ff4fb8" : "#27272a"}
        >
          <scrollbox ref={problemsRef} width="100%" height={PROBLEMS_HEIGHT - 2} scrollY viewportCulling>
            {allProblemItems.length === 0 ? (
              <box id="problem-empty" paddingLeft={1}>
                <text fg="#71717a">no problems</text>
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
                      backgroundColor={index === problemIndex && focusedPane === "problems" ? CURSOR_BG_HEX : "#09090b"}
                    >
                      <text fg="#ff5c8a">{item.isFirst ? "✖ " : "  "}</text>
                      <text fg="#a1a1aa">{item.line}</text>
                      {item.isFirst && <text fg="#71717a">{`  [${item.checker}]`}</text>}
                    </box>
                  ) : (
                    <box
                      key={item.id}
                      id={item.id}
                      width="100%"
                      flexDirection="row"
                      paddingLeft={1}
                      paddingRight={1}
                      backgroundColor={index === problemIndex && focusedPane === "problems" ? CURSOR_BG_HEX : "#09090b"}
                    >
                      <text fg={item.problem.severity === "error" ? "#ff5c8a" : "#fbbf24"}>
                        {item.problem.severity === "error" ? "✖ " : "⚠ "}
                      </text>
                      <text fg="#d4d4d8">{`${item.problem.path}${item.problem.line === undefined ? "" : `:${item.problem.line}`} `}</text>
                      <text fg="#a1a1aa">{item.problem.message}</text>
                      <text fg="#71717a">{`  [${item.problem.checker}]`}</text>
                    </box>
                  ),
                )}
              </>
            )}
          </scrollbox>
        </box>
      ) : null}
      <box height={1} flexDirection="row" justifyContent="space-between" paddingLeft={1} paddingRight={1} backgroundColor="#111113">
        <text fg="#71717a">{keyHints(focusedPane)}</text>
        <text fg="#a1a1aa">{statusRight}</text>
      </box>
      {paletteOpen ? (
        <box
          position="absolute"
          left={paletteLeft}
          top={1}
          width={paletteWidth}
          flexDirection="column"
          borderStyle="single"
          borderColor="#ff4fb8"
          backgroundColor="#111113"
          zIndex={100}
        >
          <input
            focused
            width="100%"
            placeholder="go to file…"
            backgroundColor="#111113"
            focusedBackgroundColor="#111113"
            textColor="#e4e4e7"
            cursorColor="#ff4fb8"
            onInput={handlePaletteInput}
            onSubmit={pickPaletteResult}
          />
          <scrollbox ref={paletteRef} width="100%" height={Math.min(12, Math.max(1, paletteResults.length))} scrollY viewportCulling>
            {paletteResults.length === 0 ? (
              <box id="palette-empty" paddingLeft={1}>
                <text fg="#71717a">no matches</text>
              </box>
            ) : (
              paletteResults.map((path, index) => {
                const changed = model.changedByPath.get(path)
                const recency = recencyLevel(recencyByPath.get(path), now)
                // key and id both by index: reordering results must never
                // change a live renderable's id or the scrollbox loses rows
                // oxlint-disable react/no-array-index-key -- intentional: stable id-by-index required by scrollbox
                return (
                  <box
                    key={`palette-${index}`}
                    id={`palette-${index}`}
                    width="100%"
                    flexDirection="row"
                    justifyContent="space-between"
                    paddingLeft={1}
                    paddingRight={1}
                    backgroundColor={index === paletteIndex ? CURSOR_BG_HEX : "#111113"}
                  >
                    <box flexDirection="row">
                      <text fg={index === paletteIndex ? "#ffffff" : changed === undefined ? "#a1a1aa" : kindColor(changed.kind)}>
                        {path}
                      </text>
                      <RecencyDot level={recency} />
                    </box>
                    {changed === undefined ? null : <text fg={stageColor(changed.stage)}>{kindLetter(changed.kind)}</text>}
                  </box>
                )
                // oxlint-enable react/no-array-index-key
              })
            )}
          </scrollbox>
        </box>
      ) : null}
    </box>
  )
}

type TreeRowProps = {
  row: FileTreeRow
  focused: boolean
  selectedPath: string | undefined
  expandedDirectories: Set<string>
  checkerState: CheckerState
  recencyByPath: Map<string, number>
  now: number
}

// memoized so cursor moves and status updates do not re-render every row
const TreeRow = memo(function TreeRow({ row, focused, selectedPath, expandedDirectories, checkerState, recencyByPath, now }: TreeRowProps) {
  const node = row.node
  const indent = " ".repeat(Math.max(0, row.depth) * 2)
  const background = focused ? CURSOR_BG_HEX : "#09090b"

  if (node.type === "directory") {
    const isExpanded = expandedDirectories.has(node.id)
    const chevron = isExpanded ? "▾" : "▸"
    const recency = directoryRecency(node, expandedDirectories, recencyByPath, now)
    const summary = isExpanded ? null : directorySummary(node.path, checkerState)
    const nameFg = focused ? "#ffffff" : node.changedCount > 0 ? "#e4e4e7" : "#d4d4d8"
    return (
      <box
        id={node.id}
        width="100%"
        flexDirection="row"
        justifyContent="space-between"
        paddingLeft={1}
        paddingRight={1}
        backgroundColor={background}
      >
        <box flexDirection="row">
          <text fg={nameFg}>{`${indent}${chevron} ${node.name}/`}</text>
          <RecencyDot level={recency} />
        </box>
        <box flexDirection="row">
          {summary?.failed ? <text fg="#ff5c8a">fail </text> : null}
          {summary !== null && summary.errors > 0 ? <text fg="#ff5c8a">{`✖${summary.errors} `}</text> : null}
          {summary !== null && summary.errors === 0 && summary.warnings > 0 ? <text fg="#fbbf24">{`⚠${summary.warnings} `}</text> : null}
          {summary?.pending ? <text fg="#71717a">… </text> : null}
          {summary !== null &&
          node.changedCount > 0 &&
          !summary.failed &&
          !summary.pending &&
          summary.errors === 0 &&
          summary.warnings === 0 ? (
            <text fg="#3ddc84">✓ </text>
          ) : null}
          {node.changedCount > 0 ? (
            <text fg={node.stage !== undefined ? stageColor(node.stage) : "#71717a"}>{`+${node.additions} -${node.deletions}`}</text>
          ) : null}
        </box>
      </box>
    )
  }

  const changed = node.changed
  const recency = recencyLevel(recencyByPath.get(node.path), now)
  const summary = checkerSummary(node.path, checkerState)
  const selected = selectedPath === node.path
  const nameFg = focused || selected ? "#ffffff" : changed === undefined ? "#a1a1aa" : kindColor(changed.kind)
  const pending = changed !== undefined && summary.pending

  return (
    <box
      id={node.id}
      width="100%"
      flexDirection="row"
      justifyContent="space-between"
      paddingLeft={1}
      paddingRight={1}
      backgroundColor={background}
    >
      <box flexDirection="row">
        <text fg={nameFg}>{`${indent}${node.name}`}</text>
        <RecencyDot level={recency} />
      </box>
      <box flexDirection="row">
        {summary.failed ? <text fg="#ff5c8a">fail </text> : null}
        {summary.errors > 0 ? <text fg="#ff5c8a">{`✖${summary.errors} `}</text> : null}
        {summary.errors === 0 && summary.warnings > 0 ? <text fg="#fbbf24">{`⚠${summary.warnings} `}</text> : null}
        {changed !== undefined && changed.warnings.length > 0 ? <text fg="#fbbf24">! </text> : null}
        {changed === undefined ? null : <text fg="#71717a">{`+${changed.additions} -${changed.deletions} `}</text>}
        {pending ? <text fg="#71717a">… </text> : null}
        {changed === undefined ? null : <text fg={stageColor(changed.stage)}>{kindLetter(changed.kind)}</text>}
      </box>
    </box>
  )
})

function RecencyDot({ level }: { level: RecencyLevel }) {
  if (level === "none") {
    return null
  }

  return <text fg={level === "fresh" ? "#ff4fb8" : "#8a3a6e"}> ●</text>
}

function directoryRecency(
  node: DirectoryNode,
  expandedDirectories: Set<string>,
  recencyByPath: Map<string, number>,
  now: number,
): RecencyLevel {
  if (expandedDirectories.has(node.id)) {
    return "none"
  }

  const prefix = `${node.path}/`
  let level: RecencyLevel = "none"
  for (const [path, at] of recencyByPath) {
    if (!path.startsWith(prefix)) {
      continue
    }

    const pathLevel = recencyLevel(at, now)
    if (pathLevel === "fresh") {
      return "fresh"
    }

    if (pathLevel === "recent") {
      level = "recent"
    }
  }

  return level
}

function viewerTitle(
  selectedPath: string | undefined,
  selectedFile: ChangedFile | undefined,
  showFileContent: boolean,
  fileContent: FileContent | undefined,
) {
  if (selectedPath === undefined) {
    return ""
  }

  if (showFileContent) {
    const lines = fileContent?.kind === "text" ? ` · ${fileContent.lineCount} lines${fileContent.truncated ? " (truncated)" : ""}` : ""
    return `${selectedPath}${lines}`
  }

  const rename = selectedFile?.oldPath === undefined ? "" : ` (from ${selectedFile.oldPath})`
  const warnings = selectedFile === undefined || selectedFile.warnings.length === 0 ? "" : ` !${selectedFile.warnings.join(",")}`
  return `${selectedPath}${rename}  +${selectedFile?.additions ?? 0} -${selectedFile?.deletions ?? 0}${warnings}`
}

function truncate(text: string, max: number) {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`
}

function placeholderText(content: FileContent) {
  if (content.kind === "binary") {
    return "binary file"
  }

  if (content.kind === "too-large") {
    return `file too large (${Math.round(content.bytes / 1024)}kb) · f to load`
  }

  return "file not found"
}

function keyHints(pane: "tree" | "diff" | "problems") {
  if (pane === "problems") {
    return "j/k problem · enter jump · p close · q quit"
  }

  if (pane === "diff") {
    return "j/k · v file/diff · y copy · ctrl-p goto · p problems · q quit"
  }

  return "j/k · h/l fold · ctrl-p goto · s scope · c changes · p problems · q quit"
}

function stageColor(stage: StageState) {
  if (stage === "staged") {
    return "#3ddc84"
  }

  if (stage === "unstaged") {
    return "#fbbf24"
  }

  if (stage === "mixed") {
    return "#fb923c"
  }

  return "#a1a1aa"
}

function kindColor(kind: ChangedFile["kind"]) {
  if (kind === "untracked" || kind === "added") {
    return "#3ddc84"
  }

  if (kind === "deleted") {
    return "#ff5c8a"
  }

  if (kind === "renamed") {
    return "#c084fc"
  }

  return "#fbbf24"
}

function kindLetter(kind: ChangedFile["kind"]) {
  if (kind === "untracked") {
    return "U"
  }

  if (kind === "added") {
    return "A"
  }

  if (kind === "deleted") {
    return "D"
  }

  if (kind === "renamed") {
    return "R"
  }

  return "M"
}

function nearestNavigableIndex(lines: ParsedDiffLine[], target: number) {
  let best = -1
  let bestDistance = Number.POSITIVE_INFINITY
  lines.forEach((line, index) => {
    const reference = line.newLine ?? line.oldLine
    if (reference === undefined) {
      return
    }

    const distance = Math.abs(reference - target)
    if (distance < bestDistance) {
      bestDistance = distance
      best = index
    }
  })

  return best
}

function orderedFindingPaths(problems: Diagnostic[]) {
  return [...new Set(problems.map((problem) => problem.path))]
}

function nextFindingPath(paths: string[], selectedPath: string | undefined) {
  if (paths.length === 0) {
    return undefined
  }

  const current = selectedPath === undefined ? -1 : paths.indexOf(selectedPath)
  return paths[(current + 1) % paths.length]
}

function moveFocus(
  direction: -1 | 1,
  rows: FileTreeRow[],
  setFocusedRowIndex: (updater: (current: number) => number) => void,
  selectFile: (path: string) => void,
) {
  setFocusedRowIndex((current) => {
    const next = Math.max(0, Math.min(current + direction, rows.length - 1))
    const row = rows[next]
    if (row?.node.type === "file") {
      selectFile(row.node.path)
    }
    return next
  })
}

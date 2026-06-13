import { existsSync } from "node:fs"
import packageJson from "../package.json"
import { RegistryContext, useAtomInitialValues, useAtomMount, useAtomSet, useAtomValue } from "@effect/atom-react"
import type { ScrollBoxRenderable } from "@opentui/core"
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react"
import { useCallback, useContext, useEffect, useRef } from "react"
import { emptyActivityLog, latestActivity, recordActivity, RECENT_MS } from "./activity"
import { activityLogAtom, nowAtom, recencyByPathAtom } from "./atoms/activity"
import { copyAtom } from "./atoms/clipboard"
import {
  allProblemItemsAtom,
  checkerStateAtom,
  countsAtom,
  lineMapAtom,
  quietRerunAtom,
  runChecksAtom,
  statusAtom,
} from "./atoms/diagnostics"
import { gitModelAtom, gitPollAtom, lastChangeAtom, repoRootAtom } from "./atoms/git"
import { paletteResultsAtom } from "./atoms/palette"
import { focusedRowIndexAtom, treeRowsAtom } from "./atoms/tree"
import { loadModelAtom, loadWorktreesAtom } from "./atoms/worktree"
import {
  fileContentAtom,
  navigableLinesAtom,
  renderedPatchAtom,
  selectedFileAtom,
  showFileContentAtom,
  truncatedAtom,
} from "./atoms/viewer"
import {
  expandedDirectoriesAtom,
  fileViewAtom,
  focusedNodeIdAtom,
  focusedPaneAtom,
  fullContentPathsAtom,
  helpOpenAtom,
  paletteIndexAtom,
  paletteOpenAtom,
  paletteQueryAtom,
  problemIndexAtom,
  problemsOpenAtom,
  scopeAtom,
  selectedPathAtom,
  sidebarOpenAtom,
  worktreeIndexAtom,
  worktreeOpenAtom,
  worktreesAtom,
} from "./atoms/ui"
import type { DiffScope } from "./cli"
import { HeaderBar } from "./components/HeaderBar"
import { HelpOverlay } from "./components/HelpOverlay"
import { Palette } from "./components/Palette"
import { ProblemsPanel } from "./components/ProblemsPanel"
import { Sidebar } from "./components/Sidebar"
import { StatusBar } from "./components/StatusBar"
import { Viewer } from "./components/Viewer"
import { WorktreePicker } from "./components/WorktreePicker"
import { PROBLEMS_HEIGHT } from "./constants"
import { initialCheckerState, markPending } from "./diagnostics"
import type { ChangedFile, GitModel, Worktree } from "./git"
import { useDiffCursor } from "./hooks/useDiffCursor"
import { createKeyHandler } from "./keymap"
import type { SyntaxConfig } from "./syntax"
import { useTheme } from "./theme/context"
import { defaultExpandedDirectories, expandAncestorsForPath } from "./tree"
import { truncate, worktreeLabel } from "./ui-helpers"

interface AppProps {
  model: GitModel
  scope: DiffScope
  syntax: SyntaxConfig
}

export function App({ model: initialModel, scope: initialScope, syntax }: AppProps) {
  const renderer = useRenderer()
  const theme = useTheme()
  const registry = useContext(RegistryContext)
  const { width, height } = useTerminalDimensions()

  const initialSelectedPath = initialModel.changed[0]?.path ?? initialModel.repoFiles[0]?.path
  const baseExpanded = defaultExpandedDirectories(initialModel.changed.map((file) => file.path))
  const initialExpanded = initialSelectedPath === undefined ? baseExpanded : expandAncestorsForPath(baseExpanded, initialSelectedPath)
  useAtomInitialValues([
    [gitModelAtom, initialModel],
    [repoRootAtom, initialModel.repoRoot],
    [lastChangeAtom, Date.now()],
    [scopeAtom, initialScope],
    [selectedPathAtom, initialSelectedPath],
    [focusedNodeIdAtom, initialSelectedPath === undefined ? "" : `file:${initialSelectedPath}`],
    [expandedDirectoriesAtom, initialExpanded],
    [checkerStateAtom, initialCheckerState(initialModel.changed)],
    [statusAtom, syntax.status],
  ])

  const scope = useAtomValue(scopeAtom)
  const setGitModel = useAtomSet(gitModelAtom)
  const model = useAtomValue(gitModelAtom)
  const previousChangedRef = useRef<ChangedFile[]>(initialModel.changed)
  const previousScopeKeyRef = useRef(initialModel.scopeKey)
  const setLastChange = useAtomSet(lastChangeAtom)
  const setRepoRoot = useAtomSet(repoRootAtom)
  useAtomMount(gitPollAtom)
  useAtomMount(quietRerunAtom)
  const selectedPath = useAtomValue(selectedPathAtom)
  const setSelectedPath = useAtomSet(selectedPathAtom)
  const focusedRowIndex = useAtomValue(focusedRowIndexAtom)
  const setFocusedNodeId = useAtomSet(focusedNodeIdAtom)
  const expandedDirectories = useAtomValue(expandedDirectoriesAtom)
  const setExpandedDirectories = useAtomSet(expandedDirectoriesAtom)
  const fullContentPaths = useAtomValue(fullContentPathsAtom)
  const setFullContentPaths = useAtomSet(fullContentPathsAtom)
  const fileView = useAtomValue(fileViewAtom)
  const setFileView = useAtomSet(fileViewAtom)
  const focusedPane = useAtomValue(focusedPaneAtom)
  const setFocusedPane = useAtomSet(focusedPaneAtom)
  const problemsOpen = useAtomValue(problemsOpenAtom)
  const sidebarOpen = useAtomValue(sidebarOpenAtom)
  const problemIndex = useAtomValue(problemIndexAtom)
  const setProblemIndex = useAtomSet(problemIndexAtom)
  const paletteOpen = useAtomValue(paletteOpenAtom)
  const setPaletteOpen = useAtomSet(paletteOpenAtom)
  const setPaletteQuery = useAtomSet(paletteQueryAtom)
  const paletteIndex = useAtomValue(paletteIndexAtom)
  const setPaletteIndex = useAtomSet(paletteIndexAtom)
  const worktreeOpen = useAtomValue(worktreeOpenAtom)
  const setWorktreeOpen = useAtomSet(worktreeOpenAtom)
  const worktreeIndex = useAtomValue(worktreeIndexAtom)
  const worktrees = useAtomValue(worktreesAtom)
  const helpOpen = useAtomValue(helpOpenAtom)
  const activityLog = useAtomValue(activityLogAtom)
  const setActivityLog = useAtomSet(activityLogAtom)
  const now = useAtomValue(nowAtom)
  const recencyByPath = useAtomValue(recencyByPathAtom)
  const checkerState = useAtomValue(checkerStateAtom)
  const setCheckerState = useAtomSet(checkerStateAtom)
  const status = useAtomValue(statusAtom)
  const setStatus = useAtomSet(statusAtom)
  const runChecks = useAtomSet(runChecksAtom)
  const checksRunning = useAtomValue(runChecksAtom).waiting
  const counts = useAtomValue(countsAtom)
  const allProblemItems = useAtomValue(allProblemItemsAtom)
  const sidebarRef = useRef<ScrollBoxRenderable>(null)
  const problemsRef = useRef<ScrollBoxRenderable>(null)
  const paletteRef = useRef<ScrollBoxRenderable>(null)
  const worktreeRef = useRef<ScrollBoxRenderable>(null)
  const loadModel = useAtomSet(loadModelAtom, { mode: "promise" })
  // The keymap dispatches these fn atoms through the registry, which only runs
  // Their effect while the atom is mounted; mount them here so a keypress fires
  // (the same reason runChecksAtom runs: App reads it).
  useAtomMount(loadWorktreesAtom)
  useAtomMount(copyAtom)

  const selectedFile = useAtomValue(selectedFileAtom)
  const showFileContent = useAtomValue(showFileContentAtom)
  const treeRows = useAtomValue(treeRowsAtom)
  const paletteResults = useAtomValue(paletteResultsAtom)
  const lineMap = useAtomValue(lineMapAtom)
  const fileContent = useAtomValue(fileContentAtom)
  const renderedPatch = useAtomValue(renderedPatchAtom)
  const navigableLines = useAtomValue(navigableLinesAtom)
  const truncated = useAtomValue(truncatedAtom)

  useEffect(() => {
    const previousByPath = new Map(previousChangedRef.current.map((file) => [file.path, file]))
    const previousScopeKey = previousScopeKeyRef.current
    previousChangedRef.current = model.changed
    previousScopeKeyRef.current = model.scopeKey

    // A scope switch swaps the changed set wholesale; that is not agent
    // Activity, but the new set still needs checker state, so re-run checks
    if (previousScopeKey !== model.scopeKey) {
      runChecks(model)
      return
    }

    const entries: { path: string; kind: "changed" | "appeared" | "removed" }[] = []

    for (const file of model.changed) {
      const before = previousByPath.get(file.path)
      if (before === undefined) {
        entries.push({ kind: "appeared", path: file.path })
      } else if (before.additions !== file.additions || before.deletions !== file.deletions) {
        entries.push({ kind: "changed", path: file.path })
      }
      previousByPath.delete(file.path)
    }

    for (const path of previousByPath.keys()) {
      entries.push({ kind: "removed", path })
    }

    if (entries.length > 0) {
      setLastChange(Date.now())
      setCheckerState((current) =>
        markPending(
          current,
          model.changed,
          entries.map((entry) => entry.path),
        ),
      )
      setActivityLog((current) => recordActivity(current, entries, Date.now()))
    }
  }, [model, setLastChange, previousChangedRef, previousScopeKeyRef, runChecks, setActivityLog, setCheckerState])

  useEffect(() => {
    runChecks(model)
    // Mount-only: a fresh run for the initial model; later runs come from scope
    // Switches, the quiet-period timer, and the r key. The fiber is interrupted
    // When the atom is disposed on unmount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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
    if (worktreeOpen) {
      worktreeRef.current?.scrollChildIntoView(`worktree-${worktreeIndex}`)
    }
  }, [worktreeIndex, worktreeOpen])

  const problemsHeight = problemsOpen ? PROBLEMS_HEIGHT : 0
  const paneHeight = Math.max(1, height - 4 - problemsHeight)
  // The viewer pane spends one extra row on its path header
  const viewerHeight = Math.max(1, paneHeight - 1)

  const { cursorIndex, diffRef, setJumpTarget } = useDiffCursor({
    fileView,
    fullContentPaths,
    lineMap,
    navigableLines,
    selectedFile,
    selectedPath,
    setFileView,
    setFullContentPaths,
    truncated,
    viewerHeight,
  })

  const selectFile = useCallback(
    (path: string) => {
      setSelectedPath(path)
      setFocusedNodeId(`file:${path}`)
      setFileView(false)
      setExpandedDirectories((current) => expandAncestorsForPath(current, path))
    },
    [setSelectedPath, setFocusedNodeId, setFileView, setExpandedDirectories],
  )

  useKeyboard(createKeyHandler(registry, { quit, selectFile, switchWorktree, viewerHeight }))

  function quit() {
    renderer.destroy()
  }

  async function switchWorktree(worktree: Worktree) {
    setWorktreeOpen(false)
    if (worktree.path === model.repoRoot) {
      return
    }

    if (!existsSync(worktree.path)) {
      setStatus(`worktree missing: ${worktree.path}`)
      return
    }

    try {
      const fresh = await loadModel({ repoRoot: worktree.path, scope })
      // Prime the activity refs so the swap is not mistaken for agent edits;
      // ScopeKey matches across worktrees, so that effect will not re-run checks
      previousChangedRef.current = fresh.changed
      previousScopeKeyRef.current = fresh.scopeKey
      setLastChange(Date.now())
      setRepoRoot(fresh.repoRoot)
      setGitModel(fresh)
      const selected = fresh.changed[0]?.path ?? fresh.repoFiles[0]?.path
      setSelectedPath(selected)
      setFocusedNodeId(selected === undefined ? "" : `file:${selected}`)
      setExpandedDirectories(() => {
        const expanded = defaultExpandedDirectories(fresh.changed.map((file) => file.path))
        return selected === undefined ? expanded : expandAncestorsForPath(expanded, selected)
      })
      setFullContentPaths(new Set())
      setFileView(false)
      setJumpTarget(undefined)
      setProblemIndex(0)
      setActivityLog(emptyActivityLog)
      setFocusedPane("tree")
      setStatus(`worktree: ${worktreeLabel(worktree)}`)
      runChecks(fresh)
    } catch (error) {
      setStatus(error instanceof Error ? (error.message.split("\n")[0] ?? "") : String(error))
    }
  }

  const handlePaletteInput = useCallback(
    (value: string) => {
      setPaletteQuery(value)
      setPaletteIndex(0)
    },
    [setPaletteQuery, setPaletteIndex],
  )

  const pickPaletteResult = useCallback(() => {
    const path = paletteResults[paletteIndex]
    if (path !== undefined) {
      selectFile(path)
      setFocusedPane("diff")
    }
    setPaletteOpen(false)
  }, [paletteResults, paletteIndex, selectFile, setFocusedPane, setPaletteOpen])

  const sidebarWidth = sidebarOpen ? Math.max(34, Math.min(54, Math.floor(width * 0.34))) : 0
  const paletteWidth = Math.max(30, Math.min(70, width - 8))
  const paletteLeft = Math.max(0, Math.floor((width - paletteWidth) / 2))
  const cursorLine = navigableLines[cursorIndex]
  const cursorLineNumber = cursorLine?.newLine ?? cursorLine?.oldLine
  const cursorFindings = cursorLine?.newLine === undefined ? undefined : lineMap.get(cursorLine.newLine)
  const latest = latestActivity(activityLog)
  const activityText =
    latest === undefined || now - latest.at >= RECENT_MS ? "" : `${Math.max(0, Math.round((now - latest.at) / 1000))}s ago ${latest.path}`
  const displayStatus = checksRunning ? "running checks…" : status
  const hints = "? keys · q quit"
  // The hints are navigation; the status is transient and yields on narrow terminals
  const statusRight = truncate(
    cursorFindings?.[0] !== undefined
      ? `${cursorFindings[0].checker}: ${cursorFindings[0].message}`
      : [activityText, truncated === true ? `${displayStatus} · truncated; f for full` : displayStatus]
          .filter((part) => part !== "")
          .join(" · "),
    Math.max(10, Math.min(width - 50, width - hints.length - 4)),
  )
  const countsText = `${counts.errors > 0 ? `✖${counts.errors}` : ""}${counts.warnings > 0 ? ` ⚠${counts.warnings}` : ""}`.trim()

  return (
    <box width="100%" height="100%" flexDirection="column" backgroundColor={theme.colors.surface.base}>
      <HeaderBar
        version={packageJson.version}
        repoRoot={model.repoRoot}
        scope={scope}
        changedCount={model.changed.length}
        countsText={countsText}
      />
      <box flexGrow={1} flexDirection="row">
        {sidebarOpen && (
          <Sidebar
            sidebarRef={sidebarRef}
            sidebarWidth={sidebarWidth}
            paneHeight={paneHeight}
            focused={focusedPane === "tree"}
            treeRows={treeRows}
            focusedRowIndex={focusedRowIndex}
            selectedPath={selectedPath}
            expandedDirectories={expandedDirectories}
            checkerState={checkerState}
            recencyByPath={recencyByPath}
            now={now}
          />
        )}
        <Viewer
          diffRef={diffRef}
          focused={focusedPane === "diff"}
          viewerHeight={viewerHeight}
          selectedPath={selectedPath}
          selectedFile={selectedFile}
          showFileContent={showFileContent}
          fileContent={fileContent}
          cursorLineNumber={cursorLineNumber}
          diff={renderedPatch.diff}
          fullContent={selectedPath !== undefined && fullContentPaths.has(selectedPath)}
          syntax={syntax}
        />
      </box>
      {problemsOpen ? (
        <ProblemsPanel
          problemsRef={problemsRef}
          allProblemItems={allProblemItems}
          problemIndex={problemIndex}
          focused={focusedPane === "problems"}
        />
      ) : null}
      <StatusBar hints={hints} statusRight={statusRight} />
      {paletteOpen ? (
        <Palette
          paletteRef={paletteRef}
          paletteLeft={paletteLeft}
          paletteWidth={paletteWidth}
          paletteResults={paletteResults}
          paletteIndex={paletteIndex}
          changedByPath={model.changedByPath}
          recencyByPath={recencyByPath}
          now={now}
          onInput={handlePaletteInput}
          onSubmit={pickPaletteResult}
        />
      ) : null}
      {worktreeOpen ? (
        <WorktreePicker
          worktreeRef={worktreeRef}
          paletteLeft={paletteLeft}
          paletteWidth={paletteWidth}
          worktrees={worktrees}
          worktreeIndex={worktreeIndex}
          repoRoot={model.repoRoot}
        />
      ) : null}
      {helpOpen ? <HelpOverlay paletteLeft={paletteLeft} paletteWidth={paletteWidth} height={height} /> : null}
    </box>
  )
}

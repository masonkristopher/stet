import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";

import { Effect, Queue, Stream } from "effect";
import {
  batch,
  createEffect,
  createMemo,
  createRoot,
  createSignal,
  on,
  onCleanup,
  untrack,
} from "solid-js";

import type { DiffScope, ScopeKind } from "./cli";
import { Clipboard } from "./clipboard/service";
import { PROBLEMS_HEIGHT, SIDEBAR_MIN_WIDTH, SIDEBAR_VIEWER_MIN } from "./constants";
import {
  allFindings,
  countBySeverity,
  directorySummaries,
  findingsLineMap,
  initialCheckerState,
  markPending,
} from "./diagnostics/checker";
import type { CheckerState, Diagnostic } from "./diagnostics/checker";
import { buildProblemItems, isNavigableProblemItem } from "./diagnostics/problems";
import { Provisioner } from "./diagnostics/provision";
import { Diagnostics } from "./diagnostics/service";
import { DiffEngine, highlightSnippet, structureDiff } from "./diff/engine";
import type { DiffRender, RenderInput } from "./diff/engine";
import { followScrollTop } from "./diff/follow";
import type { RenderSpan } from "./diff/hast";
import { firstWord, lastWord, nextWord, prevWord, wordAt } from "./diff/words";
import { contentToContextPatch } from "./file/content";
import type { FileContent } from "./file/content";
import { File } from "./file/service";
import {
  directoryRecency,
  emptyActivityLog,
  lastChangedAt,
  latestActivity,
  RECENT_MS,
  recordActivity,
} from "./git/activity";
import type { ActivityEventKind, ActivityLog } from "./git/activity";
import { changedPathsDiffer, EMPTY_TREE_SHA, mergeChanged } from "./git/model";
import type { ChangedFile, GitModel, Worktree } from "./git/model";
import { filterPathspecs } from "./git/search";
import type { SearchMatch } from "./git/search";
import { Git } from "./git/service";
import {
  buildTreeStructure,
  decorateTree,
  defaultExpandedDirectories,
  expandAncestorsForPath,
  flattenTree,
} from "./git/tree";
import type { HoverSegment, NormalizedLocation } from "./intel/protocol";
import { attachReferencePreviews, byReferenceOrder } from "./intel/references";
import type { ReferenceResult } from "./intel/references";
import { Intel } from "./intel/service";
import { levelGlyph } from "./log/levels";
import type { LogLevel } from "./log/levels";
import { runtime } from "./runtime";
import { activeThemeName, selection, setSelection } from "./theme/active";
import { themeNames } from "./theme/registry";
import type { ThemeSelection } from "./theme/registry";
import { worktreeLabel } from "./ui-helpers";
import { fetchLatestVersion, isNewer } from "./upgrade/release";
import { findMatches as findMatchIndices } from "./utils/find";
import { rankFiles } from "./utils/fuzzy";
import { refreshDelay } from "./utils/refresh-cadence";
import { collapseHome, truncate, truncateLeft } from "./utils/text";
import {
  back,
  canBack,
  canForward,
  closeTab,
  currentLocation,
  forward,
  initialNav,
  navigate,
  nextTab,
  openTab,
  pinTab,
  prevTab,
  recall,
  recordCurrent,
  remember,
  selectTab,
  unpinTab,
} from "./viewer/navigation";
import type { Location, NavState } from "./viewer/navigation";
import { buildSearchItems, isNavigableSearchItem } from "./viewer/search-items";
import { Watcher } from "./watcher/service";

interface JumpTarget {
  path: string;
  line: number;
  // 1-based column to land the caret on (snapped to the word that owns it);
  // Undefined keeps the caret at the target line's first word.
  column?: number;
  escalate: boolean;
}

// A caret-anchored viewer overlay (the hover card, later peek/gutters), distinct
// From the centered command-palette overlays. Content-agnostic on purpose so a
// Second consumer reuses the same seam; the caret cell it renders at is derived
// Live in DiffView, not stored here.
// One rendered line of a decoration: a syntax-highlighted code line (colored
// Spans) or a plain prose line. The card renders code as styled spans and prose
// As muted text, the way an editor's hover shows a highlighted signature above
// Plain docs.
type DecorationLine = { kind: "code"; spans: RenderSpan[] } | { kind: "prose"; text: string };

interface ViewerDecoration {
  status: "loading" | "ready" | "empty" | "error";
  lines: DecorationLine[];
}

// A hover segment becomes rendered lines: prose maps one line each; a code block
// Is syntax-highlighted in its language (uncolored when the language is absent).
async function segmentToLines(
  segment: HoverSegment,
  highlight: (code: string, lang: string) => Promise<RenderSpan[][]>,
): Promise<DecorationLine[]> {
  if (segment.kind === "prose") {
    return segment.lines.map((text) => ({ kind: "prose", text }));
  }
  if (segment.lang === undefined) {
    return segment.lines.map((line) => ({ kind: "code", spans: [{ text: line }] }));
  }
  const highlighted = await highlight(segment.lines.join("\n"), segment.lang);
  return highlighted.map((spans) => ({ kind: "code", spans }));
}

// A single muted line (loading / empty / error), the simplest decoration content.
function noticeLines(text: string): DecorationLine[] {
  return [{ kind: "prose", text }];
}

// The caret/scroll/file the decoration opened against; any drift closes it, so the
// Card never lingers over content it no longer describes. `repoRoot` and `scope`
// Catch the cases the caret signals miss: a worktree or scope switch can keep the
// Same selected path, cursor, and scroll yet show an entirely different diff.
interface DecorationAnchor {
  index: number;
  column: number;
  scrollTop: number;
  scrollX: number;
  path: string | undefined;
  repoRoot: string;
  scope: string;
  // The active theme the card's colors were highlighted against; a theme switch
  // Leaves caret/scroll/path/scope untouched yet restyles the diff, so a stale
  // Card must close rather than keep the old palette.
  theme: string;
}

// A one-shot request to place the cursor and scroll once the diff for `path`
// Has loaded: every navigation enqueues one (a fresh open carries
// `cursorLine: undefined` -> first change; back/forward and revisits carry the
// Remembered line). The Viewer applies it under the same async-coherence guard as
// A jump, so "reset on file switch" is just restore-to-default through one path.
interface PendingRestore {
  path: string;
  cursorLine: number | undefined;
  // The caret's UTF-16 offset to restore; undefined → the cursor line's first word.
  cursorColumn: number | undefined;
  viewport: { scrollTop: number; scrollX: number };
}

// The coherent diff-pane snapshot. A selection commits in two structure-identical
// Phases: first plain rows (parse only, instant), then a rows upgrade once the
// Async highlight resolves. The signal holds the previous snapshot until phase 1
// Resolves, so the renderer never receives empty/stale/partial content; the
// Phase-2 swap keeps the same row count and gutter width, so it never thrashes.
interface DiffView {
  path: string;
  showFileContent: boolean;
  fileContent: FileContent | undefined;
  render: DiffRender;
  highlighted: boolean;
}

interface DiffBase {
  diff: string;
  fileContent: FileContent | undefined;
  showFileContent: boolean;
}

const DIFF_MAX_LINES = 1600;

// Bounds the search result list so a broad query in a large repo can't flood the
// Pane; hitting the cap sets `searchTruncated`, surfaced as a trailing "+".
const SEARCH_RESULT_CAP = 500;

// Lines of surrounding context shown on each side of a search match.
const SEARCH_CONTEXT_LINES = 2;

const emptyModel: GitModel = {
  changed: [],
  changedByPath: new Map(),
  repoFiles: [],
  repoFilesKey: "",
  repoRoot: "",
  scopeKey: "",
};

interface LoadedDiff {
  view: DiffView;
  highlight: RenderInput;
}

function loadDiffView(src: {
  path: string;
  scope: DiffScope;
  showFile: boolean;
  full: boolean;
  file: ChangedFile | undefined;
  model: GitModel;
}): Effect.Effect<LoadedDiff, never, File | Git> {
  // Phase 1: after the git/file I/O, build the plain row structure synchronously
  // And commit it. The patch + render options travel out as `highlight` so the
  // Caller can run the async highlight pass and swap in colored rows.
  const toView = (base: Effect.Effect<DiffBase, never, File | Git>) =>
    base.pipe(
      Effect.map((result): LoadedDiff => {
        const highlight: RenderInput = {
          full: result.showFileContent || src.full,
          maxLines: DIFF_MAX_LINES,
          patch: result.diff,
        };
        return {
          highlight,
          view: {
            fileContent: result.fileContent,
            highlighted: false,
            path: src.path,
            render: structureDiff(highlight),
            showFileContent: result.showFileContent,
          },
        };
      }),
    );

  if (src.showFile) {
    const gitSpec =
      src.file?.kind === "deleted"
        ? src.scope.kind === "unstaged"
          ? `:${src.path}`
          : `${src.scope.ref}:${src.path}`
        : undefined;
    return toView(
      File.use((file) =>
        file.content(src.model.repoRoot, src.path, { full: src.full, gitSpec }),
      ).pipe(
        Effect.map(
          (content): DiffBase => ({
            diff: content.kind === "text" ? contentToContextPatch(src.path, content.content) : "",
            fileContent: content,
            showFileContent: true,
          }),
        ),
      ),
    );
  }

  const file = src.file;
  if (file === undefined) {
    return toView(
      Effect.succeed<DiffBase>({ diff: "", fileContent: undefined, showFileContent: false }),
    );
  }

  return toView(
    Git.use((git) => git.fileDiff(src.model.repoRoot, src.scope, file)).pipe(
      Effect.map((diff): DiffBase => ({ diff, fileContent: undefined, showFileContent: false })),
      Effect.catch(() =>
        Effect.succeed<DiffBase>({ diff: "", fileContent: undefined, showFileContent: false }),
      ),
    ),
  );
}

// Case-insensitive subsequence test (cmdk-style): every query char appears in
// Order in the target. An empty query matches everything.
function isSubsequence(query: string, target: string) {
  let i = 0;
  for (const char of target) {
    if (char === query[i]) {
      i += 1;
    }
  }
  return i === query.length;
}

function createState() {
  // --- writable primitives ---
  const [scope, setScope] = createSignal<DiffScope>({ kind: "all", ref: "HEAD" });
  // The CLI ref (default HEAD), the base for the all/staged scopes.
  const [cliBaseRef, setCliBaseRef] = createSignal("HEAD");
  // The SHA HEAD pointed at when sideye launched, pinned for the session scope.
  const [sessionBase, setSessionBase] = createSignal("HEAD");
  const [scopeMenuOpen, setScopeMenuOpen] = createSignal(false);
  const [scopeMenuIndex, setScopeMenuIndex] = createSignal(0);
  const [iconsEnabled, setIconsEnabled] = createSignal(true);
  const [overflow, setOverflow] = createSignal<"scroll" | "wrap">("scroll");
  const [changesOnly, setChangesOnly] = createSignal(false);
  const [selectedPath, setSelectedPath] = createSignal<string | undefined>(undefined);
  const [expandedDirectories, setExpandedDirectories] = createSignal(new Set<string>());
  const [fileView, setFileView] = createSignal(false);
  const [fullContentPaths, setFullContentPaths] = createSignal(new Set<string>());
  const [focusedNodeId, setFocusedNodeId] = createSignal("");
  const [focusedPane, setFocusedPane] = createSignal<"tree" | "diff" | "problems" | "search">(
    "tree",
  );
  const [sidebarOpen, setSidebarOpen] = createSignal(true);
  const [sidebarWidthOverride, setSidebarWidthOverride] = createSignal<number | null>(null);
  const [sidebarScrollTop, setSidebarScrollTop] = createSignal(0);
  const [problemsOpen, setProblemsOpen] = createSignal(false);
  const [problemIndex, setProblemIndex] = createSignal(0);
  const [problemsScrollTop, setProblemsScrollTop] = createSignal(0);
  const [fileComboboxOpen, setFileComboboxOpen] = createSignal(false);
  const [fileComboboxQuery, setFileComboboxQuery] = createSignal("");
  const [fileComboboxIndex, setFileComboboxIndex] = createSignal(0);
  // Which view occupies the main area. A union (not per-view booleans) so exactly
  // One view is ever active; future panes extend it.
  const [mainView, setMainView] = createSignal<"file" | "search">("file");
  const [searchQuery, setSearchQuery] = createSignal("");
  const [searchGlob, setSearchGlob] = createSignal("");
  const [searchRegex, setSearchRegex] = createSignal(false);
  const [searchCaseSensitive, setSearchCaseSensitive] = createSignal(false);
  const [searchScope, setSearchScope] = createSignal<"changed" | "repo">("changed");
  const [searchFocus, setSearchFocus] = createSignal<"query" | "glob" | "results">("query");
  const [searchIndex, setSearchIndex] = createSignal(0);
  const [searchScrollTop, setSearchScrollTop] = createSignal(0);
  const [searchCollapsed, setSearchCollapsed] = createSignal(new Set<string>());
  const [searchResults, setSearchResults] = createSignal<SearchMatch[]>([]);
  const [searchFileLines, setSearchFileLines] = createSignal(new Map<string, string[]>());
  const [searchTruncated, setSearchTruncated] = createSignal(false);
  const [searchStatus, setSearchStatus] = createSignal<"idle" | "searching" | "ready" | "error">(
    "idle",
  );
  const [referencesOpen, setReferencesOpen] = createSignal(false);
  const [referencesStatus, setReferencesStatus] = createSignal<
    "loading" | "ready" | "empty" | "error"
  >("loading");
  const [referencesResults, setReferencesResults] = createSignal<ReferenceResult[]>([]);
  const [referencesIndex, setReferencesIndex] = createSignal(0);
  const [referencesLabel, setReferencesLabel] = createSignal<"references" | "definitions">(
    "references",
  );
  const [findOpen, setFindOpen] = createSignal(false);
  const [findActive, setFindActive] = createSignal(false);
  const [findQuery, setFindQuery] = createSignal("");
  const [findMatchPos, setFindMatchPos] = createSignal(0);
  const [worktreeComboboxOpen, setWorktreeComboboxOpen] = createSignal(false);
  const [worktreeComboboxIndex, setWorktreeComboboxIndex] = createSignal(0);
  const [worktreeComboboxQuery, setWorktreeComboboxQuery] = createSignal("");
  const [worktrees, setWorktrees] = createSignal<Worktree[] | undefined>(undefined);
  const [helpDialogOpen, setHelpDialogOpen] = createSignal(false);
  const [themeComboboxOpen, setThemeComboboxOpen] = createSignal(false);
  const [themeComboboxIndex, setThemeComboboxIndex] = createSignal(0);
  const [themeComboboxQuery, setThemeComboboxQuery] = createSignal("");
  // The selection active when the picker opened, restored if the user cancels.
  const [themeComboboxOrigin, setThemeComboboxOrigin] = createSignal<ThemeSelection>(undefined);
  const [gitModel, setGitModel] = createSignal<GitModel>(emptyModel);
  const [repoRoot, setRepoRoot] = createSignal("");
  // The repository's main worktree, resolved once at startup (repository-wide
  // Constant). It outlives a deleted linked worktree, so it is the recovery
  // Target; if it too is gone, the repository is gone and there is no survivor.
  const [mainWorktreePath, setMainWorktreePath] = createSignal("");
  // Flips when the heartbeat finds the worktree deleted (its root or the main
  // Worktree gone); App reacts by switching to the main worktree or exiting.
  const [currentWorktreeDeleted, setCurrentWorktreeDeleted] = createSignal(false);
  // Two timestamps that drive the adaptive safety-poll cadence: when git state
  // Last changed, and when the fs watcher last ticked (0 = never, i.e. unproven).
  const [lastChange, setLastChange] = createSignal(0);
  const [lastWatcherTick, setLastWatcherTick] = createSignal(0);
  const [cursorIndex, setCursorIndex] = createSignal(0);
  // The in-line caret: a UTF-16 offset (a word start) on the cursor line. Motion
  // Hops word to word; a precise offset is still stored so a diagnostic jump lands
  // On its exact column and copy-reference can emit `:line:col`. Normalized to the
  // Line's first word whenever the cursor line or content changes (the Viewer
  // Effect), unless a restore/jump placed it on a valid word.
  const [cursorColumn, setCursorColumn] = createSignal(0);
  // True when the caret selects a whole line, not a symbol on it (a click on the
  // Gutter): no word is highlighted and `y` copies `path:line`, not `path:line:col`.
  // Transient — any vertical move, word hop, jump, or content click re-selects a
  // Symbol, so it is never captured into navigation history.
  const [caretLineLevel, setCaretLineLevel] = createSignal(false);
  // The viewer's scroll offsets, lifted out of DiffView so a navigation can
  // Capture and restore them; the renderer mirrors `viewerScrollTop` onto the
  // Scrollbox every frame (it stays the single source of truth for the window).
  const [viewerScrollTop, setViewerScrollTop] = createSignal(0);
  const [viewerScrollX, setViewerScrollX] = createSignal(0);
  // The active caret-anchored decoration and the anchor it opened against. The
  // Content is the rendering source; the anchor is an orthogonal watcher that
  // Closes the card on any caret/scroll/file drift (see the clear effect below).
  const [viewerDecoration, setViewerDecorationContent] = createSignal<ViewerDecoration | undefined>(
    undefined,
  );
  const [decorationAnchor, setDecorationAnchor] = createSignal<DecorationAnchor | undefined>(
    undefined,
  );
  // The viewer's navigation history: tabs of visited Locations plus a per-path
  // MRU viewport. `selectedPath`/`fileView`/the scroll signals stay the live
  // Source of truth the viewer renders; navState records them on leave and
  // Restores them on back/forward or a revisit (capture-on-leave, like a browser).
  const [navState, setNavState] = createSignal<NavState>(initialNav(undefined));
  const [pendingRestore, setPendingRestore] = createSignal<PendingRestore | undefined>(undefined);
  // Monotonic tab id source (the seed tab is "0"); never reset, so ids stay unique
  // Across a seedNav that re-collapses to one tab.
  let nextTabId = 1;
  const [jumpTarget, setJumpTarget] = createSignal<JumpTarget | undefined>(undefined);
  const [checkerState, setCheckerState] = createSignal<CheckerState>(initialCheckerState([]));
  const [status, setStatus] = createSignal("");
  const [statusLevel, setStatusLevel] = createSignal<LogLevel>("info");
  // A live in-flight indicator for a code-intel pull (F12), distinct from the
  // Auto-clearing `notice` acknowledgment: it is set on the keystroke and cleared
  // When the pull settles, so the status bar shows the action is underway.
  const [intelStatus, setIntelStatus] = createSignal<string | undefined>(undefined);
  const report = (text: string, level: LogLevel = "info") => {
    setStatus(text);
    setStatusLevel(level);
  };
  // An ephemeral acknowledgment of a user action (copied, scope changed, …),
  // Held for a fixed dwell so it outlives the keystroke that triggered it.
  const [notice, setNotice] = createSignal<{ text: string; level: LogLevel } | undefined>(
    undefined,
  );
  // Set by the background release check; read once on quit to print the post-exit notice.
  const [availableUpdate, setAvailableUpdate] = createSignal<
    { current: string; latest: string } | undefined
  >(undefined);
  const [activityLog, setActivityLog] = createSignal<ActivityLog>(emptyActivityLog);
  const [checksRunning, setChecksRunning] = createSignal(false);
  const [now, setNow] = createSignal(Date.now());
  const [terminalWidth, setTerminalWidth] = createSignal(80);
  const [terminalHeight, setTerminalHeight] = createSignal(24);
  const [editorTemplate, setEditorTemplate] = createSignal<string>("vim +{line} {file}");
  const [ideTemplate, setIdeTemplate] = createSignal<string | undefined>(undefined);

  // --- synchronous derived ---
  const selectedFile = createMemo(() => {
    const path = selectedPath();
    return path === undefined ? undefined : gitModel().changedByPath.get(path);
  });
  const showFileContent = createMemo(
    () => selectedPath() !== undefined && (selectedFile() === undefined || fileView()),
  );
  // Split the tree build so the repo-size-proportional structure pass is skipped
  // On a content-only edit. `repoFiles` is reference-stable across changed-set
  // Updates (mergeChanged preserves it, repoFilesCache dedupes), and `changedPaths`
  // Changes only when a path appears/disappears, so `treeStructure` rebuilds only
  // On a real structural shift; `tree` overlays the live changed set (counts,
  // Badges, aggregates) cheaply over that cached structure on every model update.
  const repoFiles = createMemo(() => gitModel().repoFiles);
  const changedPaths = createMemo(() => new Set(gitModel().changedByPath.keys()), undefined, {
    equals: (previous, next) => previous.size === next.size && previous.isSubsetOf(next),
  });
  // Paths absent from repoFiles but present in changedPaths: staged deletions only. Narrower
  // Than changedPaths so the O(repoFiles) structure walk is skipped on content-only edits.
  const repoFilePaths = createMemo(() => new Set(repoFiles().map((f) => f.path)));
  const stagedDeletionPaths = createMemo(
    () => {
      // Until repoFiles loads (deferred poll, empty key) every changed path looks
      // "Absent from repoFiles", which would render the whole changed set as the
      // Default tree and then re-render the full tree, a visible jump. A deletion is
      // Only knowable once repoFiles exists, so report none until then.
      if (gitModel().repoFilesKey === "") {
        return new Set<string>();
      }
      const filePaths = repoFilePaths();
      return new Set([...changedPaths()].filter((p) => !filePaths.has(p)));
    },
    undefined,
    { equals: (previous, next) => previous.size === next.size && previous.isSubsetOf(next) },
  );
  const treeStructure = createMemo(() =>
    buildTreeStructure(repoFiles(), changesOnly() ? changedPaths() : stagedDeletionPaths(), {
      changesOnly: changesOnly(),
    }),
  );
  const tree = createMemo(() => decorateTree(treeStructure(), gitModel().changedByPath));
  const treeRows = createMemo(() => flattenTree(tree(), expandedDirectories()));
  // Index the flat row list by node id so cursor moves are O(1) rather than O(rows).
  const treeRowsById = createMemo(() => new Map(treeRows().map((row) => [row.node.id, row.index])));
  const focusedRowIndex = createMemo(() => treeRowsById().get(focusedNodeId()) ?? 0);

  // A windowed uniform-row list (the sidebar, the problems panel) renders only
  // The rows inside [scrollTop, +viewport), so its renderable count is bounded
  // By the viewport, not the content. This registers the shared glue: a follow
  // Effect keeping the cursor framed (editor-style scrolloff) that tracks only
  // The cursor, viewport, and gate, while rows and the current offset are read
  // Untracked so a background refresh tick never snaps a wheel-scrolled window
  // Back to the cursor; and a clamp effect bounding the window when the row
  // List shrinks under it. The search pane deliberately does not use this: its
  // Follow is action-driven (setSearchSelection), so a results update never
  // Re-frames a wheel-scrolled window.
  function followListWindow(options: {
    cursor: () => number;
    viewport: () => number;
    rowCount: () => number;
    scrollTop: () => number;
    setScrollTop: (next: number) => void;
    active?: () => boolean;
  }) {
    createEffect(() => {
      if (options.active !== undefined && !options.active()) {
        return;
      }
      const top = options.cursor();
      const viewport = options.viewport();
      const current = untrack(options.scrollTop);
      const next = followScrollTop({
        current,
        height: 1,
        margin: 2,
        maxScroll: Math.max(0, untrack(options.rowCount) - viewport),
        top,
        viewport,
      });
      if (next !== current) {
        options.setScrollTop(next);
      }
    });
    createEffect(() => {
      const maxScroll = Math.max(0, options.rowCount() - options.viewport());
      if (untrack(options.scrollTop) > maxScroll) {
        options.setScrollTop(maxScroll);
      }
    });
  }

  followListWindow({
    cursor: focusedRowIndex,
    rowCount: () => treeRows().length,
    scrollTop: sidebarScrollTop,
    setScrollTop: setSidebarScrollTop,
    // A thunk, not the memo itself: paneHeight is declared later in this root,
    // And the effects only run after the whole root body has executed.
    viewport: () => paneHeight(),
  });

  // The default tree is the whole repo, so it stays empty until the deferred
  // RepoFiles poll fills it. parseRepoFiles always folds repoRoot into the key, so
  // A loaded 0-file repo has a non-empty key: an empty key means "not loaded yet"
  // (including the pre-startup empty model), and the sidebar reserves blank space
  // For that window instead of flashing the empty state.
  const repoFilesLoading = createMemo(() => gitModel().repoFilesKey === "");
  const recencyByPath = createMemo(() => lastChangedAt(activityLog()));
  // Per-directory aggregates, one pass each, so collapsed directory rows do O(1)
  // Lookups instead of scanning every entry per row per render.
  const directoryRecencyByPath = createMemo(() => directoryRecency(recencyByPath()));
  const directorySummariesByPath = createMemo(() => directorySummaries(checkerState()));
  const problems = createMemo(() => allFindings(checkerState()));
  const counts = createMemo(() => countBySeverity(problems()));
  const lineMap = createMemo(() => {
    const path = selectedPath();
    return path === undefined
      ? new Map<number, Diagnostic[]>()
      : findingsLineMap(path, checkerState());
  });
  // Reuse the `problems` memo's sorted findings so one checker update pays the
  // AllFindings sort once, not once here and once inside buildProblemItems.
  const allProblemItems = createMemo(() => buildProblemItems(checkerState(), problems()));
  // The first row the problems cursor can land on; headers and help sub-lines are
  // Skipped so opening the panel never parks the cursor on a non-navigable row.
  const firstNavigableProblemIndex = createMemo(() => {
    const index = allProblemItems().findIndex(isNavigableProblemItem);
    return index === -1 ? 0 : index;
  });

  // The `active` gate is tracked, so opening the panel frames the cursor at once.
  followListWindow({
    active: problemsOpen,
    cursor: problemIndex,
    rowCount: () => allProblemItems().length,
    scrollTop: problemsScrollTop,
    setScrollTop: setProblemsScrollTop,
    viewport: () => PROBLEMS_HEIGHT - 2,
  });
  // The go-to-file universe: repoFiles plus changed-only paths (staged
  // Deletions), the same universe the tree renders. Every dependency is
  // Identity-gated (`repoFiles` is reference-stable across content edits,
  // `changedPaths` set-equality-gated), so a content-only refresh tick never
  // Rebuilds this array while the picker is open.
  const fileComboboxPaths = createMemo(() => {
    const filePaths = repoFilePaths();
    return [
      ...repoFiles().map((file) => file.path),
      ...[...changedPaths()].filter((path) => !filePaths.has(path)),
    ];
  });
  // The rank context is snapshotted when the picker opens, so a background
  // Refresh never re-ranks (and never reorders) the list under the cursor while
  // It is open; the universe above stays live, so a file created mid-open still
  // Appears. Per-row decorations (recency dot, changed tint) keep reading live
  // State.
  const [fileComboboxRankContext, setFileComboboxRankContext] = createSignal({
    changed: new Set<string>(),
    lastChangedAt: new Map<string, number>(),
  });
  function openFileCombobox() {
    batch(() => {
      setFileComboboxRankContext({
        changed: untrack(changedPaths),
        lastChangedAt: untrack(recencyByPath),
      });
      setFileComboboxQuery("");
      setFileComboboxIndex(0);
      setFileComboboxOpen(true);
    });
  }
  const fileComboboxResults = createMemo(() => {
    if (!fileComboboxOpen()) {
      return [];
    }
    return rankFiles(fileComboboxQuery(), fileComboboxPaths(), {
      ...fileComboboxRankContext(),
      limit: 50,
    });
  });
  // A thunk, not a memo: `themeNames()` reads the registry, which user themes are
  // Registered into at startup *after* this root is created, so it must be read
  // Lazily (when the picker opens), never captured once. `auto` maps to the
  // Undefined selection (follow the terminal).
  const themeComboboxItems = (): { name: string; selection: ThemeSelection }[] => [
    { name: "auto", selection: undefined },
    ...themeNames().map((name) => ({ name, selection: name })),
  ];
  // A thunk, not a memo: a memo computes eagerly at root-creation time (module
  // Import), before startup registers user themes, and would never recompute
  // Since the registry is not reactive. Reading per call keeps it current while
  // Still tracking `themeComboboxQuery` for the reactive scopes that read it.
  const themeComboboxResults = () => {
    const query = themeComboboxQuery().toLowerCase();
    return themeComboboxItems().filter((item) => isSubsequence(query, item.name.toLowerCase()));
  };
  // `undefined` while the worktree list is still loading (so the picker keeps its
  // Loading state); otherwise the subsequence-filtered list, matching the branch
  // Label and path so a query can narrow by either.
  const worktreeComboboxResults = createMemo(() => {
    const list = worktrees();
    if (list === undefined) {
      return undefined;
    }
    const query = worktreeComboboxQuery().toLowerCase();
    if (query === "") {
      return list;
    }
    return list.filter((worktree) =>
      isSubsequence(
        query,
        `${worktreeLabel(worktree)} ${collapseHome(worktree.path)}`.toLowerCase(),
      ),
    );
  });

  // --- coherent diff-pane snapshot (the freeze fix) ---
  const diffSource = createMemo(() => {
    const path = selectedPath();
    if (path === undefined) {
      return undefined;
    }
    return {
      file: selectedFile(),
      full: fullContentPaths().has(path),
      model: gitModel(),
      path,
      scope: scope(),
      showFile: showFileContent(),
    };
  });
  const [diffView, setDiffView] = createSignal<DiffView | undefined>(undefined);
  createEffect(() => {
    // Re-run on a theme change too (a runtime appearance flip), so the diff
    // Re-renders with the new palette; the engine keys its cache by the theme.
    activeThemeName();
    const src = diffSource();
    if (src === undefined) {
      setDiffView(undefined);
      return;
    }
    const controller = new AbortController();
    const { signal } = controller;
    runtime
      .runPromise(loadDiffView(src), { signal })
      .then(({ highlight, view }) => {
        // The controller can abort after the load resolved but before this
        // Microtask drains; committing then would paint a stale snapshot over the
        // Fresh one. Mirror the phase-2 guard so only the live selection lands.
        if (signal.aborted) {
          return;
        }
        setDiffView(view);
        // Phase 2: highlight off the critical path, then swap in colored rows
        // (structure-identical) only if this exact phase-1 snapshot is still
        // Showing. Reference identity (not path equality) is required so a stale
        // Highlight never lands on a newer same-path snapshot (scope/full toggle,
        // Live edit); the abort guard drops it when the selection changed.
        runtime
          .runPromise(
            DiffEngine.use((engine) => engine.render(highlight)),
            { signal },
          )
          .then((render) => {
            if (signal.aborted) {
              return;
            }
            setDiffView((current) =>
              current === view
                ? {
                    ...current,
                    highlighted: true,
                    render: { ...current.render, rows: render.rows },
                  }
                : current,
            );
          })
          .catch(() => {});
      })
      .catch(() => {});
    onCleanup(() => controller.abort());
  });

  // Read each matched file once (bounded, never `full`) so results can show
  // Context lines and feed the highlighter; a binary or oversized file yields no
  // Lines and its matches degrade to grep-text-only rows.
  function readSearchLines(root: string, matches: readonly SearchMatch[], signal: AbortSignal) {
    // TextContent already stripped the single trailing newline, so a plain split
    // Is line-exact: no phantom empty last line, and a genuine final blank line
    // (a file ending in two newlines) is kept, since git grep can match on it.
    const contentLines = (content: FileContent) =>
      content.kind === "text" ? content.content.split(/\r?\n/) : undefined;
    const paths = [...new Set(matches.map((match) => match.path))];
    return runtime.runPromise(
      File.use((file) =>
        Effect.all(
          paths.map((path) =>
            file
              .content(root, path, { full: false })
              .pipe(Effect.map((content) => [path, contentLines(content)] as const)),
          ),
          // Bounded: a capped result set can still touch hundreds of files, and
          // Unbounded async reads would open that many descriptors at once.
          { concurrency: 16 },
        ),
      ).pipe(
        Effect.map(
          (entries) =>
            new Map(
              entries.flatMap(([path, lines]) =>
                lines === undefined ? [] : [[path, lines] as const],
              ),
            ),
        ),
      ),
      { signal },
    );
  }

  // Project content search: debounced git grep over the changed set (honoring the
  // Active scope, since `changed` already reflects it), the whole repo, or the
  // Glob pathspecs. The snapshot (results + file lines + truncation) commits as
  // One batch and holds until the next query resolves; cleanup aborts the prior
  // Grep and cancels a not-yet-fired keystroke, the same restart-on-rekey pattern
  // As the diff pipeline. Leaving the search view returns early *without*
  // Clearing, so toggling back restores the results with no flash.
  const SEARCH_DEBOUNCE_MS = 120;
  createEffect(() => {
    if (mainView() !== "search") {
      return;
    }
    const query = searchQuery();
    const root = repoRoot();
    const options = { caseSensitive: searchCaseSensitive(), regex: searchRegex() };
    const globTokens = filterPathspecs(searchGlob());
    // Track the git model itself (not the set-equal `changedPaths` memo, and in
    // Every scope): a content-only edit to an already-changed file keeps the
    // Path-set identical but moves matches and line numbers, so the grep must
    // Re-run on each model commit or results, context, and jump targets go
    // Stale against the working tree, the agent-edits-while-you-watch core
    // Scenario.
    const model = gitModel();
    const changedScopePaths =
      searchScope() === "changed" ? model.changed.map((file) => file.path) : undefined;
    if (query === "" || root === "") {
      batch(() => {
        setSearchResults([]);
        setSearchFileLines(new Map());
        setSearchTruncated(false);
        setSearchStatus("idle");
      });
      return;
    }
    if (
      changedScopePaths !== undefined &&
      changedScopePaths.length === 0 &&
      globTokens === undefined
    ) {
      batch(() => {
        setSearchResults([]);
        setSearchFileLines(new Map());
        setSearchTruncated(false);
        setSearchStatus("ready");
      });
      return;
    }
    // A glob narrows via pathspecs; under the changed scope the glob drives the
    // Grep and the changed set filters after (pathspecs union, never intersect).
    const paths = globTokens ?? changedScopePaths;
    const changedSet =
      globTokens !== undefined && changedScopePaths !== undefined
        ? new Set(changedScopePaths)
        : undefined;
    setSearchStatus("searching");
    const controller = new AbortController();
    const timer = setTimeout(() => {
      runtime
        .runPromise(
          Git.use((git) => git.search(root, query, paths, options)),
          {
            signal: controller.signal,
          },
        )
        .then(async (all) => {
          const inScope =
            changedSet === undefined ? all : all.filter((match) => changedSet.has(match.path));
          const matches = inScope.slice(0, SEARCH_RESULT_CAP);
          const linesByPath = await readSearchLines(root, matches, controller.signal);
          // Drop a superseded query's results: a search can resolve just as a newer
          // Keystroke aborts its controller, so guard the write the same way.
          if (controller.signal.aborted) {
            return;
          }
          batch(() => {
            setSearchResults(matches);
            setSearchFileLines(linesByPath);
            setSearchTruncated(inScope.length > SEARCH_RESULT_CAP);
            setSearchStatus("ready");
          });
        })
        // A genuine grep failure (a half-typed regex) keeps the prior results in
        // Place under an error status, so an unfinished pattern never blanks the
        // Pane; our own cancellation (the aborted controller) changes nothing.
        .catch(() => {
          if (!controller.signal.aborted) {
            setSearchStatus("error");
          }
        });
    }, SEARCH_DEBOUNCE_MS);
    onCleanup(() => {
      clearTimeout(timer);
      controller.abort();
    });
  });

  const searchItems = createMemo(() =>
    buildSearchItems({
      collapsed: searchCollapsed(),
      context: SEARCH_CONTEXT_LINES,
      linesByPath: searchFileLines(),
      matches: searchResults(),
    }),
  );

  // Move the selection and keep it in the results viewport, mirroring the diff
  // Cursor's follow-scroll (margin rows of context, never glued to the edge).
  function setSearchSelection(index: number) {
    batch(() => {
      setSearchIndex(index);
      setSearchScrollTop(
        followScrollTop({
          current: searchScrollTop(),
          height: 1,
          margin: 2,
          maxScroll: Math.max(0, searchItems().length - searchListHeight()),
          top: index,
          viewport: searchListHeight(),
        }),
      );
    });
  }

  // Hop the selection to the next/previous navigable row (matches and file
  // Headers), skipping context lines and gaps.
  function moveSearchSelection(direction: number) {
    const items = searchItems();
    const current = searchIndex();
    const next =
      direction > 0
        ? items.findIndex((item, index) => index > current && isNavigableSearchItem(item))
        : items.findLastIndex((item, index) => index < current && isNavigableSearchItem(item));
    if (next !== -1) {
      setSearchSelection(next);
    }
  }

  // Half-page the selection by *visual* rows (the viewport unit ctrl-d/ctrl-u
  // Promise), then snap to the nearest navigable row in the travel direction;
  // Counting navigable hops instead would overshoot by each match's context
  // Rows and headers.
  function pageSearchSelection(direction: number) {
    const items = searchItems();
    const step = Math.max(1, Math.floor(searchListHeight() / 2)) * direction;
    const target = Math.max(0, Math.min(searchIndex() + step, items.length - 1));
    const snapped =
      direction > 0
        ? items.findIndex((item, index) => index >= target && isNavigableSearchItem(item))
        : items.findLastIndex((item, index) => index <= target && isNavigableSearchItem(item));
    const landed =
      snapped !== -1
        ? snapped
        : direction > 0
          ? items.findLastIndex(isNavigableSearchItem)
          : items.findIndex(isNavigableSearchItem);
    if (landed !== -1) {
      setSearchSelection(landed);
    }
  }

  // Keep the selection on a navigable row as the item list changes underneath it
  // (new results, a collapse, a filter), and the scroll inside shrunken content.
  createEffect(() => {
    const items = searchItems();
    const index = untrack(searchIndex);
    const item = items[index];
    if (item === undefined || !isNavigableSearchItem(item)) {
      const bounded = Math.min(index, items.length - 1);
      const previous = items.findLastIndex(
        (candidate, candidateIndex) =>
          candidateIndex <= bounded && isNavigableSearchItem(candidate),
      );
      setSearchIndex(
        previous === -1 ? Math.max(0, items.findIndex(isNavigableSearchItem)) : previous,
      );
    }
    const maxScroll = Math.max(0, items.length - searchListHeight());
    if (untrack(searchScrollTop) > maxScroll) {
      setSearchScrollTop(maxScroll);
    }
  });

  function openSearch() {
    batch(() => {
      setMainView("search");
      setFocusedPane("search");
      setSearchFocus("query");
    });
  }

  // Closing the view keeps every search signal (query, snapshot, selection,
  // Collapsed groups): persistence across jumps is the point of the pane.
  function closeSearch() {
    batch(() => {
      setMainView("file");
      if (focusedPane() === "search") {
        setFocusedPane("diff");
      }
    });
  }

  // Open a result row (Enter or a click): a match line lands the caret on its
  // Exact column; a context line lands line-level. Both route through the same
  // JumpTarget path as problems/references navigation, whose goToLocation step
  // Closes the search view like any other navigation.
  function jumpToSearchItem(index: number) {
    const item = searchItems()[index];
    if (item === undefined || item.kind !== "line") {
      return;
    }
    batch(() => {
      setSearchIndex(index);
      selectFile(item.path, { column: item.match?.column, escalate: true, line: item.line });
    });
  }

  function resetSearchSelection() {
    batch(() => {
      setSearchIndex(0);
      setSearchScrollTop(0);
    });
  }

  function toggleSearchRegex() {
    setSearchRegex((enabled) => !enabled);
    resetSearchSelection();
  }

  function toggleSearchCase() {
    setSearchCaseSensitive((enabled) => !enabled);
    resetSearchSelection();
  }

  function toggleSearchScope() {
    setSearchScope((current) => (current === "changed" ? "repo" : "changed"));
    resetSearchSelection();
  }

  function toggleSearchGroup(path: string) {
    batch(() => {
      setSearchCollapsed((current) => {
        const next = new Set(current);
        if (!next.delete(path)) {
          next.add(path);
        }
        return next;
      });
      const header = searchItems().findIndex(
        (item) => item.kind === "header" && item.path === path,
      );
      if (header !== -1) {
        setSearchSelection(header);
      }
    });
  }

  // Search results are repo-specific paths: a worktree switch (or the deleted-
  // Worktree recovery) invalidates them. Clear the snapshot but keep the query,
  // The same drift rule as the references overlay.
  createEffect(
    on(
      repoRoot,
      () => {
        batch(() => {
          setSearchResults([]);
          setSearchFileLines(new Map());
          setSearchTruncated(false);
          setSearchStatus("idle");
          setSearchCollapsed(new Set<string>());
          resetSearchSelection();
        });
      },
      { defer: true },
    ),
  );

  const navigableLines = createMemo(() => diffView()?.render.navigable ?? []);
  const truncated = createMemo(() => {
    const content = diffView()?.fileContent;
    return (
      (diffView()?.render.hiddenLines ?? 0) > 0 || (content?.kind === "text" && content.truncated)
    );
  });
  // Line rows the cap hid, for the "N more lines" footer. In file-content mode the
  // True total is the file's own line count (the render is built from an
  // Already-capped slice), so measure the hidden count against what's shown; a diff
  // Has no larger total, so its own dropped-row count is exact.
  const truncatedHidden = createMemo(() => {
    const view = diffView();
    if (view === undefined) {
      return 0;
    }
    const content = view.fileContent;
    if (content?.kind === "text" && content.truncated) {
      return Math.max(0, content.lineCount - view.render.navigable.length);
    }
    return view.render.hiddenLines;
  });

  // In-buffer find: row indices into navigableLines whose content matches the
  // Query. Computed only while the bar is open or a search is committed, so the
  // Viewer paints highlights live as you type and keeps them until esc/file switch.
  const findMatches = createMemo(() =>
    findOpen() || findActive()
      ? findMatchIndices(
          navigableLines().map((line) => line.content),
          findQuery(),
        )
      : [],
  );

  // The one reset for find lifecycle (close, clear, file switch all share it).
  function resetFind() {
    setFindOpen(false);
    setFindActive(false);
    setFindQuery("");
    setFindMatchPos(0);
  }

  // A file switch ends any active find so highlights never bleed across files.
  createEffect(on(selectedPath, () => batch(resetFind)));

  // Live theme preview: while the picker is open, the highlighted row is the
  // Active selection, so moving (keys, hover, wheel) or filtering re-themes the
  // Whole UI and re-highlights the diff instantly through the one reactive seam.
  // It only writes while open; cancel/commit are handled by closeThemePicker.
  createEffect(() => {
    if (!themeComboboxOpen()) {
      return;
    }
    const item = themeComboboxResults()[themeComboboxIndex()];
    setSelection(item === undefined ? themeComboboxOrigin() : item.selection);
  });

  // --- layout (derived from terminal dimensions) ---
  const problemsHeight = createMemo(() => (problemsOpen() ? PROBLEMS_HEIGHT : 0));
  const paneHeight = createMemo(() => Math.max(1, terminalHeight() - 4 - problemsHeight()));
  // A truncated file reserves one row for the "N more lines" footer, so the diff
  // Content shrinks by it; DiffView derives its whole windowing from this height,
  // So the single subtraction keeps the slice and scroll math correct.
  const viewerHeight = createMemo(() => Math.max(1, paneHeight() - 1 - (truncated() ? 1 : 0)));
  // The search view's results band: the pane interior minus its four fixed chrome
  // Rows (query, filter, summary, footer). Fixed chrome, so no state ever shifts it.
  const searchListHeight = createMemo(() => Math.max(1, paneHeight() - 4));
  // A manual width is stored raw and only clamped here, so it never overflows a
  // Shrunken terminal yet is restored intact when the terminal grows back. The
  // Responsive default and a manual override share the same clamp, so the
  // Viewer-preserving max holds in both cases.
  const sidebarMax = () => Math.max(SIDEBAR_MIN_WIDTH, terminalWidth() - SIDEBAR_VIEWER_MIN);
  const sidebarWidth = createMemo(() => {
    if (!sidebarOpen()) {
      return 0;
    }
    const responsive = Math.max(34, Math.min(54, Math.floor(terminalWidth() * 0.34)));
    const desired = sidebarWidthOverride() ?? responsive;
    return Math.max(SIDEBAR_MIN_WIDTH, Math.min(desired, sidebarMax()));
  });
  // Closing the sidebar moves focus off the now-hidden tree so keys still land
  // Somewhere, on whichever view the main area shows; the `ctrl-b` toggle and a
  // Shrink-past-minimum share this one path.
  const collapseSidebar = () => {
    if (focusedPane() === "tree") {
      setFocusedPane(mainView() === "search" ? "search" : "diff");
    }
    setSidebarOpen(false);
  };
  const toggleSidebar = () => {
    if (sidebarOpen()) {
      collapseSidebar();
    } else {
      setSidebarOpen(true);
    }
  };
  // Nudges seed from the current rendered width on first use so the step is
  // Relative to what's on screen, not a stale override. Shrinking past the
  // Minimum collapses the sidebar rather than clamping, like an IDE pane.
  const nudgeSidebarWidth = (delta: number) => {
    const next = (sidebarWidthOverride() ?? sidebarWidth()) + delta;
    if (next < SIDEBAR_MIN_WIDTH) {
      collapseSidebar();
      return;
    }
    setSidebarWidthOverride(next);
  };
  const resetSidebarWidth = () => setSidebarWidthOverride(null);
  const overlayWidth = createMemo(() => Math.max(30, Math.min(70, terminalWidth() - 8)));
  const overlayLeft = createMemo(() =>
    Math.max(0, Math.floor((terminalWidth() - overlayWidth()) / 2)),
  );

  // --- status / cursor view-model ---
  const cursorLine = createMemo(() => navigableLines()[cursorIndex()]);
  const cursorLineContent = createMemo(() => cursorLine()?.content ?? "");
  const cursorLineNumber = createMemo(() => {
    const line = cursorLine();
    return line?.newLine ?? line?.oldLine;
  });
  // The symbol the caret sits on, for the highlight and (later) the code-intel
  // Requests. Undefined in line-level mode or on a gap/word-less position.
  const caretWord = createMemo(() =>
    caretLineLevel() ? undefined : wordAt(cursorLineContent(), cursorColumn()),
  );
  // The exact 1-based column the caret points at, for `:col` in copy/stats. Driven
  // By line-level alone (not `caretWord`), so a diagnostic jump that lands in a gap
  // Still reports its precise column instead of falling back to line-only.
  const caretColumn = createMemo(() => (caretLineLevel() ? undefined : cursorColumn() + 1));
  const cursorFindings = createMemo(() => {
    const line = cursorLine();
    return line?.newLine === undefined ? undefined : lineMap().get(line.newLine);
  });
  const countsText = createMemo(() => {
    const value = counts();
    return `${value.errors > 0 ? `${levelGlyph("error")}${value.errors}` : ""}${value.warnings > 0 ? ` ${levelGlyph("warning")}${value.warnings}` : ""}`.trim();
  });
  // The status bar's left key hints, keyed to the active mode. Lives here (not in
  // The StatusBar component) so the right-status budget below can reserve the exact
  // Width the hint takes, instead of a hardcoded copy that drifts from the render.
  const statusHint = createMemo(() =>
    findOpen()
      ? "type to find · enter confirm · esc cancel"
      : findActive()
        ? "n/N next/prev · esc clear find"
        : "? keys · q quit",
  );
  const statusRightModel = createMemo(() => {
    // Reserve the left hint plus the bar's two paddings and a gap between the halves;
    // What remains is the right status's, less the leading level glyph + space it prepends.
    const width = Math.max(10, terminalWidth() - statusHint().length - 4);
    const textWidth = Math.max(1, width - 2);
    // An in-flight code-intel pull outranks even a held acknowledgment: it is the
    // Acknowledgment of the very keystroke the user is waiting on, so it stays until
    // The pull settles (which then clears it, letting any follow-up notice show).
    const busy = intelStatus();
    if (busy !== undefined) {
      return { level: "info" as const, text: truncate(busy, textWidth) };
    }
    // A held acknowledgment wins over ambient status for its dwell, so the user
    // Sees their action confirmed even as checks/activity churn underneath.
    const held = notice();
    if (held !== undefined) {
      return { level: held.level, text: truncate(held.text, textWidth) };
    }
    const finding = cursorFindings()?.[0];
    if (finding !== undefined) {
      return {
        level: finding.severity satisfies LogLevel,
        text: truncate(`${finding.checker}: ${finding.message}`, textWidth),
      };
    }
    const latest = latestActivity(activityLog());
    const displayStatus = checksRunning() ? "checking…" : status();
    const recent = latest !== undefined && now() - latest.at < RECENT_MS ? latest : undefined;
    const prefix =
      recent === undefined ? "" : `${Math.max(0, Math.round((now() - recent.at) / 1000))}s ago `;
    // Reserve the seconds prefix and, when present, the " · status" suffix the join
    // Appends, so a long path shortens from its front (keeping the filename) instead
    // Of shoving the status off the line.
    const suffix = displayStatus === "" ? "" : ` · ${displayStatus}`;
    const activityText =
      recent === undefined
        ? ""
        : `${prefix}${truncateLeft(recent.path, Math.max(1, textWidth - prefix.length - suffix.length))}`;
    const text = truncate(
      [activityText, displayStatus].filter((part) => part !== "").join(" · "),
      textWidth,
    );
    // A glyph belongs only to an actual status message. Activity alone is ambient
    // And idle is empty, so neither carries a level: the bar renders the text bare,
    // Never a lone glyph.
    const level = displayStatus === "" ? undefined : checksRunning() ? "info" : statusLevel();
    return { level, text };
  });
  const statusRight = () => statusRightModel().text;
  const statusRightLevel = () => statusRightModel().level;

  // --- navigation ---
  const canGoBack = createMemo(() => canBack(navState()));
  const canGoForward = createMemo(() => canForward(navState()));
  // The tab strip's view-model: each open tab's current file and which is active.
  // The viewer shows the strip only when there is more than one.
  const tabItems = createMemo(() => {
    const nav = navState();
    return nav.tabs.map((tab) => ({
      active: tab.id === nav.activeTabId,
      id: tab.id,
      path: tab.entries[tab.index]?.path,
      preview: tab.preview,
    }));
  });

  // Snapshot the live viewer state for the path being left, so a later
  // Back/forward restores the exact spot. Undefined when nothing is selected.
  // A still-outstanding restore for this path means the cursor/scroll signals
  // Have not been applied for it yet (they still hold the previous file's values
  // While its diff loads); capture the intended restore instead of those stale
  // Live signals, so rapid navigation never records a neighbor's position.
  function captureCurrent(): Location | undefined {
    const path = selectedPath();
    if (path === undefined) {
      return undefined;
    }
    const pending = pendingRestore();
    const settled = pending === undefined || pending.path !== path;
    const line = navigableLines()[cursorIndex()];
    return {
      cursorColumn: settled ? cursorColumn() : pending.cursorColumn,
      cursorLine: settled ? (line?.newLine ?? line?.oldLine) : pending.cursorLine,
      fileView: fileView(),
      fullContent: fullContentPaths().has(path),
      kind: currentLocation(navState())?.kind ?? "jump",
      path,
      viewport: settled
        ? { scrollTop: viewerScrollTop(), scrollX: viewerScrollX() }
        : pending.viewport,
    };
  }

  // The Location to arrive at when opening `path` fresh. A jump seeds the entry
  // With its real target line so back/forward restore it (and the dedup in
  // `navigate` can tell one jump from another); the column stays undefined so the
  // Async `jumpTarget` effect snaps the caret to the exact word on landing. Absent
  // A target, a revisit restores its remembered cursor/scroll from the MRU, a first
  // Visit defaults (first change, top). `fileView` always resets to the diff.
  function arrivingLocation(path: string, kind: "browse" | "jump", targetLine?: number): Location {
    const remembered = recall(navState(), path);
    return {
      cursorColumn: targetLine === undefined ? remembered?.cursorColumn : undefined,
      cursorLine: targetLine ?? remembered?.cursorLine,
      fileView: false,
      fullContent: fullContentPaths().has(path),
      kind,
      path,
      viewport: remembered?.viewport ?? { scrollTop: 0, scrollX: 0 },
    };
  }

  // Drive the live signals to a Location and enqueue its restore. The fullContent
  // Set is additive (a path stays un-truncated globally); back never re-truncates.
  // Any navigation reveals the file view. Keyed here rather than on a
  // SelectedPath *change*, so a jump landing on the already-selected file still
  // Closes the search view instead of being consumed invisibly behind it.
  function goToLocation(location: Location) {
    closeSearch();
    setSelectedPath(location.path);
    setFileView(location.fileView);
    if (location.fullContent) {
      setFullContentPaths((current) =>
        current.has(location.path) ? current : new Set(current).add(location.path),
      );
    }
    setPendingRestore({
      cursorColumn: location.cursorColumn,
      cursorLine: location.cursorLine,
      path: location.path,
      viewport: location.viewport,
    });
  }

  // Record the location being left into its tab and into the MRU, the shared
  // Capture-on-leave step before any tab switch / navigation.
  function recordLeaving(nav: NavState, leaving: Location | undefined) {
    return leaving === undefined
      ? nav
      : remember(recordCurrent(nav, leaving), leaving.path, {
          cursorColumn: leaving.cursorColumn,
          cursorLine: leaving.cursorLine,
          viewport: leaving.viewport,
        });
  }

  // All file navigation routes to the single preview tab (Zed's model): otherwise
  // The preview tab is navigated in place (browse coalesces, jump pushes), or a
  // Fresh preview tab is opened when none exists (e.g. right after a pin). A pinned
  // Tab already showing `path` is the destination instead of the preview: a plain
  // Re-focus (no line) just re-activates it, restoring where you were (no dup),
  // While a line jump navigates within it so the target line seeds that tab's
  // History and back/forward restore it, like any other jump.
  function navigateTo(path: string, kind: "browse" | "jump", targetLine?: number) {
    const nav = navState();
    const pinned = nav.tabs.find((tab) => !tab.preview && tab.entries[tab.index]?.path === path);
    if (pinned !== undefined && targetLine === undefined) {
      activateTab(pinned.id);
      return;
    }
    const leaving = captureCurrent();
    const arriving = arrivingLocation(path, kind, targetLine);
    const preview = nav.tabs.find((tab) => tab.preview);
    const openingPreview = pinned === undefined && preview === undefined;
    const destinationId = pinned?.id ?? preview?.id ?? String(nextTabId);
    if (openingPreview) {
      nextTabId += 1;
    }
    batch(() => {
      setNavState((current) => {
        const recorded = recordLeaving(current, leaving);
        return openingPreview
          ? openTab(recorded, arriving, destinationId, true)
          : navigate({ ...recorded, activeTabId: destinationId }, arriving);
      });
      goToLocation(arriving);
    });
  }

  function goBack() {
    const nav = navState();
    if (!canBack(nav)) {
      return;
    }
    const leaving = captureCurrent();
    const moved = back(recordLeaving(nav, leaving));
    const target = currentLocation(moved);
    batch(() => {
      setNavState(moved);
      if (target !== undefined) {
        goToLocation(target);
      }
    });
  }

  function goForward() {
    const nav = navState();
    if (!canForward(nav)) {
      return;
    }
    const leaving = captureCurrent();
    const moved = forward(recordLeaving(nav, leaving));
    const target = currentLocation(moved);
    batch(() => {
      setNavState(moved);
      if (target !== undefined) {
        goToLocation(target);
      }
    });
  }

  // Tab switches reuse back/forward's capture-on-leave / apply-on-arrive: record
  // Where we left the active tab, transform the tab set, then restore the new
  // Active tab's current location.
  function switchActiveTab(transform: (nav: NavState) => NavState) {
    const nav = navState();
    const leaving = captureCurrent();
    const recorded = leaving === undefined ? nav : recordCurrent(nav, leaving);
    const remembered =
      leaving === undefined
        ? recorded
        : remember(recorded, leaving.path, {
            cursorColumn: leaving.cursorColumn,
            cursorLine: leaving.cursorLine,
            viewport: leaving.viewport,
          });
    const moved = transform(remembered);
    const target = currentLocation(moved);
    batch(() => {
      setNavState(moved);
      if (target !== undefined) {
        goToLocation(target);
      }
    });
  }

  // Toggle the active tab's pin: a preview pins (persists; the next navigation
  // Opens a fresh preview), a pinned tab unpins (reverts to the dim preview). The
  // Viewed file is unchanged either way, so only navState moves.
  function togglePinActiveTab() {
    setNavState((nav) => {
      const active = nav.tabs.find((tab) => tab.id === nav.activeTabId);
      if (active === undefined) {
        return nav;
      }
      return active.preview ? pinTab(nav, nav.activeTabId) : unpinTab(nav, nav.activeTabId);
    });
  }

  // Pin-only (idempotent): the double-click gesture promotes the active tab and
  // Never unpins, unlike `ctrl-t`'s toggle. Unpinning stays a keyboard action.
  function pinActiveTab() {
    setNavState((nav) => pinTab(nav, nav.activeTabId));
  }

  function cycleTab(direction: number) {
    switchActiveTab((nav) => (direction > 0 ? nextTab(nav) : prevTab(nav)));
  }

  function activateTab(id: string) {
    switchActiveTab((nav) => selectTab(nav, id));
  }

  // Close the active tab. Removing it activates a neighbor (restore its location);
  // Closing the sole tab instead reverts it to the preview (same file, strip gone),
  // So no location change and nothing to restore.
  function closeActiveTab() {
    const nav = navState();
    const leaving = captureCurrent();
    const moved = closeTab(recordLeaving(nav, leaving), nav.activeTabId);
    if (moved.tabs.length === nav.tabs.length) {
      setNavState(moved);
      return;
    }
    const target = currentLocation(moved);
    batch(() => {
      setNavState(moved);
      if (target !== undefined) {
        goToLocation(target);
      }
    });
  }

  // Reset history to a fresh single tab seeded with `path` (startup and worktree
  // Switch). Caller already runs inside a batch; this stays unbatched so it folds
  // Into that one update.
  function seedNav(path: string | undefined) {
    if (path === undefined) {
      setNavState(initialNav(undefined));
      setSelectedPath(undefined);
      setFileView(false);
      setPendingRestore(undefined);
      return;
    }
    const location: Location = {
      cursorLine: undefined,
      fileView: false,
      fullContent: false,
      kind: "jump",
      path,
      viewport: { scrollTop: 0, scrollX: 0 },
    };
    setNavState(initialNav(location));
    goToLocation(location);
  }

  // --- actions ---
  function moveFocus(direction: number) {
    const rows = treeRows();
    const node = rows[Math.max(0, Math.min(focusedRowIndex() + direction, rows.length - 1))]?.node;
    if (node === undefined) {
      return;
    }
    setFocusedNodeId(node.id);
    if (node.type === "file") {
      navigateTo(node.path, "browse");
    }
  }

  // Open a file as a jump (palette, search, go-to-definition, a reference/problem).
  // A `target` line is the single source of truth for where the jump lands: it
  // Seeds the history Location (so back/forward restore it) and the transient
  // `jumpTarget` (which snaps the caret to the column and escalates to file view).
  function selectFile(
    path: string,
    target?: { line: number; column?: number; escalate?: boolean },
  ) {
    batch(() => {
      setFocusedNodeId(`file:${path}`);
      setExpandedDirectories((current) => expandAncestorsForPath(current, path));
      navigateTo(path, "jump", target?.line);
      if (target !== undefined) {
        setJumpTarget({
          column: target.column,
          escalate: target.escalate ?? true,
          line: target.line,
          path,
        });
      }
    });
  }

  // Move the line cursor and land the caret on the new line's first word, so every
  // Vertical move (j/k, page, top/bottom, find cycle, the row click) leaves the
  // Caret on a symbol ready for go-to-definition/hover. A jump or restore sets the
  // Caret itself, so those use `setCursorIndex` directly and bypass this.
  function setCursorRow(index: number) {
    batch(() => {
      setCaretLineLevel(false);
      setCursorIndex(index);
      setCursorColumn(firstWord(navigableLines()[index]?.content ?? ""));
    });
  }

  // Hop the caret to the next word; past the line's last word it wraps to the next
  // Navigable line's first word, so h/l tab through every symbol in the file. From
  // Line-level (a gutter click), the first hop just selects the current first word.
  function caretNextWord() {
    if (caretLineLevel()) {
      setCaretLineLevel(false);
      return;
    }
    const content = cursorLineContent();
    const column = cursorColumn();
    const next = nextWord(content, column);
    if (next !== column) {
      setCursorColumn(next);
      return;
    }
    const lines = navigableLines();
    const index = cursorIndex();
    if (index < lines.length - 1) {
      batch(() => {
        setCursorIndex(index + 1);
        setCursorColumn(firstWord(lines[index + 1]?.content ?? ""));
      });
    }
  }
  // Hop the caret to the previous word; past the line's first word it wraps to the
  // Previous navigable line's last word. From line-level, select the line's last word.
  function caretPrevWord() {
    if (caretLineLevel()) {
      batch(() => {
        setCaretLineLevel(false);
        setCursorColumn(lastWord(cursorLineContent()));
      });
      return;
    }
    const content = cursorLineContent();
    const column = cursorColumn();
    const previous = prevWord(content, column);
    if (previous !== column) {
      setCursorColumn(previous);
      return;
    }
    const lines = navigableLines();
    const index = cursorIndex();
    if (index > 0) {
      batch(() => {
        setCursorIndex(index - 1);
        setCursorColumn(lastWord(lines[index - 1]?.content ?? ""));
      });
    }
  }

  let checksController: AbortController | undefined;
  async function runChecks(model: GitModel) {
    checksController?.abort();
    const controller = new AbortController();
    checksController = controller;
    // Keep prior diagnostics while re-checking (update in place); only files new to the set get a
    // Pending placeholder. Changed files are already marked pending by the edit-detection effect.
    setCheckerState((current) => markPending(current, model.changed, []));
    // Hold each file's badge across the run: awaiting files render this prior until their servers
    // Report, so stable files never flicker to pending (markPending already pendinged edited/new ones).
    const prior = checkerState().diagnostics;
    setChecksRunning(true);
    const failures: string[] = [];
    let installing: string | undefined;
    try {
      await runtime.runPromise(
        Diagnostics.use((diagnostics) =>
          diagnostics.run(model.repoRoot, model.changed, prior).pipe(
            Stream.runForEach((update) =>
              Effect.sync(() => {
                setCheckerState((current) => ({ ...current, [update.checker]: update.state }));
                for (const fileState of update.state.values()) {
                  if (fileState.status === "failed") {
                    failures.push(
                      `${update.checker} failed: ${fileState.message?.split("\n")[0] ?? ""}`,
                    );
                    break;
                  }
                  // A pending file carrying a message is a server still downloading.
                  if (fileState.status === "pending" && fileState.message !== undefined) {
                    installing ??= fileState.message;
                  }
                }
              }),
            ),
          ),
        ),
        { signal: controller.signal },
      );
      report(
        failures[0] ?? installing ?? "checks passed",
        failures[0] !== undefined ? "error" : installing !== undefined ? "info" : "success",
      );
    } catch {
      // Interrupted by a newer run or a worktree switch
    } finally {
      if (checksController === controller) {
        setChecksRunning(false);
      }
    }
  }

  // When a language server finishes downloading, re-run checks so its files resolve from pending.
  runtime.runFork(
    Provisioner.use((provisioner) =>
      Queue.take(provisioner.completions).pipe(
        Effect.flatMap(() => Effect.sync(() => void runChecks(gitModel()))),
        Effect.forever,
      ),
    ),
  );

  // Hold a user-action acknowledgment for a fixed dwell (~1.5s) so an ambient
  // Status event or the next keystroke can't overwrite it before it's read.
  let noticeTimer: ReturnType<typeof setTimeout> | undefined;
  function notify(text: string, level: LogLevel = "info") {
    setNotice({ level, text });
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => setNotice(undefined), 1500);
  }

  // Background, non-blocking: a newer release surfaces in the post-exit quit notice. Bounded by a
  // Timeout and error-swallowing in fetchLatestVersion, so it never blocks or breaks startup.
  async function checkForUpdate(current: string) {
    const latest = await fetchLatestVersion();
    if (latest !== undefined && isNewer(latest, current)) {
      setAvailableUpdate({ current, latest });
    }
  }

  // One controller for both code-intel overlays (definition and references): they share the
  // Single overlay, so a fresh request of either kind supersedes the other's in-flight pull,
  // Rather than two uncoordinated controllers clobbering each other's results.
  let intelController: AbortController | undefined;
  // Jump the viewer to the definition of the symbol under the caret. Read-only LSP pull
  // (`textDocument/definition`) over the warm server pool; degrades to a notice, never throws.
  async function goToDefinition() {
    // A fresh invocation supersedes any in-flight lookup, even when the guards below no-op, so a
    // Stale result can't land a jump after the user has moved on.
    intelController?.abort();
    const path = selectedPath();
    const line = cursorLineNumber();
    if (path === undefined || line === undefined) {
      return;
    }
    // The caret must sit on a symbol in the current file's text: a gap or line-level caret has no
    // Position to resolve, and a removed (old-only) line isn't in the file the server reads.
    if (caretWord() === undefined) {
      notify("no symbol at caret");
      return;
    }
    if (cursorLine()?.newLine === undefined) {
      notify("can't resolve a removed line");
      return;
    }
    const controller = new AbortController();
    intelController = controller;
    setIntelStatus("resolving definition…");
    const requestRoot = repoRoot();
    try {
      const locations = await runtime.runPromise(
        Intel.use((intel) =>
          intel.definition(requestRoot, path, { character: cursorColumn(), line: line - 1 }),
        ),
        { signal: controller.signal },
      );
      // A worktree switch mid-request leaves these paths resolving against the old repo, so a jump
      // Would land on a stale or missing file; drop the result unless the root still matches.
      if (controller.signal.aborted || repoRoot() !== requestRoot) {
        return;
      }
      if (locations.length === 0) {
        notify("no definition");
        return;
      }
      // The service relativizes in-repo paths; an out-of-repo target (e.g. node_modules) stays
      // Absolute and the tree can't open it, so jump to the first in-repo result instead.
      const inRepo = locations
        .filter((location) => !isAbsolute(location.path))
        .toSorted(byReferenceOrder);
      const target = inRepo[0];
      if (target === undefined) {
        notify("definition outside repo");
        return;
      }
      // More than one definition (e.g. an overloaded symbol) is a pick, not a jump: read
      // Each target's source line and hand the set to the shared references overlay.
      if (inRepo.length > 1) {
        const linesByPath = await readReferenceLines(requestRoot, inRepo, controller.signal);
        if (intelController !== controller || repoRoot() !== requestRoot) {
          return;
        }
        openReferences("definitions", attachReferencePreviews(inRepo, linesByPath));
        return;
      }
      batch(() => {
        selectFile(target.path, { column: target.column, escalate: true, line: target.line });
        setFocusedPane("diff");
      });
    } catch {
      if (!controller.signal.aborted) {
        notify("language server unreachable", "error");
      }
    } finally {
      // A superseding F12 installs its own controller and indicator, so only the
      // Latest invocation clears the busy state; the aborted one leaves it alone.
      if (intelController === controller) {
        setIntelStatus(undefined);
      }
    }
  }

  // Read each referenced file's lines once (keyed by path) so the overlay can show a
  // Source-line preview beside `path:line:col`. Local reads (the LSP resolves against
  // On-disk files); a missing or binary file yields no lines, so its rows show no preview.
  function readReferenceLines(
    root: string,
    locations: readonly NormalizedLocation[],
    signal: AbortSignal,
  ) {
    const paths = [...new Set(locations.map((location) => location.path))];
    return runtime.runPromise(
      File.use((file) =>
        Effect.all(
          paths.map((path) =>
            file.content(root, path, { full: true }).pipe(
              Effect.map(
                // Split on CRLF too, so a Windows-checkout preview doesn't keep a trailing
                // \r that trimStart can't remove and that renders as a control glyph.
                (content) =>
                  [path, content.kind === "text" ? content.content.split(/\r?\n/) : []] as const,
              ),
            ),
          ),
          { concurrency: "unbounded" },
        ),
      ).pipe(Effect.map((entries) => new Map(entries))),
      { signal },
    );
  }

  function resetReferencesState() {
    setReferencesOpen(false);
    setReferencesResults([]);
    setReferencesIndex(0);
    setReferencesStatus("loading");
  }

  // The repoRoot the open overlay's results belong to, captured on open so the drift
  // Effect below can close it when a worktree switch moves off that repo.
  let referencesRoot: string | undefined;

  function openReferences(label: "references" | "definitions", results: ReferenceResult[]) {
    referencesRoot = repoRoot();
    batch(() => {
      setReferencesLabel(label);
      setReferencesResults(results);
      setReferencesIndex(0);
      setReferencesStatus("ready");
      setReferencesOpen(true);
    });
  }

  // Find every use of the symbol under the caret via `textDocument/references`. Opens the
  // Results overlay at once in a loading state, then resolves it in place to the list, an
  // Empty screen, or an error; read-only, degrades to a notice, never throws.
  async function findReferences() {
    intelController?.abort();
    const path = selectedPath();
    const line = cursorLineNumber();
    if (path === undefined || line === undefined) {
      return;
    }
    if (caretWord() === undefined) {
      notify("no symbol at caret");
      return;
    }
    if (cursorLine()?.newLine === undefined) {
      notify("can't resolve a removed line");
      return;
    }
    const controller = new AbortController();
    intelController = controller;
    const requestRoot = repoRoot();
    referencesRoot = requestRoot;
    batch(() => {
      // References takes over the shared intel slot; drop any definition indicator its
      // Superseded pull left behind, since this flow shows progress in the overlay instead.
      setIntelStatus(undefined);
      setReferencesLabel("references");
      setReferencesResults([]);
      setReferencesIndex(0);
      setReferencesStatus("loading");
      setReferencesOpen(true);
    });
    try {
      const locations = await runtime.runPromise(
        Intel.use((intel) =>
          intel.references(requestRoot, path, { character: cursorColumn(), line: line - 1 }),
        ),
        { signal: controller.signal },
      );
      // A superseding request or a worktree switch drops this result: the newer request
      // Owns the overlay, and a stale root would resolve previews against the wrong repo.
      if (intelController !== controller || repoRoot() !== requestRoot) {
        return;
      }
      const inRepo = locations
        .filter((location) => !isAbsolute(location.path))
        .toSorted(byReferenceOrder);
      if (inRepo.length === 0) {
        setReferencesStatus("empty");
        return;
      }
      const linesByPath = await readReferenceLines(requestRoot, inRepo, controller.signal);
      if (intelController !== controller || repoRoot() !== requestRoot) {
        return;
      }
      openReferences("references", attachReferencePreviews(inRepo, linesByPath));
    } catch {
      if (intelController === controller) {
        setReferencesStatus("error");
      }
    }
  }

  function closeReferences() {
    intelController?.abort();
    intelController = undefined;
    batch(resetReferencesState);
  }

  // Jump to a result (Enter or a click) and dismiss the overlay, mirroring the search
  // Overlay's open-a-match path so a reference jump and a search jump behave the same.
  function jumpToReference(index: number) {
    const target = referencesResults()[index];
    if (target === undefined) {
      return;
    }
    intelController?.abort();
    intelController = undefined;
    batch(() => {
      selectFile(target.path, { column: target.column, escalate: true, line: target.line });
      setFocusedPane("diff");
      resetReferencesState();
    });
  }

  // The overlay lists repo-specific paths, so a repoRoot change (a worktree switch, or
  // The deleted-worktree recovery) leaves it showing files from the old worktree. Close
  // It on that drift; closeReferences aborts any in-flight request, the way the caret
  // Decoration clears when its anchor drifts.
  createEffect(() => {
    if (referencesOpen() && repoRoot() !== referencesRoot) {
      closeReferences();
    }
  });

  // The active scope's identity, so a scope switch that leaves the path unchanged
  // Still drifts the anchor off the now-different diff.
  const scopeIdentity = () => `${scope().kind}:${scope().ref}`;

  // Open a caret-anchored decoration, capturing the caret/scroll/file it describes.
  function openViewerDecoration(content: ViewerDecoration) {
    batch(() => {
      setDecorationAnchor({
        column: cursorColumn(),
        index: cursorIndex(),
        path: selectedPath(),
        repoRoot: repoRoot(),
        scope: scopeIdentity(),
        scrollTop: viewerScrollTop(),
        scrollX: viewerScrollX(),
        theme: activeThemeName(),
      });
      setViewerDecorationContent(content);
    });
  }

  // Update an open decoration's content (loading -> ready/empty/error). A no-op
  // Once the anchor is gone (the caret moved and the clear effect already closed
  // It), so a late async result can't resurrect a card the user moved past.
  function resolveViewerDecoration(content: ViewerDecoration) {
    if (decorationAnchor() !== undefined) {
      setViewerDecorationContent(content);
    }
  }

  function closeViewerDecoration() {
    batch(() => {
      setViewerDecorationContent(undefined);
      setDecorationAnchor(undefined);
    });
  }

  let hoverController: AbortController | undefined;
  // Show type + docs for the symbol under the caret in a caret-anchored card. Same
  // Read-only pull and guards as `goToDefinition`, but the reply is text into the
  // Decoration seam instead of a jump; degrades to an empty/error card, never throws.
  async function showHover() {
    hoverController?.abort();
    const path = selectedPath();
    const line = cursorLineNumber();
    if (path === undefined || line === undefined) {
      return;
    }
    if (caretWord() === undefined) {
      notify("no symbol at caret");
      return;
    }
    if (cursorLine()?.newLine === undefined) {
      notify("can't resolve a removed line");
      return;
    }
    const controller = new AbortController();
    hoverController = controller;
    const requestRoot = repoRoot();
    openViewerDecoration({ lines: noticeLines("resolving…"), status: "loading" });
    try {
      const segments = await runtime.runPromise(
        Intel.use((intel) =>
          intel.hover(requestRoot, path, { character: cursorColumn(), line: line - 1 }),
        ),
        { signal: controller.signal },
      );
      if (controller.signal.aborted || repoRoot() !== requestRoot) {
        return;
      }
      if (segments.length === 0) {
        resolveViewerDecoration({ lines: noticeLines("no hover info"), status: "empty" });
        return;
      }
      const groups = await Promise.all(
        segments.map((segment) => segmentToLines(segment, highlightSnippet)),
      );
      if (controller.signal.aborted) {
        return;
      }
      // Flatten the groups with a blank line between segments (signature from docs),
      // The way an editor spaces them.
      const lines: DecorationLine[] = [];
      for (const [index, group] of groups.entries()) {
        if (index > 0) {
          lines.push({ kind: "prose", text: "" });
        }
        for (const groupLine of group) {
          lines.push(groupLine);
        }
      }
      resolveViewerDecoration({ lines, status: "ready" });
    } catch {
      if (!controller.signal.aborted) {
        resolveViewerDecoration({
          lines: noticeLines("couldn't reach the language server"),
          status: "error",
        });
      }
    }
  }

  // Close the decoration the instant its caret, scroll, or file drifts: it
  // Describes one exact spot, so it must not survive a move past it.
  createEffect(() => {
    const anchor = decorationAnchor();
    if (anchor === undefined) {
      return;
    }
    if (
      cursorIndex() !== anchor.index ||
      cursorColumn() !== anchor.column ||
      viewerScrollTop() !== anchor.scrollTop ||
      viewerScrollX() !== anchor.scrollX ||
      selectedPath() !== anchor.path ||
      repoRoot() !== anchor.repoRoot ||
      scopeIdentity() !== anchor.scope ||
      activeThemeName() !== anchor.theme
    ) {
      closeViewerDecoration();
    }
  });

  function copy(text: string, message = `copied ${text.split("\n")[0]}`) {
    runtime
      .runPromise(Clipboard.use((clipboard) => clipboard.copy(text)))
      .then(() => notify(message, "success"))
      .catch((error: unknown) =>
        notify(`couldn't copy: ${error instanceof Error ? error.message : String(error)}`, "error"),
      );
  }

  // Reads the file fresh with `full: true` rather than reusing the loaded
  // `diffView`: in diff view only the diff is in memory, and the file-view
  // Snapshot can be truncated. Mirrors `loadDiffView`'s deleted-file gitSpec.
  function copyFileContents() {
    const path = selectedPath();
    if (path === undefined) {
      return;
    }
    const model = gitModel();
    const file = selectedFile();
    const currentScope = scope();
    const gitSpec =
      file?.kind === "deleted"
        ? currentScope.kind === "unstaged"
          ? `:${path}`
          : `${currentScope.ref}:${path}`
        : undefined;
    runtime
      .runPromise(
        File.use((service) => service.content(model.repoRoot, path, { full: true, gitSpec })),
      )
      .then((content) => {
        if (content.kind === "text") {
          copy(content.content, `copied ${path}`);
          return;
        }
        notify(`can't copy ${content.kind} file`, "warning");
      })
      .catch((error: unknown) =>
        notify(`couldn't copy: ${error instanceof Error ? error.message : String(error)}`, "error"),
      );
  }

  // Opt the current path out of the truncation cap for a full re-read. Reached by
  // The `f` key and the truncation footer's click; the footer clearing and the
  // Content growing are the acknowledgment, so it stays silent.
  function loadFullContent() {
    const path = selectedPath();
    if (path === undefined) {
      return;
    }
    setFullContentPaths(new Set(fullContentPaths()).add(path));
  }

  function loadWorktrees(root: string) {
    runtime
      .runPromise(Git.use((git) => git.worktrees(root)))
      .then((list) => {
        const selectable = list.filter((worktree) => !worktree.bare);
        batch(() => {
          setWorktrees(selectable);
          // Seed the highlight on the current worktree only when no query has been
          // Typed while loading was in flight; a query filters the list, so the
          // Full-list position could be out of range. The input resets to 0 on type.
          setWorktreeComboboxIndex(
            worktreeComboboxQuery() === ""
              ? Math.max(
                  0,
                  selectable.findIndex((worktree) => worktree.path === root),
                )
              : 0,
          );
        });
      })
      .catch((error: unknown) => {
        batch(() => {
          setWorktreeComboboxOpen(false);
          report(
            `couldn't list worktrees: ${error instanceof Error ? (error.message.split("\n")[0] ?? "") : String(error)}`,
            "error",
          );
        });
      });
  }

  // Open the theme picker on the active selection (so it reads as "where am I
  // Now"), capturing it as the revert target. A `{dark,light}` pair (config-only,
  // The picker never writes one) matches no single row, so it parks on `auto`.
  function openThemePicker() {
    const current = selection();
    const index =
      current === undefined
        ? 0
        : Math.max(
            0,
            themeComboboxItems().findIndex((item) => item.selection === current),
          );
    batch(() => {
      setThemeComboboxOrigin(current);
      setThemeComboboxQuery("");
      setThemeComboboxIndex(index);
      setThemeComboboxOpen(true);
    });
  }

  // Commit applies the highlighted row's selection, cancel restores the one
  // Captured on open. Done explicitly (not left to the preview effect) so a click
  // Or enter finalizes deterministically even without a prior hover, then closing
  // Stops the effect from writing further.
  function closeThemePicker(commit: boolean) {
    if (commit) {
      const item = themeComboboxResults()[themeComboboxIndex()];
      setSelection(item === undefined ? themeComboboxOrigin() : item.selection);
    } else {
      setSelection(themeComboboxOrigin());
    }
    setThemeComboboxOpen(false);
  }

  // A monotonic token guards the async last-commit resolution: a newer pick (of
  // Any kind) bumps it, so a late parentRef result can't overwrite the newer scope.
  let scopeSelection = 0;

  // Resolve a picked scope kind to a fully-formed DiffScope. last-commit needs its
  // Parent ref resolved (async), so it sets the scope once that lands, guarded
  // Against a newer pick and against an unborn HEAD (no commits yet, where a
  // `git diff <parent> HEAD` has no right side to diff). The others are synchronous.
  function selectScope(kind: ScopeKind) {
    const token = (scopeSelection += 1);

    if (kind === "session") {
      setScope({ kind, ref: sessionBase() });
      return;
    }

    if (kind === "last-commit") {
      const root = repoRoot();
      runtime
        .runPromise(Git.use((git) => Effect.all([git.headRef(root), git.parentRef(root)])))
        .then(([head, parent]) => {
          if (token !== scopeSelection) {
            return;
          }
          if (head === EMPTY_TREE_SHA) {
            notify("no commits yet");
            return;
          }
          setScope({ headRef: "HEAD", kind, ref: parent });
        })
        .catch(() => {});
      return;
    }

    setScope({ kind, ref: cliBaseRef() });
  }

  // A worktree switch is a new inspection context: the session base re-pins to the
  // New worktree's HEAD and session/last-commit (whose refs pointed into the old
  // Worktree's history) re-resolve against it. We return the resolved base and
  // Scope rather than committing them, so `switchWorktree` applies them only after
  // The model load succeeds and only for the latest request (a failed or superseded
  // Switch must not leave future session picks pointed at the wrong HEAD).
  // CLI-ref kinds (all/staged/unstaged) are valid in any worktree, so they carry over.
  async function rebaselineScope(root: string) {
    const head = await runtime.runPromise(Git.use((git) => git.headRef(root)));
    const active = scope();
    if (active.kind === "session") {
      return { scope: { kind: "session", ref: head } satisfies DiffScope, sessionBase: head };
    }
    if (active.kind === "last-commit") {
      const parent = await runtime.runPromise(Git.use((git) => git.parentRef(root)));
      return {
        scope: { headRef: "HEAD", kind: "last-commit", ref: parent } satisfies DiffScope,
        sessionBase: head,
      };
    }
    return { scope: active, sessionBase: head };
  }

  // Repoint the whole app (tree, diffs, polling, checks) at another worktree
  // Without a restart. Lives in state, not App, so the keymap, the picker's
  // Mouse click, and App's deleted-worktree recovery all reach the one action
  // Directly. It only writes state and reloads the model (no `renderer`), so it
  // Belongs here next to `runChecks`; `reason` overrides the status.
  let switchRequest = 0;
  async function switchWorktree(worktree: Worktree, reason?: string) {
    setWorktreeComboboxOpen(false);
    if (worktree.path === gitModel().repoRoot) {
      return;
    }
    if (!existsSync(worktree.path)) {
      report(`missing worktree: ${worktree.path}`, "warning");
      return;
    }
    // The load is async, so a second switch started before the first resolves
    // Could land out of order and overwrite the newer worktree. Stamp each call
    // And bail if a later one superseded it, mirroring the diff/search pipelines'
    // Restart-on-rekey guard, so only the latest request commits or reports.
    const request = ++switchRequest;
    try {
      // Re-pin session/last-commit to the target worktree's history before loading.
      const { sessionBase: nextSessionBase, scope: nextScope } = await rebaselineScope(
        worktree.path,
      );
      // Load only the changed set (the same shape startup seeds, repoFiles empty),
      // So the tree repoints the instant the cheap diff commands resolve instead of
      // Blocking on `git ls-files --stage` over the whole worktree. The repoFilesPoll
      // In the refresh effect re-keys on the new repoRoot and fills the full tree.
      const changed = await runtime.runPromise(
        Git.use((git) => git.changedFiles(worktree.path, nextScope)),
      );
      if (request !== switchRequest) {
        return;
      }
      const fresh: GitModel = {
        repoRoot: worktree.path,
        ...changed,
        repoFiles: [],
        repoFilesKey: "",
      };
      const selected = fresh.changed[0]?.path ?? fresh.repoFiles[0]?.path;
      const expanded = defaultExpandedDirectories(fresh.changed.map((file) => file.path));
      batch(() => {
        setSessionBase(nextSessionBase);
        setScope(nextScope);
        setCurrentWorktreeDeleted(false);
        setLastChange(Date.now());
        setRepoRoot(fresh.repoRoot);
        setGitModel(fresh);
        setFocusedNodeId(selected === undefined ? "" : `file:${selected}`);
        setExpandedDirectories(
          selected === undefined ? expanded : expandAncestorsForPath(expanded, selected),
        );
        setFullContentPaths(new Set<string>());
        setJumpTarget(undefined);
        // Reset navigation: worktree A's history is meaningless in B, so collapse
        // To one fresh tab on the new worktree's selected file.
        seedNav(selected);
        setProblemIndex(0);
        // Worktree A's diagnostics are meaningless in B; without this, markPending and
        // The cross-file carry-forward would accumulate every visited worktree's findings.
        setCheckerState(initialCheckerState(fresh.changed));
        setActivityLog(emptyActivityLog);
        setFocusedPane("tree");
        report(reason ?? `switched to ${worktreeLabel(worktree)}`);
      });
      void runChecks(fresh);
    } catch (error) {
      if (request !== switchRequest) {
        return;
      }
      report(
        `couldn't switch worktree: ${error instanceof Error ? (error.message.split("\n")[0] ?? "") : String(error)}`,
        "error",
      );
    }
  }

  // --- background fibers (re-key/restart reactively, interrupt the prior fiber
  // On cleanup so an in-flight git is killed) ---

  // Event-driven git refresh. A debounced fs-watch tick re-derives the changed
  // Set the instant a real change lands; a slow safety poll is the floor that
  // Covers anything the watcher misses (a platform without recursive watch, a
  // Gitignored boundary), so the worst case is poll-speed, never stale. The repo
  // File list refreshes only when the changed set's paths shift (plus a slow
  // Floor), never on a blind timer. Re-keys only on repoRoot/scope; cleanup
  // Aborts the controller, closing the watcher and any in-flight git.
  createEffect(() => {
    const root = repoRoot();
    const scopeNow = scope();
    if (root === "") {
      return;
    }
    const controller = new AbortController();
    // A fresh worktree re-proves the watcher from scratch (its fs.watch is new).
    setLastWatcherTick(0);
    runtime
      .runPromise(
        Effect.gen(function* refreshLoop() {
          // Two conflating queues (sliding, capacity 1): every trigger collapses
          // To at most one pending run, so a burst of fs events on a large repo
          // Can never queue a backlog of expensive `git status` / `ls-files`
          // Reads. Each drain is serial, so two reads of the same kind never
          // Overlap and write each other's stale result.
          const changedTriggers = yield* Queue.sliding<void>(1);
          const repoFilesTriggers = yield* Queue.sliding<void>(1);

          const refreshChanged = Git.use((git) => git.changedFiles(root, scopeNow)).pipe(
            // Functional update so the merge is always against the latest committed
            // Model: the repoFiles drain runs concurrently, so reasoning about which
            // Write lands first is unnecessary when each merges from the current state.
            Effect.tap((next) =>
              Effect.sync(() =>
                setGitModel((prev) => {
                  if (prev.repoRoot !== root) {
                    return prev;
                  }
                  // Only re-list the whole repo when the file set actually shifted;
                  // A content-only edit leaves the tree structure untouched.
                  if (changedPathsDiffer(prev.changed, next.changed)) {
                    Queue.offerUnsafe(repoFilesTriggers, undefined);
                  }
                  return mergeChanged(prev, next);
                }),
              ),
            ),
            // Last-commit's right side is the literal HEAD (it always follows the
            // Newest commit), but its parent must re-resolve as HEAD moves so a new
            // Commit advances the window and re-keys checks. Guarded so we only re-key
            // When the parent actually changed; session/all/staged need no resolution.
            Effect.tap(() =>
              scopeNow.kind === "last-commit"
                ? Git.use((git) => git.parentRef(root)).pipe(
                    Effect.tap((parent) =>
                      Effect.sync(() => {
                        const current = scope();
                        if (current.kind === "last-commit" && current.ref !== parent) {
                          setScope({ headRef: "HEAD", kind: "last-commit", ref: parent });
                        }
                      }),
                    ),
                    Effect.ignore,
                  )
                : Effect.void,
            ),
            // The heartbeat is the always-on detector: a failure means this worktree
            // Was deleted when its root is gone, or when the main worktree is gone (a
            // Linked worktree's git breaks once main's .git is deleted, even if its own
            // Dir lingers). Flag it (App recovers); any other failure is transient.
            Effect.catch(() =>
              Effect.sync(() => {
                const main = mainWorktreePath();
                if (!existsSync(root) || (main !== "" && !existsSync(main))) {
                  setCurrentWorktreeDeleted(true);
                }
              }),
            ),
          );
          const refreshRepoFiles = Git.use((git) => git.repoFiles(root)).pipe(
            Effect.tap((next) =>
              Effect.sync(() =>
                setGitModel((prev) =>
                  prev.repoRoot === root && prev.repoFilesKey !== next.repoFilesKey
                    ? { ...prev, repoFiles: next.repoFiles, repoFilesKey: next.repoFilesKey }
                    : prev,
                ),
              ),
            ),
            Effect.ignore,
          );

          // Changed-set triggers: an immediate tick on (re)key, a debounced
          // Fs-watch tick per change (which also records watcher health), and a
          // Safety poll whose cadence adapts to that health — fast where the
          // Watcher is unproven or has missed a change, slow once it has earned
          // Trust. See `refreshDelay`.
          const watchTicks = Stream.unwrap(
            Effect.gen(function* watchStream() {
              const watcher = yield* Watcher;
              return watcher.changes(root);
            }),
          ).pipe(Stream.tap(() => Effect.sync(() => setLastWatcherTick(Date.now()))));
          const safetyTicks = Stream.fromEffect(
            Effect.suspend(() =>
              Effect.sleep(
                refreshDelay({
                  lastChangeAt: lastChange(),
                  lastWatcherTickAt: lastWatcherTick(),
                  now: Date.now(),
                }),
              ),
            ),
          ).pipe(Stream.forever);
          // RepoFiles triggers: an immediate load on (re)key plus a slow floor.
          // The changed refresh wakes it on any real structural shift, so this
          // Floor only covers a change the changed set never reflected.
          const repoFilesFloor = Stream.fromEffect(Effect.sleep("30 seconds")).pipe(Stream.forever);

          const feedChanged = Stream.mergeAll([Stream.make(undefined), watchTicks, safetyTicks], {
            concurrency: "unbounded",
          }).pipe(Stream.runForEach(() => Queue.offer(changedTriggers, undefined)));
          const feedRepoFiles = Stream.mergeAll([Stream.make(undefined), repoFilesFloor], {
            concurrency: "unbounded",
          }).pipe(Stream.runForEach(() => Queue.offer(repoFilesTriggers, undefined)));
          const drainChanged = Stream.fromQueue(changedTriggers).pipe(
            Stream.mapEffect(() => refreshChanged),
            Stream.runDrain,
          );
          const drainRepoFiles = Stream.fromQueue(repoFilesTriggers).pipe(
            Stream.mapEffect(() => refreshRepoFiles),
            Stream.runDrain,
          );

          // All four run until the controller aborts (worktree/scope re-key),
          // Which interrupts the fiber and closes the watcher's fs handles.
          yield* Effect.all([feedChanged, feedRepoFiles, drainChanged, drainRepoFiles], {
            concurrency: "unbounded",
          });
        }),
        { signal: controller.signal },
      )
      .catch(() => {});
    onCleanup(() => controller.abort());
  });

  // Keep "Ns ago" labels fresh once a second while activity is recent, then stop.
  createEffect(() => {
    const latest = latestActivity(activityLog());
    if (latest === undefined || Date.now() - latest.at >= RECENT_MS) {
      setNow(Date.now());
      return;
    }
    const timer = setInterval(() => {
      setNow(Date.now());
      if (Date.now() - latest.at >= RECENT_MS) {
        clearInterval(timer);
      }
    }, 1000);
    onCleanup(() => clearInterval(timer));
  });

  // Re-run checks once the repo has been quiet for 2s; new activity resets it.
  createEffect(() => {
    if (activityLog().events.length === 0) {
      return;
    }
    const timer = setTimeout(() => void runChecks(gitModel()), 2000);
    onCleanup(() => clearTimeout(timer));
  });

  // Detect agent edits from each new model: record activity + mark checkers
  // Pending, and re-run checks wholesale when the scope changes. A repoRoot
  // Change (worktree switch or the initial seed) only re-baselines — the caller
  // Runs the checks — so a swapped changed-set is never mistaken for agent edits.
  let previousChanged: ChangedFile[] = [];
  let previousScopeKey = "";
  let previousRepoRoot = "";
  createEffect(() => {
    const model = gitModel();
    const previousByPath = new Map(previousChanged.map((file) => [file.path, file]));
    const prevScopeKey = previousScopeKey;
    const prevRepoRoot = previousRepoRoot;
    previousChanged = model.changed;
    previousScopeKey = model.scopeKey;
    previousRepoRoot = model.repoRoot;

    if (model.repoRoot !== prevRepoRoot) {
      return;
    }

    if (prevScopeKey !== model.scopeKey) {
      void runChecks(model);
      return;
    }

    const entries: { path: string; kind: ActivityEventKind }[] = [];
    for (const file of model.changed) {
      const before = previousByPath.get(file.path);
      if (before === undefined) {
        entries.push({ kind: "appeared", path: file.path });
      } else if (before.additions !== file.additions || before.deletions !== file.deletions) {
        entries.push({ kind: "changed", path: file.path });
      }
      previousByPath.delete(file.path);
    }
    for (const path of previousByPath.keys()) {
      entries.push({ kind: "removed", path });
    }

    if (entries.length > 0) {
      batch(() => {
        setLastChange(Date.now());
        setCheckerState((current) =>
          markPending(
            current,
            model.changed,
            entries.map((entry) => entry.path),
          ),
        );
        setActivityLog((current) => recordActivity(current, entries, Date.now()));
      });
    }
  });

  return {
    activateTab,
    activityLog,
    allProblemItems,
    availableUpdate,
    canGoBack,
    canGoForward,
    caretColumn,
    caretLineLevel,
    caretNextWord,
    caretPrevWord,
    caretWord,
    changesOnly,
    checkForUpdate,
    checkerState,
    checksRunning,
    closeActiveTab,
    closeReferences,
    closeSearch,
    closeThemePicker,
    closeViewerDecoration,
    collapseSidebar,
    copy,
    copyFileContents,
    counts,
    countsText,
    currentWorktreeDeleted,
    cursorColumn,
    cursorIndex,
    cursorLineContent,
    cursorLineNumber,
    cycleTab,
    diffView,
    directoryRecencyByPath,
    directorySummariesByPath,
    editorTemplate,
    expandedDirectories,
    fileComboboxIndex,
    fileComboboxOpen,
    fileComboboxQuery,
    fileComboboxResults,
    fileView,
    findActive,
    findMatchPos,
    findMatches,
    findOpen,
    findQuery,
    findReferences,
    firstNavigableProblemIndex,
    focusedNodeId,
    focusedPane,
    focusedRowIndex,
    fullContentPaths,
    gitModel,
    goBack,
    goForward,
    goToDefinition,
    helpDialogOpen,
    iconsEnabled,
    ideTemplate,
    jumpTarget,
    jumpToReference,
    jumpToSearchItem,
    lineMap,
    loadFullContent,
    loadWorktrees,
    mainView,
    mainWorktreePath,
    moveFocus,
    moveSearchSelection,
    navState,
    navigableLines,
    notify,
    now,
    nudgeSidebarWidth,
    openFileCombobox,
    openSearch,
    openThemePicker,
    openViewerDecoration,
    overflow,
    overlayLeft,
    overlayWidth,
    pageSearchSelection,
    paneHeight,
    pendingRestore,
    pinActiveTab,
    problemIndex,
    problems,
    problemsOpen,
    problemsScrollTop,
    recencyByPath,
    referencesIndex,
    referencesLabel,
    referencesOpen,
    referencesResults,
    referencesStatus,
    repoFilesLoading,
    repoRoot,
    resetFind,
    resetSidebarWidth,
    resolveViewerDecoration,
    runChecks,
    scope,
    scopeMenuIndex,
    scopeMenuOpen,
    searchCaseSensitive,
    searchFocus,
    searchGlob,
    searchIndex,
    searchItems,
    searchListHeight,
    searchQuery,
    searchRegex,
    searchResults,
    searchScope,
    searchScrollTop,
    searchStatus,
    searchTruncated,
    seedNav,
    selectFile,
    selectScope,
    selectedFile,
    selectedPath,
    setActivityLog,
    setCaretLineLevel,
    setChangesOnly,
    setCheckerState,
    setCliBaseRef,
    setCurrentWorktreeDeleted,
    setCursorColumn,
    setCursorIndex,
    setCursorRow,
    setEditorTemplate,
    setExpandedDirectories,
    setFileComboboxIndex,
    setFileComboboxOpen,
    setFileComboboxQuery,
    setFileView,
    setFindActive,
    setFindMatchPos,
    setFindOpen,
    setFindQuery,
    setFocusedNodeId,
    setFocusedPane,
    setFullContentPaths,
    setGitModel,
    setHelpDialogOpen,
    setIconsEnabled,
    setIdeTemplate,
    setJumpTarget,
    setLastChange,
    setMainWorktreePath,
    setNotice,
    setNow,
    setOverflow,
    setPendingRestore,
    setProblemIndex,
    setProblemsOpen,
    setProblemsScrollTop,
    setReferencesIndex,
    setRepoRoot,
    setScope,
    setScopeMenuIndex,
    setScopeMenuOpen,
    setSearchFocus,
    setSearchGlob,
    setSearchIndex,
    setSearchQuery,
    setSearchScrollTop,
    setSearchSelection,
    setSessionBase,
    setSidebarOpen,
    setSidebarScrollTop,
    setTerminalHeight,
    setTerminalWidth,
    setThemeComboboxIndex,
    setThemeComboboxQuery,
    setViewerScrollTop,
    setViewerScrollX,
    setWorktreeComboboxIndex,
    setWorktreeComboboxOpen,
    setWorktreeComboboxQuery,
    setWorktrees,
    showFileContent,
    showHover,
    sidebarOpen,
    sidebarScrollTop,
    sidebarWidth,
    status,
    statusHint,
    statusRight,
    statusRightLevel,
    switchWorktree,
    tabItems,
    terminalHeight,
    terminalWidth,
    themeComboboxIndex,
    themeComboboxOpen,
    themeComboboxOrigin,
    themeComboboxResults,
    togglePinActiveTab,
    toggleSearchCase,
    toggleSearchGroup,
    toggleSearchRegex,
    toggleSearchScope,
    toggleSidebar,
    treeRows,
    truncated,
    truncatedHidden,
    viewerDecoration,
    viewerHeight,
    viewerScrollTop,
    viewerScrollX,
    worktreeComboboxIndex,
    worktreeComboboxOpen,
    worktreeComboboxQuery,
    worktreeComboboxResults,
    worktrees,
  };
}

// One global reactive root owns every signal/memo/effect for the app's lifetime
// (the process exits rather than disposing it), so module consumers can import
// Accessors directly without prop-drilling or a context provider.
export const state = createRoot(createState);

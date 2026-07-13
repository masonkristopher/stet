import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";

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
import { formatCopyReference } from "./clipboard/reference";
import { Clipboard } from "./clipboard/service";
import { buildCommandMenuItems } from "./components/command-menu/items";
import type { CommandAction, CommandMenuInput } from "./components/command-menu/items";
import {
  PROBLEMS_HEIGHT,
  REFERENCES_MAX_ROWS,
  SIDEBAR_MIN_WIDTH,
  SIDEBAR_VIEWER_MIN,
  SYMBOLS_MAX_ROWS,
} from "./constants";
import {
  allFindings,
  countBySeverity,
  directorySummaries,
  findingsLineMap,
  initialCheckerState,
  markPending,
} from "./diagnostics/checker";
import type { CheckerState, Diagnostic } from "./diagnostics/checker";
import { LspProcess } from "./diagnostics/lsp-process";
import { buildProblemItems, isNavigableProblemItem } from "./diagnostics/problems";
import { Provisioner } from "./diagnostics/provision";
import { intelLanguage, serversProviding } from "./diagnostics/servers";
import { Diagnostics } from "./diagnostics/service";
import { DiffEngine, highlightSnippet, languageForPath, structureDiff } from "./diff/engine";
import type { DiffRender, RenderInput } from "./diff/engine";
import { followScrollTop } from "./diff/follow";
import type { RenderSpan } from "./diff/hast";
import {
  applyCollapsedRegions,
  foldKey,
  foldRegionsFor,
  remapCursorAfterToggle,
} from "./diff/regions";
import type { GapSource } from "./diff/regions";
import type { DiffRow, NavigableLine } from "./diff/rows";
import { firstWord, lastWord, nextWord, prevWord, wordAt } from "./diff/words";
import { openExternalCommand } from "./editor/reference";
import { Editor } from "./editor/service";
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
import type { BlameLine } from "./git/blame";
import { fileDiffSides } from "./git/file-patch";
import type { BinaryDiff } from "./git/file-patch";
import type { Commit } from "./git/log";
import {
  changedContentAdvanced,
  changedPathsDiffer,
  EMPTY_TREE_SHA,
  mergeChanged,
} from "./git/model";
import type { ChangedFile, GitModel } from "./git/model";
import { classifyProvenance } from "./git/provenance";
import type { Provenance } from "./git/provenance";
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
import {
  mergeWorktreeSummaries,
  orderWorktrees,
  PEER_SUMMARY_MS,
  WORKTREE_ACTIVE_MS,
} from "./git/worktree";
import type { Worktree, WorktreeSummary } from "./git/worktree";
import type { HoverSegment, NormalizedLocation, NormalizedSymbol } from "./intel/protocol";
import { attachReferencePreviews, buildReferenceRows, byReferenceOrder } from "./intel/references";
import type { ReferenceResult } from "./intel/references";
import { Intel } from "./intel/service";
import type { IntelRequestError } from "./intel/service";
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
import { relativeTime } from "./utils/relative-time";
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

// The context the command menu was opened against; a clear effect closes the menu
// The moment any of it drifts, so the open state can never outlive the anchored
// Render (a click away moves the caret/focus and dismisses the menu). The tree menu
// Tracks its focused node and sidebar scroll, the viewer menu its caret and scroll.
interface CommandMenuGuard {
  context: "tree" | "viewer";
  focusedPane: "tree" | "diff" | "problems" | "search";
  path: string | undefined;
  focusedNodeId: string;
  sidebarScrollTop: number;
  cursorIndex: number;
  cursorColumn: number;
  caretLineLevel: boolean;
  scrollTop: number;
  scrollX: number;
  scope: string;
  repoRoot: string;
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
  // Present only for a changed binary file: its two sides' size/dimensions, so the
  // Viewer renders a metadata placeholder instead of the empty diff stet can't draw.
  binary?: BinaryDiff;
}

interface DiffBase {
  diff: string;
  fileContent: FileContent | undefined;
  showFileContent: boolean;
  binary?: BinaryDiff;
}

const DIFF_MAX_LINES = 1600;

// Bounds the search result list so a broad query in a large repo can't flood the
// Pane; hitting the cap sets `searchTruncated`, surfaced as a trailing "+".
const SEARCH_RESULT_CAP = 500;

// Lines of surrounding context shown on each side of a search match.
const SEARCH_CONTEXT_LINES = 2;

const emptyModel: GitModel = {
  branch: undefined,
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
            binary: result.binary,
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

  // A binary file has no diff to draw, so skip the patch entirely and fetch the two
  // Sides' size/dimensions for the placeholder; `fileDiff` would only return "" here.
  if (file.binary) {
    return toView(
      Git.use((git) => git.binaryMeta(src.model.repoRoot, src.scope, file)).pipe(
        Effect.map(
          (binary): DiffBase => ({
            binary,
            diff: "",
            fileContent: undefined,
            showFileContent: false,
          }),
        ),
        // A `git show` failure still shows the designed binary surface (metadata just
        // Absent), never a blank pane, so a changed binary always reads as one. Scoped
        // To GitError so an unexpected defect still propagates.
        Effect.catchTag("GitError", () =>
          Effect.succeed<DiffBase>({
            binary: {},
            diff: "",
            fileContent: undefined,
            showFileContent: false,
          }),
        ),
      ),
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
  // The SHA HEAD pointed at when stet launched, pinned for the session scope.
  const [sessionBase, setSessionBase] = createSignal("HEAD");
  const [scopeMenuOpen, setScopeMenuOpen] = createSignal(false);
  const [scopeMenuIndex, setScopeMenuIndex] = createSignal(0);
  // The scope picker is two levels: the kinds list, and a drill-down into recent
  // Commits (each viewable as its own diff). `scopeMenuIndex` is reused per level.
  const [scopeMenuView, setScopeMenuView] = createSignal<"kinds" | "commits">("kinds");
  const [commits, setCommits] = createSignal<Commit[]>([]);
  const [commitsStatus, setCommitsStatus] = createSignal<"loading" | "ready" | "empty" | "error">(
    "loading",
  );
  // The commit pinned by the active `commit` scope (its subject drives the header
  // Label, so it survives even after the commit ages out of the reloaded list).
  const [selectedCommit, setSelectedCommit] = createSignal<Commit | undefined>(undefined);
  // Wall-clock captured when the commits drill-down opens, for the rows' relative
  // Dates. Not `now` (the recency clock), which freezes while the repo is idle.
  const [commitsNow, setCommitsNow] = createSignal(0);
  // The context menu: shared open/index state across the tree and viewer instances
  // (only one is ever open, gated by `commandMenuContext`). The anchor is the global
  // Terminal cell the tree menu opens at; the viewer instance derives its own from
  // The caret, so it stays undefined there.
  const [commandMenuOpen, setCommandMenuOpen] = createSignal(false);
  const [commandMenuIndex, setCommandMenuIndex] = createSignal(0);
  const [commandMenuContext, setCommandMenuContext] = createSignal<"tree" | "viewer">("tree");
  const [commandMenuAnchor, setCommandMenuAnchor] = createSignal<{ x: number; y: number }>();
  const [commandMenuGuard, setCommandMenuGuard] = createSignal<CommandMenuGuard>();
  const [iconsEnabled, setIconsEnabled] = createSignal(true);
  // The per-line provenance rail (blame reframed): off by default, toggled by `a`. The three
  // Timeline anchors: `sessionCommits` = SHAs in `sessionBase..HEAD` (since launch),
  // `branchCommits` = SHAs in `branchBase..HEAD` (this branch, a superset of the session set),
  // And `fileFirstSha` = the open file's introducing commit. `blameByLine` maps a working-tree
  // Line number to its blame; `openFileWhollyNew` marks an untracked/added file whose every
  // Line is uncommitted (git can't blame it).
  const [blameEnabled, setBlameEnabled] = createSignal(false);
  const [blameByLine, setBlameByLine] = createSignal<ReadonlyMap<number, BlameLine>>(new Map());
  const [sessionCommits, setSessionCommits] = createSignal<ReadonlySet<string>>(new Set());
  const [branchCommits, setBranchCommits] = createSignal<ReadonlySet<string>>(new Set());
  // The branch base is session-stable, so it is resolved on its own (per repo), separate from the
  // Commit set that refreshes on the model drain.
  const [branchBaseSha, setBranchBaseSha] = createSignal<string | undefined>(undefined);
  const [fileFirstSha, setFileFirstSha] = createSignal<string | undefined>(undefined);
  const [openFileWhollyNew, setOpenFileWhollyNew] = createSignal(false);
  const toggleBlame = () => setBlameEnabled((enabled) => !enabled);
  // The provenance band + blame for a viewer row, O(1) off the precomputed map. A pure
  // Removal (no working-tree line) has no blame; a wholly-new file's every line is
  // Uncommitted. Read by the rail (band) and the status detail (band + blame).
  const provenanceForRow = (row: { newLine?: number }) => {
    if (!blameEnabled() || row.newLine === undefined) {
      return undefined;
    }
    if (openFileWhollyNew()) {
      return { band: "uncommitted" as Provenance, blame: undefined };
    }
    const blame = blameByLine().get(row.newLine);
    return blame === undefined
      ? undefined
      : {
          band: classifyProvenance(blame, {
            branchShas: branchCommits(),
            fileFirstSha: fileFirstSha(),
            sessionShas: sessionCommits(),
          }),
          blame,
        };
  };
  const [overflow, setOverflow] = createSignal<"scroll" | "wrap">("scroll");
  const [changesOnly, setChangesOnly] = createSignal(false);
  const [selectedPath, setSelectedPath] = createSignal<string | undefined>(undefined);
  const [expandedDirectories, setExpandedDirectories] = createSignal(new Set<string>());
  const [fileView, setFileView] = createSignal(false);
  const [fullContentPaths, setFullContentPaths] = createSignal(new Set<string>());
  // Viewer folds/gaps for the current file (reset on file switch): a `Set` of folded
  // Fold-region keys and a `Set` of expanded gap keys, both feeding `collapsedRender`.
  // Their opposite defaults (a fold starts open, a gap starts collapsed) are why they
  // Are two sets, not one; the transform that consumes them is shared.
  const [foldedRegions, setFoldedRegions] = createSignal(new Set<string>());
  const [expandedGaps, setExpandedGaps] = createSignal(new Set<string>());
  // The current file's revealed-gap source, loaded lazily on the first gap expansion.
  const [gapSource, setGapSource] = createSignal<
    | { path: string; status: "loading" | "error" }
    | { path: string; status: "loaded"; lines: string[] }
    | undefined
  >(undefined);
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
  const [referencesScrollTop, setReferencesScrollTop] = createSignal(0);
  const [referencesLabel, setReferencesLabel] = createSignal<
    "references" | "definitions" | "implementations" | "incoming calls" | "outgoing calls"
  >("references");
  const [symbolsOpen, setSymbolsOpen] = createSignal(false);
  const [symbolsStatus, setSymbolsStatus] = createSignal<
    "loading" | "ready" | "empty" | "error" | "unsupported"
  >("loading");
  const [symbolsResults, setSymbolsResults] = createSignal<NormalizedSymbol[]>([]);
  const [symbolsIndex, setSymbolsIndex] = createSignal(0);
  const [symbolsScrollTop, setSymbolsScrollTop] = createSignal(0);
  const [findOpen, setFindOpen] = createSignal(false);
  const [findActive, setFindActive] = createSignal(false);
  const [findQuery, setFindQuery] = createSignal("");
  const [findMatchPos, setFindMatchPos] = createSignal(0);
  const [worktreeComboboxOpen, setWorktreeComboboxOpen] = createSignal(false);
  const [worktreeComboboxIndex, setWorktreeComboboxIndex] = createSignal(0);
  const [worktreeComboboxQuery, setWorktreeComboboxQuery] = createSignal("");
  const [worktrees, setWorktrees] = createSignal<Worktree[] | undefined>(undefined);
  // How much work sits in each worktree and when it last moved, keyed by worktree
  // Path. Repository-wide (not scoped to the active worktree), so a worktree switch
  // Leaves it valid. Written only by `refreshWorktreeSummaries`.
  const [worktreeSummaries, setWorktreeSummaries] = createSignal<Map<string, WorktreeSummary>>(
    new Map(),
  );
  const [helpDialogOpen, setHelpDialogOpen] = createSignal(false);
  const [quitConfirmOpen, setQuitConfirmOpen] = createSignal(false);
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
  // The fixed end of a line-range selection: a navIndex, or undefined when there
  // Is only a caret (today's behavior). The selection spans anchor..cursorIndex,
  // Whole-line. Transient like `caretLineLevel`: any plain caret move or navigation
  // Clears it (see `setCursorRow`/`goToLocation`), and it is never captured into
  // Navigation history. `C` copies the spanned lines' source text.
  const [selectionAnchor, setSelectionAnchor] = createSignal<number | undefined>(undefined);
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
  // Languages whose server is downloading right now, sourced live from the provisioner (not the
  // Check run), so the status bar shows it promptly and drops it the moment the download resolves.
  const [provisioningLanguages, setProvisioningLanguages] = createSignal<ReadonlySet<string>>(
    new Set(),
  );
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

  // The references overlay windows its rows like the problems panel rather than leaning on a
  // Native scrollbox: the visible slice is `referencesScrollTop`, followed off the cursor's row
  // Position (headers offset it, so `referencesIndex` in results space is mapped to a row index).
  const referencesRows = createMemo(() => buildReferenceRows(referencesResults()));
  const referencesViewport = createMemo(() =>
    Math.min(REFERENCES_MAX_ROWS, Math.max(1, referencesRows().length)),
  );
  const referencesCursorRow = createMemo(() => {
    const target = referencesIndex();
    const row = referencesRows().findIndex(
      (entry) => entry.kind === "match" && entry.index === target,
    );
    return row === -1 ? 0 : row;
  });
  followListWindow({
    active: referencesOpen,
    cursor: referencesCursorRow,
    rowCount: () => referencesRows().length,
    scrollTop: referencesScrollTop,
    setScrollTop: setReferencesScrollTop,
    viewport: referencesViewport,
  });
  // The symbol outline overlay windows the same way. It has no header rows (one file's
  // Symbols, not a per-file grouping), so `symbolsIndex` is already the row index and the
  // Follow tracks it directly rather than mapping through a rows list.
  const symbolsViewport = createMemo(() =>
    Math.min(SYMBOLS_MAX_ROWS, Math.max(1, symbolsResults().length)),
  );
  followListWindow({
    active: symbolsOpen,
    cursor: symbolsIndex,
    rowCount: () => symbolsResults().length,
    scrollTop: symbolsScrollTop,
    setScrollTop: setSymbolsScrollTop,
    viewport: symbolsViewport,
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

  // The commits landed since launch (`sessionBase..HEAD`), the boundary of the "this session"
  // Tier. Re-run on a model drain (a new commit moves HEAD); only fetched while the rail is on,
  // And cheap (a bare rev-list). Failures leave the last set intact; disabling the rail clears it
  // (like the blame effect), so a re-enable starts from an empty set until the refetch lands.
  createEffect(() => {
    if (!blameEnabled()) {
      setSessionCommits(new Set<string>());
      return;
    }
    const model = gitModel();
    const base = sessionBase();
    const controller = new AbortController();
    runtime
      .runPromise(
        Git.use((git) => git.commitsSince(model.repoRoot, base)),
        {
          signal: controller.signal,
        },
      )
      .then((shas) => {
        if (!controller.signal.aborted) {
          setSessionCommits(shas);
        }
      })
      .catch(() => {});
    onCleanup(() => controller.abort());
  });

  // The branch base (`merge-base HEAD <default-branch>`) is session-stable, so resolve it once per
  // Repo (keyed on `repoRoot`, not the model drain), gated on the rail; its `symbolic-ref` plus
  // Merge-base calls stay off the hot refresh path. A repo with no default branch leaves it
  // Undefined, folding the branch tier away.
  createEffect(() => {
    if (!blameEnabled()) {
      setBranchBaseSha(undefined);
      return;
    }
    const root = repoRoot();
    const controller = new AbortController();
    runtime
      .runPromise(
        Git.use((git) => git.branchBase(root)),
        { signal: controller.signal },
      )
      .then((base) => {
        if (!controller.signal.aborted) {
          setBranchBaseSha(base);
        }
      })
      .catch(() => {});
    onCleanup(() => controller.abort());
  });

  // The commits since the branch base (`branchBase..HEAD`), bounding the "this branch" tier (a
  // Superset of the session set; the ordered classify separates them). Re-run on a model drain (a
  // New commit moves HEAD) and when the base resolves, but only a bare rev-list, not the merge-base
  // Resolution above. Disabling the rail clears it (like the blame effect).
  createEffect(() => {
    const base = branchBaseSha();
    if (!blameEnabled() || base === undefined) {
      setBranchCommits(new Set<string>());
      return;
    }
    const model = gitModel();
    const controller = new AbortController();
    runtime
      .runPromise(
        Git.use((git) => git.commitsSince(model.repoRoot, base)),
        {
          signal: controller.signal,
        },
      )
      .then((shas) => {
        if (!controller.signal.aborted) {
          setBranchCommits(shas);
        }
      })
      .catch(() => {});
    onCleanup(() => controller.abort());
  });

  // The open file's introducing commit (the `initial` boundary) is static per path, so resolve it
  // On a file switch (keyed on `selectedPath`/`repoRoot`), not on every model drain like blame; an
  // Untracked file has no history and resolves to undefined. Disabling the rail clears it.
  createEffect(() => {
    const path = selectedPath();
    if (!blameEnabled() || path === undefined) {
      setFileFirstSha(undefined);
      return;
    }
    const root = repoRoot();
    const controller = new AbortController();
    runtime
      .runPromise(
        Git.use((git) => git.fileFirstCommit(root, path)),
        { signal: controller.signal },
      )
      .then((sha) => {
        if (!controller.signal.aborted && selectedPath() === path) {
          setFileFirstSha(sha);
        }
      })
      .catch(() => {});
    onCleanup(() => controller.abort());
  });

  // Per-line blame for the open file, refreshed on the same trigger as the diff. A wholly-new file
  // (untracked/added) is unblameable, so skip the git call and mark every line uncommitted from the
  // Model; otherwise map each blame line by its line number for O(1) rail lookups. The previous
  // File's map is cleared before the async reload so its lines never decorate this file, and the
  // Reload aborts/re-runs on a file switch like the diff pipeline so a stale blame never lands.
  createEffect(() => {
    if (!blameEnabled()) {
      batch(() => {
        setBlameByLine(new Map());
        setOpenFileWhollyNew(false);
      });
      return;
    }
    const src = diffSource();
    if (src === undefined) {
      setBlameByLine(new Map());
      return;
    }
    const kind = src.model.changedByPath.get(src.path)?.kind;
    if (kind === "untracked" || kind === "added") {
      batch(() => {
        setOpenFileWhollyNew(true);
        setBlameByLine(new Map());
      });
      return;
    }
    // Clear the previous file's blame before the async reload so its lines never decorate this one.
    batch(() => {
      setOpenFileWhollyNew(false);
      setBlameByLine(new Map());
    });
    // Blame the diff's right side, not always the working tree: a `staged`/`last-commit`/`commit`
    // Scope shows the index or a revision, whose line numbers only match the rail when blamed there.
    // `worktree`/`empty` sides (and unchanged files) blame the working tree.
    const side = src.file === undefined ? undefined : fileDiffSides(src.scope, src.file).newSide;
    const controller = new AbortController();
    runtime
      .runPromise(
        Git.use((git) => git.blame(src.model.repoRoot, src.path, side)),
        {
          signal: controller.signal,
        },
      )
      .then((lines) => {
        if (controller.signal.aborted || selectedPath() !== src.path) {
          return;
        }
        setBlameByLine(new Map(lines.map((line) => [line.line, line])));
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

  const loadedGapSource = (): GapSource | undefined => {
    const source = gapSource();
    return source?.status === "loaded" ? { lines: source.lines } : undefined;
  };
  // Fold by structure: markdown files fold by heading section, everything else by
  // Indentation. The same `languageForPath` the highlighter uses, so the fold model
  // Agrees with the rendered language.
  const foldMode = () => {
    const language = languageForPath(diffView()?.path ?? "");
    return language === "markdown" || language === "mdx" ? "markdown" : "indent";
  };
  // The single "collapsed regions" transform: the raw render folded/gapped for the
  // Current state. `navigableLines` and the viewer's rows both read it, so the caret
  // Indexes only visible lines and can never land inside a collapsed region. Keyed on
  // The fold/gap sets and the loaded source (not the caret), so cursor moves don't
  // Recompute it. `truncated`/`truncatedHidden` stay on the raw `render` deliberately:
  // The maxLines cap is about the whole file, not what the user folded away.
  const collapsedRender = createMemo(() => {
    const view = diffView();
    if (view === undefined) {
      return { navigable: [] as NavigableLine[], rows: [] as DiffRow[] };
    }
    return applyCollapsedRegions(view.render.rows, {
      expandedGaps: expandedGaps(),
      folded: foldedRegions(),
      gapSource: loadedGapSource(),
      mode: foldMode(),
    });
  });
  const navigableLines = createMemo(() => collapsedRender().navigable);
  const viewerRows = () => collapsedRender().rows;
  // The navigable list for a hypothetical fold/gap state, so a toggle can remap the
  // Caret against the next lines within one synchronous batch (no memo-timing race).
  const collapsedNavigableFor = (folded: ReadonlySet<string>, gaps: ReadonlySet<string>) => {
    const view = diffView();
    if (view === undefined) {
      return [] as NavigableLine[];
    }
    return applyCollapsedRegions(view.render.rows, {
      expandedGaps: gaps,
      folded,
      gapSource: loadedGapSource(),
      mode: foldMode(),
    }).navigable;
  };
  // Folds shrink `navigableLines`, so the caret can end up past its end; the Viewer's
  // Existing cursor clamp (keyed on `navigableLines().length`) already re-homes it.
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

  // Folds/gaps are per file (the #181 v1 decision): a file switch clears them and
  // Drops any loaded gap source, so a returned-to file opens fully expanded. A scope
  // Change clears them too, since the gap keys (`gap:N` hunk ordinals) and the loaded
  // `gapSource` (the scope's new-side text) are both scope-relative, so keeping them
  // Could reveal mismatched lines from the previous scope's snapshot.
  const resetFolds = () => {
    setFoldedRegions(new Set<string>());
    setExpandedGaps(new Set<string>());
    setGapSource(undefined);
  };
  createEffect(on(selectedPath, () => batch(resetFolds)));
  createEffect(on(scope, () => batch(resetFolds)));

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
  // The inclusive [start, end] navIndex span of the active line selection, ordered
  // Regardless of drag direction; undefined when only a caret is present. Drives the
  // Selection band in the viewer and the range `C` copies.
  const selectionRange = createMemo(() => {
    const anchor = selectionAnchor();
    if (anchor === undefined) {
      return undefined;
    }
    const focus = cursorIndex();
    return [Math.min(anchor, focus), Math.max(anchor, focus)] as const;
  });
  // The selected lines' source text (no sign, no gutter), what `C` copies. Empty
  // When there is no selection; a folded or git-elided region is excluded for free,
  // Since it never enters `navigableLines`.
  const selectionText = createMemo(() => {
    const range = selectionRange();
    if (range === undefined) {
      return "";
    }
    return navigableLines()
      .slice(range[0], range[1] + 1)
      .map((line) => line.content)
      .join("\n");
  });
  // The context menu's inputs, gathered from the caret (viewer) or the focused node
  // (tree). Taking `context` as an argument (not the signal) lets `openCommandMenu`
  // Read a context's items before committing it, sidestepping the stale-memo read a
  // Same-batch signal write would cause.
  const commandMenuInput = (context: "tree" | "viewer"): CommandMenuInput => {
    if (context === "viewer") {
      return {
        caretColumn: caretColumn(),
        caretLine: cursorLineNumber(),
        context: "viewer",
        hasSymbol: caretWord() !== undefined,
        selectedPath: selectedPath(),
        treeNode: undefined,
        truncated: truncated(),
      };
    }
    const node = treeRows()[focusedRowIndex()]?.node;
    return {
      caretColumn: undefined,
      caretLine: undefined,
      context: "tree",
      hasSymbol: false,
      selectedPath: selectedPath(),
      treeNode: node === undefined ? undefined : { id: node.id, kind: node.type, path: node.path },
      truncated: false,
    };
  };
  // Both the render (CommandMenu) and the dispatch (keymap/click) read this one list,
  // So the highlighted index always maps to the same action. Gated on the menu being
  // Open so it does not rebuild on every caret move or tree refresh while closed.
  const commandMenuItems = createMemo(() =>
    commandMenuOpen() ? buildCommandMenuItems(commandMenuInput(commandMenuContext())) : [],
  );
  const cursorFindings = createMemo(() => {
    const line = cursorLine();
    return line?.newLine === undefined ? undefined : lineMap().get(line.newLine);
  });
  const countsText = createMemo(() => {
    const value = counts();
    return `${value.errors > 0 ? `${levelGlyph("error")}${value.errors}` : ""}${value.warnings > 0 ? ` ${levelGlyph("warning")}${value.warnings}` : ""}`.trim();
  });
  // The caret line's commit for the status bar: `author · age · subject` for a committed line
  // (the band is the leading glyph the bar draws, not repeated in words), `uncommitted · working
  // Tree` otherwise. Undefined when the rail is off or the caret sits on a row git can't attribute.
  const caretProvenanceDetail = createMemo(() => {
    const row = cursorLine();
    const provenance = row === undefined ? undefined : provenanceForRow(row);
    if (provenance === undefined) {
      return undefined;
    }
    const text =
      provenance.blame === undefined || provenance.band === "uncommitted"
        ? "uncommitted · working tree"
        : [
            provenance.blame.author,
            // The true wall clock in seconds, not the recency `now()` signal, which freezes ~30s
            // After the last git activity and would under-report the age in an idle session.
            relativeTime(provenance.blame.authorTime, Date.now() / 1000),
            provenance.blame.summary,
          ]
            .filter((part) => part !== "")
            .join(" · ");
    return { band: provenance.band, text };
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
  // A terse, live "installing…" line while servers download. Terse because the status slot is tight:
  // It shares the line with the activity path and spends a glyph + space on a leveled message.
  const provisioningStatus = createMemo(() => {
    const languages = [...provisioningLanguages()].toSorted();
    if (languages.length === 0) {
      return undefined;
    }
    return languages.length === 1
      ? `installing ${languages[0]} server…`
      : `installing ${languages.length} servers…`;
  });
  const statusRightModel = createMemo(() => {
    // Reserve the left hint plus the bar's two paddings and a gap between the halves;
    // What remains is the right status's, less the leading level glyph + space it prepends.
    const width = Math.max(10, terminalWidth() - statusHint().length - 4);
    const textWidth = Math.max(1, width - 2);
    // An in-flight code-intel pull outranks even a held acknowledgment: it is the
    // Acknowledgment of the very keystroke the user is waiting on, so it stays until
    // The pull settles (which then clears it, letting any follow-up notice show).
    // The transient tiers are pure leveled messages with no changed-file lead, so their
    // Whole text is the message and they carry no path, change kind, or recency; only the
    // Default activity tier below shows a recent changed file the bar tints and fades.
    const busy = intelStatus();
    if (busy !== undefined) {
      const message = truncate(busy, textWidth);
      return {
        activityPath: "",
        changeKind: undefined,
        level: "info" as const,
        message,
        provenanceCommit: undefined,
        recencyAt: undefined,
        text: message,
      };
    }
    // A held acknowledgment wins over ambient status for its dwell, so the user
    // Sees their action confirmed even as checks/activity churn underneath.
    const held = notice();
    if (held !== undefined) {
      const message = truncate(held.text, textWidth);
      return {
        activityPath: "",
        changeKind: undefined,
        level: held.level,
        message,
        provenanceCommit: undefined,
        recencyAt: undefined,
        text: message,
      };
    }
    const finding = cursorFindings()?.[0];
    if (finding !== undefined) {
      const message = truncate(`${finding.checker}: ${finding.message}`, textWidth);
      return {
        activityPath: "",
        changeKind: undefined,
        level: finding.severity satisfies LogLevel,
        message,
        provenanceCommit: undefined,
        recencyAt: undefined,
        text: message,
      };
    }
    const provisioning = provisioningStatus();
    const displayStatus = provisioning ?? (checksRunning() ? "checking…" : status());
    // A glyph belongs only to an actual status message. Activity alone is ambient and idle is
    // Empty, so neither carries a level: the bar renders the text bare, never a lone glyph.
    const level =
      displayStatus === ""
        ? undefined
        : provisioning !== undefined || checksRunning()
          ? "info"
          : statusLevel();
    // In provenance mode the caret line's commit fills the whole bar (a blame inspector),
    // Replacing the ambient recent-file + status lead. The transient tiers above (intel pull,
    // Held notice, cursor finding) and an error/warning-level ambient status (a failed check)
    // Preempt it, so a real problem is never hidden behind blame; a plain "checking…"/idle does not.
    const commit = caretProvenanceDetail();
    if (commit !== undefined && level !== "error" && level !== "warning") {
      // Truncate against the bar's two paddings plus the band glyph + its space lead.
      const text = truncate(commit.text, Math.max(1, terminalWidth() - 4));
      return {
        activityPath: "",
        changeKind: undefined,
        level: undefined,
        message: "",
        provenanceCommit: { band: commit.band, text },
        recencyAt: undefined,
        text,
      };
    }
    const latest = latestActivity(activityLog());
    const recent = latest !== undefined && now() - latest.at < RECENT_MS ? latest : undefined;
    // Budget the path + message against the right slot after the marks the bar draws: the
    // Severity glyph (2 cells, with a status), the recency dot before the path (2), and the
    // Gap between the two groups (2, only when both are present). The path yields first, its
    // Front truncating against the full status; if the status still overruns it caps too, so
    // The groups never spill past the slot into the left hint. The path is tinted by change
    // Kind and fades with recency (no "Ns ago"), the same cue the tree gives a changed file.
    const GLYPH_CELLS = 2;
    const DOT_CELLS = 2;
    const GAP_CELLS = 2;
    const overhead =
      (displayStatus === "" ? 0 : GLYPH_CELLS) +
      (recent === undefined ? 0 : DOT_CELLS) +
      (recent === undefined || displayStatus === "" ? 0 : GAP_CELLS);
    const textBudget = Math.max(1, width - overhead);
    const activityPath =
      recent === undefined
        ? ""
        : truncateLeft(recent.path, Math.max(1, textBudget - displayStatus.length));
    const message = truncate(displayStatus, Math.max(1, textBudget - activityPath.length));
    const text = [activityPath, message].filter((part) => part !== "").join(" · ");
    // The recent file's git change kind tints the path (the tree's changed-file color);
    // Its timestamp feeds both the fading tint and the recency dot the bar draws.
    const changeKind =
      recent === undefined ? undefined : gitModel().changedByPath.get(recent.path)?.kind;
    return {
      activityPath,
      changeKind,
      level,
      message,
      provenanceCommit: undefined,
      recencyAt: recent?.at,
      text,
    };
  });
  const statusRight = () => statusRightModel().text;
  const statusRightLevel = () => statusRightModel().level;
  const statusRightPath = () => statusRightModel().activityPath;
  const statusRightMessage = () => statusRightModel().message;
  const statusRightRecencyAt = () => statusRightModel().recencyAt;
  const statusRightChangeKind = () => statusRightModel().changeKind;
  const statusProvenanceCommit = () => statusRightModel().provenanceCommit;

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
    setSelectionAnchor(undefined);
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
      setSelectionAnchor(undefined);
      setCursorIndex(index);
      setCursorColumn(firstWord(navigableLines()[index]?.content ?? ""));
    });
  }

  // Extend (or begin) a line selection to `index`, keeping the caret on a symbol
  // There. Mirrors `setCursorRow` but seeds the anchor from the current row on the
  // First extend and, unlike it, preserves the anchor. Reached by Shift+arrow and a
  // Shift-click / drag in the viewer.
  function extendSelectionTo(index: number) {
    batch(() => {
      if (selectionAnchor() === undefined) {
        setSelectionAnchor(cursorIndex());
      }
      setCaretLineLevel(false);
      setCursorIndex(index);
      setCursorColumn(firstWord(navigableLines()[index]?.content ?? ""));
    });
  }

  // Hop the caret to the next word; past the line's last word it wraps to the next
  // Navigable line's first word, so h/l tab through every symbol in the file. From
  // Line-level (a gutter click), the first hop just selects the current first word.
  function caretNextWord() {
    setSelectionAnchor(undefined);
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
    setSelectionAnchor(undefined);
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

  // Toggle one fold, keeping the caret on its file line (or the fold header once the
  // Line it was on is hidden). The next navigable list is computed purely so the remap
  // Lands in the same batch as the set write, with no reliance on memo recomputation.
  function toggleFold(key: string) {
    const previous = navigableLines();
    const next = new Set(foldedRegions());
    if (next.has(key)) {
      next.delete(key);
    } else {
      next.add(key);
    }
    const nextLines = collapsedNavigableFor(next, expandedGaps());
    // Remap the selection's anchor across the toggle exactly as the caret is, so a
    // Live selection survives a fold the same way the cursor does (setCursorRow
    // Clears the anchor, so restore the remapped value after it).
    const anchor = selectionAnchor();
    const remappedAnchor =
      anchor === undefined ? undefined : remapCursorAfterToggle(previous, anchor, nextLines);
    batch(() => {
      setFoldedRegions(next);
      setCursorRow(remapCursorAfterToggle(previous, cursorIndex(), nextLines));
      setSelectionAnchor(remappedAnchor);
    });
  }

  // Toggle one git-elided gap; expanding one lazily loads the file's source so the
  // Revealed lines can be filled (until it resolves the gap stays a collapsed marker).
  function toggleGap(key: string) {
    const previous = navigableLines();
    const next = new Set(expandedGaps());
    const expanding = !next.has(key);
    if (expanding) {
      next.add(key);
    } else {
      next.delete(key);
    }
    const nextLines = collapsedNavigableFor(foldedRegions(), next);
    const anchor = selectionAnchor();
    const remappedAnchor =
      anchor === undefined ? undefined : remapCursorAfterToggle(previous, anchor, nextLines);
    batch(() => {
      setExpandedGaps(next);
      setCursorRow(remapCursorAfterToggle(previous, cursorIndex(), nextLines));
      setSelectionAnchor(remappedAnchor);
    });
    if (expanding) {
      ensureGapSource();
    }
  }

  function ensureGapSource() {
    const path = selectedPath();
    const file = selectedFile();
    if (path === undefined || file === undefined) {
      return;
    }
    const current = gapSource();
    if (current?.path === path && current.status !== "error") {
      return;
    }
    setGapSource({ path, status: "loading" });
    const model = gitModel();
    runtime
      .runPromise(Git.use((git) => git.fileSource(model.repoRoot, scope(), file)))
      .then((content) => {
        if (selectedPath() !== path) {
          return;
        }
        if (content.kind !== "text") {
          setGapSource({ path, status: "error" });
          return;
        }
        // Revealing lines shifts the index of everything below them; keep the caret on
        // Its file line across the async load. The synchronous toggle could not remap
        // Yet (the source was not loaded, so it revealed nothing), so do it here.
        batch(() => {
          const previous = navigableLines();
          const anchor = cursorIndex();
          const selAnchor = selectionAnchor();
          setGapSource({
            lines: content.text.replace(/\r?\n$/, "").split(/\r?\n/),
            path,
            status: "loaded",
          });
          const next = navigableLines();
          setCursorRow(remapCursorAfterToggle(previous, anchor, next));
          // Restore the anchor remapped (setCursorRow above cleared it) so a live
          // Selection survives the async reveal as the synchronous toggleGap kept it.
          if (selAnchor !== undefined) {
            setSelectionAnchor(remapCursorAfterToggle(previous, selAnchor, next));
          }
        });
      })
      .catch(() => {
        if (selectedPath() === path) {
          setGapSource({ path, status: "error" });
        }
      });
  }

  // The `z` action: fold/unfold the region at the caret. Unfold when the caret sits on
  // A folded header; otherwise fold the region it heads or is nested in; failing that,
  // Toggle the git-elided gap nearest the caret (hunk's "nearest to the selection").
  function toggleRegionAtCaret() {
    const lines = navigableLines();
    const index = cursorIndex();
    const caret = lines[index];
    if (caret === undefined) {
      return;
    }
    if (foldedRegions().has(foldKey(caret))) {
      toggleFold(foldKey(caret));
      return;
    }
    const regions = foldRegionsFor(lines, foldMode());
    const region =
      regions.find((candidate) => candidate.headerNavIndex === index) ??
      regions.find(
        (candidate) => candidate.headerNavIndex < index && index <= candidate.endNavIndex,
      );
    if (region !== undefined) {
      toggleFold(region.key);
      return;
    }
    const gap = nearestGapKey(index);
    if (gap !== undefined) {
      toggleGap(gap);
    }
  }

  function nearestGapKey(cursorRow: number) {
    const rows = viewerRows();
    const caretPos = rows.findIndex((row) => row.kind === "line" && row.navIndex === cursorRow);
    const from = caretPos === -1 ? rows.length - 1 : caretPos;
    for (let index = from; index >= 0; index -= 1) {
      const row = rows[index];
      if (row?.kind === "marker" && row.regionKind === "gap") {
        return row.key;
      }
    }
    for (let index = from + 1; index < rows.length; index += 1) {
      const row = rows[index];
      if (row?.kind === "marker" && row.regionKind === "gap") {
        return row.key;
      }
    }
    return undefined;
  }

  // A jump (diagnostic, symbol, reference, find) may target a line a fold is hiding.
  // Clear the fold(s) covering it so the jump can land; the Viewer's jump effect
  // Re-runs on the resulting navigable change and finds the now-visible line.
  function revealLineForJump(line: number) {
    const view = diffView();
    if (view === undefined) {
      return false;
    }
    const rawIndex = view.render.navigable.findIndex((navigable) => navigable.newLine === line);
    if (rawIndex === -1) {
      return false;
    }
    const covering = foldRegionsFor(view.render.navigable, foldMode()).filter(
      (region) =>
        region.headerNavIndex < rawIndex &&
        rawIndex <= region.endNavIndex &&
        foldedRegions().has(region.key),
    );
    if (covering.length === 0) {
      return false;
    }
    const next = new Set(foldedRegions());
    for (const region of covering) {
      next.delete(region.key);
    }
    setFoldedRegions(next);
    return true;
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
                }
              }),
            ),
          ),
        ),
        { signal: controller.signal },
      );
      report(failures[0] ?? "checks passed", failures[0] !== undefined ? "error" : "success");
    } catch {
      // Interrupted by a newer run or a worktree switch
    } finally {
      if (checksController === controller) {
        setChecksRunning(false);
      }
    }
  }

  // A download starting/finishing drives the live "installing…" status: add on start, drop on
  // Finish. Finishing also re-runs checks so the language's files resolve from pending.
  runtime.runFork(
    Provisioner.use((provisioner) =>
      Queue.take(provisioner.starts).pipe(
        Effect.flatMap((language) =>
          Effect.sync(() => setProvisioningLanguages((current) => new Set(current).add(language))),
        ),
        Effect.forever,
      ),
    ),
  );
  runtime.runFork(
    Provisioner.use((provisioner) =>
      Queue.take(provisioner.completions).pipe(
        Effect.flatMap((language) =>
          Effect.sync(() => {
            setProvisioningLanguages((current) => {
              const next = new Set(current);
              next.delete(language);
              return next;
            });
            void runChecks(gitModel());
          }),
        ),
        Effect.forever,
      ),
    ),
  );
  // A server nudging `workspace/diagnostic/refresh` (rust-analyzer after a cargo-check cycle)
  // Re-runs checks, exactly like a finished download; a nudge from another repo's pooled server
  // (a just-switched-away worktree) is ignored rather than churning the current one.
  runtime.runFork(
    LspProcess.use((lsp) =>
      Queue.take(lsp.refreshes).pipe(
        Effect.flatMap((refreshedRoot) =>
          Effect.sync(() => {
            if (refreshedRoot === gitModel().repoRoot) {
              void runChecks(gitModel());
            }
          }),
        ),
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

  // Keep the intel-capable server for the viewed repo warm across the whole session so the first
  // Intel action never pays a cold spawn plus project load (the stall). The seed latches to the most
  // Recent intel-capable file in the current repo and stays put across non-code detours (a README,
  // JSON, an image), so browsing one of those never tears the hold down and lets the 30s idle TTL
  // Reap the server. It resets when the repo changes; a worktree switch re-keys the seed and releases
  // The old server, quit disposes the root. `Effect.scoped` holds the acquire until the abort
  // Interrupts the never-resolving fiber, at which point the scope closes and the pool reference drops.
  const warmSeed = createMemo<{ root: string; path: string } | undefined>((prev) => {
    const root = repoRoot();
    if (root === "") {
      return undefined;
    }
    // Already latched for this repo: keep the seed (and stop tracking selectedPath) so non-code
    // Files don't churn or drop the hold.
    if (prev?.root === root) {
      return prev;
    }
    const path = selectedPath();
    return path !== undefined && intelLanguage(path, root) !== undefined
      ? { path, root }
      : undefined;
  });
  createEffect(() => {
    const seed = warmSeed();
    if (seed === undefined) {
      return;
    }
    const controller = new AbortController();
    runtime
      .runPromise(Effect.scoped(Intel.use((intel) => intel.warmHold(seed.root, seed.path))), {
        signal: controller.signal,
      })
      .catch(() => {});
    onCleanup(() => controller.abort());
  });

  // Drop the switched-to repo's cached intel on a worktree switch: its cache may hold entries from
  // An earlier visit that changed while the watcher for that root was inactive. Repo-wide is the
  // Safe grain (an edit to one file can move a references or call-hierarchy result queried from
  // Another), and this fires only on an actual repo change, not a scope re-resolve. Within one
  // Repo, invalidation is driven per working-tree write by the filesystem watcher (see the refresh
  // Effect): the cache keys off working-tree content, so a baseline move (commit, staging) never
  // Touches a tracked file and leaves still-valid entries intact.
  createEffect(
    on(repoRoot, (root, prev) => {
      if (prev === undefined || root === "" || root === prev) {
        return;
      }
      runtime.runPromise(Intel.use((intel) => intel.invalidate(root, []))).catch(() => {});
    }),
  );

  // Safety-poll fallback for intel invalidation. The watcher drives per-write invalidation
  // Precisely (it catches every working-tree write, including a revert, a deletion, or a
  // Non-advancing-mtime write), but it is best-effort: a platform whose fs.watch never delivers
  // (no inotify, a sandbox, a network filesystem) or a dropped event would otherwise leave intel
  // Stale with no floor, the same failure the git refresh covers with its slow poll. So whenever
  // The poll (or the watcher) surfaces a model whose newest mtime advanced, invalidate repo-wide
  // Too. `changedContentAdvanced` is deliberately conservative: a commit, staging, or scope
  // Re-resolve moves no mtime, so this stays silent on a baseline move and never over-invalidates.
  // It is redundant with the watcher on a healthy platform (a harmless second repo-wide clear) and
  // Is the correctness floor where the watcher misses.
  createEffect(
    on(gitModel, (model, prev) => {
      if (prev === undefined || model.repoRoot === "" || model === prev) {
        return;
      }
      // A repo switch is handled by the repoRoot effect above; within one repo, gate on a real edit.
      if (prev.repoRoot !== model.repoRoot || !changedContentAdvanced(prev, model)) {
        return;
      }
      runtime
        .runPromise(Intel.use((intel) => intel.invalidate(model.repoRoot, [])))
        .catch(() => {});
    }),
  );

  // Jump the viewer to the definition of the symbol under the caret. Read-only LSP pull
  // (`textDocument/definition`) over the warm server pool; degrades to a notice, never throws.
  // The shared precondition for a caret-anchored pull: the caret must sit on a symbol in the
  // Current file's text. A gap or line-level caret has no position to resolve, and a removed
  // (old-only) line isn't in the file the server reads. Returns the file line (1-based) so the
  // Caller can pass `line - 1` as the LSP position; undefined (after a notice) means don't pull.
  function caretTarget() {
    const path = selectedPath();
    const line = cursorLineNumber();
    if (path === undefined || line === undefined) {
      return undefined;
    }
    if (caretWord() === undefined) {
      notify("no symbol at caret");
      return undefined;
    }
    if (cursorLine()?.newLine === undefined) {
      notify("can't resolve a removed line");
      return undefined;
    }
    return { line, path };
  }

  // The jump-or-list pull shared by go-to-definition and find-implementations: both resolve the
  // Caret to locations, then a single in-repo target jumps while several open the references
  // Overlay to pick from. They differ only in the LSP method, the in-flight status, the overlay
  // Label, and the notices. The caller owns the abort/controller/caret setup (so the deliberate
  // "supersede even when a guard no-ops" behavior stays there), and passes a `pull` thunk closing
  // Over the resolved caret; this owns the status indicator and the result handling.
  async function resolveAndJump(
    controller: AbortController,
    requestRoot: string,
    statusText: string,
    label: "definitions" | "implementations",
    notices: { none: string; outside: string },
    pull: () => Effect.Effect<NormalizedLocation[], IntelRequestError, Intel>,
  ) {
    setIntelStatus(statusText);
    try {
      const locations = await runtime.runPromise(pull(), { signal: controller.signal });
      // A worktree switch mid-request leaves these paths resolving against the old repo, so a jump
      // Would land on a stale or missing file; drop the result unless the root still matches.
      if (controller.signal.aborted || repoRoot() !== requestRoot) {
        return;
      }
      if (locations.length === 0) {
        notify(notices.none);
        return;
      }
      // The service relativizes in-repo paths; an out-of-repo target (e.g. node_modules) stays
      // Absolute and the tree can't open it, so jump to the first in-repo result instead.
      const inRepo = locations
        .filter((location) => !isAbsolute(location.path))
        .toSorted(byReferenceOrder);
      const target = inRepo[0];
      if (target === undefined) {
        notify(notices.outside);
        return;
      }
      // More than one result (an overloaded symbol, or an interface with several implementors) is a
      // Pick, not a jump: read each target's source line and hand the set to the references overlay.
      if (inRepo.length > 1) {
        const linesByPath = await readReferenceLines(requestRoot, inRepo, controller.signal);
        if (intelController !== controller || repoRoot() !== requestRoot) {
          return;
        }
        openReferences(label, attachReferencePreviews(inRepo, linesByPath));
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
      // A superseding request installs its own controller and indicator, so only the latest
      // Invocation clears the busy state; the aborted one leaves it alone.
      if (intelController === controller) {
        setIntelStatus(undefined);
      }
    }
  }

  async function goToDefinition() {
    // A fresh invocation supersedes any in-flight lookup, even when the guard below no-ops, so a
    // Stale result can't land a jump after the user has moved on.
    intelController?.abort();
    const caret = caretTarget();
    if (caret === undefined) {
      return;
    }
    const { line, path } = caret;
    const controller = new AbortController();
    intelController = controller;
    const requestRoot = repoRoot();
    await resolveAndJump(
      controller,
      requestRoot,
      "resolving definition…",
      "definitions",
      { none: "no definition", outside: "definition outside repo" },
      () =>
        Intel.use((intel) =>
          intel.definition(requestRoot, path, { character: cursorColumn(), line: line - 1 }),
        ),
    );
  }

  async function findImplementations() {
    intelController?.abort();
    const caret = caretTarget();
    if (caret === undefined) {
      return;
    }
    const { line, path } = caret;
    const controller = new AbortController();
    intelController = controller;
    const requestRoot = repoRoot();
    await resolveAndJump(
      controller,
      requestRoot,
      "resolving implementations…",
      "implementations",
      { none: "no implementations", outside: "implementations outside repo" },
      () =>
        Intel.use((intel) =>
          intel.implementation(requestRoot, path, { character: cursorColumn(), line: line - 1 }),
        ),
    );
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
    hierarchyAnchor = undefined;
    setReferencesOpen(false);
    setReferencesResults([]);
    setReferencesIndex(0);
    setReferencesScrollTop(0);
    setReferencesStatus("loading");
  }

  // The repoRoot the open overlay's results belong to, captured on open so the drift
  // Effect below can close it when a worktree switch moves off that repo.
  let referencesRoot: string | undefined;

  // What produced the open overlay when it is a call hierarchy: the caret it was pulled from plus
  // The current direction, so `Tab` can re-resolve the other direction against the same symbol.
  // References/definitions carry no direction, so they leave this undefined and `Tab` is a no-op.
  interface HierarchyAnchor {
    root: string;
    path: string;
    position: { character: number; line: number };
    direction: "incoming" | "outgoing";
  }
  let hierarchyAnchor: HierarchyAnchor | undefined;

  function openReferences(
    label: ReturnType<typeof referencesLabel>,
    results: ReferenceResult[],
    anchor?: HierarchyAnchor,
  ) {
    referencesRoot = repoRoot();
    hierarchyAnchor = anchor;
    batch(() => {
      setReferencesLabel(label);
      setReferencesResults(results);
      setReferencesIndex(0);
      setReferencesScrollTop(0);
      setReferencesStatus("ready");
      setReferencesOpen(true);
    });
  }

  // Drive a location-list pull (references or a call hierarchy) into the references overlay: open it
  // At once in a loading state, then resolve in place to the list, an empty screen, or an error.
  // The `anchor` is the direction context for a hierarchy (undefined for references, which clears any
  // Prior one so `Tab` is a no-op); `label` drives the header and empty text. The caller owns the
  // Abort/controller setup, so the deliberate "supersede even when a guard no-ops" behavior stays put.
  async function openReferencesPull(
    controller: AbortController,
    requestRoot: string,
    label: ReturnType<typeof referencesLabel>,
    anchor: HierarchyAnchor | undefined,
    pull: () => Effect.Effect<NormalizedLocation[], IntelRequestError, Intel>,
  ) {
    referencesRoot = requestRoot;
    hierarchyAnchor = anchor;
    batch(() => {
      // Drop any definition indicator a superseded pull left behind; progress shows in the overlay.
      setIntelStatus(undefined);
      setReferencesLabel(label);
      setReferencesResults([]);
      setReferencesIndex(0);
      setReferencesStatus("loading");
      setReferencesOpen(true);
    });
    try {
      const locations = await runtime.runPromise(pull(), { signal: controller.signal });
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
      openReferences(label, attachReferencePreviews(inRepo, linesByPath), anchor);
    } catch {
      if (intelController === controller) {
        setReferencesStatus("error");
      }
    }
  }

  // Find every use of the symbol under the caret via `textDocument/references`. Opens the
  // Results overlay at once in a loading state, then resolves it in place to the list, an
  // Empty screen, or an error; read-only, degrades to a notice, never throws.
  async function findReferences() {
    intelController?.abort();
    const caret = caretTarget();
    if (caret === undefined) {
      return;
    }
    const { line, path } = caret;
    const controller = new AbortController();
    intelController = controller;
    const requestRoot = repoRoot();
    // A plain references pull has no direction, so its undefined anchor clears any a prior open left.
    await openReferencesPull(controller, requestRoot, "references", undefined, () =>
      Intel.use((intel) =>
        intel.references(requestRoot, path, { character: cursorColumn(), line: line - 1 }),
      ),
    );
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

  const hierarchyLabel = (anchor: HierarchyAnchor) =>
    anchor.direction === "incoming" ? "incoming calls" : "outgoing calls";

  // The driver for the call hierarchy and its direction toggle: a two-step `prepare` → resolve pull
  // Surfaced through the references overlay via `openReferencesPull`. `Tab` calls back in with the
  // Flipped anchor, superseding the prior direction via the shared controller.
  async function runHierarchy(anchor: HierarchyAnchor) {
    intelController?.abort();
    const controller = new AbortController();
    intelController = controller;
    await openReferencesPull(controller, anchor.root, hierarchyLabel(anchor), anchor, () =>
      Intel.use((intel) =>
        intel.callHierarchy(anchor.root, anchor.path, anchor.position, anchor.direction),
      ),
    );
  }

  // Call hierarchy (Shift+H) for the symbol under the caret, opening on incoming calls (who calls
  // This); `Tab` flips to outgoing. Read-only two-step LSP pull, degrades to a notice, never throws.
  function callHierarchy() {
    intelController?.abort();
    const caret = caretTarget();
    if (caret === undefined) {
      return;
    }
    const { line, path } = caret;
    void runHierarchy({
      direction: "incoming",
      path,
      position: { character: cursorColumn(), line: line - 1 },
      root: repoRoot(),
    });
  }

  // Flip the open call hierarchy's direction (incoming↔outgoing) and re-resolve the same symbol. A
  // No-op when the overlay is references/definitions, which carry no direction.
  function toggleReferencesDirection() {
    const anchor = hierarchyAnchor;
    if (anchor !== undefined) {
      void runHierarchy({
        ...anchor,
        direction: anchor.direction === "incoming" ? "outgoing" : "incoming",
      });
    }
  }

  // The symbol outline overlay. Its own controller (not the shared `intelController`), since
  // It owns a separate overlay from definition/references and the two must not clobber each
  // Other's in-flight pull; captured `symbolsPath`/`symbolsRoot` scope the result to the file
  // And repo it was requested for, so a mid-request file switch or worktree switch drops it.
  let symbolsController: AbortController | undefined;
  let symbolsPath: string | undefined;
  let symbolsRoot: string | undefined;
  // The open file's ChangedFile identity when the outline was requested. A same-path content
  // Reload mints a new reference, so drifting off it closes the outline before its captured
  // Line:col positions go stale (the outline shows no source preview to reveal the mismatch).
  let symbolsFile: ReturnType<typeof selectedFile>;

  function resetSymbolsState() {
    setSymbolsOpen(false);
    setSymbolsResults([]);
    setSymbolsIndex(0);
    setSymbolsScrollTop(0);
    setSymbolsStatus("loading");
  }

  function closeSymbols() {
    symbolsController?.abort();
    symbolsController = undefined;
    batch(resetSymbolsState);
  }

  // Fill the overlay with a ready result set, anchoring it to the file/repo/content it belongs to
  // So the drift effect closes it when any of those move. `findSymbols` only reaches here once its
  // Guard has confirmed the selection did not move during the pull, so these live reads match the
  // Request; a direct caller (tests injecting results) anchors to the current selection. Mirrors
  // `openReferences`.
  function openSymbols(results: NormalizedSymbol[]) {
    symbolsPath = selectedPath();
    symbolsRoot = repoRoot();
    symbolsFile = selectedFile();
    batch(() => {
      setSymbolsResults(results);
      setSymbolsIndex(0);
      setSymbolsScrollTop(0);
      setSymbolsStatus("ready");
      setSymbolsOpen(true);
    });
  }

  // List the open file's symbols via `textDocument/documentSymbol` and open the outline overlay.
  // Unlike definition/references this needs no caret, only a viewed file: the whole document is
  // The query. Opens at once in a loading state, then resolves to the list, an empty screen, or
  // An error; read-only, degrades in place, never throws.
  async function findSymbols() {
    symbolsController?.abort();
    const path = selectedPath();
    if (path === undefined) {
      return;
    }
    // Capture the anchor once, up front, so every drift/staleness check keys off the file the
    // Request belongs to rather than a later live value.
    symbolsPath = path;
    symbolsRoot = repoRoot();
    symbolsFile = selectedFile();
    // No server advertises `documentSymbol` for this language, so a pull would return `[]` and read
    // As "no symbols" (a false claim). Short-circuit to a distinct state without issuing a request.
    if (serversProviding(path, "documentSymbol").length === 0) {
      symbolsController = undefined;
      batch(() => {
        setSymbolsResults([]);
        setSymbolsIndex(0);
        setSymbolsScrollTop(0);
        setSymbolsStatus("unsupported");
        setSymbolsOpen(true);
      });
      return;
    }
    const controller = new AbortController();
    symbolsController = controller;
    const requestRoot = symbolsRoot;
    batch(() => {
      setSymbolsResults([]);
      setSymbolsIndex(0);
      setSymbolsScrollTop(0);
      setSymbolsStatus("loading");
      setSymbolsOpen(true);
    });
    try {
      const symbols = await runtime.runPromise(
        Intel.use((intel) => intel.symbols(requestRoot, path)),
        { signal: controller.signal },
      );
      // A superseding request, a worktree switch, or a same-repo file switch drops this result: the
      // Newer request owns the overlay, a stale root would jump into the wrong repo, and a stale
      // Path would bind this file's outline to a different open file (the guard closes the race
      // Window before the drift effect has flushed).
      if (
        symbolsController !== controller ||
        repoRoot() !== requestRoot ||
        selectedPath() !== path
      ) {
        return;
      }
      if (symbols.length === 0) {
        setSymbolsStatus("empty");
        return;
      }
      openSymbols(symbols);
    } catch {
      if (symbolsController === controller) {
        setSymbolsStatus("error");
      }
    }
  }

  // Jump to a symbol (Enter or a click) and dismiss the overlay. The outline is always the
  // Currently open file, so it jumps within `symbolsPath` (captured on open) rather than a
  // Result-carried path; escalate flips to full-file view when the line is outside the diff.
  function jumpToSymbol(index: number) {
    const target = symbolsResults()[index];
    if (target === undefined || symbolsPath === undefined) {
      return;
    }
    const path = symbolsPath;
    symbolsController?.abort();
    symbolsController = undefined;
    batch(() => {
      selectFile(path, { column: target.column, escalate: true, line: target.line });
      setFocusedPane("diff");
      resetSymbolsState();
    });
  }

  // The outline belongs to one file's content in one repo, so it goes stale the moment any of those
  // Drifts (a worktree switch, navigating to another file, or the open file's own content
  // Reloading); close it, aborting any in-flight pull.
  createEffect(() => {
    if (
      symbolsOpen() &&
      (repoRoot() !== symbolsRoot ||
        selectedPath() !== symbolsPath ||
        selectedFile() !== symbolsFile)
    ) {
      closeSymbols();
    }
  });

  // The active scope's identity, so a scope switch that leaves the path unchanged
  // Still drifts the anchor off the now-different diff. Includes headRef (the pinned
  // Sha for a commit scope), or two sibling commits sharing a first-parent would read
  // As the same scope and never drift the hover card / command menu (mirrors scopeKey).
  const scopeIdentity = () => `${scope().kind}:${scope().ref}:${scope().headRef ?? ""}`;

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
    const caret = caretTarget();
    if (caret === undefined) {
      return;
    }
    const { line, path } = caret;
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

  // Drop the line selection when the viewed content's identity changes (file,
  // Scope, or worktree): a navIndex anchor is meaningless against a different line
  // List. This is the structural backstop for every reload path (the scope menu,
  // A worktree switch, empty-worktree recovery) that does not route through the
  // Caret/`goToLocation` clears. It deliberately does not track the git model, so a
  // Background refresh of the same file keeps the selection instead of dropping it.
  createEffect(
    on([selectedPath, scopeIdentity, repoRoot], () => setSelectionAnchor(undefined), {
      defer: true,
    }),
  );

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

  // Copy the selected lines' source text (no sign, no gutter), or the caret line
  // When there is no selection. Reads the on-screen `navigableLines`, so a folded or
  // Git-elided region is naturally excluded (it never enters that list). Reuses the
  // Shared `copy` sink for the pbcopy/wl-copy path and the success/error notice.
  function copySelection() {
    const range = selectionRange();
    if (range === undefined) {
      if (cursorLine() === undefined) {
        return;
      }
      copy(cursorLineContent(), "copied 1 line");
      return;
    }
    const count = range[1] - range[0] + 1;
    copy(selectionText(), `copied ${count} line${count === 1 ? "" : "s"}`);
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

  // Open the context menu on a pane. A right-click passes its exact cell as `anchor`;
  // The keyboard trigger omits it, so the tree menu falls back to the focused row and
  // The viewer menu derives its anchor from the caret (stored as none). A no-op when
  // The context has no items (defensive: every real context has one).
  function openCommandMenu(context: "tree" | "viewer", anchor?: { x: number; y: number }) {
    const items = buildCommandMenuItems(commandMenuInput(context));
    if (items.length === 0) {
      return;
    }
    batch(() => {
      setCommandMenuContext(context);
      setCommandMenuAnchor(
        context === "viewer"
          ? undefined
          : (anchor ?? { x: 2, y: 2 + focusedRowIndex() - sidebarScrollTop() }),
      );
      setCommandMenuIndex(0);
      // Snapshot the context so the clear effect can dismiss the menu the moment a
      // Click or refresh drifts the caret/focus/file it was opened against.
      setCommandMenuGuard({
        caretLineLevel: caretLineLevel(),
        context,
        cursorColumn: cursorColumn(),
        cursorIndex: cursorIndex(),
        focusedNodeId: focusedNodeId(),
        focusedPane: focusedPane(),
        path: selectedPath(),
        repoRoot: repoRoot(),
        scope: scopeIdentity(),
        scrollTop: viewerScrollTop(),
        scrollX: viewerScrollX(),
        sidebarScrollTop: sidebarScrollTop(),
      });
      setCommandMenuOpen(true);
    });
  }

  function closeCommandMenu() {
    batch(() => {
      setCommandMenuOpen(false);
      setCommandMenuGuard(undefined);
    });
  }

  // Dismiss the menu the instant its opening context drifts (a click elsewhere moves
  // The caret or focus, a scope/worktree change reloads the diff), so its open state
  // Can never outlive the anchored render and trap the keyboard. Mirrors the hover
  // Card's clear effect.
  createEffect(() => {
    const guard = commandMenuGuard();
    if (guard === undefined) {
      return;
    }
    if (
      focusedPane() !== guard.focusedPane ||
      selectedPath() !== guard.path ||
      scopeIdentity() !== guard.scope ||
      repoRoot() !== guard.repoRoot ||
      (guard.context === "tree"
        ? focusedNodeId() !== guard.focusedNodeId || sidebarScrollTop() !== guard.sidebarScrollTop
        : cursorIndex() !== guard.cursorIndex ||
          cursorColumn() !== guard.cursorColumn ||
          caretLineLevel() !== guard.caretLineLevel ||
          viewerScrollTop() !== guard.scrollTop ||
          viewerScrollX() !== guard.scrollX)
    ) {
      closeCommandMenu();
    }
  });

  // Open a file in the OS default application. A GUI handler that stet neither owns nor waits on
  // (fork-and-forget, no renderer suspend), so it lives in `state` and is reached directly by the
  // Keymap and the command menu, unlike the terminal editor which needs the renderer.
  function openExternally(path: string) {
    const argv = openExternalCommand(join(gitModel().repoRoot, path));
    if (argv === undefined) {
      notify("open externally isn't supported on this platform", "warning");
      return;
    }
    runtime.runFork(
      Editor.use((editor) => editor.openExternal(argv, gitModel().repoRoot)).pipe(
        Effect.tap((code) =>
          code === 0 ? Effect.void : Effect.sync(() => notify("couldn't open the file", "warning")),
        ),
        Effect.catchTag("EditorError", (error) =>
          Effect.sync(() => notify(`couldn't open externally: ${error.message}`, "error")),
        ),
      ),
    );
  }

  // Run a menu item's action by dispatching to the existing state action. `openEditor`
  // Is excluded: it needs the renderer, so the keymap (host) and the row click
  // (useRenderer) run it themselves; every other action is pure state.
  function dispatchCommandAction(action: Exclude<CommandAction, { kind: "openEditor" }>) {
    switch (action.kind) {
      case "goToDefinition": {
        void goToDefinition();
        return;
      }
      case "findReferences": {
        void findReferences();
        return;
      }
      case "callHierarchy": {
        callHierarchy();
        return;
      }
      case "findImplementations": {
        void findImplementations();
        return;
      }
      case "showHover": {
        void showHover();
        return;
      }
      case "findSymbols": {
        void findSymbols();
        return;
      }
      case "copyReference": {
        copy(formatCopyReference({ column: action.column, line: action.line, path: action.path }));
        return;
      }
      case "copyFileContents": {
        copyFileContents();
        return;
      }
      case "loadFullContent": {
        loadFullContent();
        return;
      }
      case "pinTab": {
        // Open the right-clicked file, then pin it (the double-click gesture): the
        // Menu is anchored on that node, not on whatever the viewer currently shows.
        selectFile(action.path);
        pinActiveTab();
        return;
      }
      case "openExternal": {
        openExternally(action.path);
        return;
      }
    }
  }

  // The only writer of `worktreeSummaries`. Reached from two places: the picker's
  // Open (so a single-worktree repo, which the background poll skips, still fills
  // Its row) and the peer poll below.
  function refreshWorktreeSummaries(list: readonly Worktree[], root: string) {
    return runtime
      .runPromise(Git.use((git) => git.worktreeSummaries(list, root)))
      .then((summaries) => {
        setWorktreeSummaries((previous) => mergeWorktreeSummaries(previous, summaries));
      })
      .catch(() => {});
  }

  function openWorktreePicker() {
    batch(() => {
      setWorktreeComboboxOpen(true);
      setWorktreeComboboxIndex(0);
      setWorktreeComboboxQuery("");
      setWorktrees(undefined);
    });
    loadWorktrees(gitModel().repoRoot);
  }

  function loadWorktrees(root: string) {
    runtime
      .runPromise(Git.use((git) => git.worktrees(root)))
      .then((list) => {
        const selectable = list.filter((worktree) => !worktree.bare);
        // Ordered once, here: the rows read their ages live from the summary map,
        // But the order is fixed at open, so a summary landing while the picker is
        // Up can never reshuffle the list under the cursor.
        const ordered = orderWorktrees(selectable, worktreeSummaries());
        batch(() => {
          setWorktrees(ordered);
          // Seed the highlight on the current worktree only when no query has been
          // Typed while loading was in flight; a query filters the list, so the
          // Full-list position could be out of range. The input resets to 0 on type.
          setWorktreeComboboxIndex(
            worktreeComboboxQuery() === ""
              ? Math.max(
                  0,
                  ordered.findIndex((worktree) => worktree.path === root),
                )
              : 0,
          );
        });
        void refreshWorktreeSummaries(ordered, root);
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

  const LOG_LIMIT = 30;

  // The recent commits are a snapshot loaded when the drill-down opens, guarded so
  // A stale load (or one from a superseded open) can't overwrite a newer list.
  let commitsLoad = 0;
  function loadCommits(root: string) {
    const token = (commitsLoad += 1);
    // Clear the prior snapshot so nothing can select a stale row while the reload
    // Is in flight (the "loading" view hides the list, so this never flashes).
    setCommits([]);
    setCommitsStatus("loading");
    setCommitsNow(Math.floor(Date.now() / 1000));
    runtime
      .runPromise(Git.use((git) => git.recentCommits(root, LOG_LIMIT)))
      .then((loaded) => {
        if (token === commitsLoad) {
          setCommits(loaded);
          setCommitsStatus(loaded.length === 0 ? "empty" : "ready");
        }
      })
      .catch(() => {
        if (token === commitsLoad) {
          setCommits([]);
          setCommitsStatus("error");
        }
      });
  }

  // Pin the viewer to one commit shown as its own diff (its first parent..the
  // Commit), reusing the range-scope pipeline. Synchronous: the parent came with
  // The log, so no ref resolution is needed. Returns whether a commit was pinned
  // (false for an out-of-range index, e.g. an empty/loading list), so the caller
  // Only closes the picker on a real selection. Bumps the async-scope token so a
  // Pending last-commit resolution can't clobber the commit just pinned.
  function selectCommit(index: number) {
    const commit = commits()[index];
    if (commit === undefined) {
      return false;
    }
    scopeSelection += 1;
    setSelectedCommit(commit);
    setScope({ headRef: commit.sha, kind: "commit", ref: commit.parent });
    return true;
  }

  // The header names the active commit by its subject alone (the sha lives in the
  // Picker); the "commit ·" scope marker at the diff already says it is a commit.
  // Read from the commit captured at selection, so the label holds even after the
  // Commit ages out of the reloaded list.
  const commitScopeLabel = createMemo(() => {
    const commit = selectedCommit();
    if (commit === undefined) {
      return "commit";
    }
    // Return the full subject; the header budgets it to the width it actually has.
    return commit.subject;
  });

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
    if (active.kind === "commit") {
      // A pinned commit SHA has no meaning in the target worktree; fall back to the
      // Default all-changes lens (the drill-down reloads against the new history).
      return { scope: { kind: "all", ref: cliBaseRef() } satisfies DiffScope, sessionBase: head };
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
                if (
                  repoRoot() === root &&
                  (!existsSync(root) || (main !== "" && !existsSync(main)))
                ) {
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
          // Fs-watch tick per change (which also records watcher health and, on a
          // Tracked working-tree write, invalidates the content-keyed intel cache),
          // And a safety poll whose cadence adapts to that health — fast where the
          // Watcher is unproven or has missed a change, slow once it has earned
          // Trust. See `refreshDelay`.
          const watchTicks = Stream.unwrap(
            Effect.gen(function* watchStream() {
              const watcher = yield* Watcher;
              return watcher.changes(root);
            }),
          ).pipe(
            Stream.tap(() => Effect.sync(() => setLastWatcherTick(Date.now()))),
            // A write to a file git tracks (or already counts as changed) alters what the language
            // Server reads, so drop the repo's cached intel. Gate on tracked-ness: the watcher also
            // Sees gitignored churn (`node_modules/`, `dist/`) an agent generates, which must not
            // Wipe the warm cache, and a git-internal or nameless batch carries no path at all.
            Stream.tap((paths) =>
              paths.some((path) => repoFilePaths().has(path) || gitModel().changedByPath.has(path))
                ? Intel.use((intel) => intel.invalidate(root, [])).pipe(Effect.ignore)
                : Effect.void,
            ),
            Stream.map(() => undefined),
          );
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

  // Keep every worktree's summary warm, so the header can say that an agent is working
  // Somewhere else and the picker opens on real ages instead of a loading row. Polled
  // Rather than watched: only the active worktree earns an fs watcher, and the ages this
  // Feeds are real timestamps (a file mtime, a reflog mtime, a commit date), so a poll that
  // Runs late still reports an exact age; only its appearance lags, by at most one tick.
  //
  // `git worktree list` is also the discovery mechanism, so it cannot be resolved once at
  // Startup: an agent can create a worktree mid-session. It is a cheap directory read, and a
  // Repo with a single worktree stops there, never paying for a `git status` it has no peer
  // To compare against.
  createEffect(() => {
    const root = repoRoot();
    if (root === "") {
      return;
    }
    const controller = new AbortController();
    runtime
      .runPromise(
        Effect.gen(function* peerSummaryLoop() {
          const git = yield* Git;
          while (true) {
            const list = yield* git.worktrees(root).pipe(Effect.orElseSucceed(() => []));
            const selectable = list.filter((worktree) => !worktree.bare);
            if (selectable.length > 1) {
              yield* Effect.promise(() => refreshWorktreeSummaries(selectable, root));
            }
            yield* Effect.sleep(PEER_SUMMARY_MS);
          }
        }),
        { signal: controller.signal },
      )
      .catch(() => {});
    onCleanup(() => controller.abort());
  });

  // Tick the recency clock once a second while anything is still fading, then stop. Drives the
  // Tree's fading recency dots, the status bar's fading activity path, and every age in the worktree
  // Picker (all read now()). The two sources decay over different windows, so each keeps the clock
  // Awake for its own: a changed file for RECENT_MS, a worktree being worked in for the much longer
  // WORKTREE_ACTIVE_MS.
  //
  // `worktreeAt` spans **every** worktree, including the one being inspected: the picker fades an
  // Age for the worktree you are *in* too, so excluding it would freeze that row 30s after its last
  // Edit (once the file log ages out of RECENT_MS), leaving it reading `now` in fresh pink minutes
  // After the agent stopped.
  createEffect(() => {
    const fileAt = latestActivity(activityLog())?.at ?? 0;
    const worktreeAt = Math.max(
      0,
      ...[...worktreeSummaries().values()].map((summary) => summary.lastActivityAt ?? 0),
    );
    const fading = () =>
      Date.now() - fileAt < RECENT_MS || Date.now() - worktreeAt < WORKTREE_ACTIVE_MS;
    if ((fileAt === 0 && worktreeAt === 0) || !fading()) {
      setNow(Date.now());
      return;
    }
    const timer = setInterval(() => {
      setNow(Date.now());
      if (!fading()) {
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
    blameEnabled,
    callHierarchy,
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
    closeCommandMenu,
    closeReferences,
    closeSearch,
    closeSymbols,
    closeThemePicker,
    closeViewerDecoration,
    collapseSidebar,
    commandMenuAnchor,
    commandMenuContext,
    commandMenuIndex,
    commandMenuItems,
    commandMenuOpen,
    commitScopeLabel,
    commits,
    commitsNow,
    commitsStatus,
    copy,
    copyFileContents,
    copySelection,
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
    dispatchCommandAction,
    editorTemplate,
    expandedDirectories,
    extendSelectionTo,
    fileComboboxIndex,
    fileComboboxOpen,
    fileComboboxQuery,
    fileComboboxResults,
    fileView,
    findActive,
    findImplementations,
    findMatchPos,
    findMatches,
    findOpen,
    findQuery,
    findReferences,
    findSymbols,
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
    jumpToSymbol,
    lineMap,
    loadCommits,
    loadFullContent,
    mainView,
    mainWorktreePath,
    moveFocus,
    moveSearchSelection,
    navState,
    navigableLines,
    notify,
    now,
    nudgeSidebarWidth,
    openCommandMenu,
    openExternally,
    openFileCombobox,
    openReferences,
    openSearch,
    openSymbols,
    openThemePicker,
    openViewerDecoration,
    openWorktreePicker,
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
    provenanceForRow,
    quitConfirmOpen,
    recencyByPath,
    referencesIndex,
    referencesLabel,
    referencesOpen,
    referencesResults,
    referencesRows,
    referencesScrollTop,
    referencesStatus,
    referencesViewport,
    repoFilesLoading,
    repoRoot,
    resetFind,
    resetSidebarWidth,
    resolveViewerDecoration,
    revealLineForJump,
    runChecks,
    scope,
    scopeMenuIndex,
    scopeMenuOpen,
    scopeMenuView,
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
    selectCommit,
    selectFile,
    selectScope,
    selectedFile,
    selectedPath,
    selectionAnchor,
    selectionRange,
    selectionText,
    setActivityLog,
    setCaretLineLevel,
    setChangesOnly,
    setCheckerState,
    setCliBaseRef,
    setCommandMenuIndex,
    setCommits,
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
    setProvisioningLanguages,
    setQuitConfirmOpen,
    setReferencesIndex,
    setReferencesScrollTop,
    setRepoRoot,
    setScope,
    setScopeMenuIndex,
    setScopeMenuOpen,
    setScopeMenuView,
    setSearchFocus,
    setSearchGlob,
    setSearchIndex,
    setSearchQuery,
    setSearchScrollTop,
    setSearchSelection,
    setSelectionAnchor,
    setSessionBase,
    setSidebarOpen,
    setSidebarScrollTop,
    setSymbolsIndex,
    setSymbolsScrollTop,
    setTerminalHeight,
    setTerminalWidth,
    setThemeComboboxIndex,
    setThemeComboboxQuery,
    setViewerScrollTop,
    setViewerScrollX,
    setWorktreeComboboxIndex,
    setWorktreeComboboxOpen,
    setWorktreeComboboxQuery,
    setWorktreeSummaries,
    setWorktrees,
    showFileContent,
    showHover,
    sidebarOpen,
    sidebarScrollTop,
    sidebarWidth,
    status,
    statusHint,
    statusProvenanceCommit,
    statusRight,
    statusRightChangeKind,
    statusRightLevel,
    statusRightMessage,
    statusRightPath,
    statusRightRecencyAt,
    switchWorktree,
    symbolsIndex,
    symbolsOpen,
    symbolsResults,
    symbolsScrollTop,
    symbolsStatus,
    symbolsViewport,
    tabItems,
    terminalHeight,
    terminalWidth,
    themeComboboxIndex,
    themeComboboxOpen,
    themeComboboxOrigin,
    themeComboboxResults,
    toggleBlame,
    toggleFold,
    toggleGap,
    togglePinActiveTab,
    toggleReferencesDirection,
    toggleRegionAtCaret,
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
    viewerRows,
    viewerScrollTop,
    viewerScrollX,
    worktreeComboboxIndex,
    worktreeComboboxOpen,
    worktreeComboboxQuery,
    worktreeComboboxResults,
    worktreeSummaries,
    worktrees,
  };
}

// One global reactive root owns every signal/memo/effect for the app's lifetime
// (the process exits rather than disposing it), so module consumers can import
// Accessors directly without prop-drilling or a context provider.
export const state = createRoot(createState);

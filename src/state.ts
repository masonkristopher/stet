import { existsSync } from "node:fs";

import { Effect, Queue, Stream } from "effect";
import { batch, createEffect, createMemo, createRoot, createSignal, on, onCleanup } from "solid-js";

import type { DiffScope, ScopeKind } from "./cli";
import { Clipboard } from "./clipboard/service";
import { PROBLEMS_HEIGHT, SIDEBAR_MIN_WIDTH, SIDEBAR_VIEWER_MIN } from "./constants";
import {
  allFindings,
  countBySeverity,
  findingsLineMap,
  initialCheckerState,
  markPending,
} from "./diagnostics/checker";
import type { CheckerState, Diagnostic } from "./diagnostics/checker";
import { buildProblemItems, isNavigableProblemItem } from "./diagnostics/problems";
import { Provisioner } from "./diagnostics/provision";
import { Diagnostics } from "./diagnostics/service";
import { DiffEngine, structureDiff } from "./diff/engine";
import type { DiffRender, RenderInput } from "./diff/engine";
import { firstWord, lastWord, nextWord, prevWord, wordAt } from "./diff/words";
import { contentToContextPatch } from "./file/content";
import type { FileContent } from "./file/content";
import { File } from "./file/service";
import {
  emptyActivityLog,
  lastChangedAt,
  latestActivity,
  RECENT_MS,
  recordActivity,
} from "./git/activity";
import type { ActivityEventKind, ActivityLog } from "./git/activity";
import { changedPathsDiffer, EMPTY_TREE_SHA, mergeChanged } from "./git/model";
import type { ChangedFile, GitModel, Worktree } from "./git/model";
import type { SearchMatch } from "./git/search";
import { Git } from "./git/service";
import {
  buildTreeStructure,
  decorateTree,
  defaultExpandedDirectories,
  expandAncestorsForPath,
  flattenTree,
} from "./git/tree";
import { runtime } from "./runtime";
import { activeThemeName, selection, setSelection } from "./theme/active";
import { themeNames } from "./theme/registry";
import type { ThemeSelection } from "./theme/registry";
import { worktreeLabel } from "./ui-helpers";
import { findMatches as findMatchIndices } from "./utils/find";
import { rankFiles } from "./utils/fuzzy";
import { refreshDelay } from "./utils/refresh-cadence";
import { truncate } from "./utils/text";
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
import { Watcher } from "./watcher/service";

interface JumpTarget {
  path: string;
  line: number;
  // 1-based column to land the caret on (snapped to the word that owns it);
  // Undefined keeps the caret at the target line's first word.
  column?: number;
  escalate: boolean;
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
// Panel; hitting the cap sets `searchComboboxTruncated`, surfaced as a trailing "+".
const SEARCH_RESULT_CAP = 500;

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
  const [focusedPane, setFocusedPane] = createSignal<"tree" | "diff" | "problems">("tree");
  const [sidebarOpen, setSidebarOpen] = createSignal(true);
  const [sidebarWidthOverride, setSidebarWidthOverride] = createSignal<number | null>(null);
  const [problemsOpen, setProblemsOpen] = createSignal(false);
  const [problemIndex, setProblemIndex] = createSignal(0);
  const [fileComboboxOpen, setFileComboboxOpen] = createSignal(false);
  const [fileComboboxQuery, setFileComboboxQuery] = createSignal("");
  const [fileComboboxIndex, setFileComboboxIndex] = createSignal(0);
  const [searchComboboxOpen, setSearchComboboxOpen] = createSignal(false);
  const [searchComboboxQuery, setSearchComboboxQuery] = createSignal("");
  const [searchComboboxIndex, setSearchComboboxIndex] = createSignal(0);
  const [searchComboboxScope, setSearchComboboxScope] = createSignal<"changed" | "repo">("changed");
  const [searchComboboxResults, setSearchComboboxResults] = createSignal<SearchMatch[]>([]);
  const [searchComboboxTruncated, setSearchComboboxTruncated] = createSignal(false);
  const [findOpen, setFindOpen] = createSignal(false);
  const [findActive, setFindActive] = createSignal(false);
  const [findQuery, setFindQuery] = createSignal("");
  const [findMatchPos, setFindMatchPos] = createSignal(0);
  const [worktreeMenuOpen, setWorktreeMenuOpen] = createSignal(false);
  const [worktreeMenuIndex, setWorktreeMenuIndex] = createSignal(0);
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
  // An ephemeral acknowledgment of a user action (copied, scope changed, …),
  // Held for a fixed dwell so it outlives the keystroke that triggered it.
  const [notice, setNotice] = createSignal<string | undefined>(undefined);
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
  const treeStructure = createMemo(() =>
    buildTreeStructure(repoFiles(), changedPaths(), { changesOnly: changesOnly() }),
  );
  const tree = createMemo(() => decorateTree(treeStructure(), gitModel().changedByPath));
  const treeRows = createMemo(() => flattenTree(tree(), expandedDirectories()));
  const focusedRowIndex = createMemo(() => {
    const rows = treeRows();
    const index = rows.findIndex((row) => row.node.id === focusedNodeId());
    return index === -1 ? 0 : index;
  });
  const recencyByPath = createMemo(() => lastChangedAt(activityLog()));
  const problems = createMemo(() => allFindings(checkerState()));
  const counts = createMemo(() => countBySeverity(problems()));
  const lineMap = createMemo(() => {
    const path = selectedPath();
    return path === undefined
      ? new Map<number, Diagnostic[]>()
      : findingsLineMap(path, checkerState());
  });
  const allProblemItems = createMemo(() => buildProblemItems(checkerState()));
  // The first row the problems cursor can land on; headers and help sub-lines are
  // Skipped so opening the panel never parks the cursor on a non-navigable row.
  const firstNavigableProblemIndex = createMemo(() => {
    const index = allProblemItems().findIndex(isNavigableProblemItem);
    return index === -1 ? 0 : index;
  });
  const fileComboboxResults = createMemo(() => {
    if (!fileComboboxOpen()) {
      return [];
    }
    const model = gitModel();
    const allPaths = [
      ...new Set([...model.repoFiles.map((file) => file.path), ...model.changedByPath.keys()]),
    ];
    return rankFiles(fileComboboxQuery(), allPaths, {
      changed: new Set(model.changedByPath.keys()),
      lastChangedAt: recencyByPath(),
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

  // Project content search: debounced git grep over the changed set (honoring the
  // Active scope, since `changed` already reflects it) or the whole repo. Holds
  // The previous results until the new query resolves; cleanup aborts the prior
  // Grep and cancels a not-yet-fired keystroke, the same restart-on-rekey pattern
  // As the diff pipeline.
  const SEARCH_DEBOUNCE_MS = 120;
  createEffect(() => {
    const query = searchComboboxQuery();
    const paths =
      searchComboboxScope() === "changed" ? gitModel().changed.map((file) => file.path) : undefined;
    const root = repoRoot();
    if (
      !searchComboboxOpen() ||
      query === "" ||
      root === "" ||
      (paths !== undefined && paths.length === 0)
    ) {
      batch(() => {
        setSearchComboboxResults([]);
        setSearchComboboxTruncated(false);
      });
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      runtime
        .runPromise(
          Git.use((git) => git.search(root, query, paths)),
          {
            signal: controller.signal,
          },
        )
        // Drop a superseded query's results: a search can resolve just as a newer
        // Keystroke aborts its controller, so guard the write the same way.
        .then((matches) => {
          if (controller.signal.aborted) {
            return;
          }
          batch(() => {
            setSearchComboboxResults(matches.slice(0, SEARCH_RESULT_CAP));
            setSearchComboboxTruncated(matches.length > SEARCH_RESULT_CAP);
          });
        })
        // A genuine grep failure clears stale results; our own cancellation (the
        // Aborted controller on re-query) must leave the prior results in place.
        .catch(() => {
          if (!controller.signal.aborted) {
            batch(() => {
              setSearchComboboxResults([]);
              setSearchComboboxTruncated(false);
            });
          }
        });
    }, SEARCH_DEBOUNCE_MS);
    onCleanup(() => {
      clearTimeout(timer);
      controller.abort();
    });
  });

  const navigableLines = createMemo(() => diffView()?.render.navigable ?? []);
  const truncated = createMemo(() => {
    const content = diffView()?.fileContent;
    return (
      (diffView()?.render.truncated ?? false) || (content?.kind === "text" && content.truncated)
    );
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
  const viewerHeight = createMemo(() => Math.max(1, paneHeight() - 1));
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
  // Somewhere; the `b` toggle and a shrink-past-minimum share this one path.
  const collapseSidebar = () => {
    if (focusedPane() === "tree") {
      setFocusedPane("diff");
    }
    setSidebarOpen(false);
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
    return `${value.errors > 0 ? `✖${value.errors}` : ""}${value.warnings > 0 ? ` ⚠${value.warnings}` : ""}`.trim();
  });
  const statusRight = createMemo(() => {
    const hints = "? keys · q quit";
    const width = Math.max(10, Math.min(terminalWidth() - 50, terminalWidth() - hints.length - 4));
    // A held acknowledgment wins over ambient status for its dwell, so the user
    // Sees their action confirmed even as checks/activity churn underneath.
    const held = notice();
    if (held !== undefined) {
      return truncate(held, width);
    }
    const findings = cursorFindings();
    const latest = latestActivity(activityLog());
    const activityText =
      latest === undefined || now() - latest.at >= RECENT_MS
        ? ""
        : `${Math.max(0, Math.round((now() - latest.at) / 1000))}s ago ${latest.path}`;
    const displayStatus = checksRunning() ? "running checks…" : status();
    return truncate(
      findings?.[0] !== undefined
        ? `${findings[0].checker}: ${findings[0].message}`
        : [activityText, truncated() ? `${displayStatus} · truncated; f for full` : displayStatus]
            .filter((part) => part !== "")
            .join(" · "),
      width,
    );
  });

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

  // The Location to arrive at when opening `path` fresh: a revisit restores its
  // Remembered cursor/scroll from the MRU, a first visit defaults (first change,
  // Top). `fileView` always resets to the diff, matching the prior selectFile.
  function arrivingLocation(path: string, kind: "browse" | "jump"): Location {
    const remembered = recall(navState(), path);
    return {
      cursorColumn: remembered?.cursorColumn,
      cursorLine: remembered?.cursorLine,
      fileView: false,
      fullContent: fullContentPaths().has(path),
      kind,
      path,
      viewport: remembered?.viewport ?? { scrollTop: 0, scrollX: 0 },
    };
  }

  // Drive the live signals to a Location and enqueue its restore. The fullContent
  // Set is additive (a path stays un-truncated globally); back never re-truncates.
  function goToLocation(location: Location) {
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

  // All file navigation routes to the single preview tab (Zed's model): a pinned
  // Tab already showing `path` is focused (no dup); otherwise the preview tab is
  // Navigated in place (browse coalesces, jump pushes), or a fresh preview tab is
  // Opened when none exists (e.g. right after a pin).
  function navigateTo(path: string, kind: "browse" | "jump") {
    const nav = navState();
    const pinned = nav.tabs.find((tab) => !tab.preview && tab.entries[tab.index]?.path === path);
    if (pinned !== undefined) {
      activateTab(pinned.id);
      return;
    }
    const leaving = captureCurrent();
    const arriving = arrivingLocation(path, kind);
    const preview = nav.tabs.find((tab) => tab.preview);
    const id = preview === undefined ? String(nextTabId) : preview.id;
    if (preview === undefined) {
      nextTabId += 1;
    }
    batch(() => {
      setNavState((current) => {
        const recorded = recordLeaving(current, leaving);
        return preview === undefined
          ? openTab(recorded, arriving, id, true)
          : navigate({ ...recorded, activeTabId: preview.id }, arriving);
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

  function selectFile(path: string) {
    batch(() => {
      setFocusedNodeId(`file:${path}`);
      setExpandedDirectories((current) => expandAncestorsForPath(current, path));
      navigateTo(path, "jump");
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
      setStatus(failures[0] ?? installing ?? "checks finished");
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
  function notify(text: string) {
    setNotice(text);
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => setNotice(undefined), 1500);
  }

  function copy(text: string) {
    runtime
      .runPromise(Clipboard.use((clipboard) => clipboard.copy(text)))
      .then(() => notify(`copied ${text.split("\n")[0]}`))
      .catch((error: unknown) => notify(error instanceof Error ? error.message : String(error)));
  }

  function loadWorktrees(root: string) {
    runtime
      .runPromise(Git.use((git) => git.worktrees(root)))
      .then((list) => {
        const selectable = list.filter((worktree) => !worktree.bare);
        batch(() => {
          setWorktrees(selectable);
          setWorktreeMenuIndex(
            Math.max(
              0,
              selectable.findIndex((worktree) => worktree.path === root),
            ),
          );
        });
      })
      .catch((error: unknown) => {
        batch(() => {
          setWorktreeMenuOpen(false);
          setStatus(error instanceof Error ? (error.message.split("\n")[0] ?? "") : String(error));
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
    setWorktreeMenuOpen(false);
    if (worktree.path === gitModel().repoRoot) {
      return;
    }
    if (!existsSync(worktree.path)) {
      setStatus(`worktree missing: ${worktree.path}`);
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
        setActivityLog(emptyActivityLog);
        setFocusedPane("tree");
        setStatus(reason ?? `worktree: ${worktreeLabel(worktree)}`);
      });
      void runChecks(fresh);
    } catch (error) {
      if (request !== switchRequest) {
        return;
      }
      setStatus(error instanceof Error ? (error.message.split("\n")[0] ?? "") : String(error));
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
    canGoBack,
    canGoForward,
    caretColumn,
    caretLineLevel,
    caretNextWord,
    caretPrevWord,
    caretWord,
    changesOnly,
    checkerState,
    checksRunning,
    closeActiveTab,
    closeThemePicker,
    collapseSidebar,
    copy,
    counts,
    countsText,
    currentWorktreeDeleted,
    cursorColumn,
    cursorIndex,
    cursorLineContent,
    cursorLineNumber,
    cycleTab,
    diffView,
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
    firstNavigableProblemIndex,
    focusedNodeId,
    focusedPane,
    focusedRowIndex,
    fullContentPaths,
    gitModel,
    goBack,
    goForward,
    helpDialogOpen,
    iconsEnabled,
    ideTemplate,
    jumpTarget,
    lineMap,
    loadWorktrees,
    mainWorktreePath,
    moveFocus,
    navState,
    navigableLines,
    notify,
    now,
    nudgeSidebarWidth,
    openThemePicker,
    overflow,
    overlayLeft,
    overlayWidth,
    paneHeight,
    pendingRestore,
    pinActiveTab,
    problemIndex,
    problems,
    problemsOpen,
    recencyByPath,
    repoRoot,
    resetFind,
    resetSidebarWidth,
    runChecks,
    scope,
    scopeMenuIndex,
    scopeMenuOpen,
    searchComboboxIndex,
    searchComboboxOpen,
    searchComboboxQuery,
    searchComboboxResults,
    searchComboboxScope,
    searchComboboxTruncated,
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
    setRepoRoot,
    setScope,
    setScopeMenuIndex,
    setScopeMenuOpen,
    setSearchComboboxIndex,
    setSearchComboboxOpen,
    setSearchComboboxQuery,
    setSearchComboboxScope,
    setSessionBase,
    setSidebarOpen,
    setStatus,
    setTerminalHeight,
    setTerminalWidth,
    setThemeComboboxIndex,
    setThemeComboboxQuery,
    setViewerScrollTop,
    setViewerScrollX,
    setWorktreeMenuIndex,
    setWorktreeMenuOpen,
    setWorktrees,
    showFileContent,
    sidebarOpen,
    sidebarWidth,
    status,
    statusRight,
    switchWorktree,
    tabItems,
    terminalHeight,
    terminalWidth,
    themeComboboxIndex,
    themeComboboxOpen,
    themeComboboxOrigin,
    themeComboboxResults,
    togglePinActiveTab,
    treeRows,
    truncated,
    viewerHeight,
    viewerScrollTop,
    viewerScrollX,
    worktreeMenuIndex,
    worktreeMenuOpen,
    worktrees,
  };
}

// One global reactive root owns every signal/memo/effect for the app's lifetime
// (the process exits rather than disposing it), so module consumers can import
// Accessors directly without prop-drilling or a context provider.
export const state = createRoot(createState);

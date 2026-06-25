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
  type CheckerState,
  type Diagnostic,
} from "./diagnostics/checker";
import { buildProblemItems, isNavigableProblemItem } from "./diagnostics/problems";
import { Provisioner } from "./diagnostics/provision";
import { Diagnostics } from "./diagnostics/service";
import { DiffEngine, structureDiff, type DiffRender, type RenderInput } from "./diff/engine";
import { contentToContextPatch, type FileContent } from "./file/content";
import { File } from "./file/service";
import {
  emptyActivityLog,
  lastChangedAt,
  latestActivity,
  RECENT_MS,
  recordActivity,
  type ActivityEventKind,
  type ActivityLog,
} from "./git/activity";
import {
  EMPTY_TREE_SHA,
  mergeChanged,
  type ChangedFile,
  type GitModel,
  type Worktree,
} from "./git/model";
import type { SearchMatch } from "./git/search";
import { Git } from "./git/service";
import {
  buildFileTree,
  defaultExpandedDirectories,
  expandAncestorsForPath,
  flattenTree,
} from "./git/tree";
import { runtime } from "./runtime";
import { activeThemeName } from "./theme/active";
import { worktreeLabel } from "./ui-helpers";
import { findMatches as findMatchIndices } from "./utils/find";
import { rankFiles } from "./utils/fuzzy";
import { refreshDelay } from "./utils/refresh-cadence";
import { truncate } from "./utils/text";
import { Watcher } from "./watcher/service";

interface JumpTarget {
  path: string;
  line: number;
  escalate: boolean;
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
// Panel; hitting the cap sets `searchTruncated`, surfaced as a trailing "+".
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

function createState() {
  // --- writable primitives ---
  const [scope, setScope] = createSignal<DiffScope>({ kind: "all", ref: "HEAD" });
  // The CLI ref (default HEAD), the base for the all/staged scopes.
  const [cliBaseRef, setCliBaseRef] = createSignal("HEAD");
  // The SHA HEAD pointed at when sideye launched, pinned for the session scope.
  const [sessionBase, setSessionBase] = createSignal("HEAD");
  const [scopeOpen, setScopeOpen] = createSignal(false);
  const [scopeIndex, setScopeIndex] = createSignal(0);
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
  const [paletteOpen, setPaletteOpen] = createSignal(false);
  const [paletteQuery, setPaletteQuery] = createSignal("");
  const [paletteIndex, setPaletteIndex] = createSignal(0);
  const [searchOpen, setSearchOpen] = createSignal(false);
  const [searchQuery, setSearchQuery] = createSignal("");
  const [searchIndex, setSearchIndex] = createSignal(0);
  const [searchScope, setSearchScope] = createSignal<"changed" | "repo">("changed");
  const [searchResults, setSearchResults] = createSignal<SearchMatch[]>([]);
  const [searchTruncated, setSearchTruncated] = createSignal(false);
  const [findOpen, setFindOpen] = createSignal(false);
  const [findActive, setFindActive] = createSignal(false);
  const [findQuery, setFindQuery] = createSignal("");
  const [findMatchPos, setFindMatchPos] = createSignal(0);
  const [worktreeOpen, setWorktreeOpen] = createSignal(false);
  const [worktreeIndex, setWorktreeIndex] = createSignal(0);
  const [worktrees, setWorktrees] = createSignal<Worktree[] | undefined>(undefined);
  const [helpOpen, setHelpOpen] = createSignal(false);
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
  const tree = createMemo(() =>
    buildFileTree(gitModel().repoFiles, gitModel().changedByPath, { changesOnly: changesOnly() }),
  );
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
  const paletteResults = createMemo(() => {
    if (!paletteOpen()) {
      return [];
    }
    const model = gitModel();
    const allPaths = [
      ...new Set([...model.repoFiles.map((file) => file.path), ...model.changedByPath.keys()]),
    ];
    return rankFiles(paletteQuery(), allPaths, {
      changed: new Set(model.changedByPath.keys()),
      lastChangedAt: recencyByPath(),
      limit: 50,
    });
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
    const query = searchQuery();
    const paths =
      searchScope() === "changed" ? gitModel().changed.map((file) => file.path) : undefined;
    const root = repoRoot();
    if (
      !searchOpen() ||
      query === "" ||
      root === "" ||
      (paths !== undefined && paths.length === 0)
    ) {
      batch(() => {
        setSearchResults([]);
        setSearchTruncated(false);
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
            setSearchResults(matches.slice(0, SEARCH_RESULT_CAP));
            setSearchTruncated(matches.length > SEARCH_RESULT_CAP);
          });
        })
        // A genuine grep failure clears stale results; our own cancellation (the
        // Aborted controller on re-query) must leave the prior results in place.
        .catch(() => {
          if (!controller.signal.aborted) {
            batch(() => {
              setSearchResults([]);
              setSearchTruncated(false);
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
  const paletteWidth = createMemo(() => Math.max(30, Math.min(70, terminalWidth() - 8)));
  const paletteLeft = createMemo(() =>
    Math.max(0, Math.floor((terminalWidth() - paletteWidth()) / 2)),
  );

  // --- status / cursor view-model ---
  const cursorLine = createMemo(() => navigableLines()[cursorIndex()]);
  const cursorLineNumber = createMemo(() => {
    const line = cursorLine();
    return line?.newLine ?? line?.oldLine;
  });
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

  // --- actions ---
  function moveFocus(direction: number) {
    const rows = treeRows();
    const node = rows[Math.max(0, Math.min(focusedRowIndex() + direction, rows.length - 1))]?.node;
    if (node === undefined) {
      return;
    }
    setFocusedNodeId(node.id);
    if (node.type === "file") {
      setSelectedPath(node.path);
      setFileView(false);
    }
  }

  function selectFile(path: string) {
    batch(() => {
      setSelectedPath(path);
      setFocusedNodeId(`file:${path}`);
      setFileView(false);
      setExpandedDirectories((current) => expandAncestorsForPath(current, path));
    });
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
          setWorktreeIndex(
            Math.max(
              0,
              selectable.findIndex((worktree) => worktree.path === root),
            ),
          );
        });
      })
      .catch((error: unknown) => {
        batch(() => {
          setWorktreeOpen(false);
          setStatus(error instanceof Error ? (error.message.split("\n")[0] ?? "") : String(error));
        });
      });
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
    setWorktreeOpen(false);
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
        setSelectedPath(selected);
        setFocusedNodeId(selected === undefined ? "" : `file:${selected}`);
        setExpandedDirectories(
          selected === undefined ? expanded : expandAncestorsForPath(expanded, selected),
        );
        setFullContentPaths(new Set<string>());
        setFileView(false);
        setJumpTarget(undefined);
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
  // File list keeps its own slow poll. Re-keys only on repoRoot/scope; cleanup
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
    const refreshChanged = Git.use((git) => git.changedFiles(root, scopeNow)).pipe(
      Effect.tap((next) =>
        Effect.sync(() => {
          const prev = gitModel();
          if (prev.repoRoot === root) {
            setGitModel(mergeChanged(prev, next));
          }
        }),
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
    // Three refresh sources, merged through ONE serializing mapEffect so two
    // ChangedFiles reads can never overlap and write each other's stale result:
    // An immediate tick on (re)key, a debounced fs-watch tick per change (which
    // Also records watcher health), and a safety poll whose cadence adapts to
    // That health — fast where the watcher is unproven or has missed a change,
    // Slow once it has earned trust. See `refreshDelay`.
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
    const changedRefresh = Stream.mergeAll([Stream.make(undefined), watchTicks, safetyTicks], {
      concurrency: "unbounded",
    }).pipe(Stream.mapEffect(() => refreshChanged));
    const repoFilesPoll = Stream.fromEffect(
      Effect.gen(function* repoFilesLoop() {
        yield* Git.use((git) => git.repoFiles(root)).pipe(
          Effect.tap((next) =>
            Effect.sync(() => {
              const prev = gitModel();
              if (prev.repoRoot === root && prev.repoFilesKey !== next.repoFilesKey) {
                setGitModel({
                  ...prev,
                  repoFiles: next.repoFiles,
                  repoFilesKey: next.repoFilesKey,
                });
              }
            }),
          ),
          Effect.ignore,
        );
        yield* Effect.sleep("5 seconds");
      }),
    ).pipe(Stream.forever);
    runtime
      .runPromise(Stream.merge(changedRefresh, repoFilesPoll).pipe(Stream.runDrain), {
        signal: controller.signal,
      })
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
    activityLog,
    allProblemItems,
    changesOnly,
    checkerState,
    checksRunning,
    collapseSidebar,
    copy,
    counts,
    countsText,
    currentWorktreeDeleted,
    cursorIndex,
    cursorLineNumber,
    diffView,
    editorTemplate,
    expandedDirectories,
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
    helpOpen,
    iconsEnabled,
    ideTemplate,
    jumpTarget,
    lineMap,
    loadWorktrees,
    mainWorktreePath,
    moveFocus,
    navigableLines,
    notify,
    now,
    nudgeSidebarWidth,
    overflow,
    paletteIndex,
    paletteLeft,
    paletteOpen,
    paletteQuery,
    paletteResults,
    paletteWidth,
    paneHeight,
    problemIndex,
    problems,
    problemsOpen,
    recencyByPath,
    repoRoot,
    resetFind,
    resetSidebarWidth,
    runChecks,
    scope,
    scopeIndex,
    scopeOpen,
    searchIndex,
    searchOpen,
    searchQuery,
    searchResults,
    searchScope,
    searchTruncated,
    selectFile,
    selectScope,
    selectedFile,
    selectedPath,
    setActivityLog,
    setChangesOnly,
    setCheckerState,
    setCliBaseRef,
    setCurrentWorktreeDeleted,
    setCursorIndex,
    setEditorTemplate,
    setExpandedDirectories,
    setFileView,
    setFindActive,
    setFindMatchPos,
    setFindOpen,
    setFindQuery,
    setFocusedNodeId,
    setFocusedPane,
    setFullContentPaths,
    setGitModel,
    setHelpOpen,
    setIconsEnabled,
    setIdeTemplate,
    setJumpTarget,
    setLastChange,
    setMainWorktreePath,
    setNotice,
    setNow,
    setOverflow,
    setPaletteIndex,
    setPaletteOpen,
    setPaletteQuery,
    setProblemIndex,
    setProblemsOpen,
    setRepoRoot,
    setScope,
    setScopeIndex,
    setScopeOpen,
    setSearchIndex,
    setSearchOpen,
    setSearchQuery,
    setSearchScope,
    setSelectedPath,
    setSessionBase,
    setSidebarOpen,
    setStatus,
    setTerminalHeight,
    setTerminalWidth,
    setWorktreeIndex,
    setWorktreeOpen,
    setWorktrees,
    showFileContent,
    sidebarOpen,
    sidebarWidth,
    status,
    statusRight,
    switchWorktree,
    terminalHeight,
    terminalWidth,
    treeRows,
    truncated,
    viewerHeight,
    worktreeIndex,
    worktreeOpen,
    worktrees,
  };
}

// One global reactive root owns every signal/memo/effect for the app's lifetime
// (the process exits rather than disposing it), so module consumers can import
// Accessors directly without prop-drilling or a context provider.
export const state = createRoot(createState);

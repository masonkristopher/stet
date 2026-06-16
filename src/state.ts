import { Effect, Queue, Stream } from "effect";
import { batch, createEffect, createMemo, createRoot, createSignal, on, onCleanup } from "solid-js";

import type { DiffScope } from "./cli";
import { Clipboard } from "./clipboard/service";
import { PROBLEMS_HEIGHT } from "./constants";
import {
  allFindings,
  checkerNames,
  countBySeverity,
  findingsLineMap,
  initialCheckerState,
  markPending,
  type CheckerName,
  type CheckerState,
  type Diagnostic,
} from "./diagnostics/checker";
import { Provisioner } from "./diagnostics/provision";
import { Diagnostics } from "./diagnostics/service";
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
import { mergeChanged, type ChangedFile, type GitModel, type Worktree } from "./git/model";
import { renderPatch } from "./git/patch";
import type { SearchMatch } from "./git/search";
import { Git } from "./git/service";
import { buildFileTree, expandAncestorsForPath, flattenTree } from "./git/tree";
import { runtime } from "./runtime";
import type { SyntaxConfig } from "./syntax/highlight";
import { findMatches as findMatchIndices } from "./utils/find";
import { rankFiles } from "./utils/fuzzy";
import { truncate } from "./utils/text";

interface JumpTarget {
  path: string;
  line: number;
  escalate: boolean;
}

type ProblemItem =
  | { kind: "failure"; id: string; checker: CheckerName; line: string; isFirst: boolean }
  | { kind: "problem"; id: string; problem: Diagnostic };

// The coherent diff-pane snapshot. One async load per selection produces a
// Complete value; the signal holds the previous complete snapshot until the new
// One resolves, so `<diff>` never receives empty/stale/partial content. That
// Incoherent intermediate content is what oscillated OpenTUI's gutter width and
// Wedged the renderer under the old async atom pipeline.
interface DiffView {
  path: string;
  showFileContent: boolean;
  fileContent: FileContent | undefined;
  diff: string;
}

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

function loadDiffView(src: {
  path: string;
  scope: DiffScope;
  showFile: boolean;
  full: boolean;
  file: ChangedFile | undefined;
  model: GitModel;
}): Effect.Effect<DiffView, never, File | Git> {
  if (src.showFile) {
    const gitSpec =
      src.file?.kind === "deleted"
        ? src.scope.kind === "unstaged"
          ? `:${src.path}`
          : `${src.scope.ref}:${src.path}`
        : undefined;
    return File.pipe(
      Effect.flatMap((file) =>
        file.content(src.model.repoRoot, src.path, { full: src.full, gitSpec }),
      ),
      Effect.map(
        (content): DiffView => ({
          diff: content.kind === "text" ? contentToContextPatch(src.path, content.content) : "",
          fileContent: content,
          path: src.path,
          showFileContent: true,
        }),
      ),
    );
  }

  const file = src.file;
  if (file === undefined) {
    return Effect.succeed<DiffView>({
      diff: "",
      fileContent: undefined,
      path: src.path,
      showFileContent: false,
    });
  }

  return Git.pipe(
    Effect.flatMap((git) => git.fileDiff(src.model.repoRoot, src.scope, file)),
    Effect.map(
      (diff): DiffView => ({
        diff,
        fileContent: undefined,
        path: src.path,
        showFileContent: false,
      }),
    ),
    Effect.catch(() =>
      Effect.succeed<DiffView>({
        diff: "",
        fileContent: undefined,
        path: src.path,
        showFileContent: false,
      }),
    ),
  );
}

function createState() {
  // --- writable primitives ---
  const [scope, setScope] = createSignal<DiffScope>({ kind: "all", ref: "HEAD" });
  const [iconsEnabled, setIconsEnabled] = createSignal(true);
  const [changesOnly, setChangesOnly] = createSignal(false);
  const [selectedPath, setSelectedPath] = createSignal<string | undefined>(undefined);
  const [expandedDirectories, setExpandedDirectories] = createSignal(new Set<string>());
  const [fileView, setFileView] = createSignal(false);
  const [fullContentPaths, setFullContentPaths] = createSignal(new Set<string>());
  const [focusedNodeId, setFocusedNodeId] = createSignal("");
  const [focusedPane, setFocusedPane] = createSignal<"tree" | "diff" | "problems">("tree");
  const [sidebarOpen, setSidebarOpen] = createSignal(true);
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
  const [lastChange, setLastChange] = createSignal(0);
  const [cursorIndex, setCursorIndex] = createSignal(0);
  const [jumpTarget, setJumpTarget] = createSignal<JumpTarget | undefined>(undefined);
  const [checkerState, setCheckerState] = createSignal<CheckerState>(initialCheckerState([]));
  const [status, setStatus] = createSignal("");
  const [activityLog, setActivityLog] = createSignal<ActivityLog>(emptyActivityLog);
  const [checksRunning, setChecksRunning] = createSignal(false);
  const [now, setNow] = createSignal(Date.now());
  const [terminalWidth, setTerminalWidth] = createSignal(80);
  const [terminalHeight, setTerminalHeight] = createSignal(24);
  const [syntax, setSyntax] = createSignal<SyntaxConfig>({ enabled: false, status: "" });

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
  const allProblemItems = createMemo<ProblemItem[]>(() => {
    const state = checkerState();
    const items: ProblemItem[] = [];
    checkerNames.forEach((checker) => {
      for (const [, fileState] of state[checker]) {
        if (fileState.status === "failed" && fileState.message !== undefined) {
          fileState.message
            .split("\n")
            .filter((line) => line.trim() !== "")
            .forEach((line, lineIndex) => {
              items.push({
                checker,
                id: `failure-${checker}-${lineIndex}`,
                isFirst: lineIndex === 0,
                kind: "failure",
                line,
              });
            });
          break;
        }
      }
    });
    problems().forEach((problem, index) => {
      items.push({ id: `problem-${index}`, kind: "problem", problem });
    });
    return items;
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
    const src = diffSource();
    if (src === undefined) {
      setDiffView(undefined);
      return;
    }
    const controller = new AbortController();
    runtime
      .runPromise(loadDiffView(src), { signal: controller.signal })
      .then(setDiffView)
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
        .runPromise(Git.pipe(Effect.flatMap((git) => git.search(root, query, paths))), {
          signal: controller.signal,
        })
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

  const renderedPatch = createMemo(() => {
    const view = diffView();
    if (view === undefined) {
      return renderPatch("", { full: false, maxLines: 1600 });
    }
    return renderPatch(view.diff, {
      full: view.showFileContent || fullContentPaths().has(view.path),
      maxLines: 1600,
    });
  });
  const navigableLines = createMemo(() => {
    const patch = renderedPatch();
    return patch.parsed.hunks.flatMap((hunk) => hunk.lines).slice(0, patch.bodyLineCount);
  });
  const truncated = createMemo(() => {
    const content = diffView()?.fileContent;
    return renderedPatch().truncated || (content?.kind === "text" && content.truncated);
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
  const sidebarWidth = createMemo(() =>
    sidebarOpen() ? Math.max(34, Math.min(54, Math.floor(terminalWidth() * 0.34))) : 0,
  );
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
    const findings = cursorFindings();
    const latest = latestActivity(activityLog());
    const activityText =
      latest === undefined || now() - latest.at >= RECENT_MS
        ? ""
        : `${Math.max(0, Math.round((now() - latest.at) / 1000))}s ago ${latest.path}`;
    const displayStatus = checksRunning() ? "running checks…" : status();
    const hints = "? keys · q quit";
    return truncate(
      findings?.[0] !== undefined
        ? `${findings[0].checker}: ${findings[0].message}`
        : [activityText, truncated() ? `${displayStatus} · truncated; f for full` : displayStatus]
            .filter((part) => part !== "")
            .join(" · "),
      Math.max(10, Math.min(terminalWidth() - 50, terminalWidth() - hints.length - 4)),
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
        Diagnostics.pipe(
          Effect.flatMap((diagnostics) =>
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
    Provisioner.pipe(
      Effect.flatMap((provisioner) =>
        Queue.take(provisioner.completions).pipe(
          Effect.flatMap(() => Effect.sync(() => void runChecks(gitModel()))),
          Effect.forever,
        ),
      ),
    ),
  );

  function copy(text: string) {
    runtime
      .runPromise(Clipboard.pipe(Effect.flatMap((clipboard) => clipboard.copy(text))))
      .then(() => setStatus(`copied ${text.split("\n")[0]}`))
      .catch((error: unknown) => setStatus(error instanceof Error ? error.message : String(error)));
  }

  function loadWorktrees(root: string) {
    runtime
      .runPromise(Git.pipe(Effect.flatMap((git) => git.worktrees(root))))
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

  function loadModel(input: { repoRoot: string; scope: DiffScope }) {
    return runtime.runPromise(
      Git.pipe(Effect.flatMap((git) => git.loadModel(input.repoRoot, input.scope))),
    );
  }

  // --- background fibers (re-key/restart reactively, interrupt the prior fiber
  // On cleanup so an in-flight git is killed) ---

  // Adaptive git poll: 750ms while active, 2s after 10s quiet; a slow 5s loop
  // Refreshes the repo file list. Re-keys only on repoRoot/scope.
  createEffect(() => {
    const root = repoRoot();
    const scopeNow = scope();
    if (root === "") {
      return;
    }
    const controller = new AbortController();
    const fast = Stream.fromEffect(
      Effect.gen(function* fastPoll() {
        const git = yield* Git;
        yield* git.changedFiles(root, scopeNow).pipe(
          Effect.tap((next) =>
            Effect.sync(() => {
              const prev = gitModel();
              if (prev.repoRoot === root) {
                setGitModel(mergeChanged(prev, next));
              }
            }),
          ),
          Effect.ignore,
        );
        const quiet = Date.now() - lastChange() > 10_000;
        yield* Effect.sleep(quiet ? "2 seconds" : "750 millis");
      }),
    ).pipe(Stream.forever);
    const slow = Stream.fromEffect(
      Effect.gen(function* slowPoll() {
        const git = yield* Git;
        yield* git.repoFiles(root).pipe(
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
      .runPromise(Stream.merge(fast, slow).pipe(Stream.runDrain), { signal: controller.signal })
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
    copy,
    counts,
    countsText,
    cursorIndex,
    cursorLineNumber,
    diffView,
    expandedDirectories,
    fileView,
    findActive,
    findMatchPos,
    findMatches,
    findOpen,
    findQuery,
    focusedNodeId,
    focusedPane,
    focusedRowIndex,
    fullContentPaths,
    gitModel,
    helpOpen,
    iconsEnabled,
    jumpTarget,
    lastChange,
    lineMap,
    loadModel,
    loadWorktrees,
    moveFocus,
    navigableLines,
    now,
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
    renderedPatch,
    repoRoot,
    resetFind,
    runChecks,
    scope,
    searchIndex,
    searchOpen,
    searchQuery,
    searchResults,
    searchScope,
    searchTruncated,
    selectFile,
    selectedFile,
    selectedPath,
    setActivityLog,
    setChangesOnly,
    setCheckerState,
    setCursorIndex,
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
    setJumpTarget,
    setLastChange,
    setNow,
    setPaletteIndex,
    setPaletteOpen,
    setPaletteQuery,
    setProblemIndex,
    setProblemsOpen,
    setRepoRoot,
    setScope,
    setSearchIndex,
    setSearchOpen,
    setSearchQuery,
    setSearchScope,
    setSelectedPath,
    setSidebarOpen,
    setStatus,
    setSyntax,
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
    syntax,
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

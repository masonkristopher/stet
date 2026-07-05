import type { InputRenderable } from "@opentui/core";
import { batch, createEffect, Match, on, Show, Switch } from "solid-js";

import { firstWord, wordAt } from "@/diff/words";
import { state } from "@/state";
import { useTheme } from "@/theme/context";
import { nearestNavigableIndex, placeholderText, viewerStats } from "@/ui-helpers";

import { DiffView } from "./diff/DiffView";
import { PaneFrame } from "./PaneFrame";
import { SearchPane } from "./SearchPane";
import { Tabs } from "./Tabs";

// The caret offset for a 1-based jump column: snap to the word that owns it, else
// Land on the raw (clamped) offset so a jump into a gap still lands precisely.
function caretForColumn(content: string, column: number) {
  const index = Math.max(0, Math.min(column - 1, content.length));
  return wordAt(content, index)?.start ?? index;
}

export function Viewer() {
  const theme = useTheme();
  let findInputRef: InputRenderable | undefined;

  // Apply a navigation's pending restore once the target diff has loaded under the
  // Matching view intent (the same async-coherence guard a jump uses). A fresh
  // Open carries `cursorLine: undefined` -> first change and a zero viewport, so
  // "reset on file switch" is just restore-to-default; back/forward and revisits
  // Carry a remembered line and viewport. This replaces the old per-path cursor
  // Reset and DiffView's scrollX reset with one path.
  createEffect(() => {
    const pending = state.pendingRestore();
    if (pending === undefined) {
      return;
    }
    const view = state.diffView();
    if (view?.path !== pending.path || view.showFileContent !== state.showFileContent()) {
      return;
    }
    const lines = state.navigableLines();
    const found =
      pending.cursorLine === undefined
        ? lines.findIndex((line) => line.type !== "context")
        : lines.findIndex(
            (line) => line.newLine === pending.cursorLine || line.oldLine === pending.cursorLine,
          );
    const index =
      found !== -1
        ? found
        : pending.cursorLine === undefined
          ? 0
          : Math.max(0, nearestNavigableIndex(lines, pending.cursorLine));
    // The caret restores to its remembered offset (already a word start), or the
    // New line's first word on a fresh open; the clamp effect below corrects an
    // Offset that no longer fits if the content changed under it.
    const column = pending.cursorColumn ?? firstWord(lines[index]?.content ?? "");
    batch(() => {
      state.setCaretLineLevel(false);
      state.setCursorIndex(index);
      state.setCursorColumn(column);
      state.setViewerScrollTop(pending.viewport.scrollTop);
      state.setViewerScrollX(pending.viewport.scrollX);
      state.setPendingRestore(undefined);
    });
  });

  // Clamp the cursor when a refresh shrinks the content under it (setCursorRow also
  // Re-homes the caret to the new line's first word).
  createEffect(() => {
    const last = state.navigableLines().length - 1;
    if (state.cursorIndex() > last) {
      state.setCursorRow(Math.max(0, last));
    }
  });

  // Caret safety net: if the line under the caret changes length (content reload)
  // And the caret now overflows it, re-home to the first word. Keyed on the cursor
  // Line content; the body is untracked, so it never fights an in-range placement.
  createEffect(
    on(
      () => state.cursorLineContent(),
      (content) => {
        if (state.cursorColumn() > content.length) {
          state.setCursorColumn(firstWord(content));
        }
      },
    ),
  );

  // Deferred jumps (problem/recency navigation): land on the line, un-truncate,
  // Or escalate to file view to find it. A jump sets both `jumpTarget` and (via
  // SelectFile) `pendingRestore`; this effect must stay declared after the restore
  // Effect above so it runs last and the jump's line wins over the restored cursor.
  createEffect(() => {
    const jump = state.jumpTarget();
    if (jump === undefined || jump.path !== state.selectedPath()) {
      return;
    }
    // Only resolve once the loaded snapshot matches the current target AND view
    // Intent. `selectedPath`/`fileView` update synchronously, but `diffView`
    // (which feeds `navigableLines`) loads async; acting on a stale snapshot
    // Consumes the jump against the wrong content and never lands on the line.
    // The `showFileContent` check is what makes escalation work: after the jump
    // Flips to file view, it waits for the full content instead of clearing
    // Itself against the still-loaded diff.
    const view = state.diffView();
    if (view?.path !== jump.path || view.showFileContent !== state.showFileContent()) {
      return;
    }
    const lines = state.navigableLines();
    const index = lines.findIndex((line) => line.newLine === jump.line);
    if (index !== -1) {
      const content = lines[index]?.content ?? "";
      batch(() => {
        state.setCaretLineLevel(false);
        state.setCursorIndex(index);
        state.setCursorColumn(
          jump.column === undefined ? firstWord(content) : caretForColumn(content, jump.column),
        );
        // A jump's explicit line:col supersedes any remembered restore for the same
        // Target; consume both so a later restore pass can't overwrite the caret
        // (their effect ordering is not guaranteed once folds churn navigableLines).
        state.setPendingRestore(undefined);
        state.setJumpTarget(undefined);
      });
      return;
    }
    // A fold may be hiding the target line; clearing it re-runs this effect (which
    // Reads `navigableLines`) so the now-visible line is found on the next pass.
    if (state.revealLineForJump(jump.line)) {
      return;
    }
    if (state.truncated() && !state.fullContentPaths().has(jump.path)) {
      state.setFullContentPaths((current) => new Set(current).add(jump.path));
      return;
    }
    if (jump.escalate && state.selectedFile() !== undefined && !state.fileView()) {
      state.setFileView(true);
      return;
    }
    const nearest = nearestNavigableIndex(lines, jump.line);
    if (nearest >= 0) {
      state.setCursorRow(nearest);
    }
    state.setJumpTarget(undefined);
  });

  const focused = () => state.focusedPane() === "diff" || state.focusedPane() === "search";
  const displayedFile = () => {
    const view = state.diffView();
    return view === undefined ? undefined : state.gitModel().changedByPath.get(view.path);
  };
  const isPlaceholder = () => {
    const content = state.diffView()?.fileContent;
    return (
      state.diffView()?.showFileContent === true && content !== undefined && content.kind !== "text"
    );
  };

  // The input stays mounted whenever the bar shows so a committed (blurred) find
  // Never captures the n/N cycle keys; `focused` follows findOpen. Each open
  // Clears the element's own buffer to match the freshly-reset query.
  createEffect(
    on(
      () => state.findOpen(),
      (open) => {
        if (open && findInputRef !== undefined) {
          findInputRef.value = "";
        }
      },
    ),
  );

  const findCounter = () => {
    if (state.findQuery() === "") {
      return "";
    }
    const count = state.findMatches().length;
    if (count === 0) {
      return "no matches";
    }
    // Clamp: a live edit during an active find can leave the position past the end.
    return `${Math.min(state.findMatchPos(), count - 1) + 1}/${count}`;
  };

  function onFindInput(value: string) {
    batch(() => {
      state.setFindQuery(value);
      state.setFindMatchPos(0);
    });
  }

  function onFindSubmit() {
    batch(() => {
      const matches = state.findMatches();
      const first = matches[0];
      if (first !== undefined) {
        state.setFindMatchPos(0);
        state.setCursorRow(first);
        state.setFindActive(true);
      }
      state.setFindOpen(false);
    });
  }

  return (
    <PaneFrame
      focused={focused()}
      flexGrow={1}
      height="100%"
      onMouseDown={() => state.setFocusedPane(state.mainView() === "search" ? "search" : "diff")}
    >
      {/* The main-area view switch: exactly one view owns the pane interior.
          The file view keeps its header/body/truncated rows as before; the
          search pane brings its own chrome. Future views extend the union. */}
      <Switch>
        <Match when={state.mainView() === "search"}>
          <SearchPane />
        </Match>
        <Match when={state.mainView() === "file"}>
          <Show
            when={state.findOpen() || state.findActive()}
            fallback={
              <box
                height={1}
                flexDirection="row"
                justifyContent="space-between"
                paddingLeft={1}
                paddingRight={1}
              >
                {/* The strip earns the row only once a tab is pinned; a lone preview
                shows the path as before. */}
                <Show
                  when={state.tabItems().some((tab) => !tab.preview)}
                  fallback={
                    <text fg={theme.colors.text.primary}>{state.selectedPath() ?? ""}</text>
                  }
                >
                  <Tabs />
                </Show>
                <box flexDirection="row">
                  {/* Keep the active scope legible at the diff, so a staged/unstaged
                  view is never misread as the whole change. */}
                  <Show when={state.scope().kind !== "all"}>
                    <text
                      fg={
                        state.scope().kind === "staged"
                          ? theme.colors.stage.staged
                          : theme.colors.stage.unstaged
                      }
                    >
                      {`${state.scope().kind} · `}
                    </text>
                  </Show>
                  <text fg={theme.colors.text.muted}>
                    {[
                      viewerStats(
                        displayedFile(),
                        state.diffView()?.showFileContent ?? false,
                        state.diffView()?.fileContent,
                      ),
                      state.cursorLineNumber() === undefined
                        ? ""
                        : state.caretColumn() === undefined
                          ? `ln ${state.cursorLineNumber()}`
                          : `ln ${state.cursorLineNumber()}:${state.caretColumn()}`,
                    ]
                      .filter((part) => part !== "")
                      .join(" · ")}
                  </text>
                </box>
              </box>
            }
          >
            {/* While searching, the title row becomes a full-width find bar. */}
            <box
              height={1}
              flexDirection="row"
              paddingLeft={1}
              paddingRight={1}
              backgroundColor={theme.colors.surface.panel}
            >
              <text fg={theme.colors.accent.primary}>{"/ "}</text>
              <box flexGrow={1}>
                <input
                  ref={(el: InputRenderable) => (findInputRef = el)}
                  focused={state.findOpen()}
                  width="100%"
                  backgroundColor={theme.colors.surface.panel}
                  focusedBackgroundColor={theme.colors.surface.panel}
                  textColor={theme.colors.text.primary}
                  focusedTextColor={theme.colors.text.primary}
                  cursorColor={theme.colors.accent.primary}
                  onInput={onFindInput}
                  onSubmit={onFindSubmit}
                />
              </box>
              <text fg={theme.colors.text.muted}>
                {findCounter() === "" ? "" : `${findCounter()}  `}
              </text>
              <text fg={theme.colors.text.faint}>esc</text>
            </box>
          </Show>
          {/* Nothing is selectable (an empty repository, or selection cleared):
          author that void instead of a blank pane. A selected-but-not-yet-loaded
          file keeps rendering the diff surface below, so a load never flashes
          this; that is why the guard is selectedPath, not the async diffView. */}
          <Show
            when={state.selectedPath() !== undefined}
            fallback={
              <box
                height={state.viewerHeight()}
                flexDirection="column"
                justifyContent="center"
                alignItems="center"
              >
                <text fg={theme.colors.text.muted}>nothing to inspect</text>
                <text fg={theme.colors.text.faint}>
                  {state.gitModel().repoFiles.length === 0
                    ? "this repository has no files yet"
                    : "select a file to inspect"}
                </text>
              </box>
            }
          >
            <Show
              when={!isPlaceholder()}
              fallback={
                <box height={state.viewerHeight()} paddingLeft={1}>
                  <text fg={theme.colors.text.muted}>
                    {placeholderText(state.diffView()?.fileContent)}
                  </text>
                </box>
              }
            >
              <DiffView />
            </Show>
          </Show>
          {/* A partially-loaded file reserves this row (viewerHeight already shrank by
          it) rather than crowding the transient status bar: the affordance sits at
          the content it describes. The whole row loads the rest, mirroring the `f`
          key. */}
          <Show when={state.truncated()}>
            <box
              // Non-selectable so a click/double-click on the row never starts a text
              // Selection (a stray highlight); it is chrome, not content (mirrors Tabs).
              ref={(el) => (el.selectable = false)}
              height={1}
              flexDirection="row"
              paddingLeft={1}
              paddingRight={1}
              backgroundColor={theme.colors.surface.panel}
              onMouseDown={() => state.loadFullContent()}
            >
              <text ref={(el) => (el.selectable = false)} fg={theme.colors.text.muted}>
                {`⋯ ${state.truncatedHidden()} more ${
                  state.truncatedHidden() === 1 ? "line" : "lines"
                } · f to load`}
              </text>
            </box>
          </Show>
        </Match>
      </Switch>
    </PaneFrame>
  );
}

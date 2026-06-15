import type { DiffRenderable, LineColorConfig } from "@opentui/core";
import { useRenderer } from "@opentui/solid";
import { createEffect, createMemo, on, Show } from "solid-js";

import { DIFF_ID } from "../constants";
import { state } from "../state";
import { diffFiletypeFor } from "../syntax/highlight";
import { useTheme } from "../theme/context";
import { nearestNavigableIndex, placeholderText, viewerTitle } from "../ui-helpers";

interface ScrollablePane {
  scrollY: number;
  maxScrollY: number;
}

function isScrollablePane(value: unknown): value is ScrollablePane {
  return (
    typeof value === "object" &&
    value !== null &&
    "scrollY" in value &&
    typeof value.scrollY === "number"
  );
}

export function Viewer() {
  const theme = useTheme();
  const renderer = useRenderer();
  let diffRef: DiffRenderable | undefined;

  // Reset the cursor to the first change only when the displayed file changes,
  // Not on live edits of the same file.
  createEffect(
    on(
      () => state.diffView()?.path,
      () => {
        const first = state.navigableLines().findIndex((line) => line.type !== "context");
        state.setCursorIndex(first === -1 ? 0 : first);
      },
    ),
  );

  // Deferred jumps (problem/recency navigation): land on the line, un-truncate,
  // Or escalate to file view to find it.
  createEffect(() => {
    const jump = state.jumpTarget();
    if (jump === undefined || jump.path !== state.selectedPath()) {
      return;
    }
    const lines = state.navigableLines();
    const index = lines.findIndex((line) => line.newLine === jump.line);
    if (index !== -1) {
      state.setCursorIndex(index);
      state.setJumpTarget(undefined);
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
      state.setCursorIndex(nearest);
    }
    state.setJumpTarget(undefined);
  });

  // The add/remove/diagnostic tints only change with content; a cursor move just
  // Copies this map and overlays the cursor row.
  const baseLineColors = createMemo(() => {
    const { addedBg, errorGutterBg, removedBg, transparent, warningGutterBg } = theme.rgba;
    const colors = new Map<number, LineColorConfig>();
    const lineMap = state.lineMap();
    state.navigableLines().forEach((line, index) => {
      let gutter = transparent;
      let content = transparent;
      if (line.type === "add") {
        content = addedBg;
      } else if (line.type === "remove") {
        content = removedBg;
      }
      const findings = line.newLine === undefined ? undefined : lineMap.get(line.newLine);
      if (findings !== undefined) {
        gutter = findings.some((finding) => finding.severity === "error")
          ? errorGutterBg
          : warningGutterBg;
      }
      if (gutter !== transparent || content !== transparent) {
        colors.set(index, { content, gutter });
      }
    });
    return colors;
  });

  // Paint the cursor row + diagnostic tints and keep the cursor in view.
  createEffect(() => {
    const lines = state.navigableLines();
    const cursor = state.cursorIndex();
    const base = baseLineColors();
    const height = state.viewerHeight();
    const diff = diffRef;
    if (diff === undefined || lines.length === 0) {
      return;
    }
    const last = lines.length - 1;
    if (cursor > last) {
      state.setCursorIndex(last);
      return;
    }
    const paint = () => {
      const colors = new Map<number, LineColorConfig>(base);
      colors.set(cursor, { content: theme.rgba.cursorBg, gutter: theme.rgba.cursorBg });
      diff.setLineColors(colors);
    };
    // The diff renderable repaints its own line colors when content settles;
    // Painting again in a microtask keeps the cursor/diagnostic tints on top.
    paint();
    queueMicrotask(paint);
    const pane = diff.findDescendantById(`${DIFF_ID}-left-code`);
    if (isScrollablePane(pane)) {
      if (cursor < pane.scrollY) {
        pane.scrollY = cursor;
      } else if (cursor >= pane.scrollY + height) {
        pane.scrollY = cursor - height + 1;
      }
    }
    renderer.requestRender();
  });

  const focused = () => state.focusedPane() === "diff";
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
  const syntaxStyle = () => {
    const syntax = state.syntax();
    return syntax.enabled ? syntax.style : undefined;
  };
  const treeSitterClient = () => {
    const syntax = state.syntax();
    return syntax.enabled ? syntax.treeSitterClient : undefined;
  };
  const filetype = () => {
    const path = state.diffView()?.path;
    return path === undefined ? "text" : diffFiletypeFor(path, state.syntax());
  };

  return (
    <box
      flexGrow={1}
      height="100%"
      flexDirection="column"
      borderStyle="single"
      borderColor={focused() ? theme.colors.border.focused : theme.colors.border.unfocused}
    >
      <box
        height={1}
        flexDirection="row"
        justifyContent="space-between"
        paddingLeft={1}
        paddingRight={1}
      >
        <text fg={theme.colors.text.primary}>
          {viewerTitle(
            state.diffView()?.path,
            displayedFile(),
            state.diffView()?.showFileContent ?? false,
            state.diffView()?.fileContent,
          )}
        </text>
        <text fg={theme.colors.text.muted}>
          {state.diffView()?.showFileContent ? "file" : "diff"}
          {state.cursorLineNumber() === undefined ? "" : ` · ln ${state.cursorLineNumber()}`}
        </text>
      </box>
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
        <diff
          id={DIFF_ID}
          ref={(el: DiffRenderable) => (diffRef = el)}
          width="100%"
          height={state.viewerHeight()}
          diff={state.renderedPatch().diff}
          view="unified"
          filetype={filetype()}
          syntaxStyle={syntaxStyle()}
          treeSitterClient={treeSitterClient()}
          showLineNumbers
          wrapMode="none"
          addedBg={theme.colors.diff.addedBg}
          removedBg={theme.colors.diff.removedBg}
          addedLineNumberBg={theme.colors.diff.addedLineNumberBg}
          removedLineNumberBg={theme.colors.diff.removedLineNumberBg}
          addedSignColor={theme.colors.diff.addedSign}
          removedSignColor={theme.colors.diff.removedSign}
          lineNumberFg={theme.colors.diff.lineNumberFg}
        />
      </Show>
    </box>
  );
}

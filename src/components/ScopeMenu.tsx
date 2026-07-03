import type { ScrollBoxRenderable } from "@opentui/core";
import { createEffect, Index, Show } from "solid-js";

import { scopeKinds, scopeMenuLabel } from "@/cli";
import { levelColor, levelGlyph } from "@/log/levels";
import { state } from "@/state";
import { useTheme } from "@/theme/context";
import { relativeTime } from "@/utils/relative-time";

// Two levels in one overlay: the scope kinds, and a drill-down into recent commits
// (each viewable as its own diff). `state.scopeMenuIndex` is the cursor for whichever
// Level is showing; a `▸` cursor caret plus a `●` current marker keep both legible
// Under NO_COLOR, where the highlight background alone would vanish.
export function ScopeMenu() {
  const theme = useTheme();
  let scopeMenuRef: ScrollBoxRenderable | undefined;

  createEffect(() => {
    // Re-home the scroll on a level switch as well as a cursor move.
    state.scopeMenuView();
    scopeMenuRef?.scrollChildIntoView(`scope-menu-${state.scopeMenuIndex()}`);
  });

  const commitsView = () => state.scopeMenuView() === "commits";
  // Wall-clock captured at drill-in (state.now() is the recency clock, which freezes
  // While the repo is idle and would render every commit age as "now").
  const nowSeconds = () => state.commitsNow();
  const marker = (active: boolean, current: boolean) =>
    `${active ? "▸" : " "}${current ? "●" : " "} `;
  const rowBackground = (active: boolean) =>
    active ? theme.colors.surface.cursor : theme.colors.surface.panel;
  const rowFg = (active: boolean) =>
    active ? theme.colors.text.selected : theme.colors.text.strong;
  const scrollbarOptions = {
    trackOptions: {
      backgroundColor: theme.rgba.transparent,
      foregroundColor: theme.colors.scrollbar.thumb,
    },
  };

  return (
    <box
      position="absolute"
      left={state.overlayLeft()}
      top={1}
      width={state.overlayWidth()}
      flexDirection="column"
      borderStyle="single"
      borderColor={theme.colors.border.focused}
      backgroundColor={theme.colors.surface.panel}
      zIndex={100}
    >
      <box height={1} paddingLeft={1} backgroundColor={theme.colors.surface.panel}>
        <text fg={theme.colors.text.strong}>{commitsView() ? "commits" : "switch scope"}</text>
      </box>

      <Show when={!commitsView()}>
        <scrollbox
          ref={(el) => (scopeMenuRef = el)}
          width="100%"
          height={scopeKinds.length + 1}
          scrollY
          viewportCulling
          scrollbarOptions={scrollbarOptions}
        >
          {/* Id-by-index is required: reordering must never change a live renderable's id */}
          <Index each={scopeKinds}>
            {(kind, index) => {
              const active = () => index === state.scopeMenuIndex();
              const current = () => kind() === state.scope().kind;
              return (
                <box
                  id={`scope-menu-${index}`}
                  width="100%"
                  paddingLeft={1}
                  paddingRight={1}
                  backgroundColor={rowBackground(active())}
                  onMouseDown={() => {
                    state.selectScope(kind());
                    state.setScopeMenuOpen(false);
                  }}
                >
                  <text
                    fg={rowFg(active())}
                  >{`${marker(active(), current())}${scopeMenuLabel(kind())}`}</text>
                </box>
              );
            }}
          </Index>
          {/* The commits drill-down, one row past the kinds. */}
          <box
            id={`scope-menu-${scopeKinds.length}`}
            width="100%"
            flexDirection="row"
            justifyContent="space-between"
            paddingLeft={1}
            paddingRight={1}
            backgroundColor={rowBackground(state.scopeMenuIndex() === scopeKinds.length)}
            onMouseDown={() => {
              state.setScopeMenuView("commits");
              state.setScopeMenuIndex(0);
              state.loadCommits(state.gitModel().repoRoot);
            }}
          >
            <text fg={rowFg(state.scopeMenuIndex() === scopeKinds.length)}>
              {`${marker(state.scopeMenuIndex() === scopeKinds.length, state.scope().kind === "commit")}commits`}
            </text>
            <text fg={theme.colors.text.muted}>→</text>
          </box>
        </scrollbox>
        <box height={1} paddingLeft={1} backgroundColor={theme.colors.surface.panel}>
          <text fg={theme.colors.text.muted}>↑↓ navigate · ⏎ switch · esc close</text>
        </box>
      </Show>

      <Show when={commitsView()}>
        <Show when={state.commitsStatus() === "loading"}>
          <box height={1} paddingLeft={1}>
            <text fg={theme.colors.text.muted}>loading commits…</text>
          </box>
        </Show>
        <Show when={state.commitsStatus() === "empty"}>
          <box height={1} paddingLeft={1}>
            <text fg={theme.colors.text.muted}>no commits yet</text>
          </box>
        </Show>
        <Show when={state.commitsStatus() === "error"}>
          <box height={1} paddingLeft={1}>
            <text fg={levelColor(theme.colors, "error")}>
              {`${levelGlyph("error")} could not load commits`}
            </text>
          </box>
        </Show>
        <Show when={state.commitsStatus() === "ready"}>
          <scrollbox
            ref={(el) => (scopeMenuRef = el)}
            width="100%"
            height={Math.min(14, Math.max(1, state.commits().length))}
            scrollY
            viewportCulling
            scrollbarOptions={scrollbarOptions}
          >
            <Index each={state.commits()}>
              {(commit, index) => {
                const active = () => index === state.scopeMenuIndex();
                // Marked by the pinned sha, not a list position, so a reload can't
                // Drift the ● onto the wrong row.
                const current = () => commit().sha === state.scope().headRef;
                return (
                  <box
                    id={`scope-menu-${index}`}
                    height={1}
                    width="100%"
                    flexDirection="row"
                    paddingLeft={1}
                    paddingRight={1}
                    backgroundColor={rowBackground(active())}
                    onMouseDown={() => {
                      if (state.selectCommit(index)) {
                        state.setScopeMenuOpen(false);
                      }
                    }}
                  >
                    {/* Pinned to one line (wrapMode none + height 1): subjects run long
                        and carry variation-selector gitmoji that would otherwise wrap a
                        row two cells tall and mangle the list. The sha column never
                        shrinks; the subject clips at the overlay edge. */}
                    <text
                      flexShrink={0}
                      wrapMode="none"
                      height={1}
                      fg={rowFg(active())}
                    >{`${marker(active(), current())}${commit().shortSha}`}</text>
                    <text
                      flexGrow={1}
                      wrapMode="none"
                      height={1}
                      fg={theme.colors.text.muted}
                    >{`  ${relativeTime(commit().authorTime, nowSeconds()).padEnd(4)}  ${commit().subject}`}</text>
                  </box>
                );
              }}
            </Index>
          </scrollbox>
        </Show>
        <box height={1} paddingLeft={1} backgroundColor={theme.colors.surface.panel}>
          <text fg={theme.colors.text.muted}>↑↓ navigate · ⏎ view · esc back</text>
        </box>
      </Show>
    </box>
  );
}

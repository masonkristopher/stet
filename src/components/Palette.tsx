import type { ScrollBoxRenderable } from "@opentui/core";
import { createEffect, Index, Show } from "solid-js";

import { recencyLevel } from "../git/activity";
import { state } from "../state";
import { useTheme } from "../theme/context";
import { kindLetter } from "../ui-helpers";
import { RecencyDot } from "./TreeRow";

export function Palette() {
  const theme = useTheme();
  let paletteRef: ScrollBoxRenderable | undefined;

  createEffect(() => {
    paletteRef?.scrollChildIntoView(`palette-${state.paletteIndex()}`);
  });

  function onSubmit() {
    const path = state.paletteResults()[state.paletteIndex()];
    if (path !== undefined) {
      state.selectFile(path);
      state.setFocusedPane("diff");
    }
    state.setPaletteOpen(false);
  }

  function onInput(value: string) {
    state.setPaletteQuery(value);
    state.setPaletteIndex(0);
  }

  return (
    <box
      position="absolute"
      left={state.paletteLeft()}
      top={1}
      width={state.paletteWidth()}
      flexDirection="column"
      borderStyle="single"
      borderColor={theme.colors.border.focused}
      backgroundColor={theme.colors.surface.panel}
      zIndex={100}
    >
      <input
        focused
        width="100%"
        placeholder="go to file…"
        backgroundColor={theme.colors.surface.panel}
        focusedBackgroundColor={theme.colors.surface.panel}
        textColor={theme.colors.text.primary}
        cursorColor={theme.colors.accent.primary}
        onInput={onInput}
        onSubmit={onSubmit}
      />
      <scrollbox
        ref={(el) => (paletteRef = el)}
        width="100%"
        height={Math.min(12, Math.max(1, state.paletteResults().length))}
        scrollY
        viewportCulling
        scrollbarOptions={{
          trackOptions: {
            backgroundColor: theme.colors.scrollbar.track,
            foregroundColor: theme.colors.scrollbar.thumb,
          },
        }}
      >
        <Show
          when={state.paletteResults().length > 0}
          fallback={
            <box id="palette-empty" paddingLeft={1}>
              <text fg={theme.colors.text.muted}>no matches</text>
            </box>
          }
        >
          {/* Id-by-index is required: reordering results must never change a live renderable's id */}
          <Index each={state.paletteResults()}>
            {(path, index) => {
              const changed = () => state.gitModel().changedByPath.get(path());
              const recency = () => recencyLevel(state.recencyByPath().get(path()), state.now());
              const nameFg = () =>
                index === state.paletteIndex()
                  ? theme.colors.text.selected
                  : changed() === undefined
                    ? theme.colors.text.secondary
                    : theme.colors.kind[changed()!.kind];
              return (
                <box
                  id={`palette-${index}`}
                  width="100%"
                  flexDirection="row"
                  justifyContent="space-between"
                  paddingLeft={1}
                  paddingRight={1}
                  backgroundColor={
                    index === state.paletteIndex()
                      ? theme.colors.surface.cursor
                      : theme.colors.surface.panel
                  }
                >
                  <box flexDirection="row">
                    <text fg={nameFg()}>{path()}</text>
                    <RecencyDot level={recency()} />
                  </box>
                  {changed() === undefined ? null : (
                    <text fg={theme.colors.stage[changed()!.stage]}>
                      {kindLetter(changed()!.kind)}
                    </text>
                  )}
                </box>
              );
            }}
          </Index>
        </Show>
      </scrollbox>
    </box>
  );
}

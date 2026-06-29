import type { ScrollBoxRenderable } from "@opentui/core";
import { batch, createEffect, Index, Show } from "solid-js";

import { state } from "@/state";
import { useTheme } from "@/theme/context";
import { kindLetter } from "@/ui-helpers";

import { RecencyDot } from "./TreeRow";

export function FileCombobox() {
  const theme = useTheme();
  let fileComboboxRef: ScrollBoxRenderable | undefined;

  createEffect(() => {
    fileComboboxRef?.scrollChildIntoView(`file-combobox-${state.fileComboboxIndex()}`);
  });

  // Opening a result is the same whether it comes from the input's submit (the
  // Highlighted row) or a click on a specific row.
  function openPath(path: string) {
    batch(() => {
      state.selectFile(path);
      state.setFocusedPane("diff");
      state.setFileComboboxOpen(false);
    });
  }

  function onSubmit() {
    const path = state.fileComboboxResults()[state.fileComboboxIndex()];
    if (path !== undefined) {
      openPath(path);
    } else {
      state.setFileComboboxOpen(false);
    }
  }

  function onInput(value: string) {
    state.setFileComboboxQuery(value);
    state.setFileComboboxIndex(0);
  }

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
      <input
        focused
        width="100%"
        placeholder="go to file…"
        backgroundColor={theme.colors.surface.panel}
        focusedBackgroundColor={theme.colors.surface.panel}
        textColor={theme.colors.text.primary}
        focusedTextColor={theme.colors.text.primary}
        cursorColor={theme.colors.accent.primary}
        onInput={onInput}
        onSubmit={onSubmit}
      />
      <scrollbox
        ref={(el) => (fileComboboxRef = el)}
        width="100%"
        height={Math.min(12, Math.max(1, state.fileComboboxResults().length))}
        scrollY
        viewportCulling
        scrollbarOptions={{
          trackOptions: {
            backgroundColor: theme.rgba.transparent,
            foregroundColor: theme.colors.scrollbar.thumb,
          },
        }}
      >
        <Show
          when={state.fileComboboxResults().length > 0}
          fallback={
            <box id="file-combobox-empty" paddingLeft={1}>
              <text fg={theme.colors.text.muted}>no matches</text>
            </box>
          }
        >
          {/* Id-by-index is required: reordering results must never change a live renderable's id */}
          <Index each={state.fileComboboxResults()}>
            {(path, index) => {
              const changed = () => state.gitModel().changedByPath.get(path());
              const nameFg = () =>
                index === state.fileComboboxIndex()
                  ? theme.colors.text.selected
                  : changed() === undefined
                    ? theme.colors.text.secondary
                    : theme.colors.kind[changed()!.kind];
              return (
                <box
                  id={`file-combobox-${index}`}
                  width="100%"
                  flexDirection="row"
                  justifyContent="space-between"
                  paddingLeft={1}
                  paddingRight={1}
                  backgroundColor={
                    index === state.fileComboboxIndex()
                      ? theme.colors.surface.cursor
                      : theme.colors.surface.panel
                  }
                  onMouseDown={() => openPath(path())}
                >
                  <box flexDirection="row">
                    <text fg={nameFg()}>{path()}</text>
                    <RecencyDot at={state.recencyByPath().get(path())} />
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
      <box height={1} paddingLeft={1} backgroundColor={theme.colors.surface.panel}>
        <text fg={theme.colors.text.muted}>↑↓ navigate · ⏎ open · esc close</text>
      </box>
    </box>
  );
}

import type { MouseEvent, ScrollBoxRenderable } from "@opentui/core";
import { batch, createEffect, Index, Show } from "solid-js";

import { state } from "@/state";
import { useTheme } from "@/theme/context";
import { themeForName } from "@/theme/registry";

export function ThemeCombobox() {
  const theme = useTheme();
  let themeComboboxRef: ScrollBoxRenderable | undefined;

  createEffect(() => {
    themeComboboxRef?.scrollChildIntoView(`theme-combobox-${state.themeComboboxIndex()}`);
  });

  // `auto` follows the terminal, so its swatch is the live active accent; every
  // Named theme shows its own accent regardless of what's currently active.
  const swatch = (name: string) =>
    name === "auto" ? theme.colors.accent.primary : themeForName(name).accent.primary;

  const move = (delta: number) =>
    state.setThemeComboboxIndex(
      Math.max(
        0,
        Math.min(state.themeComboboxIndex() + delta, state.themeComboboxResults().length - 1),
      ),
    );

  function onInput(value: string) {
    batch(() => {
      state.setThemeComboboxQuery(value);
      state.setThemeComboboxIndex(0);
    });
  }

  // The wheel nudges the highlight (which previews) and scrolls with it, mirroring
  // Key nav; swallow the delta so the scrollbox doesn't also scroll independently.
  const onWheel = (event: MouseEvent) => {
    const direction = event.scroll?.direction;
    const delta = event.scroll?.delta ?? 1;
    if (direction === "up") {
      move(-delta);
    } else if (direction === "down") {
      move(delta);
    }
    if (event.scroll !== undefined) {
      event.scroll.delta = 0;
    }
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
      <input
        focused
        width="100%"
        placeholder="theme…"
        backgroundColor={theme.colors.surface.panel}
        focusedBackgroundColor={theme.colors.surface.panel}
        textColor={theme.colors.text.primary}
        focusedTextColor={theme.colors.text.primary}
        cursorColor={theme.colors.accent.primary}
        onInput={onInput}
        onSubmit={() => state.closeThemePicker(true)}
      />
      <scrollbox
        ref={(el) => (themeComboboxRef = el)}
        width="100%"
        height={Math.min(12, Math.max(1, state.themeComboboxResults().length))}
        scrollY
        viewportCulling
        onMouseScroll={onWheel}
        scrollbarOptions={{
          trackOptions: {
            backgroundColor: theme.rgba.transparent,
            foregroundColor: theme.colors.scrollbar.thumb,
          },
        }}
      >
        <Show
          when={state.themeComboboxResults().length > 0}
          fallback={
            <box id="theme-combobox-empty" paddingLeft={1}>
              <text fg={theme.colors.text.muted}>no themes</text>
            </box>
          }
        >
          {/* Id-by-index is required: reordering results must never change a live renderable's id */}
          <Index each={state.themeComboboxResults()}>
            {(item, index) => {
              const selected = () => index === state.themeComboboxIndex();
              const current = () => item().selection === state.themeComboboxOrigin();
              return (
                <box
                  id={`theme-combobox-${index}`}
                  width="100%"
                  flexDirection="row"
                  paddingLeft={1}
                  paddingRight={1}
                  backgroundColor={
                    selected() ? theme.colors.surface.cursor : theme.colors.surface.panel
                  }
                  onMouseOver={() => state.setThemeComboboxIndex(index)}
                  onMouseDown={() =>
                    batch(() => {
                      state.setThemeComboboxIndex(index);
                      state.closeThemePicker(true);
                    })
                  }
                >
                  <text fg={current() ? theme.colors.accent.primary : theme.colors.text.muted}>
                    {current() ? "✓ " : "  "}
                  </text>
                  <text fg={swatch(item().name)}>{"██ "}</text>
                  <text fg={selected() ? theme.colors.text.selected : theme.colors.text.strong}>
                    {item().name}
                  </text>
                </box>
              );
            }}
          </Index>
        </Show>
      </scrollbox>
      <box height={1} paddingLeft={1} backgroundColor={theme.colors.surface.panel}>
        <text fg={theme.colors.text.muted}>↑↓/hover preview · ⏎/click apply · esc cancel</text>
      </box>
    </box>
  );
}

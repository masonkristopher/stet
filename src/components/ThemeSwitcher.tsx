import type { MouseEvent, ScrollBoxRenderable } from "@opentui/core";
import { batch, createEffect, Index, Show } from "solid-js";

import { state } from "../state";
import { useTheme } from "../theme/context";
import { themeForName } from "../theme/registry";

export function ThemeSwitcher() {
  const theme = useTheme();
  let themeRef: ScrollBoxRenderable | undefined;

  createEffect(() => {
    themeRef?.scrollChildIntoView(`theme-${state.themeIndex()}`);
  });

  // `auto` follows the terminal, so its swatch is the live active accent; every
  // Named theme shows its own accent regardless of what's currently active.
  const swatch = (name: string) =>
    name === "auto" ? theme.colors.accent.primary : themeForName(name).accent.primary;

  const move = (delta: number) =>
    state.setThemeIndex(
      Math.max(0, Math.min(state.themeIndex() + delta, state.themeResults().length - 1)),
    );

  function onInput(value: string) {
    batch(() => {
      state.setThemeQuery(value);
      state.setThemeIndex(0);
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
      left={state.paletteLeft()}
      top={1}
      width={state.paletteWidth()}
      flexDirection="column"
      borderStyle="single"
      borderColor={theme.colors.border.focused}
      backgroundColor={theme.colors.surface.panel}
      zIndex={100}
    >
      <box height={1} paddingLeft={1} backgroundColor={theme.colors.surface.panel}>
        <text fg={theme.colors.text.strong}>theme</text>
      </box>
      <input
        focused
        width="100%"
        placeholder="theme…"
        backgroundColor={theme.colors.surface.panel}
        focusedBackgroundColor={theme.colors.surface.panel}
        textColor={theme.colors.text.primary}
        cursorColor={theme.colors.accent.primary}
        onInput={onInput}
        onSubmit={() => state.closeThemePicker(true)}
      />
      <scrollbox
        ref={(el) => (themeRef = el)}
        width="100%"
        height={Math.min(12, Math.max(1, state.themeResults().length))}
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
          when={state.themeResults().length > 0}
          fallback={
            <box id="theme-empty" paddingLeft={1}>
              <text fg={theme.colors.text.muted}>no themes</text>
            </box>
          }
        >
          {/* Id-by-index is required: reordering results must never change a live renderable's id */}
          <Index each={state.themeResults()}>
            {(item, index) => {
              const selected = () => index === state.themeIndex();
              const current = () => item().selection === state.themeOrigin();
              return (
                <box
                  id={`theme-${index}`}
                  width="100%"
                  flexDirection="row"
                  paddingLeft={1}
                  paddingRight={1}
                  backgroundColor={
                    selected() ? theme.colors.surface.cursor : theme.colors.surface.panel
                  }
                  onMouseOver={() => state.setThemeIndex(index)}
                  onMouseDown={() =>
                    batch(() => {
                      state.setThemeIndex(index);
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

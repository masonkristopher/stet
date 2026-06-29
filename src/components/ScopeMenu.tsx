import type { ScrollBoxRenderable } from "@opentui/core";
import { createEffect, Index } from "solid-js";

import { scopeKinds, scopeMenuLabel } from "@/cli";
import { state } from "@/state";
import { useTheme } from "@/theme/context";

export function ScopeMenu() {
  const theme = useTheme();
  let scopeMenuRef: ScrollBoxRenderable | undefined;

  createEffect(() => {
    scopeMenuRef?.scrollChildIntoView(`scope-menu-${state.scopeMenuIndex()}`);
  });

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
        <text fg={theme.colors.text.strong}>switch scope</text>
      </box>
      <scrollbox
        ref={(el) => (scopeMenuRef = el)}
        width="100%"
        height={scopeKinds.length}
        scrollY
        viewportCulling
        scrollbarOptions={{
          trackOptions: {
            backgroundColor: theme.rgba.transparent,
            foregroundColor: theme.colors.scrollbar.thumb,
          },
        }}
      >
        {/* Id-by-index is required: reordering must never change a live renderable's id */}
        <Index each={scopeKinds}>
          {(kind, index) => {
            const current = () => kind() === state.scope().kind;
            const nameFg = () =>
              index === state.scopeMenuIndex()
                ? theme.colors.text.selected
                : theme.colors.text.strong;
            return (
              <box
                id={`scope-menu-${index}`}
                width="100%"
                paddingLeft={1}
                paddingRight={1}
                backgroundColor={
                  index === state.scopeMenuIndex()
                    ? theme.colors.surface.cursor
                    : theme.colors.surface.panel
                }
              >
                <text fg={nameFg()}>{`${current() ? "● " : "  "}${scopeMenuLabel(kind())}`}</text>
              </box>
            );
          }}
        </Index>
      </scrollbox>
      <box height={1} paddingLeft={1} backgroundColor={theme.colors.surface.panel}>
        <text fg={theme.colors.text.muted}>↑↓ navigate · ⏎ switch · esc close</text>
      </box>
    </box>
  );
}

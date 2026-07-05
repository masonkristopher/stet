import type { MouseEvent } from "@opentui/core";
import type { JSX } from "@opentui/solid";
import { Show } from "solid-js";

import { useTheme } from "@/theme/context";

/**
 * The shared frame for the three persistent panes (tree, viewer, problems). The box border stays
 * neutral in every state; focus tints the four corner glyphs pink, drawn as absolute overlays so
 * they reserve no content space (no reflow on focus). A corner glyph is a self-contained cell, so
 * it never pokes past or wraps a neutral side the way a spine on the border edge would.
 */
export function PaneFrame(props: {
  focused: boolean;
  onMouseDown?: (event: MouseEvent) => void;
  width?: number | "auto" | `${number}%`;
  height?: number | "auto" | `${number}%`;
  flexGrow?: number;
  backgroundColor?: string;
  children: JSX.Element;
}) {
  const theme = useTheme();
  return (
    <box
      position="relative"
      width={props.width}
      height={props.height}
      flexGrow={props.flexGrow}
      flexDirection="column"
      onMouseDown={props.onMouseDown}
    >
      <box
        width="100%"
        height="100%"
        flexDirection="column"
        borderStyle="single"
        borderColor={theme.colors.border.unfocused}
        backgroundColor={props.backgroundColor}
      >
        {props.children}
      </box>
      <Show when={props.focused}>
        {/* Overpaint just the four corner cells; the neutral sides show through. */}
        <text position="absolute" top={0} left={0} fg={theme.colors.border.focused}>
          {"┌"}
        </text>
        <text position="absolute" top={0} right={0} fg={theme.colors.border.focused}>
          {"┐"}
        </text>
        <text position="absolute" bottom={0} left={0} fg={theme.colors.border.focused}>
          {"└"}
        </text>
        <text position="absolute" bottom={0} right={0} fg={theme.colors.border.focused}>
          {"┘"}
        </text>
      </Show>
    </box>
  );
}

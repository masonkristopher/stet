import { Show } from "solid-js";

import { recencyFraction } from "@/git/activity";
import { state } from "@/state";
import { useTheme } from "@/theme/context";
import { lerpHex } from "@/utils/color";

// The dot fades from recency.fresh toward recency.aged across an activity's
// Lifetime, then disappears once it ages out. Reads state.now() (the 1s tick
// That already re-renders these dots), so the ramp is free of new reactivity.
// Shared by the tree, the file picker, and the status bar's recent-file cue.
// It renders only the mark; spacing is the caller's, expressed as a margin so it
// Stays gated to the dot's presence (an aged-out dot leaves no stray gap behind).
export function RecencyDot(props: {
  at: number | undefined;
  marginLeft?: number;
  marginRight?: number;
}) {
  const theme = useTheme();
  // `recencyFraction` is 0 at its freshest, so the dot must key on the resolved
  // Color (string | undefined), never on the fraction's truthiness.
  const color = () => {
    const fraction = recencyFraction(props.at, state.now());
    return fraction === undefined
      ? undefined
      : lerpHex(theme.colors.recency.fresh, theme.colors.recency.aged, fraction);
  };
  return (
    <Show when={color()}>
      {(fg) => (
        // A decorative mark, never content: opting the glyph out of OpenTUI's text selection keeps a
        // Drag over it (a tree row) from painting a stray highlight. Selection is stet's, and
        // Nothing here is worth selecting.
        <text
          ref={(el) => (el.selectable = false)}
          fg={fg()}
          marginLeft={props.marginLeft}
          marginRight={props.marginRight}
        >
          ●
        </text>
      )}
    </Show>
  );
}

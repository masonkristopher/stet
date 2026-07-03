import { createMemo } from "solid-js";

import { useTheme } from "@/theme/context";

import { scrollbarThumb } from "./scrollbar";

/**
 * A hand-drawn scroll-position indicator for a windowed list: one width-1 column whose thumb is
 * derived from the window's own (rowCount, viewport, scrollTop), since a viewport-windowed list
 * mounts only the visible slice and leaves the native scrollbox nothing to measure. Shared by the
 * sidebar, problems panel, search results, and the references overlay, the same surfaces that reuse
 * `windowWheelHandler`.
 *
 * It is one visual element, so it renders as one `<text>` (not a renderable per cell): thumb cells
 * take the glyph, track cells are spaces that paint nothing so the surface shows through
 * (transparent track). The column stays reserved even with no overflow, so content growth never
 * shifts layout.
 */
export function ListScrollbar(props: {
  rowCount: () => number;
  viewport: () => number;
  scrollTop: () => number;
}) {
  const theme = useTheme();
  const content = createMemo(() => {
    const thumb = scrollbarThumb(props.rowCount(), props.viewport(), props.scrollTop());
    return Array.from({ length: props.viewport() }, (_, index) =>
      thumb !== undefined && index >= thumb.top && index < thumb.top + thumb.size ? "▐" : " ",
    ).join("\n");
  });
  return (
    <box ref={(el) => (el.selectable = false)} width={1}>
      <text height={props.viewport()} wrapMode="none" fg={theme.colors.scrollbar.thumb}>
        {content()}
      </text>
    </box>
  );
}

import type { MouseEvent } from "@opentui/core";

const WHEEL_STEP = 3;

/**
 * Wheel-scroll for a windowed uniform-row list: 3 rows per notch, clamped to the content,
 * swallowing the event delta so an enclosing scrollbox never also scrolls. Shared by the sidebar,
 * problems panel, search results, and the references overlay, which window identically; DiffView's
 * wheel stays bespoke (a horizontal axis, wrap gating, its own steps). Callers pass `state`
 * accessors as closures, the same shape as an inline handler.
 */
export function windowWheelHandler(view: {
  rowCount: () => number;
  viewport: () => number;
  scrollTop: () => number;
  setScrollTop: (next: number) => void;
}) {
  return (event: MouseEvent) => {
    const direction = event.scroll?.direction;
    if (direction !== "up" && direction !== "down") {
      return;
    }
    const delta = event.scroll?.delta ?? 1;
    const maxScroll = Math.max(0, view.rowCount() - view.viewport());
    view.setScrollTop(
      Math.max(
        0,
        Math.min(
          view.scrollTop() + (direction === "down" ? 1 : -1) * delta * WHEEL_STEP,
          maxScroll,
        ),
      ),
    );
    if (event.scroll !== undefined) {
      event.scroll.delta = 0;
    }
  };
}

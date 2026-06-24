// Pure cursor-follow scroll: given the cursor row's position and the viewport,
// Return the scroll offset that keeps the row on screen with a margin of context
// Rows above and below it (editor-style scrolloff), so the cursor never sits
// Flush against the viewport edge. Kept pure (no Solid/OpenTUI) so the follow
// Math is unit-tested directly rather than only through the render harness.

export interface FollowScroll {
  /** Cumulative terminal-row offset of the cursor row's top edge. */
  top: number;
  /** The cursor row's terminal-row height (1 unless a wrapped line). */
  height: number;
  /** Visible viewport height in terminal rows. */
  viewport: number;
  /** The current scroll offset. */
  current: number;
  /** Deepest valid scroll offset (total content height minus the viewport). */
  maxScroll: number;
  /** Desired context rows to keep between the cursor and each viewport edge. */
  margin: number;
}

export function followScrollTop({
  top,
  height,
  viewport,
  current,
  maxScroll,
  margin,
}: FollowScroll) {
  // A row taller than the viewport can't be framed with any margin; anchor its
  // Top so repeated runs settle on one offset instead of flipping top/bottom.
  if (height >= viewport) {
    return Math.max(0, Math.min(top, maxScroll));
  }
  // Cap the margin to the space the row actually leaves on each side, not just to
  // The viewport: with `height + 2*margin > viewport` the requested margin can't
  // Hold on both edges, and a margin clamped only to the viewport would alternate
  // Between top- and bottom-alignment across runs. `floor((viewport - height) / 2)`
  // Guarantees a non-empty no-op band, so the offset converges.
  const safeMargin = Math.min(Math.max(0, margin), Math.floor((viewport - height) / 2));
  const next =
    top - safeMargin < current
      ? top - safeMargin
      : top + height + safeMargin > current + viewport
        ? top + height + safeMargin - viewport
        : current;
  return Math.max(0, Math.min(next, maxScroll));
}

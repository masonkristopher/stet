import type { MouseEvent } from "@opentui/core";
import { batch, createMemo, Show } from "solid-js";

import { checkerSummary, directorySummary } from "@/diagnostics/checker";
import { recencyFraction } from "@/git/activity";
import type { DirectoryNode, FileTreeRow } from "@/git/tree";
import { levelGlyph } from "@/log/levels";
import { state } from "@/state";
import { useTheme } from "@/theme/context";
import { kindLetter } from "@/ui-helpers";
import { lerpHex } from "@/utils/color";
import { fileIcon, folderIcon, symlinkIcon } from "@/utils/file-icon";
import { truncate, truncateName } from "@/utils/text";

// Fine-grained reactivity replaces React.memo: only the rows whose focus,
// Selection, or checker state actually change re-evaluate. The double-click guard
// Is owned by the Sidebar and shared across rows, so it survives a row remount
// Mid-gesture (a changed file's row re-renders) and never leaks process-wide.
export function TreeRow(props: { row: FileTreeRow; isDoubleClick: (id: string) => boolean }) {
  const theme = useTheme();
  const node = props.row.node;
  const indent = " ".repeat(Math.max(0, props.row.depth) * 2);
  const focused = () =>
    state.focusedPane() === "tree" && props.row.index === state.focusedRowIndex();
  const background = () => (focused() ? theme.colors.surface.cursor : theme.colors.surface.base);
  const contentWidth = () => state.sidebarWidth() - 4;

  // Clicking a row reproduces the keyboard outcome for that row: a file selects
  // And opens (like `enter`), and double-clicking it pins it as a tab; a directory
  // Moves the cursor there and toggles its expansion (collapsing `l`/`h` into one
  // Click). stopPropagation keeps the Sidebar's focus-only handler from also
  // Firing for a row click.
  const onMouseDown = (event: MouseEvent) => {
    event.stopPropagation();
    batch(() => {
      state.setFocusedPane("tree");
      if (node.type === "file") {
        state.selectFile(node.path);
        if (props.isDoubleClick(node.path)) {
          state.pinActiveTab();
        }
        return;
      }
      state.setFocusedNodeId(node.id);
      const next = new Set(state.expandedDirectories());
      if (next.has(node.id)) {
        next.delete(node.id);
      } else {
        next.add(node.id);
      }
      state.setExpandedDirectories(next);
    });
  };

  if (node.type === "directory") {
    const isExpanded = () => state.expandedDirectories().has(node.id);
    const recencyAt = () =>
      directoryRecencyAt(node, state.expandedDirectories(), state.recencyByPath());
    const summary = createMemo(() =>
      isExpanded() ? null : directorySummary(node.path, state.checkerState()),
    );
    const nameFg = () =>
      focused()
        ? theme.colors.text.selected
        : node.changedCount > 0
          ? theme.colors.text.primary
          : theme.colors.text.strong;
    const hasBadges = () => {
      const s = summary();
      return (
        !isExpanded() &&
        (node.changedCount > 0 ||
          Boolean(s?.failed) ||
          Boolean(s?.pending) ||
          Boolean(s?.unavailable) ||
          (s?.errors ?? 0) > 0 ||
          (s?.warnings ?? 0) > 0 ||
          (s?.info ?? 0) > 0)
      );
    };
    const maxNameLen = () => contentWidth() - indent.length - 2 - (hasBadges() ? 14 : 0);
    return (
      <box
        id={node.id}
        width="100%"
        height={1}
        overflow="hidden"
        flexDirection="row"
        justifyContent="space-between"
        paddingLeft={1}
        paddingRight={1}
        backgroundColor={background()}
        onMouseDown={onMouseDown}
      >
        <box flexDirection="row">
          <box flexDirection="row" flexShrink={0}>
            <text fg={nameFg()}>{indent}</text>
            <box width={2} overflow="hidden">
              <text fg={nameFg()}>
                {state.iconsEnabled() ? folderIcon(isExpanded()) : isExpanded() ? "▾" : "▸"}
              </text>
            </box>
          </box>
          <text fg={nameFg()}>{truncateName(`${node.name}/`, maxNameLen())}</text>
          <RecencyDot at={recencyAt()} />
        </box>
        <box flexDirection="row">
          {summary()?.failed ? <text fg={theme.colors.severity.error}>fail </text> : null}
          {(summary()?.errors ?? 0) > 0 ? (
            <text
              fg={theme.colors.severity.error}
            >{`${levelGlyph("error")}${summary()?.errors} `}</text>
          ) : null}
          {summary() !== null && summary()?.errors === 0 && (summary()?.warnings ?? 0) > 0 ? (
            <text
              fg={theme.colors.severity.warning}
            >{`${levelGlyph("warning")}${summary()?.warnings} `}</text>
          ) : null}
          {summary()?.errors === 0 && summary()?.warnings === 0 && (summary()?.info ?? 0) > 0 ? (
            <text
              fg={theme.colors.severity.info}
            >{`${levelGlyph("info")}${summary()?.info} `}</text>
          ) : null}
          {summary()?.pending ? <text fg={theme.colors.text.muted}>… </text> : null}
          {summary() !== null &&
          node.changedCount > 0 &&
          !summary()?.failed &&
          !summary()?.pending &&
          !summary()?.unavailable &&
          summary()?.errors === 0 &&
          summary()?.warnings === 0 &&
          (summary()?.info ?? 0) === 0 ? (
            <text fg={theme.colors.success}>{`${levelGlyph("success")} `}</text>
          ) : null}
          {summary()?.unavailable &&
          !summary()?.failed &&
          !summary()?.pending &&
          (summary()?.errors ?? 0) === 0 &&
          (summary()?.warnings ?? 0) === 0 ? (
            <text fg={theme.colors.text.muted}>○ </text>
          ) : null}
          {node.changedCount > 0 ? (
            <text
              fg={
                node.stage !== undefined ? theme.colors.stage[node.stage] : theme.colors.text.muted
              }
            >
              {`+${node.additions} -${node.deletions}`}
            </text>
          ) : null}
        </box>
      </box>
    );
  }

  const changed = node.changed;
  const summary = createMemo(() => checkerSummary(node.path, state.checkerState()));
  const selected = () => state.selectedPath() === node.path;
  const nameFg = () =>
    focused() || selected()
      ? theme.colors.text.selected
      : changed === undefined
        ? theme.colors.text.secondary
        : theme.colors.kind[changed.kind];
  const pending = () => changed !== undefined && summary().pending;
  const hasBadges = () => {
    const s = summary();
    return changed !== undefined || s.failed || s.errors > 0 || s.warnings > 0 || s.pending;
  };
  const maxNameLen = () =>
    contentWidth() - indent.length - (state.iconsEnabled() ? 2 : 0) - (hasBadges() ? 14 : 0);

  return (
    <box
      id={node.id}
      width="100%"
      height={1}
      overflow="hidden"
      flexDirection="row"
      justifyContent="space-between"
      paddingLeft={1}
      paddingRight={1}
      backgroundColor={background()}
      onMouseDown={onMouseDown}
    >
      <box flexDirection="row">
        <box flexDirection="row" flexShrink={0}>
          <text fg={theme.colors.text.muted}>{indent}</text>
          {state.iconsEnabled() ? (
            <box width={2} overflow="hidden">
              <text fg={theme.colors.text.muted}>
                {node.symlink ? symlinkIcon() : fileIcon(node.name)}
              </text>
            </box>
          ) : null}
        </box>
        <text fg={nameFg()}>{truncate(node.name, maxNameLen())}</text>
        <RecencyDot at={state.recencyByPath().get(node.path)} />
      </box>
      <box flexDirection="row">
        {summary().failed ? <text fg={theme.colors.severity.error}>fail </text> : null}
        {summary().errors > 0 ? (
          <text
            fg={theme.colors.severity.error}
          >{`${levelGlyph("error")}${summary().errors} `}</text>
        ) : null}
        {summary().errors === 0 && summary().warnings > 0 ? (
          <text
            fg={theme.colors.severity.warning}
          >{`${levelGlyph("warning")}${summary().warnings} `}</text>
        ) : null}
        {summary().errors === 0 && summary().warnings === 0 && summary().info > 0 ? (
          <text fg={theme.colors.severity.info}>{`${levelGlyph("info")}${summary().info} `}</text>
        ) : null}
        {changed !== undefined && changed.warnings.length > 0 ? (
          <text fg={theme.colors.severity.warning}>! </text>
        ) : null}
        {changed !== undefined &&
        !pending() &&
        !summary().failed &&
        !summary().unavailable &&
        summary().errors === 0 &&
        summary().warnings === 0 &&
        summary().info === 0 ? (
          <text fg={theme.colors.success}>{`${levelGlyph("success")} `}</text>
        ) : null}
        {changed !== undefined &&
        !pending() &&
        !summary().failed &&
        summary().unavailable &&
        summary().errors === 0 &&
        summary().warnings === 0 ? (
          <text fg={theme.colors.text.muted}>○ </text>
        ) : null}
        {changed === undefined ? null : (
          <text fg={theme.colors.text.muted}>{`+${changed.additions} -${changed.deletions} `}</text>
        )}
        {pending() ? <text fg={theme.colors.text.muted}>… </text> : null}
        {changed === undefined ? null : (
          <text fg={theme.colors.stage[changed.stage]}>{kindLetter(changed.kind)}</text>
        )}
      </box>
    </box>
  );
}

// The dot fades from recency.fresh toward recency.aged across an activity's
// Lifetime, then disappears once it ages out. Reads state.now() (the 1s tick
// That already re-renders these dots), so the ramp is free of new reactivity.
export function RecencyDot(props: { at: number | undefined }) {
  const theme = useTheme();
  // `recencyFraction` is 0 at its freshest, so the dot must key on the resolved
  // Color (string | undefined), never on the fraction's truthiness.
  const color = () => {
    const fraction = recencyFraction(props.at, state.now());
    return fraction === undefined
      ? undefined
      : lerpHex(theme.colors.recency.fresh, theme.colors.recency.aged, fraction);
  };
  return <Show when={color()}>{(fg) => <text fg={fg()}> ●</text>}</Show>;
}

// The directory dot tracks its most recently changed descendant; the dot itself
// Decides freshness from the timestamp, so an aged-out value simply yields no dot.
function directoryRecencyAt(
  node: DirectoryNode,
  expandedDirectories: Set<string>,
  recencyByPath: Map<string, number>,
): number | undefined {
  if (expandedDirectories.has(node.id)) {
    return undefined;
  }

  const prefix = `${node.path}/`;
  let latest: number | undefined;
  for (const [path, at] of recencyByPath) {
    if (path.startsWith(prefix) && (latest === undefined || at > latest)) {
      latest = at;
    }
  }

  return latest;
}

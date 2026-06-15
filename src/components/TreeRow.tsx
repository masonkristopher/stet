import { createMemo } from "solid-js";

import { checkerSummary, directorySummary } from "../diagnostics/checker";
import { recencyLevel, type RecencyLevel } from "../git/activity";
import type { DirectoryNode, FileTreeRow } from "../git/tree";
import { state } from "../state";
import { useTheme } from "../theme/context";
import { kindLetter } from "../ui-helpers";
import { fileIcon, folderIcon } from "../utils/file-icon";
import { truncate, truncateName } from "../utils/text";

// Fine-grained reactivity replaces React.memo: only the rows whose focus,
// Selection, or checker state actually change re-evaluate.
export function TreeRow(props: { row: FileTreeRow }) {
  const theme = useTheme();
  const node = props.row.node;
  const indent = " ".repeat(Math.max(0, props.row.depth) * 2);
  const focused = () =>
    state.focusedPane() === "tree" && props.row.index === state.focusedRowIndex();
  const background = () => (focused() ? theme.colors.surface.cursor : theme.colors.surface.base);
  const contentWidth = () => state.sidebarWidth() - 4;

  if (node.type === "directory") {
    const isExpanded = () => state.expandedDirectories().has(node.id);
    const recency = () =>
      directoryRecency(node, state.expandedDirectories(), state.recencyByPath(), state.now());
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
          (s?.errors ?? 0) > 0 ||
          (s?.warnings ?? 0) > 0)
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
          <RecencyDot level={recency()} />
        </box>
        <box flexDirection="row">
          {summary()?.failed ? <text fg={theme.colors.severity.error}>fail </text> : null}
          {(summary()?.errors ?? 0) > 0 ? (
            <text fg={theme.colors.severity.error}>{`✖${summary()?.errors} `}</text>
          ) : null}
          {summary() !== null && summary()?.errors === 0 && (summary()?.warnings ?? 0) > 0 ? (
            <text fg={theme.colors.severity.warning}>{`⚠${summary()?.warnings} `}</text>
          ) : null}
          {summary()?.pending ? <text fg={theme.colors.text.muted}>… </text> : null}
          {summary() !== null &&
          node.changedCount > 0 &&
          !summary()?.failed &&
          !summary()?.pending &&
          summary()?.errors === 0 &&
          summary()?.warnings === 0 ? (
            <text fg={theme.colors.success}>✓ </text>
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
  const recency = () => recencyLevel(state.recencyByPath().get(node.path), state.now());
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
    >
      <box flexDirection="row">
        <box flexDirection="row" flexShrink={0}>
          <text fg={theme.colors.text.muted}>{indent}</text>
          {state.iconsEnabled() ? (
            <box width={2} overflow="hidden">
              <text fg={theme.colors.text.muted}>{fileIcon(node.name)}</text>
            </box>
          ) : null}
        </box>
        <text fg={nameFg()}>{truncate(node.name, maxNameLen())}</text>
        <RecencyDot level={recency()} />
      </box>
      <box flexDirection="row">
        {summary().failed ? <text fg={theme.colors.severity.error}>fail </text> : null}
        {summary().errors > 0 ? (
          <text fg={theme.colors.severity.error}>{`✖${summary().errors} `}</text>
        ) : null}
        {summary().errors === 0 && summary().warnings > 0 ? (
          <text fg={theme.colors.severity.warning}>{`⚠${summary().warnings} `}</text>
        ) : null}
        {changed !== undefined && changed.warnings.length > 0 ? (
          <text fg={theme.colors.severity.warning}>! </text>
        ) : null}
        {changed !== undefined &&
        !pending() &&
        !summary().failed &&
        summary().errors === 0 &&
        summary().warnings === 0 ? (
          <text fg={theme.colors.success}>✓ </text>
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

export function RecencyDot(props: { level: RecencyLevel }) {
  const theme = useTheme();
  return props.level === "none" ? null : (
    <text fg={props.level === "fresh" ? theme.colors.accent.primary : theme.colors.accent.dim}>
      {" "}
      ●
    </text>
  );
}

function directoryRecency(
  node: DirectoryNode,
  expandedDirectories: Set<string>,
  recencyByPath: Map<string, number>,
  now: number,
): RecencyLevel {
  if (expandedDirectories.has(node.id)) {
    return "none";
  }

  const prefix = `${node.path}/`;
  let level: RecencyLevel = "none";
  for (const [path, at] of recencyByPath) {
    if (!path.startsWith(prefix)) {
      continue;
    }

    const pathLevel = recencyLevel(at, now);
    if (pathLevel === "fresh") {
      return "fresh";
    }

    if (pathLevel === "recent") {
      level = "recent";
    }
  }

  return level;
}

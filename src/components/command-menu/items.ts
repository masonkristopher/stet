// The context menu's item list, kept a pure function of plain inputs (no Solid/
// Effect/OpenTUI) so the per-context contents are unit-tested directly, the way
// `viewer/anchor.ts` is. `state.commandMenuItems` wraps this over the live caret and
// Tree signals; the keymap and the row click both dispatch a returned `action`, so
// The menu introduces no new behavior. Inapplicable actions are omitted, not shown
// Disabled, so every visible item is always actionable.

/**
 * A menu item's effect: every variant maps to an existing `state` action (or, for `openEditor`, the
 * injected host effect).
 */
export type CommandAction =
  | { kind: "goToDefinition" }
  | { kind: "findReferences" }
  | { kind: "callHierarchy" }
  | { kind: "findImplementations" }
  | { kind: "showHover" }
  | { kind: "findSymbols" }
  | { kind: "copyReference"; path: string; line: number | undefined; column: number | undefined }
  | { kind: "copyFileContents" }
  | { kind: "loadFullContent" }
  | { kind: "pinTab"; path: string }
  | { kind: "openEditor"; mode: "terminal" | "ide"; path: string; line: number | undefined };

export interface CommandMenuItem {
  label: string;
  action: CommandAction;
}

export interface CommandMenuInput {
  context: "tree" | "viewer";
  /** The viewed file; the viewer menu is empty without one. */
  selectedPath: string | undefined;
  /** Whether the caret sits on a symbol (`caretWord`), gating the intel actions. */
  hasSymbol: boolean;
  /** The caret line (`newLine ?? oldLine`) for copy-reference and editor open. */
  caretLine: number | undefined;
  /** The caret's 1-based column, or undefined at line level (`caretColumn`). */
  caretColumn: number | undefined;
  /** The focused tree node; the tree menu is empty without one. */
  treeNode: { kind: "file" | "directory"; id: string; path: string } | undefined;
  /** Whether the viewer capped the file, gating the "Show full content" action. */
  truncated: boolean;
}

export function buildCommandMenuItems(input: CommandMenuInput): CommandMenuItem[] {
  return input.context === "viewer" ? viewerItems(input) : treeItems(input);
}

function viewerItems(input: CommandMenuInput): CommandMenuItem[] {
  const path = input.selectedPath;
  if (path === undefined) {
    return [];
  }
  // Line-level (a gutter caret) has no column, so copy-reference degrades to path:line.
  const column = input.caretLine === undefined ? undefined : input.caretColumn;
  const intel: CommandMenuItem[] = input.hasSymbol
    ? [
        { action: { kind: "goToDefinition" }, label: "Go to definition" },
        { action: { kind: "findReferences" }, label: "Find references" },
        { action: { kind: "findImplementations" }, label: "Find implementations" },
        { action: { kind: "callHierarchy" }, label: "Call hierarchy" },
        { action: { kind: "showHover" }, label: "Quick info" },
      ]
    : [];
  return [
    ...intel,
    // Always available: the outline addresses the whole file, so it needs no caret symbol.
    { action: { kind: "findSymbols" }, label: "Find symbols" },
    {
      action: { column, kind: "copyReference", line: input.caretLine, path },
      label: "Copy reference",
    },
    { action: { kind: "copyFileContents" }, label: "Copy file contents" },
    {
      action: { kind: "openEditor", line: input.caretLine, mode: "terminal", path },
      label: "Open in editor",
    },
    {
      action: { kind: "openEditor", line: input.caretLine, mode: "ide", path },
      label: "Open in IDE",
    },
    // Only when the viewer actually capped the file; otherwise it would be a no-op.
    ...(input.truncated
      ? [{ action: { kind: "loadFullContent" }, label: "Show full content" } as const]
      : []),
  ];
}

function treeItems(input: CommandMenuInput): CommandMenuItem[] {
  const node = input.treeNode;
  if (node === undefined) {
    return [];
  }
  const copyPath: CommandMenuItem = {
    action: { column: undefined, kind: "copyReference", line: undefined, path: node.path },
    label: "Copy path",
  };
  // A directory has no open-in-a-viewer or pin-as-tab action (expand/collapse is the
  // Row click's job, not the menu's), so it offers only its path.
  if (node.kind === "directory") {
    return [copyPath];
  }
  return [
    { action: { kind: "pinTab", path: node.path }, label: "Pin as tab" },
    copyPath,
    {
      action: { kind: "openEditor", line: undefined, mode: "terminal", path: node.path },
      label: "Open in editor",
    },
    {
      action: { kind: "openEditor", line: undefined, mode: "ide", path: node.path },
      label: "Open in IDE",
    },
  ];
}

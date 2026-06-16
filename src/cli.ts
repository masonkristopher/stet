export type ScopeKind = "all" | "staged" | "unstaged";

export interface DiffScope {
  kind: ScopeKind;
  ref: string;
}

export interface CliOptions {
  scope: DiffScope;
  help: boolean;
  version: boolean;
  icons: boolean;
  lspDownload: boolean;
}

export function parseArgs(args: string[]): CliOptions {
  let kind: ScopeKind = "all";
  let help = false;
  let version = false;
  let icons = true;
  let lspDownload = true;
  let ref: string | undefined;

  for (const arg of args) {
    if (arg === "--no-icons") {
      icons = false;
      continue;
    }

    if (arg === "--no-lsp-download") {
      lspDownload = false;
      continue;
    }

    if (arg === "--staged") {
      kind = "staged";
      continue;
    }

    if (arg === "--unstaged") {
      kind = "unstaged";
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }

    if (arg === "--version" || arg === "-v") {
      version = true;
      continue;
    }

    if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    }

    if (ref !== undefined) {
      throw new Error(`Unexpected argument: ${arg}`);
    }

    ref = arg;
  }

  return {
    help,
    icons,
    lspDownload,
    scope: { kind, ref: ref ?? "HEAD" },
    version,
  };
}

export function nextScope(kind: ScopeKind): ScopeKind {
  if (kind === "all") {
    return "staged";
  }

  if (kind === "staged") {
    return "unstaged";
  }

  return "all";
}

export function scopeLabel(scope: DiffScope) {
  if (scope.kind === "staged") {
    return `staged vs ${scope.ref}`;
  }

  if (scope.kind === "unstaged") {
    return "unstaged";
  }

  return `worktree vs ${scope.ref}`;
}

export function helpText() {
  return `sideye - read-only companion TUI for CLI coding agents

Usage:
  sideye
  sideye <ref>
  sideye --staged [ref]
  sideye --unstaged
  sideye --no-icons        (disable Nerd Font file-type icons in the tree)
  sideye --no-lsp-download (do not auto-download a missing language server)

Keys:
  tab        switch focus between the file tree and the viewer

File tree:
  j/down     next row
  k/up       previous row
  h/left     collapse folder
  l/right    expand folder
  enter      open focused tree item

Viewer:
  j/down     move cursor down a line
  k/up       move cursor up a line
  ctrl-d/u   move cursor half a page
  g/G        jump to first / last line
  /          find in the viewer (n/N cycle matches, escape clears)
  h/left     return focus to the file tree

Problems:
  j/down     next problem
  k/up       previous problem
  enter      jump to the problem's file and line
  p/escape   close the panel

Anywhere:
  ctrl-p     open the go-to-file palette (type to fuzzy-search, enter jumps)
  ctrl-f     search file contents (ctrl-a toggles changes/repo, enter jumps)
  s          cycle scope: all changes -> staged -> unstaged
  c          toggle changes-only filter for the tree
  v          toggle diff <-> full file view
  p          toggle the problems panel
  .          jump to the most recently changed file
  f          load full content when truncated
  y          copy path:line + snippet at the cursor
  n          jump to next file with findings
  r          re-run checks
  q/escape   quit

The whole repo renders as a tree with changes overlaid; open any file
read-only. The view is live: files, diffs, and recency markers refresh as an
agent edits, and checks re-run after the repo goes quiet.
`;
}

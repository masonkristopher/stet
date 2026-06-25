export type ScopeKind = "unstaged" | "staged" | "all" | "session" | "last-commit";

// Picker order, also the single source of truth for the scope list.
export const scopeKinds = ["unstaged", "staged", "all", "session", "last-commit"] as const;

export interface DiffScope {
  kind: ScopeKind;
  ref: string;
  /** The right-hand ref, set only for `last-commit` (the one range scope). */
  headRef?: string;
}

export interface CliOptions {
  scope: DiffScope;
  help: boolean;
  version: boolean;
  icons: boolean;
  lspDownload: boolean;
  /** Long line handling: `scroll` (default) or `wrap`. */
  overflow: "scroll" | "wrap";
}

export function parseArgs(args: string[]): CliOptions {
  let kind: ScopeKind = "all";
  let help = false;
  let version = false;
  let icons = true;
  let lspDownload = true;
  let overflow: "scroll" | "wrap" = "scroll";
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

    if (arg === "--wrap") {
      overflow = "wrap";
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
    overflow,
    scope: { kind, ref: ref ?? "HEAD" },
    version,
  };
}

export function scopeLabel(scope: DiffScope) {
  if (scope.kind === "staged") {
    return `staged vs ${scope.ref}`;
  }

  if (scope.kind === "unstaged") {
    return "unstaged";
  }

  if (scope.kind === "session") {
    return "since session start";
  }

  if (scope.kind === "last-commit") {
    return "last commit";
  }

  return `worktree vs ${scope.ref}`;
}

// Ref-agnostic row labels for the scope picker (the active scope's full,
// Ref-bearing label still shows in the header via scopeLabel).
export function scopePickerLabel(kind: ScopeKind) {
  if (kind === "staged") {
    return "staged";
  }

  if (kind === "all") {
    return "all changes";
  }

  if (kind === "session") {
    return "since session start";
  }

  if (kind === "last-commit") {
    return "last commit";
  }

  return "unstaged";
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
  sideye --wrap            (wrap long lines in the viewer instead of overflowing)

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
  s          open the scope picker (unstaged/staged/all/session/last commit)
  t          open the theme switcher (filter, preview live, enter applies)
  c          toggle changes-only filter for the tree
  v          toggle diff <-> full file view
  z          toggle long-line wrap in the viewer
  p          toggle the problems panel
  .          jump to the most recently changed file
  f          load full content when truncated
  y          copy the focused file's path (tree) or path:line (viewer)
  n          jump to next file with findings
  r          re-run checks
  q/escape   quit

The whole repo renders as a tree with changes overlaid; open any file
read-only. The view is live: files, diffs, and recency markers refresh as an
agent edits, and checks re-run after the repo goes quiet.
`;
}

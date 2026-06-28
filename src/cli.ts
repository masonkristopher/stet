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
  editor: string | undefined;
  help: boolean;
  icons: boolean;
  ide: string | undefined;
  lspDownload: boolean;
  /** Long line handling: `scroll` (default) or `wrap`. */
  overflow: "scroll" | "wrap";
  scope: DiffScope;
  version: boolean;
}

export type Command = { kind: "run"; options: CliOptions } | { kind: "upgrade" };

/**
 * Splits the reserved `upgrade` subcommand from the default TUI invocation before `parseArgs` runs,
 * so the "single positional = git ref" grammar never has to disambiguate it. `upgrade` takes no
 * further arguments.
 */
export function parseCommand(args: string[]): Command {
  if (args[0] !== "upgrade") {
    return { kind: "run", options: parseArgs(args) };
  }

  const extra = args[1];
  if (extra !== undefined) {
    throw new Error(
      extra.startsWith("-") ? `Unknown option: ${extra}` : `Unexpected argument: ${extra}`,
    );
  }

  return { kind: "upgrade" };
}

export function parseArgs(args: string[]): CliOptions {
  let kind: ScopeKind = "all";
  let help = false;
  let version = false;
  let icons = true;
  let lspDownload = true;
  let overflow: "scroll" | "wrap" = "scroll";
  let ref: string | undefined;
  let editor: string | undefined;
  let ide: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

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

    if (arg.startsWith("--editor=")) {
      const value = arg.slice("--editor=".length);
      if (value.trim() === "") {
        throw new Error("--editor requires a non-empty value");
      }
      editor = value;
      continue;
    }

    if (arg === "--editor") {
      const value = args[++i];
      if (value === undefined || value.trim() === "") {
        throw new Error("--editor requires a non-empty value");
      }
      editor = value;
      continue;
    }

    if (arg.startsWith("--ide=")) {
      const value = arg.slice("--ide=".length);
      if (value.trim() === "") {
        throw new Error("--ide requires a non-empty value");
      }
      ide = value;
      continue;
    }

    if (arg === "--ide") {
      const value = args[++i];
      if (value === undefined || value.trim() === "") {
        throw new Error("--ide requires a non-empty value");
      }
      ide = value;
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
    editor,
    help,
    icons,
    ide,
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
export function scopeMenuLabel(kind: ScopeKind) {
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
  return `sideye - read-only companion TUI with IDE-grade insight into agent changes

Usage:
  sideye
  sideye <ref>
  sideye --staged [ref]
  sideye --unstaged
  sideye --no-icons        (disable Nerd Font file-type icons in the tree)
  sideye --no-lsp-download (do not auto-download a missing language server)
  sideye --wrap            (wrap long lines in the viewer instead of overflowing)
  sideye --editor <template>
  sideye --ide <template>
  sideye upgrade           (self-update to the latest release)

Commands:
  upgrade
      Update sideye to the latest release using the channel it was installed
      through: a standalone install re-runs the install script, an npm install
      runs npm, and a Homebrew install runs brew upgrade. If the install
      channel cannot be determined, it prints the upgrade commands instead.

Options:
  --editor <template>
      Command template for the terminal editor (e key). The renderer
      suspends, hands the TTY to the editor, then resumes when it exits.
      Use {file} for the path and {line} for the line number.
      Examples:
        --editor "vim +{line} {file}"
        --editor "nvim +{line} {file}"
        --editor "nano +{line} {file}"
      Falls back to SIDEYE_EDITOR, then $EDITOR / $VISUAL (with known-editor
      heuristics for the line arg format), then vim.

  --ide <template>
      Command template for a GUI / IDE (o key). Spawns the process and
      returns immediately; the renderer stays live in its pane.
      Examples:
        --ide "code --goto {file}:{line}"
        --ide "zed {file}:{line}"
        --ide "subl {file}:{line}"
      Falls back to SIDEYE_IDE, then $VISUAL when it differs from $EDITOR.
      If nothing is configured, o does nothing.

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
  e          open in terminal editor (suspends TUI, --editor template)
  o          open in GUI / IDE (renderer stays live, --ide template)
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

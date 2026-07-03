import util from "node:util";

export type ScopeKind = "unstaged" | "staged" | "all" | "session" | "last-commit" | "commit";

// Picker order, also the single source of truth for the scope list. `commit` is
// Absent: it is entered through the picker's commit drill-down, never applied as a
// Top-level row (so `indexOf` a `commit` scope is a benign -1).
export const scopeKinds: readonly ScopeKind[] = [
  "unstaged",
  "staged",
  "all",
  "session",
  "last-commit",
];

export interface DiffScope {
  kind: ScopeKind;
  ref: string;
  /** The right-hand ref, set for the range scopes (`last-commit` and `commit`). */
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
  const { values, positionals } = util.parseArgs({
    allowPositionals: true,
    args,
    options: {
      "editor": { type: "string" },
      "help": { short: "h", type: "boolean" },
      "ide": { type: "string" },
      "no-icons": { type: "boolean" },
      "no-lsp-download": { type: "boolean" },
      "staged": { type: "boolean" },
      "unstaged": { type: "boolean" },
      "version": { short: "v", type: "boolean" },
      "wrap": { type: "boolean" },
    },
    strict: true,
  });

  if (positionals.length > 1) {
    throw new Error(`Unexpected argument: ${positionals[1]}`);
  }

  if (values.staged && values.unstaged) {
    throw new Error("--staged and --unstaged are mutually exclusive");
  }

  const kind: ScopeKind = values.staged ? "staged" : values.unstaged ? "unstaged" : "all";

  return {
    editor: requireNonEmptyValue("--editor", values.editor),
    help: values.help ?? false,
    icons: !values["no-icons"],
    ide: requireNonEmptyValue("--ide", values.ide),
    lspDownload: !values["no-lsp-download"],
    overflow: values.wrap ? "wrap" : "scroll",
    scope: { kind, ref: positionals[0] ?? "HEAD" },
    version: values.version ?? false,
  };
}

// A blank command template (`--editor=`) parses to an empty string.
// Sideye rejects that as a usage error even though parseArgs accepts it.
function requireNonEmptyValue(flag: string, value: string | undefined) {
  if (value !== undefined && value.trim() === "") {
    throw new Error(`${flag} requires a non-empty value`);
  }
  return value;
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

  // The header shows the commit's subject via commitScopeLabel; this short
  // Sha form is the fallback for any other caller (e.g. the search pane).
  if (scope.kind === "commit") {
    return `commit ${scope.headRef?.slice(0, 7) ?? ""}`;
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
      Checks the latest GitHub release first and does nothing when already up
      to date.

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
  ctrl-f     open project search (full-view; regex/case/glob/scope toggles, enter jumps)
  s          open the scope picker (kinds, or drill into recent commits)
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

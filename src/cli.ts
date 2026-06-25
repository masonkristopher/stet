import { basename } from "node:path";

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
  editor: string | undefined;
  ide: string | undefined;
  help: boolean;
  version: boolean;
  icons: boolean;
  lspDownload: boolean;
  /** Long line handling: `scroll` (default) or `wrap`. */
  overflow: "scroll" | "wrap";
}

// Templates for editors whose line-number argument format is known.
// Keys are the basename of the editor binary.
const KNOWN_EDITOR_TEMPLATES: Record<string, string> = {
  code: "code --goto {file}:{line}",
  emacs: "emacs +{line} {file}",
  helix: "helix {file}:{line}",
  hx: "hx {file}:{line}",
  kak: "kak +{line} {file}",
  micro: "micro {file}:{line}",
  nano: "nano +{line} {file}",
  nvim: "nvim +{line} {file}",
  subl: "subl {file}:{line}",
  vi: "vi +{line} {file}",
  vim: "vim +{line} {file}",
  zed: "zed {file}:{line}",
};

/**
 * Resolves the editor command template from (in priority order):
 *   1. An explicit `--editor` value passed on the CLI
 *   2. The `SIDEYE_EDITOR` environment variable
 *   3. `$EDITOR` / `$VISUAL`, with a known-editor heuristic for the line arg format
 *   4. `vim` as the hard fallback
 *
 * The returned string is a whitespace-separated command template where
 * `{file}` and `{line}` are substituted by `buildEditorCommand`.
 */
export function resolveEditorTemplate(explicit: string | undefined): string {
  if (explicit !== undefined) {
    return explicit;
  }

  const env = process.env["SIDEYE_EDITOR"] ?? process.env["EDITOR"] ?? process.env["VISUAL"];
  if (env !== undefined && env !== "") {
    const bin = basename(env.split(/\s+/)[0] ?? env);
    return KNOWN_EDITOR_TEMPLATES[bin] ?? `${env} +{line} {file}`;
  }

  return "vim +{line} {file}";
}

/**
 * Resolves the IDE command template from (in priority order):
 *   1. An explicit `--ide` value passed on the CLI
 *   2. The `SIDEYE_IDE` environment variable
 *   3. `$VISUAL` when it differs from `$EDITOR` (Unix convention: $VISUAL is
 *      often a GUI editor while $EDITOR is a terminal one)
 *   4. `undefined` — if nothing is configured the E key does nothing
 *
 * The returned string uses the same `{file}` / `{line}` placeholder format as
 * `resolveEditorTemplate`.
 */
export function resolveIdeTemplate(explicit: string | undefined): string | undefined {
  if (explicit !== undefined) {
    return explicit;
  }

  const sideye = process.env["SIDEYE_IDE"];
  if (sideye !== undefined && sideye !== "") {
    return sideye;
  }

  const visual = process.env["VISUAL"];
  const editor = process.env["EDITOR"];
  if (visual !== undefined && visual !== "" && visual !== editor) {
    const bin = basename(visual.split(/\s+/)[0] ?? visual);
    return KNOWN_EDITOR_TEMPLATES[bin] ?? `${visual} {file}:{line}`;
  }

  return undefined;
}

/**
 * Expands a template string into an argv array ready to pass to `Bun.spawn`.
 *
 * - `{file}` is replaced with the absolute file path.
 * - `{line}` is replaced with the line number.
 * - Any argument that contains `{line}` but has no line number available is
 *   dropped entirely, so e.g. `+{line}` is omitted rather than becoming `+`.
 */
export function buildEditorCommand(template: string, file: string, line: number | undefined): string[] {
  return template
    .split(/\s+/)
    .filter((arg) => arg !== "")
    .flatMap((arg) => {
      if (arg.includes("{line}") && line === undefined) {
        return [];
      }
      return [arg.replace(/\{file\}/g, file).replace(/\{line\}/g, String(line ?? ""))];
    });
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
    const arg = args[i]!;

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
      editor = arg.slice("--editor=".length);
      continue;
    }

    if (arg === "--editor") {
      const value = args[++i];
      if (value === undefined) {
        throw new Error("--editor requires a value");
      }
      editor = value;
      continue;
    }

    if (arg.startsWith("--ide=")) {
      ide = arg.slice("--ide=".length);
      continue;
    }

    if (arg === "--ide") {
      const value = args[++i];
      if (value === undefined) {
        throw new Error("--ide requires a value");
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
  sideye --editor <template>
  sideye --ide <template>

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
      Command template for a GUI / IDE (E key). Spawns the process and
      returns immediately; the renderer stays live in its pane.
      Examples:
        --ide "code --goto {file}:{line}"
        --ide "zed {file}:{line}"
        --ide "subl {file}:{line}"
      Falls back to SIDEYE_IDE, then $VISUAL when it differs from $EDITOR.
      If nothing is configured, E does nothing.

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
  E          open in GUI / IDE (renderer stays live, --ide template)
  c          toggle changes-only filter for the tree
  v          toggle diff <-> full file view
  z          toggle long-line wrap in the viewer
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

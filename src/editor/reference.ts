import { basename } from "node:path";

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
 * Expands a value into a full command template. If the value already contains `{file}` it is
 * returned unchanged (full template, pass through). Otherwise the binary basename is looked up in
 * KNOWN_EDITOR_TEMPLATES; an unrecognised name gets `defaultSuffix` appended so `{file}` is always
 * present in the result.
 */
function normalizeTemplate(value: string, defaultSuffix: string): string {
  if (value.includes("{file}")) {
    return value;
  }
  const bin = basename(value.split(/\s+/)[0] ?? value);
  return KNOWN_EDITOR_TEMPLATES[bin] ?? `${value} ${defaultSuffix}`;
}

/**
 * Resolves the editor command template from (in priority order):
 *
 * 1. An explicit `--editor` value or `editor` config key
 * 2. The `SIDEYE_EDITOR` environment variable
 * 3. `$EDITOR` / `$VISUAL`, with a known-editor heuristic for the line arg format
 * 4. `vim` as the hard fallback
 *
 * A bare editor name (no `{file}` placeholder) is expanded through KNOWN_EDITOR_TEMPLATES before
 * being returned, so `--editor code` works the same as `--editor "code --goto {file}:{line}"`.
 */
export function resolveEditorTemplate(explicit: string | undefined): string {
  if (explicit !== undefined) {
    return normalizeTemplate(explicit, "+{line} {file}");
  }

  const sideye = process.env.SIDEYE_EDITOR;
  if (sideye !== undefined && sideye !== "") {
    return normalizeTemplate(sideye, "+{line} {file}");
  }

  const editor = process.env.EDITOR;
  if (editor !== undefined && editor !== "") {
    return normalizeTemplate(editor, "+{line} {file}");
  }
  const visual = process.env.VISUAL;
  if (visual !== undefined && visual !== "") {
    return normalizeTemplate(visual, "+{line} {file}");
  }

  return "vim +{line} {file}";
}

/**
 * Resolves the IDE command template from (in priority order):
 *
 * 1. An explicit `--ide` value or `ide` config key
 * 2. The `SIDEYE_IDE` environment variable
 * 3. `$VISUAL` when it differs from `$EDITOR` (Unix convention: $VISUAL is often a GUI editor while
 *    $EDITOR is a terminal one)
 * 4. `undefined` — if nothing is configured the o key does nothing
 *
 * A bare editor name is expanded the same way as in `resolveEditorTemplate`.
 */
export function resolveIdeTemplate(explicit: string | undefined): string | undefined {
  if (explicit !== undefined) {
    return normalizeTemplate(explicit, "{file}:{line}");
  }

  const sideye = process.env.SIDEYE_IDE;
  if (sideye !== undefined && sideye !== "") {
    return normalizeTemplate(sideye, "{file}:{line}");
  }

  const visual = process.env.VISUAL;
  const editor = process.env.EDITOR;
  if (visual !== undefined && visual !== "" && visual !== editor) {
    return normalizeTemplate(visual, "{file}:{line}");
  }

  return undefined;
}

/**
 * Expands a template string into an argv array ready to pass to `Bun.spawn`.
 *
 * - `{file}` is replaced with the absolute file path.
 * - `{line}` is replaced with the line number.
 * - When `line` is undefined and a token contains `{line}` but also `{file}` (e.g. `{file}:{line}`),
 *   the `{line}` portion is stripped so the file path is still passed. Tokens that contain only
 *   `{line}` (e.g. `+{line}`) are dropped entirely.
 */
export function buildEditorCommand(
  template: string,
  file: string,
  line: number | undefined,
): string[] {
  return template
    .split(/\s+/)
    .filter((arg) => arg !== "")
    .flatMap((arg) => {
      if (arg.includes("{line}") && line === undefined) {
        if (!arg.includes("{file}")) {
          return [];
        }
        const stripped = arg.replace(/:\{line\}|\{line\}/g, "").replace(/\{file\}/g, file);
        return stripped !== "" ? [stripped] : [];
      }
      return [arg.replace(/\{file\}/g, file).replace(/\{line\}/g, String(line ?? ""))];
    });
}

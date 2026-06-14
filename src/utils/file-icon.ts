/**
 * Nerd Font (v3) glyphs for the file tree. Every code point is taken verbatim from the official
 * Nerd Fonts `glyphnames.json`, never hand-guessed, so each is a real, named glyph rather than
 * whatever a nearby code point happens to render. They show as icons ONLY when the terminal uses a
 * Nerd Font; without one they appear as tofu, which is why the tree is gated by `--no-icons`.
 *
 * Resolution mirrors Zed / nvim-web-devicons: exact filename (stem) wins over the extension
 * (suffix), and an unmatched file falls back to the generic file glyph.
 *
 * The glyph name behind each code (for future edits): file = cod-file, folder(_open) =
 * fa-folder(_open), and per entry below: ts dev-typescript, tsx/jsx dev-react, js dev-javascript,
 * json cod-json, md dev-markdown, css dev-css3, html dev-html5, rs dev-rust, py dev-python, go
 * dev-go, sh cod-terminal_bash, toml custom-toml, yaml dev-yaml, lock fa-lock, image
 * fa-file_image_o, node dev-nodejs_small, tsconfig seti-tsconfig, bun dev-bun, docker dev-docker,
 * make seti-makefile, license seti-license, git dev-git, env seti-config, book fa-book.
 */

const DEFAULT_FILE = "\u{ea7b}";
const FOLDER = "\u{f07b}";
const FOLDER_OPEN = "\u{f07c}";

/** Exact-filename matches, checked before the extension table. */
const BY_STEM = new Map([
  ["package.json", "\u{e718}"],
  ["tsconfig.json", "\u{e69d}"],
  ["bun.lock", "\u{e76f}"],
  ["dockerfile", "\u{e7b0}"],
  ["makefile", "\u{e673}"],
  ["license", "\u{e60a}"],
  [".gitignore", "\u{e702}"],
  [".env", "\u{e615}"],
  ["readme.md", "\u{f02d}"],
]);

/** Extension matches, checked when no stem matches. */
const BY_SUFFIX = new Map([
  ["ts", "\u{e8ca}"],
  ["tsx", "\u{e7ba}"],
  ["js", "\u{e781}"],
  ["jsx", "\u{e7ba}"],
  ["mjs", "\u{e781}"],
  ["cjs", "\u{e781}"],
  ["json", "\u{eb0f}"],
  ["md", "\u{e73e}"],
  ["mdx", "\u{e73e}"],
  ["css", "\u{e749}"],
  ["html", "\u{e736}"],
  ["rs", "\u{e7a8}"],
  ["py", "\u{e73c}"],
  ["go", "\u{e724}"],
  ["sh", "\u{ebca}"],
  ["bash", "\u{ebca}"],
  ["zsh", "\u{ebca}"],
  ["toml", "\u{e6b2}"],
  ["yml", "\u{e8eb}"],
  ["yaml", "\u{e8eb}"],
  ["lock", "\u{f023}"],
  ["png", "\u{f1c5}"],
  ["jpg", "\u{f1c5}"],
  ["svg", "\u{f1c5}"],
]);

export function fileIcon(name: string) {
  const lower = name.toLowerCase();
  const stem = BY_STEM.get(lower);
  if (stem !== undefined) {
    return stem;
  }

  const dot = lower.lastIndexOf(".");
  const ext = dot > 0 ? lower.slice(dot + 1) : "";
  return BY_SUFFIX.get(ext) ?? DEFAULT_FILE;
}

export function folderIcon(expanded: boolean) {
  return expanded ? FOLDER_OPEN : FOLDER;
}

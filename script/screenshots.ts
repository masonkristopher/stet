/**
 * Regenerate the README screenshots by driving the real sideye binary through VHS (a headless
 * terminal that renders Nerd Font icons correctly), so the icons and theme match a real terminal.
 * Each screen is a generated .tape that launches sideye, drives it to a state with keystrokes, and
 * screenshots it. The problems/diagnostics shots need a changed file with diagnostics, so a temp
 * errorful file is created in src/ around those runs only.
 *
 * Capture against a clean checkout so the tree and diff are representative — uncommitted files show
 * up in the captured tree. By default that's this repo; set `SIDEYE_SCREENSHOT_REPO` to point
 * sideye at another checkout (e.g. a clean main worktree) while the images still land in THIS
 * repo's assets. Requires `vhs` on PATH (brew install vhs) and a Nerd Font installed for the
 * file-type icons. Pass screen names to shoot a subset, e.g. `bun run screenshots find problems`.
 */
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

/** Where the images are written (always this repo, so a PR here picks them up). */
const ASSETS = resolve(import.meta.dir, "../assets/screenshots");
/** Which checkout sideye runs against; override to capture a clean tree elsewhere. */
const REPO = process.env.SIDEYE_SCREENSHOT_REPO
  ? resolve(process.env.SIDEYE_SCREENSHOT_REPO)
  : resolve(import.meta.dir, "..");
const BUN = process.execPath;
const VHS = "vhs";
const TAPES = resolve(tmpdir(), "sideye-screenshots");
/** A few commits back so the diff and tree show several changed source files, not just a dep bump. */
const BASE_REF = "HEAD~3";
/**
 * Inside src/ so it falls under tsconfig's include and typescript-language-server reports the type
 * error alongside oxlint's unused-symbol findings.
 */
const FIXTURE = `${REPO}/src/_diagnostics-demo.ts`;
/**
 * A throwaway config dir for the theme-switcher shot only: sideye reads `XDG_CONFIG_HOME`, so
 * pointing that one tape here populates the theme list with named palettes (rich swatches and a
 * real diff re-theme on preview) without touching the user's real config or the other tapes.
 */
const THEME_CONFIG_DIR = resolve(tmpdir(), "sideye-screenshots-config");
const THEME_CONFIG_FILE = resolve(THEME_CONFIG_DIR, "sideye", "config.jsonc");
// Named palettes for the theme-switcher shot: each carries a distinct accent (the row swatch) and a
// Bundled Shiki `syntax` (so previewing one re-themes the diff). `theme` stays unset so the app
// Starts on `auto`, keeping the ✓ on `auto` while the highlighted row previews a different theme.
const THEME_CONFIG = JSON.stringify(
  {
    // Registration (and so list) order after auto/dark/light, sorted: catppuccin,
    // Gruvbox, rose-pine, tokyo-night, so Down x6 lands the highlight on tokyo-night.
    themes: {
      "catppuccin": { accent: { primary: "#cba6f7" }, base: "dark", syntax: "catppuccin-mocha" },
      "gruvbox": { accent: { primary: "#fabd2f" }, base: "dark", syntax: "gruvbox-dark-medium" },
      "rose-pine": { accent: { primary: "#ebbcba" }, base: "dark", syntax: "rose-pine" },
      "tokyo-night": { accent: { primary: "#7aa2f7" }, base: "dark", syntax: "tokyo-night" },
    },
  },
  null,
  2,
);

const header = [
  "Set Shell zsh",
  'Set FontFamily "FiraCode Nerd Font Mono"',
  "Set FontSize 28",
  "Set Width 2560",
  "Set Height 1520",
  "Set Padding 0",
  "Set Margin 0",
  "Set TypingSpeed 0",
].join("\n");

// VHS runs with cwd = the tmp tape dir, so cd into the capture target before launching sideye.
// `env` lets one screen prefix the launch (e.g. XDG_CONFIG_HOME for the theme shot); every other
// Tape passes nothing, so its command is unchanged.
function launchCmd(env = "") {
  return [
    "Hide",
    `Type "cd ${REPO} && ${env}${BUN} run src/main.tsx ${BASE_REF}"`,
    "Enter",
    "Sleep 3s",
    "Show",
    "Sleep 500ms",
  ].join("\n");
}

/**
 * Open a real source-file diff (the palette focuses the viewer on select), so the main and find
 * shots feature code rather than the default docs file.
 */
const openDiffView = ["Ctrl+P", 'Type "DiffView"', "Sleep 400ms", "Enter", "Sleep 800ms"].join(
  "\n",
);

/**
 * One entry per README screenshot. `steps` run after the app is up; the end state is captured.
 * `fixture: true` marks screens that need the temporary diagnostics file planted first.
 */
const screens = [
  { name: "sideye", steps: openDiffView },
  { name: "worktree-picker", steps: ['Type "w"', "Sleep 800ms"].join("\n") },
  {
    /**
     * Open a diff so a real code hunk sits behind the overlay, open the switcher, then arrow down
     * to a vivid theme (auto, dark, light, then the planted palettes) so the shot shows the full
     * themed list (accent swatches, the ✓ on the active `auto`, the highlighted preview row) with
     * the UI and diff live-re-themed to it. `Down` reaches the keymap's picker branch even with the
     * filter input focused, same as the palette/find tapes. Needs the planted demo config.
     */
    config: true,
    launchEnv: `XDG_CONFIG_HOME=${THEME_CONFIG_DIR} `,
    name: "theme-switcher",
    steps: [openDiffView, 'Type "t"', "Sleep 700ms", "Down@200ms 6", "Sleep 1200ms"].join("\n"),
  },
  { name: "go-to-file", steps: ["Ctrl+P", 'Type "diff"', "Sleep 600ms"].join("\n") },
  {
    /**
     * Open the diff and let it focus/settle, then open the find bar and type a term present in the
     * visible hunks ("scrollTop"). Capture the open bar showing the live N/M counter and highlights
     * (the render test's verified checkpoint). No commit: a too-early `/` or a no-match Enter both
     * collapse back to a plain diff with no find UI, so generous settles and a real match matter.
     */
    name: "find",
    steps: [
      "Ctrl+P",
      'Type "DiffView"',
      "Sleep 500ms",
      "Enter",
      "Sleep 1500ms",
      'Type "/"',
      "Sleep 600ms",
      'Type "scrollTop"',
      "Sleep 1s",
    ].join("\n"),
  },
  { name: "search", steps: ["Ctrl+F", 'Type "Effect"', "Sleep 1200ms"].join("\n") },
  {
    // Open an unchanged file: plain syntax-highlighted source, no diff gutters.
    name: "read-only",
    steps: ["Ctrl+P", 'Type "process"', "Sleep 400ms", "Enter", "Sleep 800ms"].join("\n"),
  },
  { name: "keys", steps: ['Type "?"', "Sleep 600ms"].join("\n") },
  {
    // Open the fixture, open the panel, then wait out tsserver's project load (slower than oxlint).
    fixture: true,
    name: "problems",
    steps: [
      "Ctrl+P",
      'Type "diagnostics-demo"',
      "Sleep 400ms",
      "Enter",
      "Sleep 800ms",
      'Type "p"',
      "Sleep 16s",
    ].join("\n"),
  },
];

function tapeFor(screen: (typeof screens)[number]) {
  return [
    `# ${screen.name}.png — generated by script/screenshots.ts`,
    header,
    launchCmd(screen.launchEnv),
    screen.steps,
    // Written next to the tape in the tmp dir (VHS's cwd), then moved into ASSETS.
    `Screenshot ${screen.name}.png`,
    "",
  ].join("\n\n");
}

async function run(cmd: string, cmdArgs: string[]) {
  const proc = Bun.spawn([cmd, ...cmdArgs], {
    cwd: TAPES,
    stdio: ["inherit", "inherit", "inherit"],
  });
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`${cmd} exited ${code}`);
  }
}

async function shoot(screen: (typeof screens)[number]) {
  await Bun.write(`${TAPES}/${screen.name}.tape`, tapeFor(screen));
  console.log(`▶ ${screen.name}`);
  await run(VHS, [`${TAPES}/${screen.name}.tape`]);
  await Bun.write(`${ASSETS}/${screen.name}.png`, Bun.file(`${TAPES}/${screen.name}.png`));
}

/**
 * Diagnostics only exist for a changed file, so plant one. Lead with clean exported lines (no
 * findings, plain gutter) so the flagged lines' severity-colored gutter numbers stand out, then tsc
 * type errors (number = string) and oxc unused-symbol findings.
 */
// Refuse to clobber a pre-existing FIXTURE: that path is script-owned, so anything
// There wasn't put by us, and `plantedFixture` makes removeFixture delete only what
// This run created rather than blindly rm-ing the path.
let plantedFixture = false;
function writeFixture() {
  if (existsSync(FIXTURE)) {
    throw new Error(`refusing to overwrite existing ${FIXTURE} (not created by this script)`);
  }
  plantedFixture = true;
  return Bun.write(
    FIXTURE,
    [
      "export function double(n: number) {",
      "  return n * 2",
      "}",
      "",
      'export const label: number = "oops"',
      "const ignored = double(label)",
      "const count: string = 42",
      "function helper(unusedParam: number) {}",
      "",
    ].join("\n"),
  );
}

// Removers are sync so a signal handler can run them before exit, not just the finally path.
function removeFixture() {
  if (!plantedFixture) {
    return;
  }
  rmSync(FIXTURE, { force: true });
  plantedFixture = false;
}

function writeThemeConfig() {
  return Bun.write(THEME_CONFIG_FILE, THEME_CONFIG);
}

function removeThemeConfig() {
  rmSync(THEME_CONFIG_DIR, { force: true, recursive: true });
}

const only = new Set(Bun.argv.slice(2));
const unknown = [...only].filter((name) => !screens.some((screen) => screen.name === name));
if (unknown.length > 0) {
  console.warn(
    `ignoring unknown screen name(s): ${unknown.join(", ")} — known: ${screens.map((screen) => screen.name).join(", ")}`,
  );
}

const wanted = screens.filter((screen) => only.size === 0 || only.has(screen.name));
const standalone = wanted.filter((screen) => !screen.fixture);
const fixtured = wanted.filter((screen) => screen.fixture);

// One cleanup list drives both the finally and the signal handlers, so a Ctrl-C mid-shoot leaves
// Behind neither the temp theme config nor the diagnostics fixture.
const cleanups: (() => void)[] = [];
function cleanup() {
  for (const remove of cleanups.splice(0)) {
    remove();
  }
}
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    cleanup();
    process.exit(130);
  });
}

try {
  // The theme shot reads named palettes from a temp config via XDG_CONFIG_HOME; it creates no repo
  // File, so planting it up front never pollutes the other shots.
  if (wanted.some((screen) => screen.config)) {
    await writeThemeConfig();
    cleanups.push(removeThemeConfig);
  }

  for (const screen of standalone) {
    // oxlint-disable-next-line no-await-in-loop -- vhs spawns a headless terminal; runs must be sequential
    await shoot(screen);
  }

  if (fixtured.length > 0) {
    // An errorful file in src/ would show up in every other shot's tree, so plant it only now,
    // After the standalone shots, and tear it down through the shared cleanup.
    await writeFixture();
    cleanups.push(removeFixture);
    for (const screen of fixtured) {
      // oxlint-disable-next-line no-await-in-loop -- vhs spawns a headless terminal; runs must be sequential
      await shoot(screen);
    }
  }
} finally {
  cleanup();
}

console.log("done");

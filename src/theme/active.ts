import { createMemo, createRoot, createSignal } from "solid-js";

import { selectThemeName, themeForName, type ThemeSelection } from "./registry";
import { resolveTheme, type ResolvedTheme } from "./resolve";

// The reactive theme state, the single seam the UI (useTheme) and the diff engine
// Read. `appearance` follows the terminal: detected once at startup, then updated
// Live by the renderer's theme_mode event. `selection` is the config choice. The
// Active theme derives from both, so a dark/light flip re-resolves everything that
// Reads it. Kept in its own root (not src/state.ts) so the diff engine can read
// Theme state without importing app state, preserving the engine -> theme boundary.
const root = createRoot(() => {
  const [appearance, setAppearance] = createSignal<"dark" | "light">("dark");
  const [selection, setSelection] = createSignal<ThemeSelection>(undefined);
  const activeThemeName = createMemo(() => selectThemeName(selection(), appearance()));
  const activeTheme = createMemo<ResolvedTheme>(() =>
    resolveTheme(themeForName(activeThemeName())),
  );
  return { activeTheme, activeThemeName, appearance, selection, setAppearance, setSelection };
});

export const { activeTheme, activeThemeName, appearance, selection, setAppearance, setSelection } =
  root;

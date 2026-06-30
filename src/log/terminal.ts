import { activeTheme } from "@/theme/active";

import { levelColor, levelGlyph } from "./levels";
import type { LogLevel } from "./levels";

// Glyph-first so severity reads under NO_COLOR and on any terminal background;
// Color is the enhancement. Info stays glyph-only: the terminal background is
// Uncontrolled, so a themed neutral hex could fall below contrast there. Gated on
// Bun.enableANSIColors, which already honors TTY / NO_COLOR / FORCE_COLOR.
function format(text: string, level: LogLevel) {
  const line = `${levelGlyph(level)} ${text}`;
  if (level === "info" || !Bun.enableANSIColors) {
    return line;
  }
  const ansi = Bun.color(levelColor(activeTheme().colors, level), "ansi");
  return ansi === null ? line : `${ansi}${line}\x1b[0m`;
}

// Errors go to stderr; every other level to stdout. The level-named helpers are
// Thin wrappers, so a caller with a dynamic level (the quit notice) uses `log`.
export function log(level: LogLevel, text: string) {
  const line = format(text, level);
  if (level === "error") {
    console.error(line);
    return;
  }
  console.log(line);
}

export const logError = (text: string) => log("error", text);
export const logSuccess = (text: string) => log("success", text);
export const logInfo = (text: string) => log("info", text);

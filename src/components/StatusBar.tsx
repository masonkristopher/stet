import { createMemo } from "solid-js";

import { levelColor, levelGlyph } from "@/log/levels";
import { state } from "@/state";
import { useTheme } from "@/theme/context";

export function StatusBar() {
  const theme = useTheme();
  const hint = () => {
    if (state.findOpen()) {
      return "type to find · enter confirm · esc cancel";
    }
    if (state.findActive()) {
      return "n/N next/prev · esc clear find";
    }
    return "? keys · q quit";
  };
  // Pair the level glyph with its color so severity reads without relying on color
  // Alone, the way the counts badge and problems panel already do. An idle bar (no
  // Leveled message) renders bare: no glyph, neutral color.
  const status = createMemo(() => {
    const level = state.statusRightLevel();
    const text = state.statusRight();
    return level === undefined
      ? { fg: theme.colors.text.secondary, text }
      : { fg: levelColor(theme.colors, level), text: `${levelGlyph(level)} ${text}` };
  });
  return (
    <box
      height={1}
      flexDirection="row"
      justifyContent="space-between"
      paddingLeft={1}
      paddingRight={1}
      backgroundColor={theme.colors.surface.base}
    >
      <text fg={theme.colors.text.muted}>{hint()}</text>
      <text fg={status().fg}>{status().text}</text>
    </box>
  );
}

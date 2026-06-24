import { state } from "../state";
import { useTheme } from "../theme/context";

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
      <text fg={theme.colors.text.secondary}>{state.statusRight()}</text>
    </box>
  );
}

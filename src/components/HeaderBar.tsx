import { basename } from "node:path";

import packageJson from "../../package.json";
import { scopeLabel } from "../cli";
import { state } from "../state";
import { useTheme } from "../theme/context";

export function HeaderBar() {
  const theme = useTheme();
  return (
    <box
      height={1}
      flexDirection="row"
      justifyContent="space-between"
      paddingLeft={1}
      paddingRight={1}
      backgroundColor={theme.colors.surface.base}
    >
      <box flexDirection="row">
        <text fg={theme.colors.text.strong}>sideye</text>
        <text fg={theme.colors.text.faint}>@{packageJson.version}</text>
      </box>
      <text fg={theme.colors.text.secondary}>
        {basename(state.gitModel().repoRoot)} · {scopeLabel(state.scope())} ·{" "}
        {state.gitModel().changed.length} changed
        {state.countsText() === "" ? "" : ` · ${state.countsText()}`}
      </text>
    </box>
  );
}

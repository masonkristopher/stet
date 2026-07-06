import type { InstallMethod } from "./install-method";

const installScriptUrl = "https://raw.githubusercontent.com/jimmy-guzman/stet/main/install.sh";

export interface UpgradeInvocation {
  /** Shown before the child runs, so the user knows which channel is being used. */
  label: string;
  argv: string[];
}

/**
 * The upgrade command for each managed channel. Standalone installs re-run the install script
 * (reusing its checksum verify + atomic swap); npm/brew defer to the package manager. `unknown` has
 * no safe command, so the caller prints guidance instead.
 */
export function upgradeInvocation(method: InstallMethod): UpgradeInvocation | undefined {
  if (method === "standalone") {
    return {
      argv: ["bash", "-c", `curl -fsSL ${installScriptUrl} | bash`],
      label: "upgrading via the install script...",
    };
  }

  if (method === "npm") {
    return { argv: ["npm", "install", "-g", "stet@latest"], label: "upgrading via npm..." };
  }

  if (method === "brew") {
    return {
      argv: ["brew", "upgrade", "jimmy-guzman/tap/stet"],
      label: "upgrading via Homebrew...",
    };
  }

  return undefined;
}

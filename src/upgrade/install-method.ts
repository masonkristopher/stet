export type InstallMethod = "standalone" | "npm" | "brew" | "unknown";

/**
 * Classifies how the running binary was installed from its own path, so `upgrade` can defer to the
 * right channel. The npm launcher (script/stet-launcher.cjs) spawns the compiled binary under
 * node_modules, so the running process's execPath carries that marker directly.
 */
export function classifyInstall(execPath: string): InstallMethod {
  // Checked before Homebrew so a global npm install on a Homebrew-managed Node (which lives
  // Under the Homebrew prefix, e.g. /opt/homebrew/lib/node_modules/...) is not caught by the
  // Brew markers. A genuine Homebrew install is under /Cellar/ with no node_modules.
  if (execPath.includes("/node_modules/")) {
    return "npm";
  }

  if (execPath.includes("/Cellar/") || execPath.includes("/homebrew/")) {
    return "brew";
  }

  if (execPath.includes("/.stet/bin/") || execPath.includes("/.local/bin/")) {
    return "standalone";
  }

  return "unknown";
}

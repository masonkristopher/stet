import { logError, logInfo, logSuccess } from "@/log/terminal";

import { upgradeInvocation } from "./commands";
import { classifyInstall } from "./install-method";
import { fetchLatestVersion, isNewer } from "./release";

const unknownGuidance = `could not determine how sideye was installed. upgrade with one of:
  curl -fsSL https://raw.githubusercontent.com/jimmy-guzman/sideye/main/install.sh | bash
  npm i -g sideye@latest
  brew upgrade jimmy-guzman/tap/sideye`;

/**
 * Self-updates sideye to the latest release via the channel it was installed through. Runs before
 * the TUI (like --help/--version) and spawns with inherited stdio so the user sees the underlying
 * curl/npm/brew progress live; that is why it uses Bun.spawn directly rather than the Process
 * service, the same documented exception EditorLive relies on. Returns the exit code.
 *
 * Checks the latest GitHub release first and short-circuits when already current, so the user is
 * not sent through a no-op channel update. A failed check (latest === undefined) falls through to
 * the channel update as before, leaving each tool to resolve `@latest` itself. `fetchLatest` is the
 * injectable seam the tests drive without hitting the network.
 */
export async function runUpgrade(input: {
  execPath: string;
  currentVersion: string;
  fetchLatest?: () => Promise<string | undefined>;
}) {
  const latest = await (input.fetchLatest ?? fetchLatestVersion)();
  if (latest !== undefined && !isNewer(latest, input.currentVersion)) {
    logSuccess(`sideye ${input.currentVersion} is already up to date`);
    return 0;
  }

  const invocation = upgradeInvocation(classifyInstall(input.execPath));

  if (invocation === undefined) {
    logError(unknownGuidance);
    return 1;
  }

  logInfo(invocation.label);
  const proc = Bun.spawn(invocation.argv, {
    stderr: "inherit",
    stdin: "inherit",
    stdout: "inherit",
  });

  return await proc.exited;
}

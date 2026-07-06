import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Config path candidates in priority order (`config.jsonc`, then `config.json`); the service reads
 * the first that exists. `env` is injected so tests can pin it without touching the real
 * environment.
 */
export function configPaths(env: NodeJS.ProcessEnv = process.env) {
  const base = env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return [join(base, "stet", "config.jsonc"), join(base, "stet", "config.json")];
}

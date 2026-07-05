/**
 * Provisions language servers sideye finds neither in the repo nor on PATH: the third discovery
 * tier. On first request for an unprovisioned language it downloads the server into a
 * sideye-managed cache (one background install per language, deduped), so diagnostics work
 * out-of-the-box without a manual install, the way Zed and opencode auto-provision. Opt out with
 * `SIDEYE_NO_LSP_DOWNLOAD`.
 *
 * The packages sideye installs are pinned to exact versions in the registry (`servers.ts`), so the
 * provisioned executable is deterministic and integrity-verified against npm's immutable published
 * version rather than resolving whatever `@latest` is that day. The cache directory is keyed by a
 * digest of that exact pinned set (`provisionKey`), so bumping a pin lands in a fresh directory and
 * re-provisions instead of the stale cached binary satisfying the existence check.
 *
 * The install is bounded (`INSTALL_TIMEOUT`): a fetch that cannot complete (offline, air-gapped,
 * proxied, locked-down CI) is interrupted and recorded as a failure, so the file degrades to
 * `unavailable` rather than hanging in `installing` forever. Every terminal outcome (success, npm
 * failure, timeout) offers a completion, which is what drives the state re-check.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { Context, Duration, Effect, Layer, Queue } from "effect";

import { CommandError, Process } from "@/process";

export interface ProvisionSpec {
  readonly binary: string;
  readonly args: readonly string[];
  readonly packages: readonly string[];
}

export type ProvisionState =
  | { readonly kind: "ready"; readonly command: string[] }
  | { readonly kind: "installing" }
  | { readonly kind: "failed"; readonly message: string }
  | { readonly kind: "disabled" };

function defaultCacheRoot(): string {
  return process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache");
}

/**
 * A short stable digest of the exact pinned package set. It keys the cache directory so a version
 * bump (e.g. patching a vulnerable server) re-provisions rather than reusing a stale binary, and it
 * derives from the packages themselves so the registry stays the single source of truth: no
 * separate revision to remember to bump.
 */
export function provisionKey(packages: readonly string[]): string {
  return createHash("sha256").update(packages.join("\n")).digest("hex").slice(0, 12);
}

function serverDir(root: string, language: string, key: string): string {
  return join(root, "sideye", "lsp", language, key);
}

function binaryPath(root: string, language: string, key: string, binary: string): string {
  return join(serverDir(root, language, key), "node_modules", ".bin", binary);
}

/** Where a provisioned binary lives in the default cache, for discovery's third tier. */
export function cachedBinaryPath(
  language: string,
  binary: string,
  packages: readonly string[],
): string {
  return binaryPath(defaultCacheRoot(), language, provisionKey(packages), binary);
}

function downloadsDisabled(): boolean {
  const value = process.env.SIDEYE_NO_LSP_DOWNLOAD;
  return value !== undefined && value !== "" && value !== "0" && value !== "false";
}

export class Provisioner extends Context.Service<
  Provisioner,
  {
    readonly ensure: (language: string, spec: ProvisionSpec) => Effect.Effect<ProvisionState>;
    /** Languages whose install just finished (succeeded or failed); drains to trigger a re-check. */
    readonly completions: Queue.Dequeue<string>;
  }
>()("sideye/Provisioner") {}

/**
 * A generous backstop for a fetch that hangs (an air-gapped/proxied network that accepts the
 * connection but never responds, where npm's own retries can stall for minutes). A working
 * connection installs these packages well under this; on expiry the download is treated as a
 * failure so the file degrades to `unavailable` instead of sitting in `installing` forever. Kept
 * generous because a false kill poisons the language for the whole session (failures are sticky).
 */
const INSTALL_TIMEOUT: Duration.Input = "120 seconds";

/**
 * The cache root is injected so tests can point at a temp dir; the Live layer uses XDG/home. The
 * install timeout is injected the same way so tests bound it without a real 120s wait.
 */
export function makeProvisioner(root: string, installTimeout: Duration.Input = INSTALL_TIMEOUT) {
  return Effect.gen(function* provisioner() {
    const proc = yield* Process;
    const scope = yield* Effect.scope;
    const inFlight = new Set<string>();
    const failures = new Map<string, string>();
    const completions = yield* Queue.unbounded<string>();

    function install(language: string, spec: ProvisionSpec) {
      const dir = serverDir(root, language, provisionKey(spec.packages));
      const command = ["npm", "install", "--no-save", ...spec.packages];
      // Effect.try, not Effect.sync: a failed mkdir/write (unwritable cache, full disk) must be a
      // Typed failure that flows through onFailure below, or it dies as a defect that bypasses the
      // InFlight cleanup and completion offer, stranding the language in `installing` forever.
      return Effect.try({
        catch: (cause) =>
          new CommandError({
            command,
            exitCode: -1,
            message: cause instanceof Error ? cause.message : String(cause),
            stderr: "",
            stdout: "",
          }),
        try: () => {
          mkdirSync(dir, { recursive: true });
          const manifest = join(dir, "package.json");
          if (!existsSync(manifest)) {
            writeFileSync(manifest, JSON.stringify({ private: true }));
          }
        },
      }).pipe(
        Effect.andThen(
          proc.run(command, dir).pipe(
            Effect.timeoutOrElse({
              duration: installTimeout,
              orElse: () =>
                Effect.fail(
                  new CommandError({
                    command,
                    exitCode: -1,
                    message: `${language} language server download timed out after ${Duration.toSeconds(installTimeout)}s`,
                    stderr: "",
                    stdout: "",
                  }),
                ),
            }),
          ),
        ),
        Effect.matchEffect({
          onFailure: (error) => Effect.sync(() => void failures.set(language, error.message)),
          onSuccess: () => Effect.void,
        }),
        Effect.andThen(Effect.sync(() => void inFlight.delete(language))),
        Effect.andThen(Queue.offer(completions, language)),
      );
    }

    function ensure(language: string, spec: ProvisionSpec): Effect.Effect<ProvisionState> {
      return Effect.suspend(() => {
        const bin = binaryPath(root, language, provisionKey(spec.packages), spec.binary);
        if (existsSync(bin)) {
          return Effect.succeed<ProvisionState>({ command: [bin, ...spec.args], kind: "ready" });
        }
        if (downloadsDisabled()) {
          return Effect.succeed<ProvisionState>({ kind: "disabled" });
        }
        const failure = failures.get(language);
        if (failure !== undefined) {
          return Effect.succeed<ProvisionState>({ kind: "failed", message: failure });
        }
        if (inFlight.has(language)) {
          return Effect.succeed<ProvisionState>({ kind: "installing" });
        }
        inFlight.add(language);
        return install(language, spec).pipe(
          Effect.forkIn(scope),
          Effect.as<ProvisionState>({ kind: "installing" }),
        );
      });
    }

    return { completions, ensure } as const;
  });
}

export const ProvisionerLive = Layer.effect(Provisioner, makeProvisioner(defaultCacheRoot()));

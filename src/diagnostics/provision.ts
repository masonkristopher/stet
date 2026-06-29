/**
 * Provisions language servers sideye finds neither in the repo nor on PATH: the third discovery
 * tier. On first request for an unprovisioned language it downloads the server into a
 * sideye-managed cache (one background install per language, deduped), so diagnostics work
 * out-of-the-box without a manual install, the way Zed and opencode auto-provision. Opt out with
 * `SIDEYE_NO_LSP_DOWNLOAD`.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { Context, Effect, Layer, Queue } from "effect";

import { Process } from "@/process";

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

function serverDir(root: string, language: string): string {
  return join(root, "sideye", "lsp", language);
}

function binaryPath(root: string, language: string, binary: string): string {
  return join(serverDir(root, language), "node_modules", ".bin", binary);
}

/** Where a provisioned binary lives in the default cache, for discovery's third tier. */
export function cachedBinaryPath(language: string, binary: string): string {
  return binaryPath(defaultCacheRoot(), language, binary);
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

/** The cache root is injected so tests can point at a temp dir; the Live layer uses XDG/home. */
export function makeProvisioner(root: string) {
  return Effect.gen(function* provisioner() {
    const proc = yield* Process;
    const scope = yield* Effect.scope;
    const inFlight = new Set<string>();
    const failures = new Map<string, string>();
    const completions = yield* Queue.unbounded<string>();

    function install(language: string, spec: ProvisionSpec) {
      const dir = serverDir(root, language);
      return Effect.sync(() => {
        mkdirSync(dir, { recursive: true });
        const manifest = join(dir, "package.json");
        if (!existsSync(manifest)) {
          writeFileSync(manifest, JSON.stringify({ private: true }));
        }
      }).pipe(
        Effect.andThen(proc.run(["npm", "install", "--no-save", ...spec.packages], dir)),
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
        const bin = binaryPath(root, language, spec.binary);
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

/**
 * Provisions language servers stet finds neither in the repo nor on PATH: the third discovery tier.
 * On first request for an unprovisioned language it downloads the server into a stet-managed cache
 * (one background install per language, deduped), so diagnostics work out-of-the-box without a
 * manual install, the way Zed and opencode auto-provision. Opt out with `STET_NO_LSP_DOWNLOAD`.
 *
 * Two channels, both pinned exactly in the registry (`servers.ts`) so the provisioned executable is
 * deterministic: `npm` installs pinned package versions (requiring `npm` on PATH),
 * integrity-checked against npm's immutable published versions; `binary` downloads a pinned GitHub
 * release asset (a gzipped single binary) and verifies its sha256 against the registry's pin before
 * anything is written, so a moved tag or tampered asset can never execute. The cache directory is
 * keyed by a digest of the exact pinned channel (`provisionKey`), so bumping a pin lands in a fresh
 * directory and re-provisions instead of the stale cached binary satisfying the existence check.
 *
 * The install is bounded (`INSTALL_TIMEOUT`): a fetch that cannot complete (offline, air-gapped,
 * proxied, locked-down CI) is interrupted and recorded as a failure, so the file degrades to
 * `unavailable` rather than hanging in `installing` forever. Every terminal outcome (success,
 * install failure, timeout) offers a completion, which is what drives the state re-check.
 */
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { Context, Data, Duration, Effect, Layer, Queue } from "effect";

import { Process } from "@/process";
import { extractTarEntry } from "@/utils/untar";

class ProvisionError extends Data.TaggedError("ProvisionError")<{ readonly message: string }> {}

/** One per-platform release asset: the exact file and the sha256 its bytes must hash to. */
interface BinaryAsset {
  readonly os: "darwin" | "linux";
  readonly arch: "arm64" | "x64";
  readonly asset: string;
  readonly sha256: string;
}

/**
 * How a server gets into the cache. `npm` covers servers published as packages; `binary` covers
 * native servers shipped as GitHub release assets (rust-analyzer, ruff), which npm can never serve.
 * A binary asset is a single gzipped executable (`archive` absent, rust-analyzer) or a `tar.gz`
 * cargo-dist archive the extractor pulls the executable out of (`archive: "tar.gz"`, ruff).
 */
export type ProvisionChannel =
  | { readonly kind: "npm"; readonly packages: readonly string[] }
  | {
      readonly kind: "binary";
      readonly repo: string;
      readonly tag: string;
      readonly assets: readonly BinaryAsset[];
      readonly archive?: "tar.gz";
    };

export interface ProvisionSpec {
  readonly binary: string;
  readonly args: readonly string[];
  readonly channel: ProvisionChannel;
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
 * A short stable digest of the exact pinned channel. It keys the cache directory so a pin bump
 * (e.g. patching a vulnerable server) re-provisions rather than reusing a stale binary, and it
 * derives from the pins themselves so the registry stays the single source of truth: no separate
 * revision to remember to bump. The npm material is the package list alone, unchanged from before
 * channels existed, so existing caches stay valid.
 */
export function provisionKey(channel: ProvisionChannel): string {
  const material =
    channel.kind === "npm"
      ? channel.packages.join("\n")
      : [
          channel.repo,
          channel.tag,
          ...channel.assets.map((a) => `${a.asset} ${a.sha256}`),
          // Appended only when set so rust-analyzer's single-gzip key (and its cached binary) stays
          // Valid; a tar.gz channel keys distinctly and re-provisions on any change.
          ...(channel.archive === undefined ? [] : [channel.archive]),
        ].join("\n");
  return createHash("sha256").update(material).digest("hex").slice(0, 12);
}

function serverDir(root: string, language: string, key: string): string {
  return join(root, "stet", "lsp", language, key);
}

// An npm install puts the executable under node_modules/.bin; the binary channel writes it at the
// Server dir's root.
function installedBinaryPath(root: string, language: string, spec: ProvisionSpec): string {
  const dir = serverDir(root, language, provisionKey(spec.channel));
  return spec.channel.kind === "npm"
    ? join(dir, "node_modules", ".bin", spec.binary)
    : join(dir, spec.binary);
}

/** Where a provisioned binary lives in the default cache, for discovery's third tier. */
export function cachedBinaryPath(language: string, spec: ProvisionSpec): string {
  return installedBinaryPath(defaultCacheRoot(), language, spec);
}

function downloadsDisabled(): boolean {
  const value = process.env.STET_NO_LSP_DOWNLOAD;
  return value !== undefined && value !== "" && value !== "0" && value !== "false";
}

export class Provisioner extends Context.Service<
  Provisioner,
  {
    readonly ensure: (language: string, spec: ProvisionSpec) => Effect.Effect<ProvisionState>;
    /** Languages whose download just began; drains to surface a live "installing…" status. */
    readonly starts: Queue.Dequeue<string>;
    /** Languages whose install just finished (succeeded or failed); drains to trigger a re-check. */
    readonly completions: Queue.Dequeue<string>;
  }
>()("stet/Provisioner") {}

/**
 * A generous backstop for a fetch that hangs (an air-gapped/proxied network that accepts the
 * connection but never responds, where npm's own retries can stall for minutes). A working
 * connection installs these packages well under this; on expiry the download is treated as a
 * failure so the file degrades to `unavailable` instead of sitting in `installing` forever. Kept
 * generous because a false kill poisons the language for the whole session (failures are sticky).
 */
const INSTALL_TIMEOUT: Duration.Input = "120 seconds";

// The live asset download. GitHub requires a User-Agent or answers 403; `arrayBuffer` (not
// `bytes`) because Bun's `bytes()` returns an ArrayBuffer at runtime (see `@/process`).
function fetchAsset(url: string): Effect.Effect<Uint8Array<ArrayBuffer>, ProvisionError> {
  return Effect.tryPromise({
    catch: (cause) =>
      new ProvisionError({ message: cause instanceof Error ? cause.message : String(cause) }),
    try: async (signal) => {
      const response = await fetch(url, { headers: { "User-Agent": "stet" }, signal });
      if (!response.ok) {
        throw new Error(`download failed: HTTP ${response.status} for ${url}`);
      }
      return new Uint8Array(await response.arrayBuffer());
    },
  });
}

/**
 * The cache root is injected so tests can point at a temp dir; the Live layer uses XDG/home. The
 * install timeout is injected the same way so tests bound it without a real 120s wait, and the
 * asset download so the binary channel's tests never touch the network.
 */
export function makeProvisioner(
  root: string,
  installTimeout: Duration.Input = INSTALL_TIMEOUT,
  download: (url: string) => Effect.Effect<Uint8Array<ArrayBuffer>, ProvisionError> = fetchAsset,
) {
  return Effect.gen(function* provisioner() {
    const proc = yield* Process;
    const scope = yield* Effect.scope;
    const inFlight = new Set<string>();
    const failures = new Map<string, string>();
    const starts = yield* Queue.unbounded<string>();
    const completions = yield* Queue.unbounded<string>();

    function installNpm(dir: string, packages: readonly string[]) {
      const command = ["npm", "install", "--no-save", ...packages];
      // Effect.try, not Effect.sync: a failed mkdir/write (unwritable cache, full disk) must be a
      // Typed failure that flows through onFailure below, or it dies as a defect that bypasses the
      // InFlight cleanup and completion offer, stranding the language in `installing` forever.
      return Effect.try({
        catch: (cause) =>
          new ProvisionError({ message: cause instanceof Error ? cause.message : String(cause) }),
        try: () => {
          mkdirSync(dir, { recursive: true });
          const manifest = join(dir, "package.json");
          if (!existsSync(manifest)) {
            writeFileSync(manifest, JSON.stringify({ private: true }));
          }
        },
      }).pipe(Effect.andThen(proc.run(command, dir)));
    }

    // Verify against the registry's pinned sha256 before anything lands on disk, then unpack the
    // Asset and mark it executable: a `gzip` asset gunzips straight to the binary (rust-analyzer),
    // A `tar.gz` gunzips to a tar the extractor pulls the named binary out of (ruff). A platform
    // With no pinned asset fails cleanly.
    function installBinary(
      dir: string,
      spec: ProvisionSpec,
      channel: ProvisionChannel & { kind: "binary" },
    ) {
      const asset = channel.assets.find(
        (candidate) => candidate.os === process.platform && candidate.arch === process.arch,
      );
      if (asset === undefined) {
        return Effect.fail(
          new ProvisionError({
            message: `no ${spec.binary} build for ${process.platform}-${process.arch}`,
          }),
        );
      }
      const url = `https://github.com/${channel.repo}/releases/download/${channel.tag}/${asset.asset}`;
      return download(url).pipe(
        Effect.flatMap((bytes) => {
          const digest = createHash("sha256").update(bytes).digest("hex");
          if (digest !== asset.sha256) {
            return Effect.fail(
              new ProvisionError({
                message: `checksum mismatch for ${asset.asset}: expected ${asset.sha256}, got ${digest}`,
              }),
            );
          }
          return Effect.try({
            catch: (cause) =>
              new ProvisionError({
                message: cause instanceof Error ? cause.message : String(cause),
              }),
            try: () => {
              const unpacked = Bun.gunzipSync(bytes);
              const binary =
                channel.archive === "tar.gz" ? extractTarEntry(unpacked, spec.binary) : unpacked;
              if (binary === undefined) {
                throw new Error(`${spec.binary} not found in ${asset.asset}`);
              }
              mkdirSync(dir, { recursive: true });
              writeFileSync(join(dir, spec.binary), binary);
              chmodSync(join(dir, spec.binary), 0o755);
            },
          });
        }),
      );
    }

    function install(language: string, spec: ProvisionSpec) {
      const dir = serverDir(root, language, provisionKey(spec.channel));
      const perform =
        spec.channel.kind === "npm"
          ? installNpm(dir, spec.channel.packages)
          : installBinary(dir, spec, spec.channel);
      return perform.pipe(
        Effect.timeoutOrElse({
          duration: installTimeout,
          orElse: () =>
            Effect.fail(
              new ProvisionError({
                message: `${language} language server download timed out after ${Duration.toSeconds(installTimeout)}s`,
              }),
            ),
        }),
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
        const bin = installedBinaryPath(root, language, spec);
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
          Effect.andThen(Queue.offer(starts, language)),
          Effect.as<ProvisionState>({ kind: "installing" }),
        );
      });
    }

    return { completions, ensure, starts } as const;
  });
}

export const ProvisionerLive = Layer.effect(Provisioner, makeProvisioner(defaultCacheRoot()));

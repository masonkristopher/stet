import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect, Layer, Queue } from "effect";

import { makeProvisioner, provisionKey, Provisioner } from "@/diagnostics/provision";
import type { ProvisionSpec } from "@/diagnostics/provision";
import { registry } from "@/diagnostics/servers";
import { Process } from "@/process";

const spec: ProvisionSpec = {
  args: ["--stdio"],
  binary: "typescript-language-server",
  channel: { kind: "npm", packages: ["typescript-language-server", "typescript"] },
};

// The test preload disables downloads globally; restore that default after each toggle.
afterEach(() => {
  process.env.STET_NO_LSP_DOWNLOAD = "1";
});

// A fake package manager: "installing" just drops the expected binary into the server dir, the way a
// Real npm install would, so the provisioner's orchestration is tested without the network.
function fakeInstaller() {
  return Layer.succeed(Process)({
    run: (_command, cwd) =>
      Effect.sync(() => {
        const binDir = join(cwd, "node_modules", ".bin");
        mkdirSync(binDir, { recursive: true });
        writeFileSync(join(binDir, "typescript-language-server"), "#!/bin/sh\n");
        return { exitCode: 0, stderr: "", stdout: "", stdoutBytes: new Uint8Array() };
      }),
  });
}

function withProvisioner<A, E>(
  root: string,
  process: Layer.Layer<Process>,
  effect: Effect.Effect<A, E, Provisioner>,
) {
  return Effect.runPromise(
    Effect.scoped(
      effect.pipe(
        Effect.provide(
          Layer.effect(Provisioner, makeProvisioner(root)).pipe(Layer.provide(process)),
        ),
      ),
    ),
  );
}

function tempRoot() {
  return mkdtempSync(join(tmpdir(), "stet-prov-"));
}

test("ensure returns ready when the binary is already cached", async () => {
  const root = tempRoot();
  try {
    const binDir = join(
      root,
      "stet",
      "lsp",
      "typescript",
      provisionKey(spec.channel),
      "node_modules",
      ".bin",
    );
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, "typescript-language-server"), "");

    const state = await withProvisioner(
      root,
      fakeInstaller(),
      Provisioner.pipe(Effect.flatMap((provisioner) => provisioner.ensure("typescript", spec))),
    );

    expect(state.kind).toBe("ready");
    if (state.kind === "ready") {
      expect(state.command).toEqual([join(binDir, "typescript-language-server"), "--stdio"]);
    }
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("ensure returns disabled when downloads are turned off", async () => {
  process.env.STET_NO_LSP_DOWNLOAD = "1";
  const root = tempRoot();
  try {
    const state = await withProvisioner(
      root,
      fakeInstaller(),
      Provisioner.pipe(Effect.flatMap((provisioner) => provisioner.ensure("typescript", spec))),
    );
    expect(state.kind).toBe("disabled");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("ensure starts one background install and reaches ready when it completes", async () => {
  process.env.STET_NO_LSP_DOWNLOAD = "";
  const root = tempRoot();
  try {
    const result = await withProvisioner(
      root,
      fakeInstaller(),
      Effect.gen(function* scenario() {
        const provisioner = yield* Provisioner;
        const first = yield* provisioner.ensure("typescript", spec);
        // A second concurrent request must not start a second install.
        const second = yield* provisioner.ensure("typescript", spec);
        const finished = yield* Queue.take(provisioner.completions);
        const third = yield* provisioner.ensure("typescript", spec);
        return { finished, first: first.kind, second: second.kind, third: third.kind };
      }),
    );

    expect(result.first).toBe("installing");
    expect(result.second).toBe("installing");
    expect(result.finished).toBe("typescript");
    expect(result.third).toBe("ready");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("ensure emits a start when a download begins, for the live installing status", async () => {
  process.env.STET_NO_LSP_DOWNLOAD = "";
  const root = tempRoot();
  try {
    const result = await withProvisioner(
      root,
      fakeInstaller(),
      Effect.gen(function* scenario() {
        const provisioner = yield* Provisioner;
        yield* provisioner.ensure("typescript", spec);
        const started = yield* Queue.take(provisioner.starts);
        const finished = yield* Queue.take(provisioner.completions);
        return { finished, started };
      }),
    );

    expect(result.started).toBe("typescript");
    expect(result.finished).toBe("typescript");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

// Records the exact argv so a test can assert the pinned versions reach `npm install`, not just that
// The provisioner orchestrates an install.
function capturingInstaller(commands: string[][]) {
  return Layer.succeed(Process)({
    run: (command, cwd) =>
      Effect.sync(() => {
        commands.push([...command]);
        const binDir = join(cwd, "node_modules", ".bin");
        mkdirSync(binDir, { recursive: true });
        writeFileSync(join(binDir, "typescript-language-server"), "#!/bin/sh\n");
        return { exitCode: 0, stderr: "", stdout: "", stdoutBytes: new Uint8Array() };
      }),
  });
}

test("provisioning installs the registry's exact pinned versions", async () => {
  process.env.STET_NO_LSP_DOWNLOAD = "";
  const root = tempRoot();
  const ts = registry.typescript;
  if (ts?.provision?.kind !== "npm") {
    throw new Error("typescript must remain npm-provisionable for this test");
  }
  const provisionSpec: ProvisionSpec = {
    args: ts.args,
    binary: ts.binary,
    channel: ts.provision,
  };
  const commands: string[][] = [];
  try {
    await withProvisioner(
      root,
      capturingInstaller(commands),
      Effect.gen(function* scenario() {
        const provisioner = yield* Provisioner;
        yield* provisioner.ensure("typescript", provisionSpec);
        yield* Queue.take(provisioner.completions);
      }),
    );

    expect(commands).toEqual([
      ["npm", "install", "--no-save", "typescript-language-server@5.3.0", "typescript@6.0.3"],
    ]);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("every provisioned server pins exactly, never a floating version or checksum-less asset", () => {
  for (const [language, serverSpec] of Object.entries(registry)) {
    const channel = serverSpec.provision;
    if (channel?.kind === "npm") {
      for (const pkg of channel.packages) {
        // A pinned spec carries `@<version>`; a bare `oxlint` or scoped `@biomejs/biome` does not.
        expect(pkg, `${language} pins ${pkg}`).toMatch(/@\d/);
      }
    }
    if (channel?.kind === "binary") {
      expect(channel.tag, `${language} pins a release tag`).not.toBe("");
      // Both shipped platforms are covered, each integrity-pinned to a full sha256.
      for (const os of ["darwin", "linux"] as const) {
        for (const arch of ["arm64", "x64"] as const) {
          const asset = channel.assets.find(
            (candidate) => candidate.os === os && candidate.arch === arch,
          );
          expect(asset, `${language} ships ${os}-${arch}`).toBeDefined();
          expect(asset?.sha256, `${language} ${os}-${arch} checksum`).toMatch(/^[0-9a-f]{64}$/);
        }
      }
    }
  }
});

// A fetch that never resolves, the way an air-gapped/proxied npm hangs. The provisioner must bound it
// So the file degrades to unavailable rather than sitting in `installing` forever.
function hangingInstaller() {
  return Layer.succeed(Process)({ run: () => Effect.never });
}

test("a hung install times out and degrades to failed", async () => {
  process.env.STET_NO_LSP_DOWNLOAD = "";
  const root = tempRoot();
  try {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* scenario() {
          const provisioner = yield* Provisioner;
          const first = yield* provisioner.ensure("typescript", spec);
          const finished = yield* Queue.take(provisioner.completions);
          const second = yield* provisioner.ensure("typescript", spec);
          return { finished, first: first.kind, second };
        }).pipe(
          Effect.provide(
            // A 10ms bound keeps the test on the real clock, no TestClock needed.
            Layer.effect(Provisioner, makeProvisioner(root, "10 millis")).pipe(
              Layer.provide(hangingInstaller()),
            ),
          ),
        ),
      ),
    );

    expect(result.first).toBe("installing");
    expect(result.finished).toBe("typescript");
    expect(result.second.kind).toBe("failed");
    if (result.second.kind === "failed") {
      expect(result.second.message).toContain("timed out");
    }
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("a filesystem setup failure degrades to failed, not a stuck install", async () => {
  process.env.STET_NO_LSP_DOWNLOAD = "";
  // A regular file as the cache root makes the server dir's mkdir fail (ENOTDIR), the way an
  // Unwritable cache or full disk would. That failure must still clear inFlight and offer a
  // Completion, or the language stays wedged in `installing`.
  const dir = tempRoot();
  const rootFile = join(dir, "not-a-dir");
  writeFileSync(rootFile, "");
  try {
    const result = await withProvisioner(
      rootFile,
      fakeInstaller(),
      Effect.gen(function* scenario() {
        const provisioner = yield* Provisioner;
        const first = yield* provisioner.ensure("typescript", spec);
        const finished = yield* Queue.take(provisioner.completions);
        const second = yield* provisioner.ensure("typescript", spec);
        return { finished, first: first.kind, second: second.kind };
      }),
    );

    expect(result.first).toBe("installing");
    expect(result.finished).toBe("typescript");
    expect(result.second).toBe("failed");
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

const binaryBytes = new TextEncoder().encode("#!/bin/sh\necho rust-analyzer\n");
const gzipped = Bun.gzipSync(binaryBytes);
const gzippedSha = createHash("sha256").update(gzipped).digest("hex");

function binarySpec(sha256: string): ProvisionSpec {
  return {
    args: [],
    binary: "rust-analyzer",
    channel: {
      assets: [
        { arch: "arm64", asset: "ra-darwin-arm64.gz", os: "darwin", sha256 },
        { arch: "x64", asset: "ra-darwin-x64.gz", os: "darwin", sha256 },
        { arch: "arm64", asset: "ra-linux-arm64.gz", os: "linux", sha256 },
        { arch: "x64", asset: "ra-linux-x64.gz", os: "linux", sha256 },
      ],
      kind: "binary",
      repo: "rust-lang/rust-analyzer",
      tag: "2026-07-06",
    },
  };
}

function withBinaryProvisioner<A, E>(
  root: string,
  download: (url: string) => Effect.Effect<Uint8Array<ArrayBuffer>>,
  effect: Effect.Effect<A, E, Provisioner>,
) {
  return Effect.runPromise(
    Effect.scoped(
      effect.pipe(
        Effect.provide(
          Layer.effect(Provisioner, makeProvisioner(root, undefined, download)).pipe(
            // The binary channel spawns nothing; a Process that fails proves it.
            Layer.provide(
              Layer.succeed(Process)({
                run: () => Effect.die(new Error("binary channel must not spawn")),
              }),
            ),
          ),
        ),
      ),
    ),
  );
}

test("the binary channel verifies the checksum, extracts, and marks the file executable", async () => {
  process.env.STET_NO_LSP_DOWNLOAD = "";
  const root = tempRoot();
  const urls: string[] = [];
  try {
    const state = await withBinaryProvisioner(
      root,
      (url) =>
        Effect.sync(() => {
          urls.push(url);
          return gzipped;
        }),
      Effect.gen(function* scenario() {
        const provisioner = yield* Provisioner;
        yield* provisioner.ensure("rust-analyzer", binarySpec(gzippedSha));
        yield* Queue.take(provisioner.completions);
        return yield* provisioner.ensure("rust-analyzer", binarySpec(gzippedSha));
      }),
    );

    expect(state.kind).toBe("ready");
    if (state.kind === "ready") {
      const [bin] = state.command;
      expect(readFileSync(bin ?? "", "utf8")).toBe("#!/bin/sh\necho rust-analyzer\n");
      // The executable bit is what lets the pool spawn it.
      expect(statSync(bin ?? "").mode & 0o111).not.toBe(0);
    }
    // The URL is assembled from the pinned repo, tag, and this platform's asset name.
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain("github.com/rust-lang/rust-analyzer/releases/download/2026-07-06/");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("a checksum mismatch fails the install and writes no binary", async () => {
  process.env.STET_NO_LSP_DOWNLOAD = "";
  const root = tempRoot();
  try {
    const state = await withBinaryProvisioner(
      root,
      () => Effect.succeed(Bun.gzipSync(new TextEncoder().encode("tampered"))),
      Effect.gen(function* scenario() {
        const provisioner = yield* Provisioner;
        yield* provisioner.ensure("rust-analyzer", binarySpec(gzippedSha));
        yield* Queue.take(provisioner.completions);
        return yield* provisioner.ensure("rust-analyzer", binarySpec(gzippedSha));
      }),
    );

    expect(state.kind).toBe("failed");
    if (state.kind === "failed") {
      expect(state.message).toContain("checksum mismatch");
    }
    // Nothing unverified ever lands on disk.
    expect(existsSync(join(root, "stet", "lsp", "rust-analyzer"))).toBe(false);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("a platform with no pinned asset degrades to failed, not a hang", async () => {
  process.env.STET_NO_LSP_DOWNLOAD = "";
  const root = tempRoot();
  const assetless: ProvisionSpec = {
    args: [],
    binary: "rust-analyzer",
    channel: {
      // An asset list that cannot match: no build for this machine.
      assets: [],
      kind: "binary",
      repo: "rust-lang/rust-analyzer",
      tag: "2026-07-06",
    },
  };
  try {
    const state = await withBinaryProvisioner(
      root,
      () => Effect.sync(() => gzipped),
      Effect.gen(function* scenario() {
        const provisioner = yield* Provisioner;
        yield* provisioner.ensure("rust-analyzer", assetless);
        yield* Queue.take(provisioner.completions);
        return yield* provisioner.ensure("rust-analyzer", assetless);
      }),
    );

    expect(state.kind).toBe("failed");
    if (state.kind === "failed") {
      expect(state.message).toContain("no rust-analyzer build for");
    }
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

// A real cargo-dist tarball (ruff's shape): the binary nested one directory in, gzipped. Built with
// The system tar so the extractor is exercised against the real archive format, not a hand encoder.
function ruffTarGz(binaryContents: string) {
  const dir = mkdtempSync(join(tmpdir(), "stet-ruff-"));
  mkdirSync(join(dir, "ruff-pkg"), { recursive: true });
  writeFileSync(join(dir, "ruff-pkg", "ruff"), binaryContents);
  writeFileSync(join(dir, "ruff-pkg", "README.md"), "docs");
  const archive = join(dir, "ruff.tar.gz");
  execFileSync("tar", ["-czf", archive, "-C", dir, "ruff-pkg"]);
  const bytes = new Uint8Array(readFileSync(archive));
  rmSync(dir, { force: true, recursive: true });
  return bytes;
}

const ruffArchive = ruffTarGz("#!/bin/sh\necho ruff\n");
const ruffSha = createHash("sha256").update(ruffArchive).digest("hex");

function ruffSpec(sha256: string): ProvisionSpec {
  return {
    args: ["server"],
    binary: "ruff",
    channel: {
      archive: "tar.gz",
      assets: [
        { arch: "arm64", asset: "ruff-aarch64-apple-darwin.tar.gz", os: "darwin", sha256 },
        { arch: "x64", asset: "ruff-x86_64-apple-darwin.tar.gz", os: "darwin", sha256 },
        { arch: "arm64", asset: "ruff-aarch64-unknown-linux-gnu.tar.gz", os: "linux", sha256 },
        { arch: "x64", asset: "ruff-x86_64-unknown-linux-gnu.tar.gz", os: "linux", sha256 },
      ],
      kind: "binary",
      repo: "astral-sh/ruff",
      tag: "0.15.21",
    },
  };
}

test("the tar.gz binary channel extracts the nested binary and marks it executable", async () => {
  process.env.STET_NO_LSP_DOWNLOAD = "";
  const root = tempRoot();
  try {
    const state = await withBinaryProvisioner(
      root,
      () => Effect.sync(() => ruffArchive),
      Effect.gen(function* scenario() {
        const provisioner = yield* Provisioner;
        yield* provisioner.ensure("ruff", ruffSpec(ruffSha));
        yield* Queue.take(provisioner.completions);
        return yield* provisioner.ensure("ruff", ruffSpec(ruffSha));
      }),
    );

    expect(state.kind).toBe("ready");
    if (state.kind === "ready") {
      const [bin] = state.command;
      expect(readFileSync(bin ?? "", "utf8")).toBe("#!/bin/sh\necho ruff\n");
      expect(statSync(bin ?? "").mode & 0o111).not.toBe(0);
      expect(state.command).toEqual([bin, "server"]);
    }
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("a tar.gz that lacks the named binary fails the install rather than writing garbage", async () => {
  process.env.STET_NO_LSP_DOWNLOAD = "";
  const root = tempRoot();
  const withoutRuff = (() => {
    const dir = mkdtempSync(join(tmpdir(), "stet-ruff-"));
    mkdirSync(join(dir, "pkg"), { recursive: true });
    writeFileSync(join(dir, "pkg", "other"), "not the binary");
    const archive = join(dir, "pkg.tar.gz");
    execFileSync("tar", ["-czf", archive, "-C", dir, "pkg"]);
    const bytes = new Uint8Array(readFileSync(archive));
    rmSync(dir, { force: true, recursive: true });
    return bytes;
  })();
  const sha = createHash("sha256").update(withoutRuff).digest("hex");
  try {
    const state = await withBinaryProvisioner(
      root,
      () => Effect.sync(() => withoutRuff),
      Effect.gen(function* scenario() {
        const provisioner = yield* Provisioner;
        yield* provisioner.ensure("ruff", ruffSpec(sha));
        yield* Queue.take(provisioner.completions);
        return yield* provisioner.ensure("ruff", ruffSpec(sha));
      }),
    );

    expect(state.kind).toBe("failed");
    if (state.kind === "failed") {
      expect(state.message).toContain("ruff not found");
    }
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  packages: ["typescript-language-server", "typescript"],
};

// The test preload disables downloads globally; restore that default after each toggle.
afterEach(() => {
  process.env.SIDEYE_NO_LSP_DOWNLOAD = "1";
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
  return mkdtempSync(join(tmpdir(), "sideye-prov-"));
}

test("ensure returns ready when the binary is already cached", async () => {
  const root = tempRoot();
  try {
    const binDir = join(
      root,
      "sideye",
      "lsp",
      "typescript",
      provisionKey(spec.packages),
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
  process.env.SIDEYE_NO_LSP_DOWNLOAD = "1";
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
  process.env.SIDEYE_NO_LSP_DOWNLOAD = "";
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
  process.env.SIDEYE_NO_LSP_DOWNLOAD = "";
  const root = tempRoot();
  const ts = registry.typescript;
  if (ts?.provision === undefined) {
    throw new Error("typescript must remain provisionable for this test");
  }
  const provisionSpec: ProvisionSpec = {
    args: ts.args,
    binary: ts.binary,
    packages: ts.provision.packages,
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

test("every provisioned server pins an exact version, never a bare @latest name", () => {
  for (const [language, serverSpec] of Object.entries(registry)) {
    for (const pkg of serverSpec.provision?.packages ?? []) {
      // A pinned spec carries `@<version>`; a bare `oxlint` or scoped `@biomejs/biome` does not.
      expect(pkg, `${language} pins ${pkg}`).toMatch(/@\d/);
    }
  }
});

// A fetch that never resolves, the way an air-gapped/proxied npm hangs. The provisioner must bound it
// So the file degrades to unavailable rather than sitting in `installing` forever.
function hangingInstaller() {
  return Layer.succeed(Process)({ run: () => Effect.never });
}

test("a hung install times out and degrades to failed", async () => {
  process.env.SIDEYE_NO_LSP_DOWNLOAD = "";
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
  process.env.SIDEYE_NO_LSP_DOWNLOAD = "";
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

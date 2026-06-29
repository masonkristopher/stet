import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect, Layer, Queue } from "effect";

import { makeProvisioner, Provisioner } from "@/diagnostics/provision";
import type { ProvisionSpec } from "@/diagnostics/provision";
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
    const binDir = join(root, "sideye", "lsp", "typescript", "node_modules", ".bin");
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

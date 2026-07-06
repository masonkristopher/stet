#!/usr/bin/env bun

// Builds standalone stet binaries and the npm package layout.
// Modeled on opencode's build script (anomalyco/opencode packages/opencode/script/build.ts),
// Which established the pattern for compiling OpenTUI apps with `bun build --compile`.

import fs from "node:fs";
import path from "node:path";

import solidPlugin from "@opentui/solid/bun-plugin";
import { $ } from "bun";

import pkg from "../package.json";

const dir = path.resolve(import.meta.dirname, "..");
process.chdir(dir);

const single = process.argv.includes("--single");
const skipInstall = process.argv.includes("--skip-install");
const archive = process.argv.includes("--archive");

interface Target {
  os: "darwin" | "linux";
  arch: "arm64" | "x64";
}

const allTargets: Target[] = [
  { arch: "arm64", os: "darwin" },
  { arch: "x64", os: "darwin" },
  { arch: "x64", os: "linux" },
  { arch: "arm64", os: "linux" },
];

const targets = single
  ? allTargets.filter((target) => target.os === process.platform && target.arch === process.arch)
  : allTargets;

if (targets.length === 0) {
  console.error(`no build target for ${process.platform}-${process.arch}`);
  process.exit(1);
}

await $`rm -rf dist`;

if (!skipInstall) {
  // Materialize every platform's native @opentui core so any target can embed its library
  await $`bun install --os="*" --cpu="*" @opentui/core@${pkg.dependencies["@opentui/core"]}`;
}

const parserWorker = fs.realpathSync(
  path.resolve(dir, "node_modules/@opentui/core/parser.worker.js"),
);
const workerRelativePath = path.relative(dir, parserWorker).replaceAll("\\", "/");
const bunfsRoot = "/$bunfs/root/";

const built: string[] = [];

for (const target of targets) {
  const name = `${pkg.name}-${target.os}-${target.arch}`;
  console.log(`building ${name}`);
  // oxlint-disable-next-line no-await-in-loop -- sequential cross-compilation: each target must complete before the next
  await $`mkdir -p dist/${name}/bin`;

  // oxlint-disable-next-line no-await-in-loop -- sequential cross-compilation: each target must complete before the next
  const result = await Bun.build({
    compile: {
      autoloadBunfig: false,
      autoloadDotenv: false,
      autoloadPackageJson: true,
      autoloadTsconfig: true,
      outfile: `dist/${name}/bin/${pkg.name}`,
      target: `bun-${target.os}-${target.arch}`,
    },
    conditions: ["bun", "node"],
    define: {
      OTUI_TREE_SITTER_WORKER_PATH: JSON.stringify(bunfsRoot + workerRelativePath),
      ...(target.os === "linux" ? { "process.env.OPENTUI_LIBC": JSON.stringify("glibc") } : {}),
    },
    entrypoints: ["./src/main.tsx", parserWorker],
    format: "esm",
    minify: true,
    plugins: [solidPlugin],
    sourcemap: "none",
    splitting: true,
    tsconfig: "./tsconfig.json",
  });

  if (!result.success) {
    console.error(result.logs.map((log) => log.message).join("\n"));
    process.exit(1);
  }

  if (target.os === process.platform && target.arch === process.arch) {
    // oxlint-disable-next-line no-await-in-loop -- sequential cross-compilation: each target must complete before the next
    const version = await $`dist/${name}/bin/${pkg.name} --version`.text();
    if (version.trim() !== pkg.version) {
      console.error(`smoke test failed: expected ${pkg.version}, got ${version.trim()}`);
      process.exit(1);
    }
    console.log(`smoke test passed: ${version.trim()}`);
  }

  // oxlint-disable-next-line no-await-in-loop -- sequential cross-compilation: each target must complete before the next
  await Bun.file(`dist/${name}/package.json`).write(
    JSON.stringify(
      {
        cpu: [target.arch],
        description: `stet binary for ${target.os}-${target.arch}`,
        license: "MIT",
        name,
        os: [target.os],
        preferUnplugged: true,
        repository: "github:jimmy-guzman/stet",
        version: pkg.version,
      },
      null,
      2,
    ),
  );

  built.push(name);
}

if (!single) {
  await $`mkdir -p dist/${pkg.name}/bin`;
  await $`cp script/stet-launcher.cjs dist/${pkg.name}/bin/stet.js`;
  await $`cp README.md LICENSE dist/${pkg.name}/`;
  await Bun.file(`dist/${pkg.name}/package.json`).write(
    JSON.stringify(
      {
        bin: { [pkg.name]: "./bin/stet.js" },
        bugs: "https://github.com/jimmy-guzman/stet/issues",
        description: pkg.description,
        homepage: "https://github.com/jimmy-guzman/stet",
        keywords: ["tui", "diff", "git", "code-review", "coding-agent", "terminal"],
        license: "MIT",
        name: pkg.name,
        optionalDependencies: Object.fromEntries(
          allTargets.map((target) => [`${pkg.name}-${target.os}-${target.arch}`, pkg.version]),
        ),
        repository: "github:jimmy-guzman/stet",
        version: pkg.version,
      },
      null,
      2,
    ),
  );
}

if (archive) {
  const sums: string[] = [];
  for (const name of built) {
    // Every platform ships tar.gz so the format never needs to be re-derived
    // By install.sh, release.yml, or the homebrew formula
    const archiveName = `${name}.tar.gz`;
    // oxlint-disable-next-line no-await-in-loop -- sequential archiving: each archive must complete before computing its checksum
    await $`tar -czf ../../${archiveName} ${pkg.name}`.cwd(`dist/${name}/bin`);

    const hasher = new Bun.CryptoHasher("sha256");
    // oxlint-disable-next-line no-await-in-loop -- sequential archiving: each archive must complete before computing its checksum
    hasher.update(await Bun.file(`dist/${archiveName}`).arrayBuffer());
    sums.push(`${hasher.digest("hex")}  ${archiveName}`);
  }
  await Bun.file("dist/SHA256SUMS").write(`${sums.join("\n")}\n`);
}

console.log(`built: ${built.join(", ")}`);

#!/usr/bin/env bun

// Builds standalone sideye binaries and the npm package layout.
// Modeled on opencode's build script (anomalyco/opencode packages/opencode/script/build.ts),
// which established the pattern for compiling OpenTUI apps with `bun build --compile`.

import { $ } from "bun"
import fs from "node:fs"
import path from "node:path"
import pkg from "../package.json"

const dir = path.resolve(import.meta.dirname, "..")
process.chdir(dir)

const single = process.argv.includes("--single")
const skipInstall = process.argv.includes("--skip-install")
const archive = process.argv.includes("--archive")

type Target = { os: "darwin" | "linux"; arch: "arm64" | "x64" }

const allTargets: Target[] = [
  { os: "darwin", arch: "arm64" },
  { os: "darwin", arch: "x64" },
  { os: "linux", arch: "x64" },
  { os: "linux", arch: "arm64" },
]

const targets = single ? allTargets.filter((target) => target.os === process.platform && target.arch === process.arch) : allTargets

if (targets.length === 0) {
  console.error(`no build target for ${process.platform}-${process.arch}`)
  process.exit(1)
}

await $`rm -rf dist`

if (!skipInstall) {
  // materialize every platform's native @opentui core so any target can embed its library
  await $`bun install --os="*" --cpu="*" @opentui/core@${pkg.dependencies["@opentui/core"]}`
}

const parserWorker = fs.realpathSync(path.resolve(dir, "node_modules/@opentui/core/parser.worker.js"))
const workerRelativePath = path.relative(dir, parserWorker).replaceAll("\\", "/")
const bunfsRoot = "/$bunfs/root/"

const built: string[] = []

for (const target of targets) {
  const name = `${pkg.name}-${target.os}-${target.arch}`
  console.log(`building ${name}`)
  // oxlint-disable-next-line no-await-in-loop -- sequential cross-compilation: each target must complete before the next
  await $`mkdir -p dist/${name}/bin`

  // oxlint-disable-next-line no-await-in-loop -- sequential cross-compilation: each target must complete before the next
  const result = await Bun.build({
    conditions: ["bun", "node"],
    tsconfig: "./tsconfig.json",
    format: "esm",
    minify: true,
    sourcemap: "none",
    splitting: true,
    compile: {
      autoloadBunfig: false,
      autoloadDotenv: false,
      autoloadTsconfig: true,
      autoloadPackageJson: true,
      target: `bun-${target.os}-${target.arch}` as never,
      outfile: `dist/${name}/bin/${pkg.name}`,
    },
    entrypoints: ["./src/main.tsx", parserWorker],
    define: {
      OTUI_TREE_SITTER_WORKER_PATH: JSON.stringify(bunfsRoot + workerRelativePath),
      ...(target.os === "linux" ? { "process.env.OPENTUI_LIBC": JSON.stringify("glibc") } : {}),
    },
  })

  if (!result.success) {
    console.error(result.logs.join("\n"))
    process.exit(1)
  }

  if (target.os === process.platform && target.arch === process.arch) {
    // oxlint-disable-next-line no-await-in-loop -- sequential cross-compilation: each target must complete before the next
    const version = await $`dist/${name}/bin/${pkg.name} --version`.text()
    if (version.trim() !== pkg.version) {
      console.error(`smoke test failed: expected ${pkg.version}, got ${version.trim()}`)
      process.exit(1)
    }
    console.log(`smoke test passed: ${version.trim()}`)
  }

  // oxlint-disable-next-line no-await-in-loop -- sequential cross-compilation: each target must complete before the next
  await Bun.file(`dist/${name}/package.json`).write(
    JSON.stringify(
      {
        name,
        version: pkg.version,
        description: `sideye binary for ${target.os}-${target.arch}`,
        repository: "github:jimmy-guzman/sideye",
        license: "MIT",
        preferUnplugged: true,
        os: [target.os],
        cpu: [target.arch],
      },
      null,
      2,
    ),
  )

  built.push(name)
}

if (!single) {
  await $`mkdir -p dist/${pkg.name}/bin`
  await $`cp script/sideye-launcher.cjs dist/${pkg.name}/bin/sideye.js`
  await $`cp README.md LICENSE dist/${pkg.name}/`
  await Bun.file(`dist/${pkg.name}/package.json`).write(
    JSON.stringify(
      {
        name: pkg.name,
        version: pkg.version,
        description: "Read-only companion TUI for CLI coding agents",
        repository: "github:jimmy-guzman/sideye",
        homepage: "https://github.com/jimmy-guzman/sideye",
        bugs: "https://github.com/jimmy-guzman/sideye/issues",
        keywords: ["tui", "diff", "git", "code-review", "coding-agent", "terminal"],
        license: "MIT",
        bin: { [pkg.name]: "./bin/sideye.js" },
        optionalDependencies: Object.fromEntries(allTargets.map((target) => [`${pkg.name}-${target.os}-${target.arch}`, pkg.version])),
      },
      null,
      2,
    ),
  )
}

if (archive) {
  const sums: string[] = []
  for (const name of built) {
    // every platform ships tar.gz so the format never needs to be re-derived
    // by install.sh, release.yml, or the homebrew formula
    const archiveName = `${name}.tar.gz`
    // oxlint-disable-next-line no-await-in-loop -- sequential archiving: each archive must complete before computing its checksum
    await $`tar -czf ../../${archiveName} ${pkg.name}`.cwd(`dist/${name}/bin`)

    const hasher = new Bun.CryptoHasher("sha256")
    // oxlint-disable-next-line no-await-in-loop -- sequential archiving: each archive must complete before computing its checksum
    hasher.update(await Bun.file(`dist/${archiveName}`).arrayBuffer())
    sums.push(`${hasher.digest("hex")}  ${archiveName}`)
  }
  await Bun.file("dist/SHA256SUMS").write(`${sums.join("\n")}\n`)
}

console.log(`built: ${built.join(", ")}`)

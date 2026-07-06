#!/usr/bin/env node

// Npm launcher: resolves the platform-specific stet binary package and execs it.
// Pattern from opencode's bin launcher (anomalyco/opencode packages/opencode/bin/opencode).

const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const forwardedSignals = ["SIGINT", "SIGTERM", "SIGHUP"];

function run(target) {
  const child = childProcess.spawn(target, process.argv.slice(2), { stdio: "inherit" });

  child.on("error", (error) => {
    console.error(error.message);
    process.exit(1);
  });

  for (const signal of forwardedSignals) {
    process.on(signal, () => {
      try {
        child.kill(signal);
      } catch {
        // The child may have already exited
      }
    });
  }

  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code === null ? 1 : code);
  });
}

const packageName = `stet-${os.platform()}-${os.arch()}`;

function findBinary(startDir) {
  let current = startDir;
  for (;;) {
    const candidate = path.join(current, "node_modules", packageName, "bin", "stet");
    if (fs.existsSync(candidate)) {
      return candidate;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

const resolved = process.env.STET_BIN_PATH || findBinary(__dirname);

if (!resolved) {
  console.error(
    `Could not find the stet binary for your platform. Your package manager may have skipped optional dependencies; try reinstalling, or install "${packageName}" directly. Supported platforms: darwin/linux on arm64/x64.`,
  );
  process.exit(1);
}

run(resolved);

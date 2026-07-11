import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { extractTarEntry } from "@/utils/untar";

// Build a real tar the way a cargo-dist release does: the binary nested one directory in, beside
// Sibling files. The system tar exercises the actual archive format (pax headers and all on macOS),
// So the reader is proven against real bytes rather than a hand-rolled encoder that could share a
// Bug with it.
function tarball(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "stet-untar-"));
  for (const [path, contents] of Object.entries(files)) {
    const full = join(dir, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents);
  }
  const archive = join(dir, "archive.tar");
  execFileSync("tar", ["-cf", archive, "-C", dir, ...Object.keys(files)]);
  const bytes = new Uint8Array(readFileSync(archive));
  rmSync(dir, { force: true, recursive: true });
  return bytes;
}

const decode = (bytes: Uint8Array | undefined) => new TextDecoder().decode(bytes);

test("extracts a nested binary from a tar by basename", () => {
  const tar = tarball({
    "ruff-aarch64-apple-darwin/README.md": "docs",
    "ruff-aarch64-apple-darwin/ruff": "#!/bin/sh\necho ruff\n",
  });

  expect(decode(extractTarEntry(tar, "ruff"))).toBe("#!/bin/sh\necho ruff\n");
});

test("reads a multi-block file at its exact length and lands on the next entry", () => {
  // A 1003-byte body spans two 512-byte content blocks with padding, so a correct size parse and
  // Block-rounding are load-bearing to still find `after`.
  const body = `${"x".repeat(1000)}END`;
  const tar = tarball({ "pkg/after": "sentinel", "pkg/ruff": body });

  expect(decode(extractTarEntry(tar, "ruff"))).toBe(body);
  expect(decode(extractTarEntry(tar, "after"))).toBe("sentinel");
});

test("returns undefined when no entry matches the basename", () => {
  expect(extractTarEntry(tarball({ "pkg/other": "x" }), "ruff")).toBeUndefined();
});

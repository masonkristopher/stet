import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect, Fiber } from "effect";

import { CommandError, Process, ProcessLive } from "@/process";

test("Process.run returns stdout for a successful command", async () => {
  const result = await Effect.runPromise(
    Process.pipe(
      Effect.flatMap((process) => process.run(["git", "--version"], import.meta.dir)),
      Effect.provide(ProcessLive),
    ),
  );

  expect(result.stdout).toContain("git version");
  expect(result.exitCode).toBe(0);
});

test("Process.run fails with CommandError on a disallowed exit code", async () => {
  const error = await Effect.runPromise(
    Process.pipe(
      Effect.flatMap((process) =>
        process.run(["git", "rev-parse", "--verify", "no-such-ref"], import.meta.dir),
      ),
      Effect.flip,
      Effect.provide(ProcessLive),
    ),
  );

  expect(error).toBeInstanceOf(CommandError);
  expect(error.exitCode).not.toBe(0);
});

test("Process.run fails with CommandError when the executable is missing", async () => {
  // Bun.spawn throws synchronously here; Effect.flip only resolves if that
  // Surfaces as a typed failure rather than an escaping defect.
  const error = await Effect.runPromise(
    Process.pipe(
      Effect.flatMap((process) => process.run(["sideye-no-such-binary"], import.meta.dir)),
      Effect.flip,
      Effect.provide(ProcessLive),
    ),
  );

  expect(error).toBeInstanceOf(CommandError);
});

test("Process.run fails with a clear message when the cwd no longer exists", async () => {
  // A deleted worktree leaves repoRoot pointing at a missing dir. The guard fails
  // With a readable cause instead of the raw "ENOENT ... posix_spawn" syscall text.
  // Create then remove a temp dir so the path is guaranteed missing in any env.
  const missingDir = mkdtempSync(join(tmpdir(), "sideye-missing-"));
  rmSync(missingDir, { force: true, recursive: true });

  const error = await Effect.runPromise(
    Process.pipe(
      Effect.flatMap((process) => process.run(["git", "status"], missingDir)),
      Effect.flip,
      Effect.provide(ProcessLive),
    ),
  );

  expect(error).toBeInstanceOf(CommandError);
  expect(error.message).toBe(`working directory no longer exists: ${missingDir}`);
  expect(error.message).not.toContain("posix_spawn");
});

test("Process.run kills the child when the fiber is interrupted", async () => {
  const start = Date.now();
  const fiber = Effect.runFork(
    Process.pipe(
      Effect.flatMap((process) => process.run(["sleep", "5"], import.meta.dir)),
      Effect.provide(ProcessLive),
    ),
  );

  await new Promise((resolve) => setTimeout(resolve, 100));
  await Effect.runPromise(Fiber.interrupt(fiber));

  // The child is killed on interrupt, so we never wait the full 5s
  expect(Date.now() - start).toBeLessThan(3000);
});

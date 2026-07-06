import { existsSync } from "node:fs";

import { Context, Data, Effect, Layer } from "effect";

import { stripGitEnv } from "@/utils/env";

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stdoutBytes: Uint8Array;
  stderr: string;
}

export class CommandError extends Data.TaggedError("CommandError")<{
  readonly command: readonly string[];
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly message: string;
}> {}

interface RunOptions {
  allowedExitCodes?: readonly number[];
  stdin?: string;
}

function renderCommand(command: readonly string[]) {
  return command.map((part) => (part.includes(" ") ? JSON.stringify(part) : part)).join(" ");
}

export class Process extends Context.Service<
  Process,
  {
    readonly run: (
      command: readonly string[],
      cwd: string,
      options?: RunOptions,
    ) => Effect.Effect<CommandResult, CommandError>;
  }
>()("stet/Process") {}

export const ProcessLive = Layer.succeed(Process)({
  // The release runs on interruption and failure, so the child is killed when a
  // Fiber is interrupted (e.g. a newer poll or a worktree switch) without any
  // Manual AbortController bookkeeping.
  run: (command, cwd, options) =>
    Effect.acquireUseRelease(
      // Bun.spawn throws synchronously when the executable is missing; Effect.try
      // Maps that into the typed CommandError channel instead of an escaping defect.
      Effect.try({
        catch: (cause) =>
          new CommandError({
            command,
            exitCode: -1,
            message: cause instanceof Error ? cause.message : String(cause),
            stderr: "",
            stdout: "",
          }),
        try: () => {
          // A deleted worktree leaves repoRoot pointing at a missing dir; Bun.spawn
          // Would surface a raw "ENOENT ... posix_spawn". Fail with a clear message
          // So callers (and the deletion detector) see the cause, not the syscall.
          if (!existsSync(cwd)) {
            throw new Error(`working directory no longer exists: ${cwd}`);
          }
          return Bun.spawn({
            cmd: [...command],
            cwd,
            // GIT_OPTIONAL_LOCKS=0 stops git status/diff from refreshing the index
            // (which takes .git/index.lock) and racing a concurrent agent commit.
            // Non-git children ignore the unknown variable, so it is safe globally.
            // StripGitEnv drops any inherited GIT_DIR/GIT_WORK_TREE/etc (e.g. from a
            // Launching shell or git hook), so cwd always governs repo discovery.
            env: { ...stripGitEnv(Bun.env), GIT_OPTIONAL_LOCKS: "0" },
            stderr: "pipe",
            stdout: "pipe",
            ...(options?.stdin === undefined ? {} : { stdin: new Blob([options.stdin]) }),
          });
        },
      }),
      (child) =>
        Effect.tryPromise({
          catch: (cause) =>
            new CommandError({
              command,
              exitCode: -1,
              message: cause instanceof Error ? cause.message : String(cause),
              stderr: "",
              stdout: "",
            }),
          try: (signal) => {
            signal.addEventListener("abort", () => child.kill(), { once: true });
            // ArrayBuffer() + an explicit Uint8Array view, never `.bytes()`: Bun
            // 1.3.14's runtime returns an ArrayBuffer from `bytes()` on a stream
            // (despite the Uint8Array typing, and unlike `bun test`, whose
            // Spec-correct Response masks it), which silently breaks every
            // Byte-level consumer downstream.
            return Promise.all([
              new Response(child.stdout).arrayBuffer(),
              new Response(child.stderr).text(),
              child.exited,
            ]);
          },
        }).pipe(
          // Decode stdout for string consumers, but keep the raw bytes so
          // Byte-level consumers (git-show binary guards, the search column
          // Parse) never trust a lossy decode.
          Effect.flatMap(([stdoutBuffer, stderr, exitCode]) => {
            const stdoutBytes = new Uint8Array(stdoutBuffer);
            const stdout = new TextDecoder().decode(stdoutBytes);
            if ((options?.allowedExitCodes ?? [0]).includes(exitCode)) {
              return Effect.succeed({ exitCode, stderr, stdout, stdoutBytes });
            }

            const detail = stderr.trim() || stdout.trim();
            return Effect.fail(
              new CommandError({
                command,
                exitCode,
                message: `${renderCommand(command)} failed with exit ${exitCode}${detail === "" ? "" : `\n${detail}`}`,
                stderr,
                stdout,
              }),
            );
          }),
        ),
      (child) =>
        Effect.sync(() => {
          if (!child.killed) {
            child.kill();
          }
        }),
    ),
});

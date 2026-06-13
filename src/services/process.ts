import { Context, Data, Effect, Layer } from "effect"

export interface CommandResult {
  exitCode: number
  stdout: string
  stderr: string
}

export class CommandError extends Data.TaggedError("CommandError")<{
  readonly command: readonly string[]
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
  readonly message: string
}> {}

interface RunOptions {
  allowedExitCodes?: readonly number[]
  stdin?: string
}

function renderCommand(command: readonly string[]) {
  return command.map((part) => (part.includes(" ") ? JSON.stringify(part) : part)).join(" ")
}

export class Process extends Context.Service<
  Process,
  {
    readonly run: (command: readonly string[], cwd: string, options?: RunOptions) => Effect.Effect<CommandResult, CommandError>
  }
>()("sideye/Process") {}

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
        try: () =>
          Bun.spawn({
            cmd: [...command],
            cwd,
            stderr: "pipe",
            stdout: "pipe",
            ...(options?.stdin === undefined ? {} : { stdin: new Blob([options.stdin]) }),
          }),
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
            signal.addEventListener("abort", () => child.kill(), { once: true })
            return Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
          },
        }).pipe(
          Effect.flatMap(([stdout, stderr, exitCode]) => {
            if ((options?.allowedExitCodes ?? [0]).includes(exitCode)) {
              return Effect.succeed({ exitCode, stderr, stdout })
            }

            const detail = stderr.trim() || stdout.trim()
            return Effect.fail(
              new CommandError({
                command,
                exitCode,
                message: `${renderCommand(command)} failed with exit ${exitCode}${detail === "" ? "" : `\n${detail}`}`,
                stderr,
                stdout,
              }),
            )
          }),
        ),
      (child) =>
        Effect.sync(() => {
          if (child.killed === false) {
            child.kill()
          }
        }),
    ),
})

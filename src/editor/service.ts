import { Context, Data, Effect, Layer } from "effect";

export class EditorError extends Data.TaggedError("EditorError")<{
  readonly message: string;
}> {}

export class Editor extends Context.Service<
  Editor,
  {
    /**
     * Spawns a GUI/IDE with ignored stdio and blocks until it exits, returning the exit code so the
     * caller can surface non-zero exits to the user.
     *
     * Note: Editor spawns directly via Bun.spawn rather than the Process service. Process pipes
     * stdio and kills children on fiber interruption, which would stop an interactive editor from
     * drawing to the TTY and kill it on watcher refresh. See AGENTS.md for the documented
     * exception.
     */
    readonly openIde: (argv: string[], cwd: string) => Effect.Effect<number, EditorError>;
    /** Spawns a terminal editor with inherited stdio and blocks until it exits. */
    readonly openTerminal: (argv: string[], cwd: string) => Effect.Effect<void, EditorError>;
  }
>()("stet/Editor") {}

export const EditorLive = Layer.succeed(Editor)({
  openIde: (argv, cwd) =>
    Effect.try({
      catch: (cause) =>
        new EditorError({ message: cause instanceof Error ? cause.message : String(cause) }),
      try: () => Bun.spawn(argv, { cwd, stderr: "ignore", stdin: "ignore", stdout: "ignore" }),
    }).pipe(
      Effect.flatMap((proc) =>
        Effect.tryPromise({
          catch: (cause) =>
            new EditorError({ message: cause instanceof Error ? cause.message : String(cause) }),
          try: () => proc.exited,
        }),
      ),
    ),
  openTerminal: (argv, cwd) =>
    Effect.try({
      catch: (cause) =>
        new EditorError({ message: cause instanceof Error ? cause.message : String(cause) }),
      try: () => Bun.spawn(argv, { cwd, stderr: "inherit", stdin: "inherit", stdout: "inherit" }),
    }).pipe(
      Effect.flatMap((proc) =>
        Effect.tryPromise({
          catch: (cause) =>
            new EditorError({ message: cause instanceof Error ? cause.message : String(cause) }),
          try: (signal) => {
            signal.addEventListener("abort", () => proc.kill(), { once: true });
            return proc.exited;
          },
        }),
      ),
      Effect.asVoid,
    ),
});

import { availableParallelism } from "node:os";
import { isAbsolute, join } from "node:path";

import { Context, Effect, Layer, Stream } from "effect";

import {
  discoverCheckerCommands,
  stateForEveryFile,
  stateForResolvedChecker,
  type CheckerCommand,
  type CheckerFileState,
  type CheckerName,
} from "../diagnostics";
import type { ChangedFile } from "../git";
import { Process } from "./process";

export interface CheckerUpdate {
  checker: CheckerName;
  state: Map<string, CheckerFileState>;
}

export class Diagnostics extends Context.Service<
  Diagnostics,
  {
    readonly run: (repoRoot: string, files: ChangedFile[]) => Stream.Stream<CheckerUpdate>;
  }
>()("sideye/Diagnostics") {}

export const DiagnosticsLive = Layer.effect(
  Diagnostics,
  Effect.gen(function* diagnosticsLive() {
    const process = yield* Process;

    // One command run: resolve per-package paths to absolute so the state helper
    // Can relativize them, capturing both a process failure and a parser throw as
    // A failure message so a broken checker degrades to "failed" rather than
    // Erroring the whole stream.
    function runCommand(repoRoot: string, command: CheckerCommand & { command: string[] }) {
      return process
        .run(command.command, command.cwd ?? repoRoot, {
          allowedExitCodes: command.allowedExitCodes,
        })
        .pipe(
          Effect.flatMap((result) =>
            Effect.try({ catch: (error) => error, try: () => command.parser(result) }),
          ),
          Effect.map((diagnostics) => ({
            diagnostics: diagnostics.map((diagnostic) => ({
              ...diagnostic,
              path:
                command.cwd !== undefined && !isAbsolute(diagnostic.path)
                  ? join(command.cwd, diagnostic.path)
                  : diagnostic.path,
            })),
            kind: "ok" as const,
          })),
          Effect.catch((error) =>
            Effect.succeed({
              kind: "failed" as const,
              message: error instanceof Error ? error.message : String(error),
            }),
          ),
        );
    }

    function runChecker(
      repoRoot: string,
      files: ChangedFile[],
      checker: CheckerName,
      commands: CheckerCommand[],
    ) {
      const [first] = commands;
      if (commands.length === 1 && first?.command === undefined) {
        const message = first?.unavailableMessage ?? `${checker} is not configured`;
        return Effect.succeed<CheckerUpdate>({
          checker,
          state: stateForEveryFile(files, "unavailable", message),
        });
      }

      const runnable = commands.filter(
        (command): command is CheckerCommand & { command: string[] } =>
          command.command !== undefined,
      );
      // A workspace typecheck fans out one process per affected package; cap the
      // Spawn rate at the core count so a large monorepo cannot launch dozens of
      // Heavy tsc/bun processes at once.
      return Effect.all(
        runnable.map((command) => runCommand(repoRoot, command)),
        { concurrency: availableParallelism() },
      ).pipe(
        Effect.map((results): CheckerUpdate => {
          const allDiagnostics = results.flatMap((result) =>
            result.kind === "ok" ? result.diagnostics : [],
          );
          const firstFailure = results.find((result) => result.kind === "failed");
          if (firstFailure?.kind === "failed" && allDiagnostics.length === 0) {
            return { checker, state: stateForEveryFile(files, "failed", firstFailure.message) };
          }

          return {
            checker,
            state: stateForResolvedChecker(checker, files, allDiagnostics, repoRoot),
          };
        }),
      );
    }

    return {
      // Each checker resolves independently and streams as soon as it finishes; a
      // Process failure becomes a "failed" state, so the stream never errors.
      // Interrupting the fiber (a newer run) kills in-flight checker processes
      // Through the Process release.
      run: (repoRoot, files) =>
        Stream.fromIterable([
          ...Map.groupBy(
            discoverCheckerCommands(repoRoot, files),
            (command) => command.checker,
          ).entries(),
        ]).pipe(
          Stream.mapEffect(
            ([checker, commands]) => runChecker(repoRoot, files, checker, commands),
            { concurrency: "unbounded" },
          ),
        ),
    };
  }),
);

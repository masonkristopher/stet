import { Context, Effect, Layer } from "effect"
import { loadFileContent, textContent, type FileContent, type LoadFileContentOptions } from "../file-view"
import { Process } from "./process"

export class File extends Context.Service<
  File,
  {
    readonly content: (repoRoot: string, path: string, options: LoadFileContentOptions) => Effect.Effect<FileContent>
  }
>()("sideye/File") {}

export const FileLive = Layer.effect(
  File,
  Effect.gen(function* fileLive() {
    const subprocess = yield* Process

    return {
      // Only the git-show path is a subprocess; local file reads stay synchronous
      // (no interruption benefit) and reuse loadFileContent's own missing/binary handling.
      content: (repoRoot, path, options) =>
        options.gitSpec === undefined
          ? Effect.sync(() => loadFileContent(repoRoot, path, options))
          : subprocess.run(["git", "show", options.gitSpec], repoRoot).pipe(
              Effect.map((result) => textContent(result.stdout, options.full)),
              Effect.catch(() => Effect.succeed<FileContent>({ kind: "missing" })),
            ),
    }
  }),
)

import { Context, Effect, Layer } from "effect";

import { Process } from "@/process";

import { classifyFileBytes, loadFileContent } from "./content";
import type { FileContent, LoadFileContentOptions } from "./content";

export class File extends Context.Service<
  File,
  {
    readonly content: (
      repoRoot: string,
      path: string,
      options: LoadFileContentOptions,
    ) => Effect.Effect<FileContent>;
  }
>()("sideye/File") {}

export const FileLive = Layer.effect(
  File,
  Effect.gen(function* fileLive() {
    const subprocess = yield* Process;

    return {
      // Only the git-show path is a subprocess; local file reads stay synchronous
      // (no interruption benefit). Both paths run classifyFileBytes over raw bytes
      // So deleted binaries are caught before decoding.
      content: (repoRoot, path, options) =>
        options.gitSpec === undefined
          ? Effect.sync(() => loadFileContent(repoRoot, path, options))
          : subprocess.run(["git", "show", options.gitSpec], repoRoot).pipe(
              Effect.map((result) => classifyFileBytes(result.stdoutBytes, options)),
              Effect.catch(() => Effect.succeed<FileContent>({ kind: "missing" })),
            ),
    };
  }),
);

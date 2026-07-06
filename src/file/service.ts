import { Context, Effect, Layer } from "effect";

import { Process } from "@/process";

import { classifyFileBytes, loadFileContentAsync } from "./content";
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
>()("stet/File") {}

export const FileLive = Layer.effect(
  File,
  Effect.gen(function* fileLive() {
    const subprocess = yield* Process;

    return {
      // Only the git-show path is a subprocess; local reads await (never block —
      // Search context fetches read up to 500 files per query) and never reject.
      // Both paths run classifyFileBytes over raw bytes so deleted binaries are
      // Caught before decoding.
      content: (repoRoot, path, options) =>
        options.gitSpec === undefined
          ? Effect.promise(() => loadFileContentAsync(repoRoot, path, options))
          : subprocess.run(["git", "show", options.gitSpec], repoRoot).pipe(
              Effect.map((result) => classifyFileBytes(result.stdoutBytes, options)),
              Effect.catch(() => Effect.succeed<FileContent>({ kind: "missing" })),
            ),
    };
  }),
);

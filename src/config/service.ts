import { Context, Data, Effect, Layer } from "effect";

import { loadConfigText } from "./load";
import type { LoadedConfig } from "./load";
import { configPaths } from "./paths";

class ConfigReadError extends Data.TaggedError("ConfigReadError")<{
  readonly message: string;
}> {}

export class Config extends Context.Service<
  Config,
  {
    readonly load: () => Effect.Effect<LoadedConfig>;
  }
>()("stet/Config") {}

const firstExistingConfig = Effect.gen(function* findConfig() {
  for (const candidate of configPaths()) {
    const exists = yield* Effect.promise(() => Bun.file(candidate).exists());
    if (exists) {
      return candidate;
    }
  }
  return undefined;
});

export const ConfigLive = Layer.effect(
  Config,
  Effect.sync(() => ({
    // No config file is the common case: defaults, no issue. A real read failure
    // (permissions, etc.) is downgraded to defaults plus an issue so the TUI
    // Always boots; only parse/validation issues come from loadConfigText.
    load: () =>
      Effect.gen(function* configLoad() {
        const path = yield* firstExistingConfig;
        if (path === undefined) {
          return { config: {}, issues: [] };
        }

        return yield* Effect.tryPromise({
          catch: (cause) =>
            new ConfigReadError({ message: `could not read config: ${String(cause)}` }),
          try: () => Bun.file(path).text(),
        }).pipe(
          Effect.map(loadConfigText),
          Effect.catch((error) => Effect.succeed({ config: {}, issues: [error.message] })),
        );
      }),
  })),
);

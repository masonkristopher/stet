import { Context, Data, Effect, Layer } from "effect";

import { Process } from "../process";
import { clipboardCommand } from "./reference";

export class ClipboardError extends Data.TaggedError("ClipboardError")<{
  readonly message: string;
}> {}

export class Clipboard extends Context.Service<
  Clipboard,
  {
    readonly copy: (text: string) => Effect.Effect<void, ClipboardError>;
  }
>()("sideye/Clipboard") {}

export const ClipboardLive = Layer.effect(
  Clipboard,
  Effect.gen(function* clipboardLive() {
    const subprocess = yield* Process;

    return {
      copy: (text) => {
        const command = clipboardCommand();
        if (command === undefined) {
          return Effect.fail(
            new ClipboardError({
              message: "no clipboard tool found; install wl-copy, xclip, or xsel",
            }),
          );
        }

        return subprocess.run(command, process.cwd(), { stdin: text }).pipe(
          Effect.asVoid,
          Effect.mapError((error) => new ClipboardError({ message: error.message })),
        );
      },
    };
  }),
);

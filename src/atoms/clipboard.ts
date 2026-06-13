import { Effect } from "effect"
import { Clipboard } from "../services/clipboard"
import { statusAtom } from "./diagnostics"
import { runtime } from "./runtime"

// Copy a reference to the clipboard, reporting success or the failure reason in
// The status bar. A fn-atom so the keymap can dispatch it without awaiting.
export const copyAtom = runtime.fn<string>()((text, get) =>
  Clipboard.pipe(
    Effect.flatMap((clipboard) => clipboard.copy(text)),
    Effect.tap(() => Effect.sync(() => get.set(statusAtom, `copied ${text.split("\n")[0]}`))),
    Effect.catch((error) => Effect.sync(() => get.set(statusAtom, error.message))),
  ),
)
